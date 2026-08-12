import { createHash } from 'node:crypto'
import type { PlanWorktreeRunRecord } from '../../shared/plan-worktree'

export type PlanWorktreeRuntimeAdmissionTurn = {
  id: string
  clientRequestId?: string
  clientRequestFingerprint?: string
  prompt?: string
  orchestration?: 'direct' | 'graph'
  agentSurface?: 'code' | 'write' | 'design'
}

export type PlanWorktreeStartTurnRequest = {
  prompt: string
  displayText: string
  clientRequestId: string
  mode: 'agent'
  orchestration: 'direct' | 'graph'
  clientSurface: 'gui'
  agentSurface: 'code'
  planBuildAdmissionCapability?: string
  attachmentIds: []
  composerContexts: []
  fileReferences: []
}

/**
 * Build the exact Kun start-turn request owned by a durable plan-worktree run.
 * Keep the schema-default arrays explicit so this request and Kun's admission
 * fingerprint remain byte-independent but semantically identical.
 */
export function planWorktreeStartTurnRequest(
  record: PlanWorktreeRunRecord
): PlanWorktreeStartTurnRequest | null {
  if (!record.executionPrompt || !record.executionDisplayText
    || !record.admissionClientRequestId) return null
  return {
    prompt: record.executionPrompt,
    displayText: record.executionDisplayText,
    clientRequestId: record.admissionClientRequestId,
    mode: 'agent',
    orchestration: record.orchestration,
    clientSurface: 'gui',
    agentSurface: 'code',
    ...(record.admissionCapability
      ? { planBuildAdmissionCapability: record.admissionCapability }
      : {}),
    attachmentIds: [],
    composerContexts: [],
    fileReferences: []
  }
}

/** Match Kun's canonical StartTurnRequest fingerprint without importing runtime internals. */
export function planWorktreeStartTurnFingerprint(
  record: PlanWorktreeRunRecord
): string | undefined {
  const request = planWorktreeStartTurnRequest(record)
  if (!request) return undefined
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(request)), 'utf8')
    .digest('hex')
}

export type PlanWorktreeForkRequest = {
  relation: 'side'
  workspace: string
  planBuildRunId: string
  planBuildAgentSurface: 'code'
  planBuildAdmissionFingerprint: string
  planBuildAdmissionCapability: string
}

export type PlanWorktreeRuntimeAdmissionBinding = {
  planBuildAdmissionFingerprint?: string
  planBuildAdmissionCapabilityHash?: string
}

/**
 * Main creates the execution fork before returning the run to the renderer.
 * The opaque capability is never sent through the renderer's ordinary fork
 * provider, so Kun can reserve the first post-fork turn for this exact run.
 */
export function planWorktreeForkRequest(
  record: PlanWorktreeRunRecord,
  workspace: string
): PlanWorktreeForkRequest | null {
  const fingerprint = planWorktreeStartTurnFingerprint(record)
  if (!record.admissionCapability || !fingerprint) return null
  return {
    relation: 'side',
    workspace,
    planBuildRunId: record.runId,
    planBuildAgentSurface: 'code',
    planBuildAdmissionFingerprint: fingerprint,
    planBuildAdmissionCapability: record.admissionCapability
  }
}

/** A newly-created execution thread must durably carry Main's exact binding. */
export function matchesPlanWorktreeAdmissionBinding(
  record: PlanWorktreeRunRecord,
  binding: PlanWorktreeRuntimeAdmissionBinding
): boolean {
  if (!record.admissionCapability) return true
  const fingerprint = planWorktreeStartTurnFingerprint(record)
  const capabilityHash = createHash('sha256')
    .update(record.admissionCapability, 'utf8')
    .digest('hex')
  return Boolean(
    fingerprint
    && binding.planBuildAdmissionFingerprint === fingerprint
    && binding.planBuildAdmissionCapabilityHash === capabilityHash
  )
}

/**
 * Timeline projections intentionally redact `turn.prompt`. Prefer Kun's
 * durable full-request fingerprint and retain the prompt hash only as a
 * compatibility fallback for older runtime projections and test fixtures.
 */
export function matchesPlanWorktreeAdmission(
  record: PlanWorktreeRunRecord,
  turn: PlanWorktreeRuntimeAdmissionTurn
): boolean {
  if (!record.admissionClientRequestId) return false
  const expectedFingerprint = planWorktreeStartTurnFingerprint(record)
  const requestMatches = turn.clientRequestFingerprint
    ? Boolean(expectedFingerprint && turn.clientRequestFingerprint === expectedFingerprint)
    : !record.admissionCapability && typeof turn.prompt === 'string' && Boolean(
        turn.prompt && record.executionPromptSha256
        && createHash('sha256').update(turn.prompt).digest('hex')
          === record.executionPromptSha256
      )
  return turn.clientRequestId === record.admissionClientRequestId
    && turn.orchestration === record.orchestration
    && turn.agentSurface === 'code'
    && requestMatches
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const entry = (value as Record<string, unknown>)[key]
    if (entry !== undefined) result[key] = canonicalize(entry)
  }
  return result
}
