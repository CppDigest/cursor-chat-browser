import { readFileSync, existsSync } from 'fs'
import { statSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { NextResponse } from 'next/server'
import Database from 'better-sqlite3'
import { resolveWorkspacePath } from '@/utils/workspace-path'

interface Project {
  id: string;
  name: string;
  path?: string;
  conversationCount: number;
  lastModified: string;
}

interface ConversationData {
  composerId: string;
  name: string;
  newlyCreatedFiles: Array<{uri: {path: string}}>;
  lastUpdatedAt: number;
  createdAt: number;
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

function determineProjectForConversation(
  composerData: any,
  composerId: string,
  projectLayoutsMap: Record<string, string[]>,
  projectNameToWorkspaceId: Record<string, string>,
  workspacePathToId: Record<string, string>,
  workspaceEntries: Array<{name: string, workspaceJsonPath: string}>,
  bubbleMap: Record<string, any>,
  composerIdToWorkspaceId?: Record<string, string>
): string | null {
  // Primary: check the definitive per-workspace composer.composerData mapping
  if (composerIdToWorkspaceId && composerIdToWorkspaceId[composerId]) {
    return composerIdToWorkspaceId[composerId]
  }
  
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
  
  // If no project found from projectLayouts, try file-based detection (fallback)
  // Check newlyCreatedFiles first
  if (composerData.newlyCreatedFiles && composerData.newlyCreatedFiles.length > 0) {
    for (const file of composerData.newlyCreatedFiles) {
      if (file.uri && file.uri.path) {
        const projectId = getProjectFromFilePath(file.uri.path, workspaceEntries)
        if (projectId) return projectId
      }
    }
  }
  
  // Check codeBlockData
  if (composerData.codeBlockData) {
    for (const filePath of Object.keys(composerData.codeBlockData)) {
      const normalizedPath = filePath.replace('file://', '')
      const projectId = getProjectFromFilePath(normalizedPath, workspaceEntries)
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
      for (const fileSelection of bubble.context.fileSelections) {
        if (fileSelection?.uri?.path) {
          const projectId = getProjectFromFilePath(fileSelection.uri.path, workspaceEntries)
          if (projectId) return projectId
        }
      }
    }
  }

  // Fallback: path contains workspace folder name as path segment (handles different path formats)
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
  let bestId: string | null = null
  let bestLen = 0
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

export async function GET() {
  try {
    const workspacePath = resolveWorkspacePath()
    const projects: Project[] = []
    
    // Get all workspace entries first
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
    
    const projectNameToWorkspaceId = createProjectNameToWorkspaceIdMap(workspaceEntries)
    const workspacePathToId = createWorkspacePathToIdMap(workspaceEntries)
    
    // Build a definitive composerId -> workspaceId map from per-workspace composer.composerData
    // This is the most reliable mapping since Cursor stores which composers belong to each workspace
    const composerIdToWorkspaceId: Record<string, string> = {}
    for (const entry of workspaceEntries) {
      const dbPath = path.join(workspacePath, entry.name, 'state.vscdb')
      if (!existsSync(dbPath)) continue
      try {
        const wsDb = new Database(dbPath, { readonly: true })
        const composerRow = wsDb.prepare(`SELECT value FROM ItemTable WHERE [key] = 'composer.composerData'`).get() as { value: string } | undefined
        if (composerRow?.value) {
          const composerData = JSON.parse(composerRow.value)
          if (composerData.allComposers && Array.isArray(composerData.allComposers)) {
            for (const composer of composerData.allComposers) {
              if (composer.composerId) {
                composerIdToWorkspaceId[composer.composerId] = entry.name
              }
            }
          }
        }
        wsDb.close()
      } catch (error) {
        // Skip workspaces with errors
      }
    }
    
    // Initialize conversation map - only count from global storage
    const conversationMap: Record<string, ConversationData[]> = {}
    
    // Get conversations from global storage only
    const globalDbPath = path.join(workspacePath, '..', 'globalStorage', 'state.vscdb')
    
    if (existsSync(globalDbPath)) {
      try {
        const globalDb = new Database(globalDbPath, { readonly: true })
        
        // Get all composerData entries (both old and new structure)
        const composerRows = globalDb.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND LENGTH(value) > 10").all()
        
        // Get all messageRequestContext entries for project assignment
        const messageContextRows = globalDb.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'messageRequestContext:%'").all()
        
        // Create a map of composerId -> projectLayouts for efficient lookup
        const projectLayoutsMap: Record<string, string[]> = {}
        for (const rowUntyped of messageContextRows) {
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
                        console.log(`Found rootPath for composer ${composerId}: ${layoutObj.rootPath}`)
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
        
        // Get all bubbleId entries for file reference detection (fallback)
        const bubbleRows = globalDb.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").all()
        
        // Create a map of bubbleId -> bubble content for efficient lookup
        const bubbleMap: Record<string, any> = {}
        for (const rowUntyped of bubbleRows) {
          const row = rowUntyped as { key: string, value: string }
          const bubbleId = row.key.split(':')[2]
          try {
            const bubble = JSON.parse(row.value)
            // Only store valid bubble objects
            if (bubble && typeof bubble === 'object') {
              bubbleMap[bubbleId] = bubble
            }
          } catch (parseError) {
            console.error('Error parsing bubble for project detection:', parseError)
          }
        }
        
        // Process each composer and assign to correct project
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
              bubbleMap,
              composerIdToWorkspaceId
            )
            
            const assignedProjectId = projectId ?? 'global'
            if (!projectId) {
              console.log(`Assigning composer ${composerId} (${composerData.name || 'Untitled'}) to Other chats`)
            } else {
              console.log(`Matched composer ${composerId} (${composerData.name || 'Untitled'}) to project ${projectId}`)
            }
            
            // Only count conversations that have at least one bubble with data
            const headers = composerData.fullConversationHeadersOnly || []
            const hasBubbles = headers.some((h: { bubbleId: string }) => bubbleMap[h.bubbleId])
            if (!hasBubbles) continue

            // Add to conversation map
            if (!conversationMap[assignedProjectId]) {
              conversationMap[assignedProjectId] = []
            }
            conversationMap[assignedProjectId].push({
              composerId,
              name: composerData.name || `Conversation ${composerId.slice(0, 8)}`,
              newlyCreatedFiles: composerData.newlyCreatedFiles || [],
              lastUpdatedAt: composerData.lastUpdatedAt || composerData.createdAt,
              createdAt: composerData.createdAt
            })
            
          } catch (parseError) {
            console.error(`Error parsing composer data for ${composerId}:`, parseError)
          }
        }
        
        globalDb.close()
      } catch (error) {
        console.error('Error reading global storage:', error)
      }
    }
    
    // Create projects with their conversation counts
    for (const entry of workspaceEntries) {
      const dbPath = path.join(workspacePath, entry.name, 'state.vscdb')
      const stats = await fs.stat(dbPath)
      
      let workspaceName = `Project ${entry.name.slice(0, 8)}`
      try {
        const workspaceData = JSON.parse(await fs.readFile(entry.workspaceJsonPath, 'utf-8'))
        const firstFolder = workspaceData.folder || workspaceData.folders?.[0]?.path
        if (firstFolder) {
          const folderName = firstFolder.split('/').pop() || firstFolder.split('\\').pop()
          workspaceName = folderName || workspaceName
        }
      } catch (error) {
        console.log(`No workspace.json found for ${entry.name}`)
      }
      
      // Count conversations for this project from the unified map only
      const conversations = conversationMap[entry.name] || []
      const conversationCount = conversations.length
      
      // Show all projects, even those with 0 conversations
      projects.push({
        id: entry.name,
        name: workspaceName,
        path: entry.workspaceJsonPath,
        conversationCount: conversationCount,
        lastModified: stats.mtime.toISOString()
      })
    }

    const globalConversations = conversationMap['global'] || []
    if (globalConversations.length > 0) {
      const lastUpdated = Math.max(...globalConversations.map((c) => c.lastUpdatedAt || 0), 0)
      projects.push({
        id: 'global',
        name: 'Other chats',
        path: undefined,
        conversationCount: globalConversations.length,
        lastModified: lastUpdated > 0 ? new Date(lastUpdated).toISOString() : new Date().toISOString()
      })
    }
    
    // Sort by last modified, newest first
    projects.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime())
    
    return NextResponse.json(projects)
  } catch (error) {
    console.error('Failed to get workspaces:', error)
    return NextResponse.json({ error: 'Failed to get workspaces' }, { status: 500 })
  }
} 