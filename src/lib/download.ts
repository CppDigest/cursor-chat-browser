import { ChatTab } from "@/types/workspace"
import { marked } from 'marked'

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').slice(0, 120)
}

export function convertChatToMarkdown(tab: ChatTab, includeMetadata = true): string {
  let markdown = ''

  if (includeMetadata && (tab.metadata || tab.bubbles.some(b => b.metadata))) {
    const meta: Record<string, unknown> = {
      title: tab.title || `Chat ${tab.id}`,
      created: new Date(tab.timestamp).toISOString(),
      conversation_id: tab.id
    }
    if (tab.metadata?.totalInputTokens != null) meta.total_input_tokens = tab.metadata.totalInputTokens
    if (tab.metadata?.totalOutputTokens != null) meta.total_output_tokens = tab.metadata.totalOutputTokens
    if (tab.metadata?.totalCachedTokens != null) meta.total_cached_tokens = tab.metadata.totalCachedTokens
    if (tab.metadata?.modelsUsed?.length) meta.models_used = tab.metadata.modelsUsed
    if (tab.metadata?.totalResponseTimeMs != null) meta.total_response_time_ms = tab.metadata.totalResponseTimeMs
    if (tab.metadata?.totalCost != null) meta.total_cost = tab.metadata.totalCost
    markdown += '---\n'
    markdown += Object.entries(meta).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n')
    markdown += '\n---\n\n'
  }

  markdown += `# ${tab.title || `Chat ${tab.id}`}\n\n`
  markdown += `_Created: ${new Date(tab.timestamp).toLocaleString()}_\n\n`
  if (includeMetadata && tab.metadata?.modelsUsed?.length) {
    markdown += `_Models: ${tab.metadata.modelsUsed.join(', ')}_\n\n`
  }
  if (includeMetadata && (tab.metadata?.totalInputTokens != null || tab.metadata?.totalOutputTokens != null || tab.metadata?.totalCachedTokens != null)) {
    markdown += `_Tokens: input ${tab.metadata.totalInputTokens ?? 0}, output ${tab.metadata.totalOutputTokens ?? 0}${tab.metadata.totalCachedTokens != null ? `, cached ${tab.metadata.totalCachedTokens}` : ''}_\n\n`
  }
  if (includeMetadata && tab.metadata?.totalResponseTimeMs != null) {
    markdown += `_Total response time: ${(tab.metadata.totalResponseTimeMs / 1000).toFixed(1)}s_\n\n`
  }
  if (includeMetadata && tab.metadata?.totalCost != null) {
    markdown += `_Cost estimate: ${tab.metadata.totalCost}_\n\n`
  }
  markdown += '---\n\n'

  tab.bubbles.forEach((bubble) => {
    markdown += `### ${bubble.type === 'ai' ? 'AI' : 'User'}\n\n`
    if (bubble.metadata?.modelName) {
      markdown += `_Model: ${bubble.metadata.modelName}_\n\n`
    }
    if (bubble.metadata?.inputTokens != null || bubble.metadata?.outputTokens != null || bubble.metadata?.cachedTokens != null) {
      markdown += `_Tokens: in ${bubble.metadata.inputTokens ?? 0}, out ${bubble.metadata.outputTokens ?? 0}${bubble.metadata.cachedTokens != null ? `, cached ${bubble.metadata.cachedTokens}` : ''}_\n\n`
    }
    if (bubble.metadata?.responseTimeMs != null) {
      markdown += `_Response time: ${(bubble.metadata.responseTimeMs / 1000).toFixed(1)}s_\n\n`
    }
    if (bubble.metadata?.cost != null) {
      markdown += `_Cost: ${bubble.metadata.cost}_\n\n`
    }
    if (bubble.text) {
      markdown += bubble.text + '\n\n'
    } else if (bubble.type === 'ai') {
      markdown += '_[TERMINAL OUTPUT NOT INCLUDED]_\n\n'
    }
    markdown += '---\n\n'
  })

  if (includeMetadata && tab.codeBlockDiffs?.length) {
    markdown += '## Code edit history\n\n'
    tab.codeBlockDiffs.forEach((diff: { diffId?: string; filePath?: string; newModelDiffWrtV0?: unknown[] }, i: number) => {
      const file = (diff as { filePath?: string }).filePath ?? (diff as { file?: string }).file ?? `diff-${diff.diffId ?? i}`
      markdown += `- **${file}** (${diff.diffId ?? i})\n`
      if (Array.isArray(diff.newModelDiffWrtV0) && diff.newModelDiffWrtV0.length > 0) {
        const lines = (diff.newModelDiffWrtV0 as { modified?: string[] }[]).flatMap(d => d.modified ?? [])
        if (lines.length) markdown += '  ```\n  ' + lines.slice(0, 30).join('\n  ') + (lines.length > 30 ? '\n  ...' : '') + '\n  ```\n'
      }
      markdown += '\n'
    })
    markdown += '---\n\n'
  }

  return markdown
}

export function downloadMarkdown(tab: ChatTab, withMetadata = true) {
  const markdown = convertChatToMarkdown(tab, withMetadata)
  const blob = new Blob([markdown], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${sanitizeFilename(tab.title || `chat-${tab.id}`)}.md`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function downloadHTML(tab: ChatTab) {
  const markdown = convertChatToMarkdown(tab, true)
  const htmlContent = marked(markdown)
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>${tab.title || `Chat ${tab.id}`}</title>
      <style>
        body {
          max-width: 800px;
          margin: 40px auto;
          padding: 0 20px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          line-height: 1.6;
          color: #333;
        }
        pre {
          background: #f5f5f5;
          padding: 1em;
          overflow-x: auto;
          border-radius: 4px;
          border: 1px solid #ddd;
        }
        code {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          font-size: 0.9em;
        }
        hr {
          border: none;
          border-top: 1px solid #ddd;
          margin: 2em 0;
        }
        h1, h2, h3 {
          margin-top: 2em;
          margin-bottom: 1em;
        }
        blockquote {
          border-left: 4px solid #ddd;
          margin: 0;
          padding-left: 1em;
          color: #666;
        }
        em {
          color: #666;
        }
        @media (prefers-color-scheme: dark) {
          body {
            background: #1a1a1a;
            color: #ddd;
          }
          pre {
            background: #2d2d2d;
            border-color: #404040;
          }
          blockquote {
            border-color: #404040;
            color: #999;
          }
          em {
            color: #999;
          }
        }
      </style>
    </head>
    <body>
      ${htmlContent}
    </body>
  </html>
  `
  
  const blob = new Blob([html], { type: 'text/html' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${sanitizeFilename(tab.title || `chat-${tab.id}`)}.html`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export async function downloadPDF(tab: ChatTab) {
  try {
    const markdown = convertChatToMarkdown(tab, true)
    const response = await fetch('/api/generate-pdf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        markdown,
        title: tab.title || `Chat ${tab.id}`
      }),
    })

    if (!response.ok) {
      throw new Error('Failed to generate PDF')
    }

    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${sanitizeFilename(tab.title || `chat-${tab.id}`)}.pdf`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch (error) {
    console.error('Failed to download PDF:', error)
    alert('Failed to generate PDF. This feature is not yet implemented.')
  }
}

export function copyMarkdown(tab: ChatTab) {
  const markdown = convertChatToMarkdown(tab, true)
  navigator.clipboard.writeText(markdown)
}

export function downloadJson(tab: ChatTab) {
  const json = JSON.stringify(tab, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${sanitizeFilename(tab.title || `chat-${tab.id}`)}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function downloadCsv(tab: ChatTab) {
  const headers = ['conversation_id', 'message_index', 'role', 'model', 'input_tokens', 'output_tokens', 'cached_tokens', 'response_time_ms', 'cost', 'timestamp', 'text_preview']
  const rows: string[][] = [headers]
  tab.bubbles.forEach((bubble, i) => {
    const textPreview = (bubble.text || '').replace(/\r?\n/g, ' ').slice(0, 200)
    const model = bubble.metadata?.modelName ?? ''
    const inputTokens = bubble.metadata?.inputTokens ?? ''
    const outputTokens = bubble.metadata?.outputTokens ?? ''
    const cachedTokens = bubble.metadata?.cachedTokens ?? ''
    const responseTimeMs = bubble.metadata?.responseTimeMs ?? ''
    const cost = bubble.metadata?.cost ?? ''
    const timestamp = bubble.timestamp ? new Date(bubble.timestamp).toISOString() : ''
    const role = bubble.type === 'user' ? 'user' : 'assistant'
    rows.push([
      tab.id,
      String(i),
      role,
      model,
      String(inputTokens),
      String(outputTokens),
      String(cachedTokens),
      String(responseTimeMs),
      String(cost),
      timestamp,
      textPreview.replace(/"/g, '""')
    ])
  })
  const csv = rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${sanitizeFilename(tab.title || `chat-${tab.id}`)}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function downloadCsvCodeEdits(tab: ChatTab) {
  const headers = ['conversation_id', 'diff_index', 'diff_id', 'file_path', 'timestamp', 'summary']
  const rows: string[][] = [headers]
  const diffs = tab.codeBlockDiffs ?? []
  diffs.forEach((diff: Record<string, unknown>, i: number) => {
    const diffId = String(diff.diffId ?? i)
    const filePath = String(diff.filePath ?? diff.file ?? '')
    const timestamp = diff.timestamp ? new Date(diff.timestamp as number).toISOString() : ''
    const modified = (diff.newModelDiffWrtV0 as { modified?: string[] }[] | undefined)?.flatMap(d => d.modified ?? []) ?? []
    const summary = modified.slice(0, 5).join('; ').replace(/"/g, '""')
    rows.push([tab.id, String(i), diffId, filePath.replace(/"/g, '""'), timestamp, summary])
  })
  const csv = rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${sanitizeFilename(tab.title || `chat-${tab.id}`)}-code-edits.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}