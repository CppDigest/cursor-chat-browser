import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Download } from "lucide-react"
import { ChatTab } from "@/types/workspace"
import { downloadMarkdown, downloadPDF, downloadHTML, downloadJson, downloadCsv, downloadCsvCodeEdits } from "@/lib/download"

interface DownloadMenuProps {
  tab: ChatTab
}

export function DownloadMenu({ tab }: DownloadMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Download className="w-4 h-4 mr-2" />
          Download
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => downloadMarkdown(tab)}>
          Download as Markdown
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => downloadHTML(tab)}>
          Download as HTML
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => downloadPDF(tab)}>
          Download as PDF
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => downloadJson(tab)}>
          Download as JSON
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => downloadCsv(tab)}>
          Download as CSV
        </DropdownMenuItem>
        {tab.codeBlockDiffs?.length ? (
          <DropdownMenuItem onClick={() => downloadCsvCodeEdits(tab)}>
            Download code edits (CSV)
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
} 