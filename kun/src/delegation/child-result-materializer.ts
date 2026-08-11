import type { TurnItem } from '../contracts/items.js'
import type { ArtifactStore } from '../artifacts/artifact-store.js'
import { ContextEstimator } from '../loop/context-estimator.js'
import type { ChildResultRef } from './delegation-runtime-contracts.js'

export const CHILD_RESULT_MAX_BYTES = 50 * 1_024
export const CHILD_RESULT_MAX_LINES = 2_000
export const CHILD_RESULT_MAX_TOKENS = 8_000
export const CHILD_RESULT_PREVIEW_CHARS = 4_000
const CHILD_RESULT_ARTIFACT_PREVIEW_CHARS = CHILD_RESULT_PREVIEW_CHARS - 64

const estimator = new ContextEstimator()

export type MaterializedChildResult = {
  summary: string
  summaryTruncated?: boolean
  resultRef?: ChildResultRef
  resultUnavailableReason?: string
}

export class ChildResultExecutionError extends Error {
  constructor(
    message: string,
    readonly result: MaterializedChildResult
  ) {
    super(message)
    this.name = 'ChildResultExecutionError'
  }
}

export function childResultOwnerIds(parentThreadId: string, childId: string): string[] {
  return [`thread:${parentThreadId}`, `child:${childId}`]
}

export function childResultSource(
  items: readonly TurnItem[],
  turnId: string,
  status: 'completed' | 'failed' | 'aborted'
): string {
  const turnItems = items.filter((item) => item.turnId === turnId)
  const assistantText = [...turnItems]
    .reverse()
    .find((item): item is Extract<TurnItem, { kind: 'assistant_text' }> =>
      item.kind === 'assistant_text' && Boolean(item.text.trim()))
    ?.text.trim()
  if (assistantText) return assistantText
  const errors = turnItems
    .filter((item): item is Extract<TurnItem, { kind: 'error' }> => item.kind === 'error')
    .map((item) => item.message.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
  if (errors) return errors
  const toolResult = [...turnItems]
    .reverse()
    .find((item): item is Extract<TurnItem, { kind: 'tool_result' }> => item.kind === 'tool_result')
  if (toolResult) return stringifyResult(toolResult.output)
  return status === 'completed'
    ? 'Child agent completed without a text response.'
    : `Child agent ${status}.`
}

export async function materializeChildResult(input: {
  content: string
  childId: string
  parentThreadId: string
  artifactStore?: ArtifactStore
}): Promise<MaterializedChildResult> {
  const content = input.content.trim()
  const byteSize = Buffer.byteLength(content, 'utf8')
  const lineCount = countLines(content)
  const tokens = estimator.estimateText(content)
  const oversized =
    byteSize > CHILD_RESULT_MAX_BYTES ||
    lineCount > CHILD_RESULT_MAX_LINES ||
    tokens > CHILD_RESULT_MAX_TOKENS
  if (!oversized) return { summary: content }

  const fallbackPreview = boundedUnavailablePreview(content)
  if (!input.artifactStore) {
    return {
      summary: fallbackPreview,
      summaryTruncated: true,
      resultUnavailableReason: 'Artifact storage is unavailable; open the child session for the full result.'
    }
  }
  try {
    const stored = await input.artifactStore.put({
      content,
      mimeType: 'text/markdown',
      source: 'tool',
      origin: 'subagent-result',
      // Leave space for variable-width omitted byte/line counts in the
      // artifact marker so the head/tail preview remains intact under 4k.
      maxInlineChars: CHILD_RESULT_ARTIFACT_PREVIEW_CHARS,
      linkedOwners: childResultOwnerIds(input.parentThreadId, input.childId)
    })
    return {
      // ArtifactSummary's marker contains variable-width counts; clamp again
      // at the delegation boundary so its hard parent-context contract wins.
      summary: stored.summary.inline.slice(0, CHILD_RESULT_PREVIEW_CHARS),
      summaryTruncated: true,
      resultRef: {
        artifactId: stored.meta.id,
        byteSize: stored.meta.byteSize,
        lineCount: stored.meta.lineCount,
        mimeType: 'text/markdown'
      }
    }
  } catch (error) {
    console.warn(
      `[kun] oversized child result artifact write failed child=${input.childId}: ${safeError(error)}`
    )
    return {
      summary: fallbackPreview,
      summaryTruncated: true,
      resultUnavailableReason: 'The full child result could not be stored; open the child session for details.'
    }
  }
}

function boundedUnavailablePreview(content: string): string {
  const marker = '\n[full child result omitted; open the child session for details]\n'
  const budget = Math.max(0, CHILD_RESULT_PREVIEW_CHARS - marker.length)
  const headLength = Math.floor(budget * 0.7)
  const tailLength = Math.max(0, budget - headLength)
  return `${content.slice(0, headLength)}${marker}${content.slice(-tailLength)}`
    .slice(0, CHILD_RESULT_PREVIEW_CHARS)
}

function countLines(content: string): number {
  return content.length === 0 ? 0 : content.split('\n').length
}

function stringifyResult(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 500)
}
