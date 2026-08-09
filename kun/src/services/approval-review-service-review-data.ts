import { randomUUID } from 'node:crypto'
import {
  ApprovalActionEnvelopeSchema,
  ApprovalReviewDecisionSchema,
  type ApprovalActionEnvelope,
  type ApprovalReviewDecision,
  type ApprovalReviewTerminalStatus
} from '../contracts/approvals.js'
import {
  redactApprovalSensitiveText,
  safeApprovalActionSummary
} from '../domain/approval.js'
import { makeUserItem } from '../domain/item.js'
import type {
  ApprovalReviewInput,
  ApprovalReviewPort,
  ApprovalReviewResult
} from '../ports/approval-review.js'
import type {
  ModelClient,
  ModelRequest,
  ModelStreamChunk
} from '../ports/model-client.js'
import type { RuntimeEventRecorder } from './runtime-event-recorder.js'
import type { UsageService } from './usage-service.js'
import { utf8PrefixWithinBytes } from '../shared/utf8-text-blocks.js'
import { MAX_INTENT_BYTES, MAX_REVIEW_INPUT_BYTES } from './approval-review-service-core.js'
import { boundedText, normalizeReviewArguments, redactOutput, utf8Bytes } from './approval-review-service-normalization.js'

export function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined)
    return Promise.reject(signal.reason ?? new Error('approval review aborted'))
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(signal.reason ?? new Error('approval review aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
    )
  })
}

export function parseApprovalReviewDecision(
  raw: string
): { ok: true; value: ApprovalReviewDecision } | { ok: false; reason: string } {
  const text = raw.trim()
  if (!text) return { ok: false, reason: 'empty response' }
  if (!text.startsWith('{') || !text.endsWith('}')) {
    return { ok: false, reason: 'response was not a bare JSON object' }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'malformed JSON' }
  }
  const parsed = ApprovalReviewDecisionSchema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || 'response'}: ${issue.message}`)
        .join('; ')
        .slice(0, 1_024)
    }
  }
  return {
    ok: true,
    value: {
      ...parsed.data,
      rationale: boundedText(redactOutput(parsed.data.rationale), 2_048)
    }
  }
}

export function buildReviewData(
  input: ApprovalReviewInput,
  action: ApprovalActionEnvelope
): string {
  const normalizedArguments = normalizeReviewArguments(action.arguments)
  const criticalAction = {
    version: action.version,
    kind: action.kind,
    toolName: action.toolName,
    ...(action.providerId ? { providerId: action.providerId } : {}),
    ...(action.providerKind ? { providerKind: action.providerKind } : {}),
    ...(action.toolKind ? { toolKind: action.toolKind } : {}),
    effects: action.effects,
    workspace: action.workspace,
    ...(action.cwd ? { cwd: action.cwd } : {}),
    // Exact targets and the host-authored reason are security-critical. They
    // are never byte-sliced; an envelope that cannot carry them fails closed.
    targets: action.targets,
    reason: action.reason
  }
  const makePayload = (
    userIntent: string,
    userIntentTruncated: boolean,
    reviewArguments: Record<string, unknown>,
    argumentsTruncated: boolean
  ) => ({
    untrusted: true,
    userIntent,
    userIntentTruncated,
    hostApprovalReason: action.reason,
    action: {
      ...criticalAction,
      arguments: reviewArguments,
      argumentsTruncated
    }
  })
  const serialize = (
    userIntent: string,
    userIntentTruncated: boolean,
    reviewArguments: Record<string, unknown>,
    argumentsTruncated: boolean
  ): string => {
    const serialized = JSON.stringify(makePayload(
      userIntent,
      userIntentTruncated,
      reviewArguments,
      argumentsTruncated
    ))
    if (typeof serialized !== 'string') {
      throw new Error('review data could not be encoded as structured JSON')
    }
    return serialized
  }

  const rawIntent = redactOutput(input.intent?.trim() || '(intent unavailable)')
  let userIntent = boundedText(rawIntent, MAX_INTENT_BYTES)
  let userIntentTruncated = userIntent !== rawIntent
  const minimalArguments = { __truncated__: true }
  let minimal = serialize(userIntent, userIntentTruncated, minimalArguments, true)
  if (utf8Bytes(minimal) > MAX_REVIEW_INPUT_BYTES) {
    let low = 0
    let high = MAX_INTENT_BYTES
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      const candidateIntent = boundedText(rawIntent, mid)
      const candidate = serialize(candidateIntent, true, minimalArguments, true)
      if (utf8Bytes(candidate) <= MAX_REVIEW_INPUT_BYTES) low = mid
      else high = mid - 1
    }
    userIntent = boundedText(rawIntent, low)
    userIntentTruncated = true
    minimal = serialize(userIntent, true, minimalArguments, true)
  }
  if (utf8Bytes(minimal) > MAX_REVIEW_INPUT_BYTES) {
    throw new Error(
      'canonical action identity, effects, targets, or host reason exceed the safe review-data budget'
    )
  }

  const full = serialize(
    userIntent,
    userIntentTruncated,
    normalizedArguments.value,
    normalizedArguments.truncated
  )
  let payloadJson = full
  if (utf8Bytes(full) > MAX_REVIEW_INPUT_BYTES) {
    const boundedArguments: Record<string, unknown> = { __truncated__: true }
    for (const [key, value] of Object.entries(normalizedArguments.value)) {
      if (key === '__truncated__') continue
      const candidateArguments = { ...boundedArguments, [key]: value }
      const candidate = serialize(
        userIntent,
        userIntentTruncated,
        candidateArguments,
        true
      )
      if (utf8Bytes(candidate) <= MAX_REVIEW_INPUT_BYTES) {
        boundedArguments[key] = value
      }
    }
    payloadJson = serialize(
      userIntent,
      userIntentTruncated,
      boundedArguments,
      true
    )
  }
  if (utf8Bytes(payloadJson) > MAX_REVIEW_INPUT_BYTES) {
    throw new Error('normalized review arguments exceed the safe review-data budget')
  }
  // The byte budget is applied to the complete JSON value, never to its
  // serialized text. This guarantees the delimited body is always parseable.
  JSON.parse(payloadJson)
  return [
    '<REVIEW_DATA untrusted="true">',
    payloadJson,
    '</REVIEW_DATA>'
  ].join('\n')
}

export function canonicalApprovalAction(
  value: ApprovalReviewInput['approval']['action']
): { action?: ApprovalActionEnvelope; reason?: string } {
  if (!value) {
    return {
      reason: 'Automatic review denied because canonical action data is unavailable.'
    }
  }
  try {
    const parsed = ApprovalActionEnvelopeSchema.safeParse(value)
    if (!parsed.success) {
      return {
        reason: 'Automatic review denied because canonical action data is invalid.'
      }
    }
    const normalizedArguments = normalizeReviewArguments(parsed.data.arguments)
    const arguments_ = normalizedArguments.truncated
      ? { ...normalizedArguments.value, __truncated__: true }
      : normalizedArguments.value
    const sanitized = ApprovalActionEnvelopeSchema.safeParse({
      ...parsed.data,
      ...(parsed.data.providerId
        ? { providerId: redactOutput(parsed.data.providerId) }
        : {}),
      arguments: arguments_,
      workspace: redactOutput(parsed.data.workspace),
      ...(parsed.data.cwd ? { cwd: redactOutput(parsed.data.cwd) } : {}),
      targets: parsed.data.targets.map((target) => ({
        ...target,
        value: redactOutput(target.value)
      })),
      reason: redactOutput(parsed.data.reason)
    })
    if (
      !sanitized.success ||
      sanitized.data.targets.length === 0 ||
      sanitized.data.targets.some((target) => !target.value.trim())
    ) {
      return {
        reason: 'Automatic review denied because canonical action targets could not be represented safely.'
      }
    }
    return { action: sanitized.data }
  } catch {
    return {
      reason: 'Automatic review denied because canonical action data could not be represented safely.'
    }
  }
}
