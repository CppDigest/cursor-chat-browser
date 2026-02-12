import { NextResponse } from 'next/server'
import { existsSync, readFileSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import Database from 'better-sqlite3'
import { resolveWorkspacePath } from '@/utils/workspace-path'
import { ComposerData } from '@/types/workspace'

interface ToolCall {
  name?: string
  params?: string
  result?: string
  status?: string
}

interface ChatBubble {
  type: 'user' | 'ai'
  text: string
  timestamp: number
  metadata?: {
    modelName?: string
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
    toolResultsCount?: number
    toolResults?: unknown[]
    toolCalls?: ToolCall[]
    thinking?: string
    thinkingDurationMs?: number
    responseTimeMs?: number
    cost?: number
    contextWindowPercent?: number
  }
}

interface ChatTab {
  id: string
  title: string
  timestamp: number
  bubbles: ChatBubble[]
  codeBlockDiffs: any[]
  metadata?: {
    totalInputTokens?: number
    totalOutputTokens?: number
    totalCachedTokens?: number
    modelsUsed?: string[]
    totalResponseTimeMs?: number
    totalCost?: number
    totalToolCalls?: number
    totalThinkingDurationMs?: number
  }
}

interface RawTab {
  tabId: string;
  chatTitle: string;
  lastSendTime: number;
  bubbles: ChatBubble[];
}

const safeParseTimestamp = (timestamp: number | undefined): string => {
  try {
    if (!timestamp) {
      return new Date().toISOString();
    }
    return new Date(timestamp).toISOString();
  } catch (error) {
    console.error('Error parsing timestamp:', error, 'Raw value:', timestamp);
    return new Date().toISOString();
  }
};

function extractChatIdFromBubbleKey(key: string): string | null {
  // key format: bubbleId:<chatId>:<bubbleId>
  const match = key.match(/^bubbleId:([^:]+):/)
  return match ? match[1] : null
}

function extractChatIdFromCodeBlockDiffKey(key: string): string | null {
  // key format: codeBlockDiff:<chatId>:<diffId>
  const match = key.match(/^codeBlockDiff:([^:]+):/)
  return match ? match[1] : null
}

function formatToolAction(action: any): string {
  if (!action) return ''
  
  let result = ''
  
  // Handle code changes
  if (action.newModelDiffWrtV0 && action.newModelDiffWrtV0.length > 0) {
    for (const diff of action.newModelDiffWrtV0) {
      if (diff.modified && diff.modified.length > 0) {
        result += `\n\n**Code Changes:**\n\`\`\`\n${diff.modified.join('\n')}\n\`\`\``
      }
    }
  }
  
  // Handle file operations
  if (action.filePath) {
    result += `\n\n**File:** ${action.filePath}`
  }
  
  // Handle terminal commands
  if (action.command) {
    result += `\n\n**Command:** \`${action.command}\``
  }
  
  // Handle search results
  if (action.searchResults) {
    result += `\n\n**Search Results:**\n${action.searchResults}`
  }
  
  // Handle web search results
  if (action.webResults) {
    result += `\n\n**Web Search:**\n${action.webResults}`
  }
  
  // Handle tool actions with specific types
  if (action.toolName) {
    result += `\n\n**Tool Action:** ${action.toolName}`
    
    if (action.parameters) {
      try {
        const params = typeof action.parameters === 'string' ? JSON.parse(action.parameters) : action.parameters
        if (params.command) {
          result += `\n**Command:** \`${params.command}\``
        }
        if (params.target_file) {
          result += `\n**File:** ${params.target_file}`
        }
        if (params.query) {
          result += `\n**Query:** ${params.query}`
        }
        if (params.instructions) {
          result += `\n**Instructions:** ${params.instructions}`
        }
      } catch (error) {
        console.error('Error parsing tool parameters:', error)
      }
    }
    
    if (action.result) {
      try {
        const resultData = typeof action.result === 'string' ? JSON.parse(action.result) : action.result
        if (resultData.output) {
          result += `\n\n**Output:**\n\`\`\`\n${resultData.output}\n\`\`\``
        }
        if (resultData.contents) {
          result += `\n\n**File Contents:**\n\`\`\`\n${resultData.contents}\n\`\`\``
        }
        if (resultData.exitCodeV2 !== undefined) {
          result += `\n\n**Exit Code:** ${resultData.exitCodeV2}`
        }
        if (resultData.files && resultData.files.length > 0) {
          result += `\n\n**Files Found:**`
          for (const file of resultData.files) {
            result += `\n- ${file.name || file.path} (${file.type || 'file'})`
          }
        }
        if (resultData.results && resultData.results.length > 0) {
          result += `\n\n**Results:**`
          for (const searchResult of resultData.results) {
            if (searchResult.file && searchResult.content) {
              result += `\n\n**File:** ${searchResult.file}`
              result += `\n\`\`\`\n${searchResult.content}\n\`\`\``
            }
          }
        }
      } catch (error) {
        console.error('Error parsing tool result:', error)
      }
    }
  }
  
  // Handle actions taken
  if (action.actionsTaken && action.actionsTaken.length > 0) {
    result += `\n\n**Actions Taken:** ${action.actionsTaken.join(', ')}`
  }
  
  // Handle files modified
  if (action.filesModified && action.filesModified.length > 0) {
    result += `\n\n**Files Modified:**`
    for (const file of action.filesModified) {
      result += `\n- ${file}`
    }
  }
  
  // Handle git status
  if (action.gitStatus) {
    result += `\n\n**Git Status:**\n\`\`\`\n${action.gitStatus}\n\`\`\``
  }
  
  // Handle directory listings
  if (action.directoryListed) {
    result += `\n\n**Directory Listed:** ${action.directoryListed}`
  }
  
  // Handle web search results
  if (action.webSearchResults) {
    result += `\n\n**Web Search Results:**`
    for (const searchResult of action.webSearchResults) {
      if (searchResult.title) {
        result += `\n- ${searchResult.title}`
      }
    }
  }
  
  return result
}

function extractTextFromBubble(bubble: any): string {
  let text = ''
  
  // Try to get text from the text field first
  if (bubble.text && bubble.text.trim()) {
    text = bubble.text
  }
  
  // If no text, try to extract from richText
  if (!text && bubble.richText) {
    try {
      const richTextData = JSON.parse(bubble.richText)
      if (richTextData.root && richTextData.root.children) {
        text = extractTextFromRichText(richTextData.root.children)
      }
    } catch (error) {
      console.error('Error parsing richText:', error)
    }
  }
  
  // If it's an AI message with code blocks, include them
  if (bubble.codeBlocks && Array.isArray(bubble.codeBlocks)) {
    for (const codeBlock of bubble.codeBlocks) {
      if (codeBlock.content) {
        text += `\n\n\`\`\`${codeBlock.language || ''}\n${codeBlock.content}\n\`\`\``
      }
    }
  }
  
  return text
}

function extractTextFromRichText(children: any[]): string {
  let text = ''
  
  for (const child of children) {
    if (child.type === 'text' && child.text) {
      text += child.text
    } else if (child.type === 'code' && child.children) {
      text += '\n```\n'
      text += extractTextFromRichText(child.children)
      text += '\n```\n'
    } else if (child.children && Array.isArray(child.children)) {
      text += extractTextFromRichText(child.children)
    }
  }
  
  return text
}

function determineProjectForConversation(
  composerData: any,
  composerId: string,
  projectLayoutsMap: Record<string, string[]>,
  projectNameToWorkspaceId: Record<string, string>,
  workspacePathToId: Record<string, string>,
  workspaceEntries: Array<{name: string, workspaceJsonPath: string}>,
  bubbleMap: Record<string, any>
): string | null {
  const projectLayouts = projectLayoutsMap[composerId] || []
  for (const rootPath of projectLayouts) {
    const normalized = normalizeFilePath(rootPath)
    let workspaceId = workspacePathToId[normalized]
    if (!workspaceId) {
      const folderName = rootPath.split('/').pop() || rootPath.split('\\').pop()
      workspaceId = folderName ? projectNameToWorkspaceId[folderName] ?? '' : ''
    }
    if (workspaceId) return workspaceId
  }
  
  if (composerData.newlyCreatedFiles?.length) {
    for (const file of composerData.newlyCreatedFiles) {
      if (file.uri?.path) {
        const projectId = getProjectFromFilePath(file.uri.path, workspaceEntries)
        if (projectId) return projectId
      }
    }
  }
  if (composerData.codeBlockData && typeof composerData.codeBlockData === 'object') {
    for (const filePath of Object.keys(composerData.codeBlockData)) {
      const projectId = getProjectFromFilePath(filePath.replace('file://', ''), workspaceEntries)
      if (projectId) return projectId
    }
  }
  const conversationHeaders = composerData.fullConversationHeadersOnly || []
  for (const header of conversationHeaders) {
    const bubble = bubbleMap[header.bubbleId]
    if (!bubble) continue
    if (bubble.relevantFiles?.length) {
      for (const filePath of bubble.relevantFiles) {
        if (filePath) {
          const projectId = getProjectFromFilePath(filePath, workspaceEntries)
          if (projectId) return projectId
        }
      }
    }
    if (bubble.attachedFileCodeChunksUris?.length) {
      for (const uri of bubble.attachedFileCodeChunksUris) {
        if (uri?.path) {
          const projectId = getProjectFromFilePath(uri.path, workspaceEntries)
          if (projectId) return projectId
        }
      }
    }
    if (bubble.context?.fileSelections?.length) {
      for (const fs of bubble.context.fileSelections) {
        if (fs?.uri?.path) {
          const projectId = getProjectFromFilePath(fs.uri.path, workspaceEntries)
          if (projectId) return projectId
        }
      }
    }
  }

  const pathSegments: string[] = []
  if (composerData.newlyCreatedFiles?.length) {
    for (const f of composerData.newlyCreatedFiles) {
      if (f?.uri?.path) pathSegments.push(normalizeFilePath(f.uri.path))
    }
  }
  if (composerData.codeBlockData && typeof composerData.codeBlockData === 'object') {
    for (const filePath of Object.keys(composerData.codeBlockData)) {
      pathSegments.push(normalizeFilePath(filePath.replace('file://', '')))
    }
  }
  for (const header of conversationHeaders) {
    const bubble = bubbleMap[header.bubbleId]
    if (!bubble) continue
    if (bubble.relevantFiles?.length) {
      for (const filePath of bubble.relevantFiles) {
        if (filePath) pathSegments.push(normalizeFilePath(filePath))
      }
    }
    if (bubble.attachedFileCodeChunksUris?.length) {
      for (const uri of bubble.attachedFileCodeChunksUris) {
        if (uri?.path) pathSegments.push(normalizeFilePath(uri.path))
      }
    }
    if (bubble.context?.fileSelections?.length) {
      for (const fs of bubble.context.fileSelections) {
        if (fs?.uri?.path) pathSegments.push(normalizeFilePath(fs.uri.path))
      }
    }
  }
  const sep = process.platform === 'win32' ? '\\' : '/'
  const folderNameToWorkspaceId: Array<{ name: string; id: string }> = []
  for (const entry of workspaceEntries) {
    try {
      const workspaceData = JSON.parse(readFileSync(entry.workspaceJsonPath, 'utf-8'))
      for (const folder of getWorkspaceFolderPaths(workspaceData)) {
        const name = folder.replace(/^file:\/\//, '').split('/').pop()?.split('\\').pop()
        if (name) folderNameToWorkspaceId.push({ name, id: entry.name })
      }
    } catch (_) {}
  }
  let bestLen = 0
  let bestId: string | null = null
  for (const p of pathSegments) {
    for (const { name, id } of folderNameToWorkspaceId) {
      const needle = sep + name + sep
      const needleEnd = sep + name
      if (p.includes(needle) || p.endsWith(needleEnd)) {
        if (name.length > bestLen) {
          bestLen = name.length
          bestId = id
        }
      }
    }
  }
  if (bestId) return bestId

  return null
}

function normalizeFilePath(filePath: string): string {
  // Remove file:// protocol if present
  let normalized = filePath.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '')
  
  // URL-decode the path (handles %3a -> :, etc.)
  try {
    normalized = decodeURIComponent(normalized)
  } catch (e) {
    // If decode fails, continue with original
  }
  
  // Convert forward slashes to backslashes on Windows
  if (process.platform === 'win32') {
    normalized = normalized.replace(/\//g, '\\')
    // Remove leading backslash if followed by drive letter (e.g., \d:\ -> d:\)
    normalized = normalized.replace(/^\\([a-z]:)/i, '$1')
  }
  
  // Normalize to lowercase for case-insensitive comparison on Windows
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase()
  }
  
  return normalized
}

function getWorkspaceFolderPaths(workspaceData: { folder?: string; folders?: Array<{ path?: string }> }): string[] {
  const paths: string[] = []
  if (workspaceData.folder) paths.push(workspaceData.folder)
  if (Array.isArray(workspaceData.folders)) {
    for (const f of workspaceData.folders) {
      if (f?.path) paths.push(f.path)
    }
  }
  return paths
}

function getProjectFromFilePath(filePath: string, workspaceEntries: Array<{name: string, workspaceJsonPath: string}>): string | null {
  const normalizedPath = normalizeFilePath(filePath)
  let bestMatch: string | null = null
  let bestLen = 0
  for (const entry of workspaceEntries) {
    try {
      const workspaceData = JSON.parse(readFileSync(entry.workspaceJsonPath, 'utf-8'))
      for (const folder of getWorkspaceFolderPaths(workspaceData)) {
        const workspacePath = normalizeFilePath(folder)
        if (normalizedPath.startsWith(workspacePath) && workspacePath.length > bestLen) {
          bestLen = workspacePath.length
          bestMatch = entry.name
        }
      }
    } catch (error) {
      console.error(`Error reading workspace ${entry.name}:`, error)
    }
  }
  return bestMatch
}

function createProjectNameToWorkspaceIdMap(workspaceEntries: Array<{name: string, workspaceJsonPath: string}>): Record<string, string> {
  const projectNameToWorkspaceId: Record<string, string> = {}
  for (const entry of workspaceEntries) {
    try {
      const workspaceData = JSON.parse(readFileSync(entry.workspaceJsonPath, 'utf-8'))
      for (const folder of getWorkspaceFolderPaths(workspaceData)) {
        const workspacePath = folder.replace(/^file:\/\//, '')
        const folderName = workspacePath.split('/').pop() || workspacePath.split('\\').pop()
        if (folderName) projectNameToWorkspaceId[folderName] = entry.name
      }
    } catch (error) {
      console.error(`Error reading workspace ${entry.name}:`, error)
    }
  }
  return projectNameToWorkspaceId
}

function createWorkspacePathToIdMap(workspaceEntries: Array<{name: string, workspaceJsonPath: string}>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of workspaceEntries) {
    try {
      const workspaceData = JSON.parse(readFileSync(entry.workspaceJsonPath, 'utf-8'))
      for (const folder of getWorkspaceFolderPaths(workspaceData)) {
        const normalized = normalizeFilePath(folder)
        out[normalized] = entry.name
      }
    } catch (error) {
      console.error(`Error reading workspace ${entry.name}:`, error)
    }
  }
  return out
}

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  let globalDb: any = null
  
  try {
    const workspacePath = resolveWorkspacePath()
    const globalDbPath = path.join(workspacePath, '..', 'globalStorage', 'state.vscdb')

    const response: { tabs: ChatTab[], composers?: ComposerData } = { tabs: [] }

    // Get all workspace entries for project mapping
    const entries = await fs.readdir(workspacePath, { withFileTypes: true })
    const workspaceEntries: Array<{name: string, workspaceJsonPath: string}> = []
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const workspaceJsonPath = path.join(workspacePath, entry.name, 'workspace.json')
        if (existsSync(workspaceJsonPath)) {
          workspaceEntries.push({ name: entry.name, workspaceJsonPath })
        }
      }
    }
    
    // Create project name to workspace ID mapping
    const projectNameToWorkspaceId = createProjectNameToWorkspaceIdMap(workspaceEntries)
    const workspacePathToId = createWorkspacePathToIdMap(workspaceEntries)

    let bubbleMap: Record<string, any> = {}
    let codeBlockDiffMap: Record<string, any[]> = {}
    let messageRequestContextMap: Record<string, any[]> = {}
    
    if (existsSync(globalDbPath)) {
      globalDb = new Database(globalDbPath, { readonly: true })
      
      // Get all bubbleId entries for the actual message content
      const bubbleRows = globalDb.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").all()
      for (const rowUntyped of bubbleRows) {
        const row = rowUntyped as { key: string, value: string }
        const bubbleId = row.key.split(':')[2]
        try {
          const bubble = JSON.parse(row.value)
          if (bubble && typeof bubble === 'object') {
            bubbleMap[bubbleId] = bubble
          }
        } catch (parseError) {
          console.error('Error parsing bubble:', parseError)
        }
      }
      
      // codeBlockDiff
      const codeBlockDiffRows = globalDb.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'codeBlockDiff:%'").all()
      for (const rowUntyped of codeBlockDiffRows) {
        const row = rowUntyped as { key: string, value: string }
        const chatId = extractChatIdFromCodeBlockDiffKey(row.key)
        if (!chatId) continue
        try {
          const codeBlockDiff = JSON.parse(row.value)
          if (!codeBlockDiffMap[chatId]) codeBlockDiffMap[chatId] = []
          codeBlockDiffMap[chatId].push({
            ...codeBlockDiff,
            diffId: row.key.split(':')[2]
          })
        } catch (parseError) {
          console.error('Error parsing codeBlockDiff:', parseError)
        }
      }
      
      // messageRequestContext
      const messageRequestContextRows = globalDb.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'messageRequestContext:%'").all()
      for (const rowUntyped of messageRequestContextRows) {
        const row = rowUntyped as { key: string, value: string }
        const parts = row.key.split(':')
        if (parts.length >= 3) {
          const chatId = parts[1]
          const contextId = parts[2]
          try {
            const context = JSON.parse(row.value)
            if (!messageRequestContextMap[chatId]) messageRequestContextMap[chatId] = []
            messageRequestContextMap[chatId].push({
              ...context,
              contextId: contextId
            })
          } catch (parseError) {
            console.error('Error parsing messageRequestContext:', parseError)
          }
        }
      }
      
      // Create a map of composerId -> projectLayouts for efficient lookup
      const projectLayoutsMap: Record<string, string[]> = {}
      for (const rowUntyped of messageRequestContextRows) {
        const row = rowUntyped as { key: string, value: string }
        const parts = row.key.split(':')
        if (parts.length >= 2) {
          const composerId = parts[1]
          try {
            const context = JSON.parse(row.value)
            if (context && typeof context === 'object' && context.projectLayouts && Array.isArray(context.projectLayouts)) {
              if (!projectLayoutsMap[composerId]) {
                projectLayoutsMap[composerId] = []
              }
              for (const layout of context.projectLayouts) {
                if (typeof layout === 'string') {
                  try {
                    const layoutObj = JSON.parse(layout)
                    if (layoutObj.rootPath) {
                      projectLayoutsMap[composerId].push(layoutObj.rootPath)
                    }
                  } catch (parseError) {
                    // Skip invalid JSON
                  }
                }
              }
            }
          } catch (parseError) {
            console.error('Error parsing messageRequestContext:', parseError)
          }
        }
      }

      // Get all composerData entries that have conversation data
      const composerRows = globalDb.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND value LIKE '%fullConversationHeadersOnly%' AND value NOT LIKE '%fullConversationHeadersOnly\":[]%'").all()
      
      // Process each composerData entry and check if it belongs to this workspace
      for (const rowUntyped of composerRows) {
        const row = rowUntyped as { key: string, value: string }
        const composerId = row.key.split(':')[1]
        
        try {
          const composerData = JSON.parse(row.value)
          
          // Determine which project this conversation belongs to using unified logic
          const projectId = determineProjectForConversation(
            composerData,
            composerId,
            projectLayoutsMap,
            projectNameToWorkspaceId,
            workspacePathToId,
            workspaceEntries,
            bubbleMap
          )
          const assignedProjectId = projectId ?? 'global'

          // Only process conversations that belong to this specific workspace
          if (assignedProjectId !== params.id) {
            continue
          }
          
          console.log(`Processing workspace conversation ${composerId}: ${composerData.name || 'Untitled'}`)
          
          // Get the conversation headers to understand the structure
          const conversationHeaders = composerData.fullConversationHeadersOnly || []
          
          // Build the conversation from the headers and bubble content
          const bubbles: ChatBubble[] = []
          for (const header of conversationHeaders) {
            const bubbleId = header.bubbleId
            const bubble = bubbleMap ? bubbleMap[bubbleId] : null
            
            if (bubble) {
              // Determine if this is a user or AI message
              const isUser = header.type === 1
              const messageType = isUser ? 'user' : 'ai'
              
              // Extract the actual text content
              const text = extractTextFromBubble(bubble)
              
              // Add messageRequestContext data if available
              let contextText = ''
              const messageContexts = messageRequestContextMap[composerId] || []
              for (const context of messageContexts) {
                if (context.bubbleId === bubbleId) {
                  // Add git status if available
                  if (context.gitStatusRaw) {
                    contextText += `\n\n**Git Status:**\n\`\`\`\n${context.gitStatusRaw}\n\`\`\``
                  }
                  
                  // Add terminal files if available
                  if (context.terminalFiles && context.terminalFiles.length > 0) {
                    contextText += `\n\n**Terminal Files:**`
                    for (const file of context.terminalFiles) {
                      contextText += `\n- ${file.path}`
                    }
                  }
                  
                  // Add attached folders if available
                  if (context.attachedFoldersListDirResults && context.attachedFoldersListDirResults.length > 0) {
                    contextText += `\n\n**Attached Folders:**`
                    for (const folder of context.attachedFoldersListDirResults) {
                      if (folder.files && folder.files.length > 0) {
                        contextText += `\n\n**Folder:** ${folder.path || 'Unknown'}`
                        for (const file of folder.files) {
                          contextText += `\n- ${file.name} (${file.type})`
                        }
                      }
                    }
                  }
                  
                  // Add cursor rules if available
                  if (context.cursorRules && context.cursorRules.length > 0) {
                    contextText += `\n\n**Cursor Rules:**`
                    for (const rule of context.cursorRules) {
                      contextText += `\n- ${rule.name || rule.description || 'Rule'}`
                    }
                  }
                  
                  // Add summarized composers if available
                  if (context.summarizedComposers && context.summarizedComposers.length > 0) {
                    contextText += `\n\n**Related Conversations:**`
                    for (const composer of context.summarizedComposers) {
                      contextText += `\n- ${composer.name || composer.composerId || 'Conversation'}`
                    }
                  }
                }
              }
              
              // Combine text and context
              const fullText = text + contextText
              
              const raw = bubble as any
              const tokenCount = raw?.tokenCount

              // Extract tool calls from toolFormerData
              let toolCalls: ToolCall[] | undefined
              if (raw.toolFormerData && typeof raw.toolFormerData === 'object') {
                const tfd = raw.toolFormerData
                toolCalls = [{
                  name: tfd.name,
                  params: typeof tfd.params === 'string' ? tfd.params : (tfd.rawArgs || undefined),
                  result: typeof tfd.result === 'string' ? tfd.result?.slice(0, 500) : undefined,
                  status: tfd.status
                }]
              }

              // Extract thinking blocks
              let thinking: string | undefined
              let thinkingDurationMs: number | undefined
              if (raw.thinking) {
                thinking = typeof raw.thinking === 'string' ? raw.thinking : raw.thinking?.text
                thinkingDurationMs = raw.thinkingDurationMs
              }

              // Include bubble if it has text, tool calls, or thinking
              const hasContent = fullText.trim() || toolCalls || thinking

              if (hasContent) {
                // Extract context window status
                const ctxWindow = raw.contextWindowStatusAtCreation
                const contextWindowPercent = ctxWindow?.percentageRemainingFloat ?? ctxWindow?.percentageRemaining

                // Build display text for tool call bubbles without text
                let displayText = fullText.trim()
                if (!displayText && toolCalls) {
                  const tc = toolCalls[0]
                  displayText = `**Tool: ${tc.name || 'unknown'}**`
                  if (tc.status) displayText += ` (${tc.status})`
                }
                if (!displayText && thinking) {
                  displayText = thinking.slice(0, 200) + (thinking.length > 200 ? '...' : '')
                }

                const bubbleMeta = (messageType === 'ai' && bubble) ? {
                  modelName: raw.modelInfo?.modelName,
                  inputTokens: tokenCount?.inputTokens,
                  outputTokens: tokenCount?.outputTokens,
                  cachedTokens: tokenCount?.cachedTokens,
                  toolResultsCount: toolCalls?.length ?? (Array.isArray(raw.toolResults) ? raw.toolResults.length : undefined),
                  toolResults: Array.isArray(raw.toolResults) && raw.toolResults.length > 0 ? raw.toolResults : undefined,
                  toolCalls,
                  thinking,
                  thinkingDurationMs,
                  cost: typeof raw.cost === 'number' ? raw.cost : (raw.usageData?.cost ?? raw.usageData?.estimatedCost),
                  contextWindowPercent
                } : undefined
                const hasMeta = bubbleMeta && (bubbleMeta.modelName ?? bubbleMeta.inputTokens ?? bubbleMeta.outputTokens ?? bubbleMeta.cachedTokens ?? bubbleMeta.toolResultsCount ?? bubbleMeta.toolCalls ?? bubbleMeta.thinking ?? bubbleMeta.cost != null)
                bubbles.push({
                  type: messageType,
                  text: displayText,
                  timestamp: bubble.createdAt || bubble.timestamp || Date.now(),
                  ...(hasMeta && { metadata: bubbleMeta })
                })
              }
            }
          }
          
          if (bubbles.length > 0) {
            // Generate a title from the composer name or first message
            let title = composerData.name || `Conversation ${composerId.slice(0, 8)}`
            if (!composerData.name && bubbles.length > 0) {
              const firstMessage = bubbles[0].text
              if (firstMessage) {
                const firstLines = firstMessage.split('\n').filter((line: string) => line.trim().length > 0)
                if (firstLines.length > 0) {
                  title = firstLines[0].substring(0, 100)
                  if (title.length === 100) title += '...'
                }
              }
            }
            
            // Get codeBlockDiffs for this conversation and add them as separate bubbles
            const codeBlockDiffs = codeBlockDiffMap[composerId] || []
            for (const diff of codeBlockDiffs) {
              const diffText = formatToolAction(diff)
              if (diffText.trim()) {
                bubbles.push({
                  type: 'ai',
                  text: `**Tool Action:**${diffText}`,
                  timestamp: Date.now()
                })
              }
            }
            
            bubbles.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))

            // Response time = ms since previous user message
            let lastUserTimestamp: number | null = null
            for (const b of bubbles) {
              if (b.type === 'user') {
                lastUserTimestamp = b.timestamp ?? null
              } else if (b.type === 'ai' && lastUserTimestamp != null && b.timestamp != null && b.timestamp > lastUserTimestamp) {
                const responseTimeMs = b.timestamp - lastUserTimestamp
                if (!b.metadata) b.metadata = {}
                b.metadata.responseTimeMs = responseTimeMs
              }
            }

            let totalInput = 0
            let totalOutput = 0
            let totalCached = 0
            let totalResponseTimeMs = 0
            let totalCost = 0
            let totalToolCalls = 0
            let totalThinkingDurationMs = 0
            const modelsSet = new Set<string>()
            for (const b of bubbles) {
              const m = b.metadata
              if (m?.inputTokens != null) totalInput += m.inputTokens
              if (m?.outputTokens != null) totalOutput += m.outputTokens
              if (m?.cachedTokens != null) totalCached += m.cachedTokens
              if (m?.responseTimeMs != null) totalResponseTimeMs += m.responseTimeMs
              if (m?.cost != null) totalCost += m.cost
              if (m?.modelName) modelsSet.add(m.modelName)
              if (m?.toolCalls?.length) totalToolCalls += m.toolCalls.length
              if (m?.thinkingDurationMs != null) totalThinkingDurationMs += m.thinkingDurationMs
            }
            const usageData = composerData?.usageData as { cost?: number; estimatedCost?: number } | undefined
            const composerCost = typeof usageData?.cost === 'number' ? usageData.cost : (typeof usageData?.estimatedCost === 'number' ? usageData.estimatedCost : undefined)
            if (composerCost != null && totalCost === 0) totalCost = composerCost
            const tabMetadata = (totalInput > 0 || totalOutput > 0 || totalCached > 0 || totalResponseTimeMs > 0 || totalCost > 0 || modelsSet.size > 0 || totalToolCalls > 0 || totalThinkingDurationMs > 0)
              ? {
                  totalInputTokens: totalInput || undefined,
                  totalOutputTokens: totalOutput || undefined,
                  totalCachedTokens: totalCached || undefined,
                  modelsUsed: modelsSet.size > 0 ? Array.from(modelsSet) : undefined,
                  totalResponseTimeMs: totalResponseTimeMs || undefined,
                  totalCost: totalCost > 0 ? totalCost : undefined,
                  totalToolCalls: totalToolCalls || undefined,
                  totalThinkingDurationMs: totalThinkingDurationMs || undefined
                }
              : undefined
            
            response.tabs.push({
              id: composerId,
              title,
              timestamp: new Date(composerData.lastUpdatedAt || composerData.createdAt).getTime(),
              bubbles: bubbles.map(bubble => ({
                type: bubble.type,
                text: bubble.text || '',
                timestamp: bubble.timestamp,
                ...(bubble.metadata && { metadata: bubble.metadata })
              })),
              codeBlockDiffs: codeBlockDiffs,
              ...(tabMetadata && { metadata: tabMetadata })
            })
          }
          
        } catch (parseError) {
          console.error(`Error parsing composer data for ${composerId}:`, parseError)
        }
      }
      
      console.log(`Returning ${response.tabs.length} conversations for workspace ${params.id}`)
    } else {
      return NextResponse.json({ error: 'Global storage not found' }, { status: 404 })
    }

    if (globalDb) {
      globalDb.close()
    }
    
    return NextResponse.json(response)
  } catch (error) {
    console.error('Failed to get workspace tabs:', error)
    if (globalDb) {
      globalDb.close()
    }
    return NextResponse.json({ error: 'Failed to get workspace tabs' }, { status: 500 })
  }
}
