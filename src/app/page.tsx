"use client"

import { useState } from "react"
import { WorkspaceList } from "@/components/workspace-list"
import { Button } from "@/components/ui/button"
import { Download } from "lucide-react"

export default function Home() {
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<string | null>(null)

  const runExport = async (since: 'all' | 'last') => {
    setExporting(true)
    setExportMsg(null)
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ since })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Export failed')
      setExportMsg(data.message || `Exported ${data.count} chat(s)`)
    } catch (e) {
      setExportMsg(String(e instanceof Error ? e.message : e))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-4xl font-bold mb-4">Projects</h1>
          <p className="text-muted-foreground">
            Browse your Cursor chat conversations by project. Click on a project to view its conversations.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => runExport('all')}
            disabled={exporting}
          >
            <Download className="w-4 h-4 mr-2" />
            Export all
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => runExport('last')}
            disabled={exporting}
          >
            Export new since last
          </Button>
        </div>
      </div>
      {exportMsg && (
        <p className="text-sm text-muted-foreground mb-4">{exportMsg}</p>
      )}
      <WorkspaceList />
    </div>
  )
} 