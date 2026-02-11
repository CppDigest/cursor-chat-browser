/**
 * Research script: inspect Cursor's state.vscdb (global + workspace).
 * Run from project root: node scripts/inspect-db.js
 * Optional: set WORKSPACE_PATH to your workspaceStorage path.
 */

const path = require('path')
const os = require('os')
const fs = require('fs')

function getDefaultWorkspacePath() {
  const home = os.homedir()
  const release = os.release().toLowerCase()
  const isWSL = release.includes('microsoft') || release.includes('wsl')
  const isRemote = Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY)

  if (isWSL) {
    let username = os.userInfo().username
    try {
      const { execSync } = require('child_process')
      const output = execSync('cmd.exe /c echo %USERNAME%', { encoding: 'utf8' })
      username = output.trim()
    } catch (_) {}
    return `/mnt/c/Users/${username}/AppData/Roaming/Cursor/User/workspaceStorage`
  }

  switch (process.platform) {
    case 'win32':
      return path.join(home, 'AppData/Roaming/Cursor/User/workspaceStorage')
    case 'darwin':
      return path.join(home, 'Library/Application Support/Cursor/User/workspaceStorage')
    case 'linux':
      if (isRemote) return path.join(home, '.cursor-server/data/User/workspaceStorage')
      return path.join(home, '.config/Cursor/User/workspaceStorage')
    default:
      return path.join(home, 'workspaceStorage')
  }
}

function resolveWorkspacePath() {
  const envPath = process.env.WORKSPACE_PATH
  if (envPath && envPath.trim() !== '') {
    if (envPath.startsWith('~/')) return path.join(os.homedir(), envPath.slice(2))
    return envPath
  }
  return getDefaultWorkspacePath()
}

function getTableInfo(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
  return tables.map((t) => t.name)
}

function getTableSchema(db, tableName) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all()
  return cols
}

function listKeys(db, tableName, limit = 100) {
  const schema = getTableSchema(db, tableName)
  const keyCol = schema.find((c) => c.name === 'key' || c.name === 'Key')
  if (!keyCol) return { keys: [], total: 0 }
  const keyColumn = keyCol.name
  const total = db.prepare(`SELECT COUNT(*) as c FROM ${tableName}`).get().c
  const keys = db.prepare(`SELECT ${keyColumn} as k FROM ${tableName} LIMIT ?`).all(limit).map((r) => r.k)
  return { keys, total }
}

function listKeysByPattern(db, tableName, pattern) {
  const schema = getTableSchema(db, tableName)
  const keyCol = schema.find((c) => c.name === 'key' || c.name === 'Key')
  if (!keyCol) return []
  const keyColumn = keyCol.name
  const stmt = db.prepare(`SELECT ${keyColumn} as k FROM ${tableName} WHERE ${keyColumn} LIKE ? LIMIT 20`)
  return stmt.all(pattern).map((r) => r.k)
}

function getKeyPrefixes(keys) {
  const prefixes = new Map()
  for (const k of keys) {
    if (typeof k !== 'string') continue
    const idx = k.indexOf(':')
    const prefix = idx > 0 ? k.slice(0, idx) : k
    prefixes.set(prefix, (prefixes.get(prefix) || 0) + 1)
  }
  return Array.from(prefixes.entries()).sort((a, b) => b[1] - a[1])
}

function sampleValue(db, tableName, key) {
  const schema = getTableSchema(db, tableName)
  const keyCol = schema.find((c) => c.name === 'key' || c.name === 'Key')
  const valCol = schema.find((c) => c.name === 'value' || c.name === 'Value')
  if (!keyCol || !valCol) return null
  const row = db.prepare(`SELECT ${valCol.name} FROM ${tableName} WHERE ${keyCol.name} = ?`).get(key)
  return row ? row[valCol.name] : null
}

function inspectDb(dbPath, label) {
  if (!fs.existsSync(dbPath)) {
    console.log(`\n[${label}] NOT FOUND: ${dbPath}\n`)
    return
  }

  const Database = require('better-sqlite3')
  const db = new Database(dbPath, { readonly: true })

  console.log(`\n${'='.repeat(60)}`)
  console.log(`${label}: ${dbPath}`)
  console.log('='.repeat(60))

  const tables = getTableInfo(db)
  console.log('\nTables:', tables.join(', '))

  for (const tableName of tables) {
    console.log(`\n--- ${tableName} ---`)
    const schema = getTableSchema(db, tableName)
    console.log('Columns:', schema.map((c) => `${c.name} (${c.type})`).join(', '))

    const { keys, total } = listKeys(db, tableName, 200)
    console.log(`Total rows: ${total}. Sample keys (up to 200):`)

    if (keys.length <= 50) {
      keys.forEach((k) => console.log('  ', typeof k === 'string' && k.length > 80 ? k.slice(0, 80) + '...' : k))
    } else {
      keys.slice(0, 30).forEach((k) => console.log('  ', typeof k === 'string' && k.length > 80 ? k.slice(0, 80) + '...' : k))
      console.log('  ...')
      keys.slice(-10).forEach((k) => console.log('  ', typeof k === 'string' && k.length > 80 ? k.slice(0, 80) + '...' : k))
    }

    const prefixes = getKeyPrefixes(keys)
    if (prefixes.length > 0) {
      console.log('Key prefixes (pattern -> count):')
      prefixes.slice(0, 25).forEach(([p, c]) => console.log(`  ${p} -> ${c}`))
    }

    // Sample one value for a few interesting key patterns (chat-related)
    const valueCol = schema.find((c) => c.name === 'value' || c.name === 'Value')
    if (valueCol && keys.length > 0) {
      const keyCol = schema.find((c) => c.name === 'key' || c.name === 'Key')
      const sampleKeys = [
        keys.find((k) => String(k).startsWith('composerData:')),
        keys.find((k) => String(k).startsWith('bubbleId:')),
        keys.find((k) => String(k) === 'composer.composerData'),
        keys.find((k) => String(k).includes('messageRequestContext:')),
        keys[0]
      ].filter(Boolean)

      for (const sk of [...new Set(sampleKeys)].slice(0, 3)) {
        const val = sampleValue(db, tableName, sk)
        if (val == null) continue
        const str = typeof val === 'string' ? val : JSON.stringify(val)
        const preview = str.length > 500 ? str.slice(0, 500) + '\n... [truncated]' : str
        console.log(`\nSample value for key "${String(sk).slice(0, 60)}...":`)
        console.log(preview)
      }
    }
  }

  db.close()
}

function inspectGlobalCursorDiskKV(dbPath) {
  if (!fs.existsSync(dbPath)) return
  const Database = require('better-sqlite3')
  const db = new Database(dbPath, { readonly: true })

  console.log('\n' + '='.repeat(60))
  console.log('GLOBAL cursorDiskKV – key patterns and chat-related samples')
  console.log('='.repeat(60))

  // All key prefixes with counts (key format is "prefix:..." or single word)
  const prefixRows = db.prepare(`
    SELECT
      CASE WHEN instr(key, ':') > 0 THEN substr(key, 1, instr(key, ':') - 1) ELSE key END AS prefix,
      COUNT(*) AS cnt
    FROM cursorDiskKV
    GROUP BY prefix
    ORDER BY cnt DESC
  `).all()
  console.log('\nKey prefixes (prefix -> count):')
  prefixRows.forEach((r) => console.log('  ', r.prefix, '->', r.cnt))

  const chatPatterns = [
    ['composerData%', 'composerData'],
    ['bubbleId%', 'bubbleId'],
    ['messageRequestContext%', 'messageRequestContext'],
    ['codeBlockDiff%', 'codeBlockDiff'],
    ['checkpointId%', 'checkpointId'],
    ['codeBlockPartialInlineDiffFates%', 'codeBlockPartialInlineDiffFates']
  ]

  const metadataFields = ['usageData', 'modelConfig', 'modelInfo', 'tokenCount', 'toolResults']

  for (const [pattern, label] of chatPatterns) {
    const keys = db.prepare("SELECT key FROM cursorDiskKV WHERE key LIKE ? LIMIT 3").all(pattern)
    if (keys.length === 0) {
      console.log('\nNo keys for', label)
      continue
    }
    for (const row of keys) {
      const key = row.key
      const val = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(key)
      if (!val || !val.value) continue
      let str = val.value
      if (Buffer.isBuffer(str)) str = str.toString('utf8')
      let parsed
      try {
        parsed = JSON.parse(str)
      } catch (_) {
        console.log('\n' + label, 'key:', key.slice(0, 70) + '...')
        console.log('  (value not JSON, length:', str.length, ')')
        continue
      }
      console.log('\n' + label, 'key:', key.slice(0, 80) + (key.length > 80 ? '...' : ''))
      console.log('  Top-level keys:', Object.keys(parsed).join(', '))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const k of Object.keys(parsed).slice(0, 8)) {
          const v = parsed[k]
          const preview = typeof v === 'object' ? JSON.stringify(v).slice(0, 120) + (JSON.stringify(v).length > 120 ? '...' : '') : String(v).slice(0, 80)
          console.log('    ', k, ':', preview)
        }
        for (const mf of metadataFields) {
          if (parsed[mf] !== undefined) {
            const v = parsed[mf]
            const preview = typeof v === 'object' ? JSON.stringify(v).slice(0, 400) + (JSON.stringify(v).length > 400 ? '...' : '') : String(v)
            console.log('  [metadata]', mf, ':', preview)
          }
        }
      }
    }
  }

  db.close()
}

function main() {
  const workspacePath = resolveWorkspacePath()
  console.log('Workspace storage path:', workspacePath)

  const globalPath = path.join(workspacePath, '..', 'globalStorage', 'state.vscdb')
  inspectDb(globalPath, 'GLOBAL state.vscdb')
  inspectGlobalCursorDiskKV(globalPath)

  // Inspect first workspace that has state.vscdb
  if (fs.existsSync(workspacePath)) {
    const entries = fs.readdirSync(workspacePath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const wp = path.join(workspacePath, entry.name, 'state.vscdb')
        if (fs.existsSync(wp)) {
          inspectDb(wp, `WORKSPACE state.vscdb (${entry.name})`)
          break
        }
      }
    }
  }
}

main()
