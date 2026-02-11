import { NextResponse } from 'next/server'
import { spawn } from 'child_process'
import path from 'path'

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const since = body.since === 'last' ? 'last' : 'all'
    const outDir = body.outDir || './export'

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
    return NextResponse.json({ success: true, count, message: stdout.trim() })
  } catch (error) {
    console.error('Export error:', error)
    return NextResponse.json({ error: 'Export failed' }, { status: 500 })
  }
}
