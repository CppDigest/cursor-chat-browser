import { NextResponse } from 'next/server'
import { marked } from 'marked'
import DOMPurify from 'isomorphic-dompurify'
import pdfMake from 'pdfmake/build/pdfmake'
import pdfFonts from 'pdfmake/build/vfs_fonts'

// Initialize pdfmake with fonts
pdfMake.vfs = pdfFonts.pdfMake.vfs

export async function POST(request: Request) {
  try {
    const { markdown, title } = await request.json()
    
    // Parse markdown to get structured content
    const tokens = marked.lexer(markdown)
    
    // Convert tokens to pdfmake content
    const content: any[] = [
      { text: title, style: 'header' },
      { text: '\n' }
    ]

    tokens.forEach(token => {
      if (token.type === 'heading') {
        content.push({
          text: token.text,
          style: `heading${token.depth}`,
          margin: [0, 10, 0, 5] as [number, number, number, number]
        })
      } 
      else if (token.type === 'code') {
        const lines = token.text.split('\n')
        const lineHeight = 15 // Height per line
        const padding = 20 // Padding top and bottom
        const totalHeight = (lines.length * lineHeight) + (padding * 2) // Account for padding

        content.push({
          stack: [
            {
              canvas: [
                {
                  type: 'rect',
                  x: 0,
                  y: 0,
                  w: 515,
                  h: totalHeight,
                  color: '#1e1e1e'
                }
              ]
            },
            {
              text: token.text,
              style: 'code',
              margin: [10, -totalHeight + padding, 10, padding] as [number, number, number, number]
            }
          ],
          margin: [0, 10, 0, 10] as [number, number, number, number]
        })
      }
      else if (token.type === 'list') {
        const items = token.items.map((item: any) => ({
          text: item.text,
          margin: [0, 2, 0, 2] as [number, number, number, number]
        }))
        content.push({
          ul: items,
          margin: [10, 5, 0, 5] as [number, number, number, number]
        })
      }
      else if (token.type === 'paragraph') {
        // Handle inline code and terminal output placeholder
        const parts = token.text.split(/(`[^`]+`|\[TERMINAL OUTPUT NOT INCLUDED\])/).map((part: string, index: number) => {
          if (part.startsWith('`') && part.endsWith('`')) {
            return {
              text: part.slice(1, -1),
              style: 'inlineCode',
              background: '#1e1e1e',
              color: '#d4d4d4'
            }
          }
          if (part === '[TERMINAL OUTPUT NOT INCLUDED]') {
            return {
              text: part,
              style: 'placeholder',
              italics: true
            }
          }
          return part
        })

        content.push({
          text: parts,
          margin: [0, 5, 0, 5] as [number, number, number, number]
        })
      }
      else if (token.type === 'hr') {
        content.push({
          canvas: [{ type: 'line', x1: 0, y1: 5, x2: 515, y2: 5, lineWidth: 1 }],
          margin: [0, 10, 0, 10] as [number, number, number, number]
        })
      }
    })

    const docDefinition = {
      content,
      defaultStyle: {
        font: 'Roboto'
      },
      styles: {
        header: {
          fontSize: 24,
          bold: true,
          font: 'Roboto',
          margin: [0, 0, 0, 20] as [number, number, number, number]
        },
        heading1: {
          fontSize: 20,
          bold: true,
          font: 'Roboto',
          color: '#2563eb'
        },
        heading2: {
          fontSize: 18,
          bold: true,
          font: 'Roboto',
          color: '#3b82f6'
        },
        heading3: {
          fontSize: 16,
          bold: true,
          font: 'Roboto',
          color: '#60a5fa'
        },
        code: {
          font: 'Roboto',
          fontSize: 10,
          color: '#d4d4d4',
          lineHeight: 1.5,
          preserveLeadingSpaces: true
        },
        inlineCode: {
          font: 'Roboto',
          fontSize: 10,
          background: '#1e1e1e',
          color: '#d4d4d4',
          padding: [2, 1, 2, 1] as [number, number, number, number]
        },
        placeholder: {
          color: '#666666',
          fontSize: 12
        }
      },
      pageMargins: [40, 60, 40, 60] as [number, number, number, number]
    }

    // Generate PDF
    const pdfDoc = pdfMake.createPdf(docDefinition)
    
    return new Promise<NextResponse>((resolve) => {
      pdfDoc.getBuffer((buffer) => {
        resolve(new NextResponse(buffer, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${title}.pdf"`
          }
        }))
      })
    })
  } catch (error) {
    console.error('Failed to generate PDF:', error)
    return NextResponse.json({ error: 'Failed to generate PDF' }, { status: 500 })
  }
} 