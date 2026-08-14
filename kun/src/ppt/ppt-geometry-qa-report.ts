import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

export const PPT_GEOMETRY_QA_REPORT_VERSION = 1 as const
export const PPT_GEOMETRY_QA_RELATIVE_PATH = '.kun-ppt-review/qa.json' as const

export const PptGeometryQaSeverity = z.enum(['error', 'warning', 'unchecked'])
export type PptGeometryQaSeverity = z.infer<typeof PptGeometryQaSeverity>

export const PptGeometryQaRule = z.enum([
  'bounds.out_of_slide',
  'text.overflow',
  'objects.overlap',
  'footer.safe_zone',
  'image.aspect_ratio',
  'text.minimum_font_size'
])
export type PptGeometryQaRule = z.infer<typeof PptGeometryQaRule>

export const PptGeometryQaNormalizedRect = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  width: z.number().finite().min(0).max(1),
  height: z.number().finite().min(0).max(1)
}).strict().superRefine((rect, context) => {
  if (rect.x + rect.width > 1.000_001) {
    context.addIssue({ code: 'custom', path: ['width'], message: 'normalized rectangle exceeds slide width' })
  }
  if (rect.y + rect.height > 1.000_001) {
    context.addIssue({ code: 'custom', path: ['height'], message: 'normalized rectangle exceeds slide height' })
  }
})
export type PptGeometryQaNormalizedRect = z.infer<typeof PptGeometryQaNormalizedRect>

const PptGeometryQaIssueBase = z.object({
  rule: PptGeometryQaRule,
  severity: PptGeometryQaSeverity,
  slideIndex: z.number().int().nonnegative(),
  shapeId: z.string().trim().min(1).max(256),
  relatedShapeId: z.string().trim().min(1).max(256).optional(),
  rect: PptGeometryQaNormalizedRect,
  message: z.string().trim().min(1).max(2_000),
  repairHint: z.string().trim().min(1).max(2_000)
}).strict()

export const PptGeometryQaIssueV1 = PptGeometryQaIssueBase.extend({
  issueId: z.string().regex(/^pptqa_[a-f0-9]{24}$/)
}).strict()
export type PptGeometryQaIssueV1 = z.infer<typeof PptGeometryQaIssueV1>
export type PptGeometryQaIssueDraft = z.infer<typeof PptGeometryQaIssueBase>

export const PptGeometryQaCounts = z.object({
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  unchecked: z.number().int().nonnegative(),
  total: z.number().int().nonnegative()
}).strict()
export type PptGeometryQaCounts = z.infer<typeof PptGeometryQaCounts>

export const PptGeometryQaReportV1 = z.object({
  version: z.literal(PPT_GEOMETRY_QA_REPORT_VERSION),
  attempt: z.number().int().min(0).max(2),
  slideCount: z.number().int().positive(),
  counts: PptGeometryQaCounts,
  issues: z.array(PptGeometryQaIssueV1).max(20_000)
}).strict().superRefine((report, context) => {
  const expected = countIssues(report.issues)
  for (const key of ['errors', 'warnings', 'unchecked', 'total'] as const) {
    if (report.counts[key] !== expected[key]) {
      context.addIssue({ code: 'custom', path: ['counts', key], message: `expected ${expected[key]}` })
    }
  }
  const issueIds = new Set<string>()
  report.issues.forEach((issue, index) => {
    if (issue.slideIndex >= report.slideCount) {
      context.addIssue({ code: 'custom', path: ['issues', index, 'slideIndex'], message: 'slide index is outside the report' })
    }
    if (issueIds.has(issue.issueId)) {
      context.addIssue({ code: 'custom', path: ['issues', index, 'issueId'], message: 'issue ID must be unique' })
    }
    issueIds.add(issue.issueId)
  })
})
export type PptGeometryQaReportV1 = z.infer<typeof PptGeometryQaReportV1>

function countIssues(issues: ReadonlyArray<{ severity: PptGeometryQaSeverity }>): PptGeometryQaCounts {
  const errors = issues.filter((issue) => issue.severity === 'error').length
  const warnings = issues.filter((issue) => issue.severity === 'warning').length
  const unchecked = issues.filter((issue) => issue.severity === 'unchecked').length
  return { errors, warnings, unchecked, total: issues.length }
}

function stableIssueKey(issue: PptGeometryQaIssueDraft): string {
  return JSON.stringify([
    issue.slideIndex,
    issue.rule,
    issue.severity,
    issue.shapeId,
    issue.relatedShapeId ?? '',
    issue.rect.x,
    issue.rect.y,
    issue.rect.width,
    issue.rect.height,
    issue.message,
    issue.repairHint
  ])
}

function compareIssues(left: PptGeometryQaIssueDraft, right: PptGeometryQaIssueDraft): number {
  return left.slideIndex - right.slideIndex ||
    left.rule.localeCompare(right.rule) ||
    left.shapeId.localeCompare(right.shapeId) ||
    (left.relatedShapeId ?? '').localeCompare(right.relatedShapeId ?? '') ||
    left.severity.localeCompare(right.severity) ||
    stableIssueKey(left).localeCompare(stableIssueKey(right))
}

export function createPptGeometryQaReport(input: {
  attempt?: number
  slideCount: number
  issues: ReadonlyArray<PptGeometryQaIssueDraft>
}): PptGeometryQaReportV1 {
  const drafts = input.issues.map((issue) => PptGeometryQaIssueBase.parse(issue)).sort(compareIssues)
  const issueIds = new Map<string, number>()
  const issues = drafts.map((issue) => {
    const digest = createHash('sha256').update(stableIssueKey(issue)).digest('hex').slice(0, 24)
    const ordinal = issueIds.get(digest) ?? 0
    issueIds.set(digest, ordinal + 1)
    const issueId = ordinal === 0
      ? `pptqa_${digest}`
      : `pptqa_${createHash('sha256').update(`${digest}:${ordinal}`).digest('hex').slice(0, 24)}`
    return PptGeometryQaIssueV1.parse({ ...issue, issueId })
  })
  return PptGeometryQaReportV1.parse({
    version: PPT_GEOMETRY_QA_REPORT_VERSION,
    attempt: input.attempt ?? 0,
    slideCount: input.slideCount,
    counts: countIssues(issues),
    issues
  })
}

export function pptGeometryQaReportPath(projectAbsolutePath: string): string {
  return join(projectAbsolutePath, ...PPT_GEOMETRY_QA_RELATIVE_PATH.split('/'))
}

export async function readPptGeometryQaReport(projectAbsolutePath: string): Promise<PptGeometryQaReportV1 | undefined> {
  try {
    return PptGeometryQaReportV1.parse(JSON.parse(await readFile(pptGeometryQaReportPath(projectAbsolutePath), 'utf8')))
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

export async function writePptGeometryQaReport(
  projectAbsolutePath: string,
  report: PptGeometryQaReportV1
): Promise<void> {
  const parsed = PptGeometryQaReportV1.parse(report)
  const destination = pptGeometryQaReportPath(projectAbsolutePath)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
