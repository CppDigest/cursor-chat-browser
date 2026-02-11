/**
 * CLI: Daily export of Cursor chats to per-chat Markdown.
 * Usage: node scripts/export.js [--since all|last] [--out ./export] [--include-composer]
 * Env: WORKSPACE_PATH for Cursor workspaceStorage path.
 */
const path = require('path')
const fs = require('fs')
const os = require('os')

function getDefaultWorkspacePath() {
  const home = os.homedir()
  const release = os.release().toLowerCase()
  const isWSL = release.includes('microsoft') || release.includes('wsl')
  const isRemote = Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY)
  if (isWSL) {
    let username = os.userInfo().username
    try {
      const { execSync } = require('child_process')
      username = execSync('cmd.exe /c echo %USERNAME%', { encoding: 'utf8' }).trim()
    } catch (_) {}
    return `/mnt/c/Users/${username}/AppData/Roaming/Cursor/User/workspaceStorage`
  }
  switch (process.platform) {
    case 'win32': return path.join(home, 'AppData/Roaming/Cursor/User/workspaceStorage')
    case 'darwin': return path.join(home, 'Library/Application Support/Cursor/User/workspaceStorage')
    case 'linux': return isRemote ? path.join(home, '.cursor-server/data/User/workspaceStorage') : path.join(home, '.config/Cursor/User/workspaceStorage')
    default: return path.join(home, 'workspaceStorage')
  }
}

function resolveWorkspacePath() {
  const envPath = process.env.WORKSPACE_PATH
  if (envPath?.trim()) return envPath.startsWith('~/') ? path.join(os.homedir(), envPath.slice(2)) : envPath
  return getDefaultWorkspacePath()
}

function normalizeFilePath(p) {
  let n = (p || '').replace(/^file:\/\/\//, '').replace(/^file:\/\//, '')
  try { n = decodeURIComponent(n) } catch (_) {}
  if (process.platform === 'win32') {
    n = n.replace(/\//g, '\\').replace(/^\\([a-z]:)/i, '$1')
    n = n.toLowerCase()
  }
  return n
}

function slug(s) {
  return String(s || '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'untitled'
}

function extractTextFromRichText(children) {
  if (!Array.isArray(children)) return ''
  let t = ''
  for (const c of children) {
    if (c.type === 'text' && c.text) t += c.text
    else if (c.type === 'code' && c.children) t += '\n```\n' + extractTextFromRichText(c.children) + '\n```\n'
    else if (c.children) t += extractTextFromRichText(c.children)
  }
  return t
}

function extractTextFromBubble(bubble) {
  let t = ''
  if (bubble?.text?.trim()) t = bubble.text
  if (!t && bubble?.richText) {
    try {
      const r = JSON.parse(bubble.richText)
      if (r?.root?.children) t = extractTextFromRichText(r.root.children)
    } catch (_) {}
  }
  if (bubble?.codeBlocks?.length) {
    for (const cb of bubble.codeBlocks) {
      if (cb?.content) t += `\n\n\`\`\`${cb.language || ''}\n${cb.content}\n\`\`\``
    }
  }
  return t
}

function parseArgs() {
  const args = process.argv.slice(2)
  const out = { since: 'all', outDir: './export', includeComposer: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--since' && args[i + 1]) { out.since = args[++i] }
    else if (args[i] === '--out' && args[i + 1]) { out.outDir = args[++i] }
    else if (args[i] === '--include-composer') out.includeComposer = true
  }
  return out
}

function main() {
  const { since, outDir } = parseArgs()
  const outDirAbs = path.resolve(outDir)
  const workspacePath = resolveWorkspacePath()
  const globalPath = path.join(workspacePath, '..', 'globalStorage', 'state.vscdb')
  if (!fs.existsSync(globalPath)) {
    console.error('Cursor global storage not found:', globalPath)
    process.exit(1)
  }

  const statePath = path.join(outDir, 'export_state.json')
  let lastExport = 0
  if (since === 'last' && fs.existsSync(statePath)) {
    try {
      const st = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      lastExport = st.lastExportTime ? new Date(st.lastExportTime).getTime() : 0
    } catch (_) {}
  }

  const Database = require('better-sqlite3')
  const db = new Database(globalPath, { readonly: true })

  const entries = fs.readdirSync(workspacePath, { withFileTypes: true })
  const workspaceEntries = []
  for (const e of entries) {
    if (e.isDirectory()) {
      const wp = path.join(workspacePath, e.name, 'workspace.json')
      if (fs.existsSync(wp)) workspaceEntries.push({ name: e.name, workspaceJsonPath: wp })
    }
  }

  function getWorkspaceFolderPaths(wd) {
    const paths = []
    if (wd?.folder) paths.push(wd.folder)
    if (Array.isArray(wd?.folders)) for (const f of wd.folders) if (f?.path) paths.push(f.path)
    return paths
  }

  const workspacePathToId = {}
  const projectNameToWorkspaceId = {}
  const workspaceIdToSlug = {}
  for (const e of workspaceEntries) {
    try {
      const wd = JSON.parse(fs.readFileSync(e.workspaceJsonPath, 'utf8'))
      const firstFolder = wd.folder || wd.folders?.[0]?.path
      const folderName = firstFolder ? firstFolder.replace(/^file:\/\//, '').split('/').pop()?.split('\\').pop() : null
      if (folderName) workspaceIdToSlug[e.name] = slug(folderName)
      for (const folder of getWorkspaceFolderPaths(wd)) {
        const norm = normalizeFilePath(folder)
        workspacePathToId[norm] = e.name
        const fn = folder.replace(/^file:\/\//, '').split('/').pop()?.split('\\').pop()
        if (fn) projectNameToWorkspaceId[fn] = e.name
      }
    } catch (_) {}
  }

  const projectLayoutsMap = {}
  try {
    const ctxRows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'messageRequestContext:%'").all()
    for (const row of ctxRows) {
      const parts = row.key.split(':')
      if (parts.length < 2) continue
      try {
        const ctx = JSON.parse(row.value)
        if (ctx?.projectLayouts?.length) {
          const cid = parts[1]
          if (!projectLayoutsMap[cid]) projectLayoutsMap[cid] = []
          for (const l of ctx.projectLayouts) {
            try {
              const o = typeof l === 'string' ? JSON.parse(l) : l
              if (o?.rootPath) projectLayoutsMap[cid].push(o.rootPath)
            } catch (_) {}
          }
        }
      } catch (_) {}
    }
  } catch (_) {}

  const bubbleMap = {}
  const bubbleRows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").all()
  for (const row of bubbleRows) {
    const bid = row.key.split(':')[2]
    try {
      const b = JSON.parse(row.value)
      if (b && typeof b === 'object') bubbleMap[bid] = b
    } catch (_) {}
  }

  const codeBlockDiffMap = {}
  try {
    const diffRows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'codeBlockDiff:%'").all()
    for (const row of diffRows) {
      const cid = row.key.split(':')[1]
      if (!cid) continue
      try {
        const d = JSON.parse(row.value)
        if (!codeBlockDiffMap[cid]) codeBlockDiffMap[cid] = []
        codeBlockDiffMap[cid].push({ ...d, diffId: row.key.split(':')[2] })
      } catch (_) {}
    }
  } catch (_) {}

  function getProjectFromFilePath(filePath) {
    const normalizedPath = normalizeFilePath(filePath)
    let bestMatch = null
    let bestLen = 0
    for (const e of workspaceEntries) {
      try {
        const wd = JSON.parse(fs.readFileSync(e.workspaceJsonPath, 'utf8'))
        for (const folder of getWorkspaceFolderPaths(wd)) {
          const wp = normalizeFilePath(folder)
          if (normalizedPath.startsWith(wp) && wp.length > bestLen) {
            bestLen = wp.length
            bestMatch = e.name
          }
        }
      } catch (_) {}
    }
    return bestMatch
  }

  function assignWorkspace(composerData, composerId) {
    const pl = projectLayoutsMap[composerId] || []
    // Use longest-match for project layouts
    let bestLayout = null
    let bestLayoutLen = 0
    for (const rp of pl) {
      const match = getProjectFromFilePath(rp)
      if (match) {
        const norm = normalizeFilePath(rp)
        if (norm.length > bestLayoutLen) { bestLayoutLen = norm.length; bestLayout = match }
      }
    }
    if (bestLayout) return bestLayout
    const paths = []
    for (const f of composerData.newlyCreatedFiles || []) {
      if (f?.uri?.path) paths.push(normalizeFilePath(f.uri.path))
    }
    for (const fp of Object.keys(composerData.codeBlockData || {})) {
      paths.push(normalizeFilePath(fp.replace('file://', '')))
    }
    for (const h of composerData.fullConversationHeadersOnly || []) {
      const b = bubbleMap[h.bubbleId]
      if (!b) continue
      for (const fp of b.relevantFiles || []) if (fp) paths.push(normalizeFilePath(fp))
      for (const u of b.attachedFileCodeChunksUris || []) if (u?.path) paths.push(normalizeFilePath(u.path))
      for (const fs of b.context?.fileSelections || []) if (fs?.uri?.path) paths.push(normalizeFilePath(fs.uri.path))
    }
    const sep = process.platform === 'win32' ? '\\' : '/'
    let best = null
    let bestLen = 0
    for (const p of paths) {
      for (const e of workspaceEntries) {
        try {
          const wd = JSON.parse(fs.readFileSync(e.workspaceJsonPath, 'utf8'))
          for (const folder of getWorkspaceFolderPaths(wd)) {
            const fn = folder.replace(/^file:\/\//, '').split('/').pop()?.split('\\').pop()
            if (!fn) continue
            const needle = sep + fn + sep
            const needleEnd = sep + fn
            if (p.includes(needle) || p.endsWith(needleEnd)) {
              if (fn.length > bestLen) { bestLen = fn.length; best = e.name }
            }
          }
        } catch (_) {}
      }
    }
    return best || 'global'
  }

  const composerRows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND value LIKE '%fullConversationHeadersOnly%'").all()
  const today = new Date().toISOString().slice(0, 10)
  const exported = []
  let count = 0

  for (const row of composerRows) {
    const composerId = row.key.split(':')[1]
    let composerData
    try {
      composerData = JSON.parse(row.value)
    } catch (_) { continue }
    const headers = composerData.fullConversationHeadersOnly || []
    if (headers.length === 0) continue

    const updatedAt = composerData.lastUpdatedAt || composerData.createdAt || 0
    if (since === 'last' && updatedAt <= lastExport) continue

    const workspaceId = assignWorkspace(composerData, composerId)
    const workspaceSlug = workspaceId === 'global' ? 'other-chats' : (workspaceIdToSlug[workspaceId] || slug(workspaceId.slice(0, 12)))
    const title = composerData.name || `Chat ${composerId.slice(0, 8)}`
    const titleSlug = slug(title)
    const ts = updatedAt || Date.now()
    const tsStr = new Date(ts).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `${tsStr}__${titleSlug}__${composerId.slice(0, 8)}.md`
    const relDir = path.join(today, workspaceSlug, 'chat')
    const outPath = path.join(outDirAbs, relDir, filename)

    const bubbles = []
    for (const h of headers) {
      const b = bubbleMap[h.bubbleId]
      if (!b) continue
      let text = extractTextFromBubble(b)
      const hasToolData = b.toolFormerData && typeof b.toolFormerData === 'object'
      const hasThinking = !!b.thinking
      if (!text.trim() && !hasToolData && !hasThinking) continue
      if (!text.trim() && hasToolData) text = `**Tool: ${b.toolFormerData.name || 'unknown'}**`
      const type = h.type === 1 ? 'user' : 'ai'
      // Extract metadata from issue #1 infrastructure
      let toolCalls
      if (b.toolFormerData && typeof b.toolFormerData === 'object') {
        const tfd = b.toolFormerData
        toolCalls = [{
          name: tfd.name,
          params: typeof tfd.params === 'string' ? tfd.params : (tfd.rawArgs || undefined),
          result: typeof tfd.result === 'string' ? tfd.result?.slice(0, 500) : undefined,
          status: tfd.status
        }]
      }
      let thinking
      if (b.thinking) {
        thinking = typeof b.thinking === 'string' ? b.thinking : b.thinking?.text
      }
      bubbles.push({ type, text, timestamp: b.createdAt || b.timestamp || Date.now(), toolCalls, thinking })
    }
    const codeBlockDiffs = codeBlockDiffMap[composerId] || []
    for (const d of codeBlockDiffs) {
      bubbles.push({ type: 'ai', text: `**Code edit:** ${JSON.stringify(d).slice(0, 500)}`, timestamp: composerData.lastUpdatedAt || composerData.createdAt || Date.now() })
    }
    bubbles.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))

    const frontmatter = {
      log_id: composerId,
      log_type: 'chat',
      title,
      created_at: new Date(composerData.createdAt || ts).toISOString(),
      updated_at: new Date(updatedAt).toISOString(),
      workspace_id: workspaceId,
      workspace_path: workspaceId === 'global' ? null : workspaceId,
      storage_kind: 'global',
      message_count: bubbles.length
    }
    const totalToolCalls = bubbles.reduce((n, b) => n + (b.toolCalls?.length || 0), 0)
    const totalThinking = bubbles.filter(b => b.thinking).length
    if (totalToolCalls) frontmatter.tool_calls_count = totalToolCalls
    if (totalThinking) frontmatter.thinking_count = totalThinking

    let body = ''
    for (const bubble of bubbles) {
      const role = bubble.type === 'user' ? 'user' : 'assistant'
      body += `### ${role}\n\n`
      if (bubble.timestamp) body += `_${new Date(bubble.timestamp).toISOString()}_\n\n`
      if (bubble.thinking) {
        body += `<details><summary>Thinking</summary>\n\n${bubble.thinking}\n\n</details>\n\n`
      }
      body += bubble.text + '\n\n'
      if (bubble.toolCalls?.length) {
        for (const tc of bubble.toolCalls) {
          body += `> **Tool: ${tc.name || 'unknown'}**`
          if (tc.status) body += ` (${tc.status})`
          body += '\n'
          if (tc.params) body += `> Params: \`${tc.params.slice(0, 200)}\`\n`
          if (tc.result) body += `> Result: \`${tc.result.slice(0, 200)}\`\n`
          body += '\n'
        }
      }
      body += '---\n\n'
    }

    const md = '---\n' + Object.entries(frontmatter).map(([k, v]) => `${k}: ${v === null ? 'null' : (typeof v === 'object' ? JSON.stringify(v) : v)}`).join('\n') + '\n---\n\n' + body

    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, md, 'utf8')
    exported.push({ id: composerId, path: outPath, updatedAt })
    count++
  }

  db.close()

  // Write manifest.jsonl (merge with existing, dedup by log_id)
  fs.mkdirSync(outDirAbs, { recursive: true })
  const manifestPath = path.join(outDirAbs, 'manifest.jsonl')
  const existingEntries = new Map()
  if (fs.existsSync(manifestPath)) {
    try {
      const lines = fs.readFileSync(manifestPath, 'utf8').split('\n').filter(l => l.trim())
      for (const line of lines) {
        try {
          const entry = JSON.parse(line)
          if (entry.log_id) existingEntries.set(entry.log_id, entry)
        } catch (_) {}
      }
    } catch (_) {}
  }
  for (const e of exported) {
    existingEntries.set(e.id, {
      log_id: e.id,
      path: path.relative(outDirAbs, e.path),
      updated_at: new Date(e.updatedAt).toISOString()
    })
  }
  if (existingEntries.size > 0) {
    const manifestLines = Array.from(existingEntries.values()).map(e => JSON.stringify(e))
    fs.writeFileSync(manifestPath, manifestLines.join('\n') + '\n', 'utf8')
  }

  const state = {
    lastExportTime: new Date().toISOString(),
    exportedCount: count,
    exportDir: outDirAbs
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')

  console.log(`Exported ${count} chat(s) to ${outDir}`)
  if (count > 0) console.log(`State saved to ${statePath}`)
}

main()
