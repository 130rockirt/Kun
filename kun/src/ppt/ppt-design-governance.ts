import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import {
  PPT_CORE_DESIGN_POLICY_PATH,
  PPT_CORE_DESIGN_POLICY_RULES_PATH,
  PPT_CORE_DESIGN_POLICY_VERSION,
  PptPolicyExceptionRule,
  PptVisualEffect,
  type PptCoreDesignPolicy
} from './ppt-design-policy.js'
import {
  detectedPptAntiPatterns,
  pptDesignPlanPolicyErrors,
  sourceRequestSupportsPptPolicyException
} from './ppt-design-policy-enforcement.js'

export { PptPolicyExceptionRule, PptVisualEffect } from './ppt-design-policy.js'
export {
  PPT_ANTI_PATTERN_DETECTORS,
  pptDesignPlanPolicyErrors,
  sourceRequestSupportsPptPolicyException,
  wcagContrastRatio
} from './ppt-design-policy-enforcement.js'
export type { PptAntiPatternDetector } from './ppt-design-policy-enforcement.js'

export const PPT_DESIGN_GOVERNANCE_VERSION = 1 as const
export const PPT_CATEGORY_INDEX_PATH = 'slides_categories.md' as const

export const PptDesignCategory = z.enum([
  'analysis-decision',
  'business-plan',
  'management-report',
  'academic-research',
  'education-training',
  'tech-engineering',
  'brand-creative'
])
export type PptDesignCategory = z.infer<typeof PptDesignCategory>

export const PPT_CATEGORY_GUIDE_PATHS: Readonly<Record<PptDesignCategory, string>> = {
  'analysis-decision': 'slides_categories/analysis-decision.md',
  'business-plan': 'slides_categories/business-plan.md',
  'management-report': 'slides_categories/management-report.md',
  'academic-research': 'slides_categories/academic-research.md',
  'education-training': 'slides_categories/education-training.md',
  'tech-engineering': 'slides_categories/tech-engineering.md',
  'brand-creative': 'slides_categories/brand-creative.md'
}

const HexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/)

export const PptBackgroundTreatment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('solid') }).strict(),
  z.object({ kind: z.literal('gradient'), stops: z.array(HexColor).min(2).max(8) }).strict(),
  z.object({ kind: z.literal('image') }).strict()
])

export const PptDesignPlanInput = z.object({
  category: PptDesignCategory,
  audience: z.string().trim().min(3),
  purpose: z.string().trim().min(3),
  pageStrategy: z.object({
    pageCount: z.number().int().min(1).max(50),
    narrative: z.string().trim().min(8)
  }).strict(),
  fontRoles: z.object({
    display: z.string().trim().min(1),
    body: z.string().trim().min(1),
    monospace: z.string().trim().min(1).optional()
  }).strict(),
  colorRoles: z.object({
    background: HexColor,
    foreground: HexColor,
    accent: HexColor,
    muted: HexColor,
    positive: HexColor,
    caution: HexColor,
    critical: HexColor
  }).strict(),
  backgroundTreatment: PptBackgroundTreatment,
  effects: z.array(PptVisualEffect).default([]).superRefine((effects, ctx) => {
    const seen = new Set<string>()
    for (const [index, effect] of effects.entries()) {
      if (seen.has(effect)) {
        ctx.addIssue({ code: 'custom', path: [index], message: `duplicate visual effect ${effect}` })
      }
      seen.add(effect)
    }
  }),
  typeScale: z.object({
    title: z.number().min(28),
    section: z.number().min(22),
    body: z.number().min(14),
    caption: z.number().min(10)
  }).strict().superRefine((scale, ctx) => {
    if (!(scale.title > scale.section && scale.section > scale.body && scale.body > scale.caption)) {
      ctx.addIssue({ code: 'custom', message: 'type scale must descend from title to caption' })
    }
  }),
  spacingRhythm: z.object({
    unit: z.number().positive(),
    pageMargin: z.number().positive(),
    columns: z.number().int().min(1).max(12),
    gutter: z.number().nonnegative()
  }).strict().superRefine((spacing, ctx) => {
    if (spacing.pageMargin < spacing.unit) {
      ctx.addIssue({ code: 'custom', path: ['pageMargin'], message: 'pageMargin must be at least one spacing unit' })
    }
  }),
  layoutSystem: z.string().trim().min(8),
  imageryStrategy: z.string().trim().min(8),
  policyExceptions: z.array(z.object({
    rule: PptPolicyExceptionRule,
    evidence: z.string().trim().min(4)
  }).strict()).default([])
}).strict().superRefine((plan, ctx) => {
  const rules = new Set<PptPolicyExceptionRule>()
  for (const [index, exception] of plan.policyExceptions.entries()) {
    if (rules.has(exception.rule)) {
      ctx.addIssue({
        code: 'custom',
        path: ['policyExceptions', index, 'rule'],
        message: 'each exception rule may be claimed only once'
      })
    }
    rules.add(exception.rule)
  }
  for (const { detector, field } of detectedPptAntiPatterns(plan)) {
    if (!rules.has(detector.rule)) {
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `detected ${detector.label}; add source-backed policy exception "${detector.rule}" or remove the anti-pattern`
      })
    }
  }
})
export type PptDesignPlanInput = z.infer<typeof PptDesignPlanInput>

export const PptDesignPlan = PptDesignPlanInput.safeExtend({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRequestHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict()
export type PptDesignPlan = z.infer<typeof PptDesignPlan>

const GuideReadRange = z.object({
  start: z.number().int().positive(),
  end: z.number().int().positive()
}).strict().refine((range) => range.end >= range.start, {
  message: 'guide read range end must not precede start'
})

const GuideReadProgress = z.object({
  path: z.string().min(1),
  totalLines: z.number().int().positive(),
  ranges: z.array(GuideReadRange).min(1)
}).strict()

export const PptDesignGovernanceSnapshot = z.object({
  policy: z.object({
    version: z.literal(PPT_CORE_DESIGN_POLICY_VERSION),
    path: z.literal(PPT_CORE_DESIGN_POLICY_PATH),
    rulesPath: z.literal(PPT_CORE_DESIGN_POLICY_RULES_PATH),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    markdownSha256: z.string().regex(/^[a-f0-9]{64}$/),
    rulesSha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict(),
  category: PptDesignCategory,
  categoryGuide: z.string().min(1),
  designPlan: PptDesignPlan,
  planRevision: z.number().int().positive()
}).strict()
export type PptDesignGovernanceSnapshot = z.infer<typeof PptDesignGovernanceSnapshot>

export const PptDesignGovernanceState = z.object({
  version: z.literal(PPT_DESIGN_GOVERNANCE_VERSION),
  workflowId: z.string().min(1),
  childId: z.string().min(1),
  binding: z.object({
    workspaceCanonicalPath: z.string().min(1),
    projectCanonicalPath: z.string().min(1)
  }).strict(),
  policy: PptDesignGovernanceSnapshot.shape.policy,
  guideReads: z.array(GuideReadProgress).default([]),
  selectedCategory: PptDesignCategory.optional(),
  categoryGuide: z.string().min(1).optional(),
  designPlan: PptDesignPlan.optional(),
  planRevision: z.number().int().nonnegative().default(0),
  reviewedPlanFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  exportedPlanFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).strict()
export type PptDesignGovernanceState = z.infer<typeof PptDesignGovernanceState>

export type PptDesignGovernanceStore = Readonly<{
  directory: string
  key: string
  path: string
  identity: {
    workspaceCanonicalPath: string
    projectCanonicalPath: string
    childId: string
  }
}>

export async function resolvePptDesignGovernanceStore(input: {
  governanceDirectory: string
  workspaceCanonicalPath: string
  projectCanonicalPath: string
  childId: string
}): Promise<PptDesignGovernanceStore> {
  if (!isAbsolute(input.governanceDirectory)) {
    throw new Error('PPT governance directory must be an absolute host-owned path')
  }
  await mkdir(input.governanceDirectory, { recursive: true, mode: 0o700 })
  const directory = await realpath(input.governanceDirectory)
  const workspaceCanonicalPath = await realpath(input.workspaceCanonicalPath)
  const projectCanonicalPath = await realpath(input.projectCanonicalPath)
  const relativeToWorkspace = relative(workspaceCanonicalPath, directory)
  if (relativeToWorkspace === '' || (!relativeToWorkspace.startsWith('..') && !isAbsolute(relativeToWorkspace))) {
    throw new Error('PPT governance directory must be outside the active workspace')
  }
  const identity = {
    workspaceCanonicalPath,
    projectCanonicalPath,
    childId: input.childId
  }
  const key = sha256(identity)
  return { directory, key, path: resolve(directory, `${key}.json`), identity }
}

export function pptDesignGovernancePath(store: PptDesignGovernanceStore): string {
  return store.path
}

export function createPptDesignGovernanceState(input: {
  workflowId: string
  childId: string
  binding: PptDesignGovernanceStore['identity']
  policy: PptCoreDesignPolicy
}): PptDesignGovernanceState {
  return PptDesignGovernanceState.parse({
    version: PPT_DESIGN_GOVERNANCE_VERSION,
    workflowId: input.workflowId,
    childId: input.childId,
    binding: {
      workspaceCanonicalPath: input.binding.workspaceCanonicalPath,
      projectCanonicalPath: input.binding.projectCanonicalPath
    },
    policy: policyIdentity(input.policy),
    guideReads: [],
    planRevision: 0
  })
}

export function recordPptGuideRead(input: {
  state: PptDesignGovernanceState
  path: string
  startLine: number
  endLine: number
  totalLines: number
}): PptDesignGovernanceState {
  const path = input.path.replaceAll('\\', '/')
  const category = categoryForGuidePath(path)
  if (category && !isPptGuideComplete(input.state, PPT_CATEGORY_INDEX_PATH)) {
    throw new Error(`read the complete ${PPT_CATEGORY_INDEX_PATH} category index before ${path}`)
  }
  if (category && input.state.categoryGuide && input.state.categoryGuide !== path) {
    throw new Error(`workflow already selected ${input.state.categoryGuide}; exactly one category guide is allowed`)
  }
  const prior = input.state.guideReads.find((entry) => entry.path === path)
  const progress = GuideReadProgress.parse({
    path,
    totalLines: input.totalLines,
    ranges: mergeRanges([
      ...(prior?.ranges ?? []),
      { start: input.startLine, end: input.endLine }
    ])
  })
  const guideReads = [
    ...input.state.guideReads.filter((entry) => entry.path !== path),
    progress
  ]
  return PptDesignGovernanceState.parse({
    ...input.state,
    guideReads,
    ...(category ? { selectedCategory: category, categoryGuide: path } : {})
  })
}

export function isPptGuideComplete(state: PptDesignGovernanceState, path: string): boolean {
  const progress = state.guideReads.find((entry) => entry.path === path)
  if (!progress) return false
  return progress.ranges.length === 1 && progress.ranges[0].start === 1 &&
    progress.ranges[0].end >= progress.totalLines
}

export function submitPptDesignPlan(input: {
  state: PptDesignGovernanceState
  plan: PptDesignPlanInput
  sourceRequest: string
  policy: PptCoreDesignPolicy
}): PptDesignGovernanceState {
  const { state, sourceRequest, policy } = input
  if (!isPptGuideComplete(state, PPT_CATEGORY_INDEX_PATH)) {
    throw new Error(`design plan requires a complete read of ${PPT_CATEGORY_INDEX_PATH}`)
  }
  if (!state.categoryGuide || !state.selectedCategory || !isPptGuideComplete(state, state.categoryGuide)) {
    throw new Error('design plan requires one complete supported category guide')
  }
  if (input.plan.category !== state.selectedCategory) {
    throw new Error(`design plan category must match the selected guide: ${state.selectedCategory}`)
  }
  if (
    state.designPlan &&
    input.plan.pageStrategy.pageCount !== state.designPlan.pageStrategy.pageCount
  ) {
    throw new Error('design plan pageCount is immutable within a PPT workflow; start a new workflow to change it')
  }
  const plan = PptDesignPlanInput.parse(input.plan)
  const policyErrors = pptDesignPlanPolicyErrors(plan, policy)
  if (policyErrors.length > 0) throw new Error(policyErrors.join('; '))
  for (const exception of plan.policyExceptions) {
    if (!sourceRequestSupportsPptPolicyException(sourceRequest, exception, policy.rules)) {
      throw new Error(
        `policy exception ${exception.rule} requires a positive exact evidence quote from the source request`
      )
    }
  }
  const sourceRequestHash = sha256(sourceRequest)
  const fingerprint = sha256({
    policy: state.policy,
    categoryGuide: state.categoryGuide,
    plan,
    sourceRequestHash
  })
  const designPlan = PptDesignPlan.parse({ ...plan, fingerprint, sourceRequestHash })
  return PptDesignGovernanceState.parse({
    ...state,
    designPlan,
    planRevision: state.planRevision + 1,
    reviewedPlanFingerprint: undefined,
    exportedPlanFingerprint: undefined
  })
}

export function currentPptGovernanceSnapshot(
  state: PptDesignGovernanceState,
  policy: PptCoreDesignPolicy
): PptDesignGovernanceSnapshot {
  const errors = pptGovernanceReadinessErrors(state, policy)
  if (errors.length > 0) throw new Error(errors.join('; '))
  return PptDesignGovernanceSnapshot.parse({
    policy: state.policy,
    category: state.selectedCategory,
    categoryGuide: state.categoryGuide,
    designPlan: state.designPlan,
    planRevision: state.planRevision
  })
}

export function pptGovernanceReadinessErrors(
  state: PptDesignGovernanceState | undefined,
  policy: PptCoreDesignPolicy
): string[] {
  if (!state) return ['initialize the governed PPT workflow by reading the category index']
  const errors: string[] = []
  if (
    state.policy.version !== policy.version ||
    state.policy.sha256 !== policy.sha256 ||
    state.policy.markdownSha256 !== policy.markdownSha256 ||
    state.policy.rulesSha256 !== policy.rulesSha256
  ) {
    errors.push('the core design policy changed; reread the guides and submit a new design plan')
  }
  if (!isPptGuideComplete(state, PPT_CATEGORY_INDEX_PATH)) {
    errors.push(`read the complete ${PPT_CATEGORY_INDEX_PATH}`)
  }
  if (!state.categoryGuide || !state.selectedCategory || !isPptGuideComplete(state, state.categoryGuide)) {
    errors.push('read one complete supported category guide')
  }
  if (!state.designPlan) errors.push('submit a complete design plan with ppt_submit_design_plan')
  return errors
}

export function markPptGovernanceReviewed(
  state: PptDesignGovernanceState,
  fingerprint: string
): PptDesignGovernanceState {
  return PptDesignGovernanceState.parse({ ...state, reviewedPlanFingerprint: fingerprint })
}

export function markPptGovernanceExported(
  state: PptDesignGovernanceState,
  fingerprint: string
): PptDesignGovernanceState {
  return PptDesignGovernanceState.parse({ ...state, exportedPlanFingerprint: fingerprint })
}

export async function readPptDesignGovernance(
  store: PptDesignGovernanceStore
): Promise<PptDesignGovernanceState | undefined> {
  try {
    const state = PptDesignGovernanceState.parse(JSON.parse(await readFile(store.path, 'utf8')))
    assertPptGovernanceBinding(store, state)
    return state
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

export async function writePptDesignGovernance(
  store: PptDesignGovernanceStore,
  state: PptDesignGovernanceState
): Promise<void> {
  const parsed = PptDesignGovernanceState.parse(state)
  assertPptGovernanceBinding(store, parsed)
  const destination = store.path
  await mkdir(store.directory, { recursive: true, mode: 0o700 })
  const temporary = `${destination}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, destination)
}

export function pptGovernanceSnapshotFingerprint(snapshot: PptDesignGovernanceSnapshot): string {
  return sha256(PptDesignGovernanceSnapshot.parse(snapshot))
}

export function categoryForGuidePath(path: string): PptDesignCategory | undefined {
  const normalized = path.replaceAll('\\', '/')
  return (Object.entries(PPT_CATEGORY_GUIDE_PATHS) as Array<[PptDesignCategory, string]>)
    .find(([, guidePath]) => guidePath === normalized)?.[0]
}

export function designPlanStyleSpec(plan: PptDesignPlan): {
  fonts: string[]
  colorTokens: Record<string, string>
  typeScale: Record<string, number>
  spacingScale: number[]
  backgroundLanguage: string
  imageTreatment: string
  chartTreatment: string
} {
  return {
    fonts: [...new Set([plan.fontRoles.display, plan.fontRoles.body, plan.fontRoles.monospace].filter(Boolean) as string[])],
    colorTokens: plan.colorRoles,
    typeScale: plan.typeScale,
    spacingScale: [
      plan.spacingRhythm.unit,
      plan.spacingRhythm.gutter,
      plan.spacingRhythm.pageMargin
    ],
    backgroundLanguage: [
      plan.layoutSystem,
      plan.backgroundTreatment.kind,
      ...('stops' in plan.backgroundTreatment ? plan.backgroundTreatment.stops : []),
      ...plan.effects
    ].join(' · '),
    imageTreatment: plan.imageryStrategy,
    chartTreatment: 'Native editable charts using the governed semantic color roles'
  }
}

function policyIdentity(policy: PptCoreDesignPolicy): PptDesignGovernanceState['policy'] {
  return {
    version: policy.version,
    path: policy.path,
    rulesPath: policy.rulesPath,
    sha256: policy.sha256,
    markdownSha256: policy.markdownSha256,
    rulesSha256: policy.rulesSha256
  }
}

function assertPptGovernanceBinding(
  store: PptDesignGovernanceStore,
  state: PptDesignGovernanceState
): void {
  if (
    state.childId !== store.identity.childId ||
    state.binding.workspaceCanonicalPath !== store.identity.workspaceCanonicalPath ||
    state.binding.projectCanonicalPath !== store.identity.projectCanonicalPath
  ) {
    throw new Error('PPT governance state binding does not match the active workspace, child, and project')
  }
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const ordered = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: Array<{ start: number; end: number }> = []
  for (const range of ordered) {
    const previous = merged.at(-1)
    if (!previous || range.start > previous.end + 1) merged.push({ ...range })
    else previous.end = Math.max(previous.end, range.end)
  }
  return merged
}

function sha256(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
}
