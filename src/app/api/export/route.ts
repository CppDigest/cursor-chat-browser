import { NextResponse } from 'next/server'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import archiver from 'archiver'

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const since = body.since === 'last' ? 'last' : 'all'
    const wantZip = body.zip === true

    const outDir = wantZip
      ? path.join(os.tmpdir(), `cursor-export-${Date.now()}`)
      : (body.outDir || './export')

    const scriptPath = path.join(process.cwd(), 'scripts', 'export.js')
    const args = ['--since', since, '--out', outDir]
    if (body.includeComposer) args.push('--include-composer')

    const proc = spawn('node', [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d) => { stdout += d.toString() })
    proc.stderr?.on('data', (d) => { stderr += d.toString() })

    const code = await new Promise<number>((resolve) => {
      proc.on('close', resolve)
    })

    if (code !== 0) {
      return NextResponse.json(
        { error: 'Export failed', stderr: stderr || stdout },
        { status: 500 }
      )
    }

    const match = stdout.match(/Exported (\d+) chat/)
    const count = match ? parseInt(match[1], 10) : 0

    if (wantZip) {
      const archive = archiver('zip', { zlib: { level: 9 } })
      const chunks: Buffer[] = []
      archive.on('data', (chunk: Buffer) => chunks.push(chunk))
      const archiveDone = new Promise<void>((resolve, reject) => {
        archive.on('end', () => resolve())
        archive.on('error', reject)
      })
      archive.directory(outDir, false)
      archive.finalize()
      await archiveDone

      try {
        fs.rmSync(outDir, { recursive: true, force: true })
      } catch {}

      const zipBuffer = Buffer.concat(chunks)
      const filename = `cursor-export-${new Date().toISOString().slice(0, 10)}.zip`
      const res = new NextResponse(zipBuffer, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': String(zipBuffer.length),
          'X-Export-Count': String(count)
        }
      })
      return res
    }

    return NextResponse.json({ success: true, count, message: stdout.trim() })
  } catch (error) {
    console.error('Export error:', error)
    return NextResponse.json({ error: 'Export failed' }, { status: 500 })
  }
}
