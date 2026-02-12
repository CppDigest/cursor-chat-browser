"use client"

import { useState } from "react"
import { WorkspaceList } from "@/components/workspace-list"
import { Button } from "@/components/ui/button"
import { Download } from "lucide-react"
import JSZip from "jszip"

async function extractZipToDir(zipBlob: Blob, dirHandle: FileSystemDirectoryHandle) {
  const zip = await JSZip.loadAsync(zipBlob)
  for (const [name, entry] of Object.entries(zip.files)) {
    const parts = name.replace(/\/$/, "").split("/").filter(Boolean)
    if (entry.dir) {
      let current = dirHandle
      for (const part of parts) {
        current = await current.getDirectoryHandle(part, { create: true })
      }
    } else {
      const fileName = parts.pop()!
      let current = dirHandle
      for (const part of parts) {
        current = await current.getDirectoryHandle(part, { create: true })
      }
      const content = await entry.async("blob")
      const file = await current.getFileHandle(fileName, { create: true })
      const writable = await file.createWritable()
      await writable.write(content)
      await writable.close()
    }
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

export default function Home() {
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<string | null>(null)

  const runExport = async (since: "all" | "last") => {
    setExporting(true)
    setExportMsg(null)
    try {
      let dirHandle: FileSystemDirectoryHandle | null = null
      if ("showDirectoryPicker" in window) {
        try {
          dirHandle = await (window as Window & { showDirectoryPicker: (opts?: { mode?: string }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: "readwrite" })
        } catch (e) {
          if ((e as Error).name === "AbortError") {
            setExporting(false)
            return
          }
          throw e
        }
      }

      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ since, zip: true })
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Export failed")
      }

      const blob = await res.blob()
      const countMatch = res.headers.get("x-export-count")
      const count = countMatch ? parseInt(countMatch, 10) : 0

      if (dirHandle) {
        await extractZipToDir(blob, dirHandle)
        setExportMsg(`Exported ${count} chat(s) to the selected folder`)
      } else {
        downloadBlob(blob, `cursor-export-${new Date().toISOString().slice(0, 10)}.zip`)
        setExportMsg(`Exported ${count} chat(s). Zip downloaded (Save to folder not supported in this browser)`)
      }
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