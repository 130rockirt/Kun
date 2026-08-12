import { access } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import * as xlsx from 'xlsx'
import type { WorkspaceOfficePreviewSuccess } from '../../shared/office-document'
import { readWorkspaceOfficeSemantic } from './office-workspace-semantic-service'

function workbookPreview(): WorkspaceOfficePreviewSuccess {
  const workbook = xlsx.utils.book_new()
  const sheet = xlsx.utils.aoa_to_sheet([
    ['项目', '金额'],
    ['研发', 12],
    ['总计', { t: 'n', v: 12, f: 'SUM(B2:B2)', w: '12' }]
  ])
  xlsx.utils.book_append_sheet(workbook, sheet, '预算 2026')
  return {
    ok: true,
    path: '/tmp/workspace/budget.xlsx',
    name: 'budget.xlsx',
    sourceFormat: 'xlsx',
    renderFormat: 'xlsx',
    viewer: 'spreadsheet',
    size: 123,
    mtimeMs: 1,
    sourceSha256: 'a'.repeat(64),
    data: new Uint8Array(xlsx.write(workbook, { type: 'array', bookType: 'xlsx' }))
  }
}

describe('readWorkspaceOfficeSemantic', () => {
  it('extracts sparse formatted spreadsheet cells and formula annotations without OfficeCLI', async () => {
    const preview = workbookPreview()
    const readPreview = vi.fn(async () => preview)

    const result = await readWorkspaceOfficeSemantic({ path: preview.path }, { readPreview })

    expect(result).toMatchObject({
      ok: true,
      sourceFormat: 'xlsx',
      sourceSha256: preview.sourceSha256,
      truncated: false
    })
    expect(result.ok && result.text).toContain('[Worksheet] 预算 2026')
    expect(result.ok && result.text).toContain('A2 = 研发')
    expect(result.ok && result.text).toContain('B3 = 12 [formula: =SUM(B2:B2)]')
  })

  it('uses a private converted snapshot for legacy Word semantics and removes it afterward', async () => {
    let snapshotPath = ''
    const readPreview = vi.fn(async (): Promise<WorkspaceOfficePreviewSuccess> => ({
      ok: true,
      path: '/tmp/workspace/legacy.doc',
      name: 'legacy.doc',
      sourceFormat: 'doc',
      renderFormat: 'docx',
      viewer: 'word',
      size: 321,
      mtimeMs: 2,
      sourceSha256: 'b'.repeat(64),
      data: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      convertedFromLegacy: true
    }))
    const runOfficeCli = vi.fn(async (args: string[]) => {
      snapshotPath = args[1] ?? ''
      return { stdout: 'Heading\nConverted body', stderr: '', exitCode: 0 }
    })

    const result = await readWorkspaceOfficeSemantic(
      { path: '/tmp/workspace/legacy.doc' },
      { readPreview, runOfficeCli }
    )

    expect(result).toMatchObject({ ok: true, sourceFormat: 'doc', text: 'Heading\nConverted body' })
    expect(runOfficeCli).toHaveBeenCalledWith(['view', expect.stringMatching(/\.docx$/), 'annotated'])
    await expect(access(snapshotPath)).rejects.toThrow()
  })

  it('returns an actionable error when non-spreadsheet semantics lack OfficeCLI', async () => {
    const readPreview = vi.fn(async (): Promise<WorkspaceOfficePreviewSuccess> => ({
      ...workbookPreview(),
      sourceFormat: 'pptx',
      renderFormat: 'pptx',
      viewer: 'presentation'
    }))

    await expect(readWorkspaceOfficeSemantic(
      { path: '/tmp/workspace/slides.pptx' },
      { readPreview }
    )).resolves.toMatchObject({ ok: false, code: 'officecli_unavailable' })
  })
})
