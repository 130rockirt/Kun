import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PptGeometryQaReportV1,
  createPptGeometryQaReport,
  pptGeometryQaReportPath,
  readPptGeometryQaReport,
  writePptGeometryQaReport,
  type PptGeometryQaIssueDraft
} from './ppt-geometry-qa-report.js'

const roots: string[] = []

function draft(shapeId: string, severity: 'error' | 'warning' = 'error'): PptGeometryQaIssueDraft {
  return {
    rule: 'bounds.out_of_slide',
    severity,
    slideIndex: 0,
    shapeId,
    rect: { x: 0.8, y: 0.2, width: 0.2, height: 0.4 },
    message: `${shapeId} extends outside`,
    repairHint: `Move ${shapeId}`
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PptGeometryQaReportV1', () => {
  it('normalizes ordering, stable issue identity, and severity counts', () => {
    const first = createPptGeometryQaReport({ slideCount: 1, issues: [draft('b', 'warning'), draft('a')] })
    const second = createPptGeometryQaReport({ slideCount: 1, issues: [draft('a'), draft('b', 'warning')] })

    expect(first).toEqual(second)
    expect(first.version).toBe(1)
    expect(first.attempt).toBe(0)
    expect(first.issues.map((issue) => issue.shapeId)).toEqual(['a', 'b'])
    expect(first.issues.every((issue) => /^pptqa_[a-f0-9]{24}$/.test(issue.issueId))).toBe(true)
    expect(first.counts).toEqual({ errors: 1, warnings: 1, unchecked: 0, total: 2 })
  })

  it('rejects inconsistent counts, out-of-range slides, and non-normalized rectangles', () => {
    const report = createPptGeometryQaReport({ slideCount: 1, issues: [draft('a')] })
    expect(PptGeometryQaReportV1.safeParse({
      ...report,
      counts: { ...report.counts, errors: 0 }
    }).success).toBe(false)
    expect(PptGeometryQaReportV1.safeParse({
      ...report,
      issues: [{ ...report.issues[0], slideIndex: 1 }]
    }).success).toBe(false)
    expect(PptGeometryQaReportV1.safeParse({
      ...report,
      issues: [{ ...report.issues[0], rect: { x: 0.9, y: 0, width: 0.2, height: 1 } }]
    }).success).toBe(false)
    const withoutShapeId: Record<string, unknown> = { ...report.issues[0] }
    delete withoutShapeId.shapeId
    expect(PptGeometryQaReportV1.safeParse({ ...report, issues: [withoutShapeId] }).success).toBe(false)
  })

  it('atomically replaces and validates the project-local report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-ppt-geometry-report-'))
    roots.push(root)
    const first = createPptGeometryQaReport({ slideCount: 1, issues: [draft('a')] })
    const second = createPptGeometryQaReport({
      attempt: 1,
      slideCount: 1,
      issues: [draft('b', 'warning')]
    })

    expect(await readPptGeometryQaReport(root)).toBeUndefined()
    await writePptGeometryQaReport(root, first)
    await writePptGeometryQaReport(root, second)

    await expect(readPptGeometryQaReport(root)).resolves.toEqual(second)
    expect(pptGeometryQaReportPath(root)).toBe(join(root, '.kun-ppt-review', 'qa.json'))
    expect(await readdir(join(root, '.kun-ppt-review'))).toEqual(['qa.json'])
  })
})
