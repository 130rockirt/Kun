import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'

export const PPT_REVIEW_MANIFEST_VERSION = 1 as const

export const PptWorkflowPhase = z.enum([
  'planning',
  'generating_previews',
  'awaiting_review',
  'revising_previews',
  'retrying_failed',
  'building_deck',
  'validating_deck',
  'completed',
  'failed_recoverable',
  'cancelled',
  'direct_build'
])
export type PptWorkflowPhase = z.infer<typeof PptWorkflowPhase>

export const PptReviewSlideStatus = z.enum(['pending', 'generating', 'ready', 'failed', 'approved'])
export type PptReviewSlideStatus = z.infer<typeof PptReviewSlideStatus>

export const PptStyleSpec = z.object({
  fingerprint: z.string().min(1),
  fonts: z.array(z.string().min(1)).default([]),
  colorTokens: z.record(z.string(), z.string()).default({}),
  typeScale: z.record(z.string(), z.number().positive()).default({}),
  spacingScale: z.array(z.number().nonnegative()).default([]),
  backgroundLanguage: z.string().default(''),
  imageTreatment: z.string().default(''),
  chartTreatment: z.string().default(''),
  anchorImagePath: z.string().min(1).optional()
}).strict()
export type PptStyleSpec = z.infer<typeof PptStyleSpec>

export const PptReviewSlide = z.object({
  slideId: z.string().min(1),
  index: z.number().int().nonnegative(),
  title: z.string().min(1),
  pagePath: z.string().min(1).optional(),
  layoutSpecPath: z.string().min(1),
  previewPath: z.string().min(1).optional(),
  revision: z.number().int().nonnegative(),
  status: PptReviewSlideStatus,
  attempts: z.number().int().nonnegative(),
  lastError: z.string().min(1).optional(),
  promptHash: z.string().min(1)
}).strict()
export type PptReviewSlide = z.infer<typeof PptReviewSlide>

export const PptReviewManifestV1 = z.object({
  version: z.literal(PPT_REVIEW_MANIFEST_VERSION),
  workflowId: z.string().min(1),
  parentThreadId: z.string().min(1),
  childId: z.string().min(1),
  projectDir: z.string().min(1),
  phase: PptWorkflowPhase,
  deck: z.object({
    title: z.string().min(1),
    aspectRatio: z.literal('16:9'),
    slideCount: z.number().int().positive()
  }).strict(),
  styleSpec: PptStyleSpec,
  slides: z.array(PptReviewSlide).min(1),
  board: z.object({
    artifactId: z.string().min(1),
    lastAppliedRevision: z.number().int().nonnegative()
  }).strict().optional()
}).strict()
export type PptReviewManifestV1 = z.infer<typeof PptReviewManifestV1>

export type PptReviewBundleV1 = {
  workflowId: string
  childId: string
  manifestPath: string
  deckTitle: string
  styleFingerprint: string
  phase: PptWorkflowPhase
  slides: Array<{
    slideId: string
    index: number
    title: string
    previewPath?: string
    revision: number
    status: 'ready' | 'failed'
    error?: string
  }>
}

export type PptReviewContextV1 = {
  workflowId: string
  slides: Array<{
    slideId: string
    revision: number
    feedback?: string
    annotations?: string[]
    imagePath?: string
  }>
}

export function reviewDirectory(projectAbsolutePath: string): string {
  return resolve(projectAbsolutePath, '.kun-ppt-review')
}

export function reviewManifestPath(projectAbsolutePath: string): string {
  return resolve(reviewDirectory(projectAbsolutePath), 'manifest.json')
}

export function createPptReviewManifest(input: {
  workflowId?: string
  parentThreadId: string
  childId: string
  projectDir: string
  deckTitle: string
  styleSpec: Omit<PptStyleSpec, 'fingerprint'> & { fingerprint?: string }
  slides: Array<{ slideId?: string; title: string; layoutSpecPath?: string; prompt: string }>
}): PptReviewManifestV1 {
  const workflowId = input.workflowId?.trim() || `ppt_${randomUUID()}`
  const styleSpec = PptStyleSpec.parse({
    ...input.styleSpec,
    fingerprint: input.styleSpec.fingerprint?.trim() || fingerprint(input.styleSpec)
  })
  return PptReviewManifestV1.parse({
    version: PPT_REVIEW_MANIFEST_VERSION,
    workflowId,
    parentThreadId: input.parentThreadId,
    childId: input.childId,
    projectDir: input.projectDir,
    phase: 'planning',
    deck: { title: input.deckTitle, aspectRatio: '16:9', slideCount: input.slides.length },
    styleSpec,
    slides: input.slides.map((slide, index) => ({
      slideId: slide.slideId?.trim() || `${workflowId}-slide-${index + 1}`,
      index,
      title: slide.title,
      layoutSpecPath: slide.layoutSpecPath?.trim() || `.kun-ppt-review/layouts/slide-${index + 1}.json`,
      revision: 0,
      status: 'pending',
      attempts: 0,
      promptHash: pptReviewPromptHash(styleSpec, slide.prompt)
    }))
  })
}

export async function readPptReviewManifest(projectAbsolutePath: string): Promise<PptReviewManifestV1 | undefined> {
  try {
    return PptReviewManifestV1.parse(JSON.parse(await readFile(reviewManifestPath(projectAbsolutePath), 'utf8')))
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

export async function writePptReviewManifest(
  projectAbsolutePath: string,
  manifest: PptReviewManifestV1
): Promise<void> {
  const destination = reviewManifestPath(projectAbsolutePath)
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(PptReviewManifestV1.parse(manifest), null, 2)}\n`, 'utf8')
  await rename(temporary, destination)
}

export function toPptReviewBundle(
  manifest: PptReviewManifestV1,
  manifestPath: string
): PptReviewBundleV1 {
  return {
    workflowId: manifest.workflowId,
    childId: manifest.childId,
    manifestPath,
    deckTitle: manifest.deck.title,
    styleFingerprint: manifest.styleSpec.fingerprint,
    phase: manifest.phase,
    slides: manifest.slides.map((slide) => ({
      slideId: slide.slideId,
      index: slide.index,
      title: slide.title,
      ...(slide.previewPath ? { previewPath: slide.previewPath } : {}),
      revision: slide.revision,
      status: slide.status === 'failed' ? 'failed' : 'ready',
      ...(slide.lastError ? { error: slide.lastError } : {})
    }))
  }
}

export function assertWorkspaceRelativePath(path: string, workspaceRoot: string): string {
  if (!path.trim() || isAbsolute(path)) throw new Error('path must be workspace-relative')
  const absolute = resolve(workspaceRoot, path)
  const outside = relative(workspaceRoot, absolute)
  if (outside.startsWith('..') || isAbsolute(outside)) throw new Error('path escapes the active workspace')
  return absolute
}

export function pptReviewPromptHash(styleSpec: PptStyleSpec, prompt: string): string {
  return fingerprint({ styleSpec, prompt })
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}
