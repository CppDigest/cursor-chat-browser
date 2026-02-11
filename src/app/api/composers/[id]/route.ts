import { NextResponse } from 'next/server'
import path from 'path'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import Database from 'better-sqlite3'
import { ComposerChat, ComposerData } from '@/types/workspace'
import { resolveWorkspacePath } from '@/utils/workspace-path'

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const workspacePath = resolveWorkspacePath()
    const entries = await fs.readdir(workspacePath, { withFileTypes: true })
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dbPath = path.join(workspacePath, entry.name, 'state.vscdb')
        
        if (!existsSync(dbPath)) continue
        
        const db = new Database(dbPath, { readonly: true })
        const result = db.prepare(`
          SELECT value FROM ItemTable 
          WHERE [key] = 'composer.composerData'
        `).get()
        db.close()
        
        if (result && (result as any).value) {
          const composerData = JSON.parse((result as any).value) as ComposerData
          const composer = composerData.allComposers.find(
            (c: ComposerChat) => c.composerId === params.id
          )
          if (composer) {
            return NextResponse.json(composer)
          }
        }
      }
    }

    // Fallback: global storage (unmatched chats)
    const globalDbPath = path.join(workspacePath, '..', 'globalStorage', 'state.vscdb')
    if (existsSync(globalDbPath)) {
      const db = new Database(globalDbPath, { readonly: true })
      const row = db.prepare(
        "SELECT value FROM cursorDiskKV WHERE key = ?"
      ).get(`composerData:${params.id}`) as { value: string | Buffer } | undefined
      db.close()
      if (row?.value) {
        const raw = typeof row.value === 'string' ? row.value : (row.value as Buffer).toString('utf8')
        const composer = JSON.parse(raw) as Record<string, unknown>
        return NextResponse.json({
          ...composer,
          conversation: composer.conversation ?? []
        })
      }
    }

    return NextResponse.json(
      { error: 'Composer not found' },
      { status: 404 }
    )
  } catch (error) {
    console.error('Failed to get composer:', error)
    return NextResponse.json(
      { error: 'Failed to get composer' },
      { status: 500 }
    )
  }
} 