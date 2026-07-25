import { describe, expect, it } from 'vitest'
import {
  composerReferencesToUserFileReferences,
  composerToolReferencePlaceholder,
  stripTransientAttachmentFields
} from './workbench-composer-prompts'

describe('workbench composer prompt helpers', () => {
  it('maps composer file references to the Kun request contract', () => {
    expect(composerReferencesToUserFileReferences([
      {
        path: '/repo/src/renderer/App.tsx',
        relativePath: 'src/renderer/App.tsx',
        name: 'App.tsx',
        type: 'file'
      },
      {
        path: '/repo/src/renderer',
        relativePath: 'src/renderer',
        name: 'renderer',
        type: 'directory'
      }
    ])).toEqual([
      {
        path: '/repo/src/renderer/App.tsx',
        relativePath: 'src/renderer/App.tsx',
        name: 'App.tsx',
        kind: 'file'
      },
      {
        path: '/repo/src/renderer',
        relativePath: 'src/renderer',
        name: 'renderer',
        kind: 'directory'
      }
    ])
  })

  it('keeps document identity metadata but strips transient semantic and visual preview payloads', () => {
    expect(stripTransientAttachmentFields([{
      id: 'att_office',
      kind: 'document',
      name: 'book.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      documentFormat: 'xlsx',
      sourceSha256: 'a'.repeat(64),
      documentText: 'Sheet1 A1=42',
      previewUrl: 'data:image/webp;base64,cHJldmlldw==',
      previewUnavailableReason: 'none'
    }])).toEqual([{
      id: 'att_office',
      kind: 'document',
      name: 'book.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      documentFormat: 'xlsx',
      sourceSha256: 'a'.repeat(64)
    }])
  })

  it('keeps Office and unknown binary references tool-readable instead of embedding binary text', () => {
    expect(composerToolReferencePlaceholder(
      { path: '/workspace/book.xlsx' },
      'xlsx'
    )).toContain('Use office_inspect')
    expect(composerToolReferencePlaceholder(
      { path: '/workspace/archive.bin' }
    )).toContain('Use a suitable file tool')
  })
})
