import { createHash } from 'node:crypto'
import type { ModelToolSpec } from '../ports/model-client.js'
import { buildToolCatalogFingerprint } from './tool-catalog-fingerprint.js'

export type PromptCachePhase =
  | 'agent'
  | 'plan'
  | 'graph-planning'
  | 'graph-active'
  | 'svg'

export type PromptCachePartition = Readonly<{
  hash: string
  phase: PromptCachePhase
  stableInstructionFingerprint: string
  toolCatalogFingerprint: string
  protocolVariant: string
}>

export function resolvePromptCachePhase(input: {
  svg: boolean
  graph: boolean
  graphActive: boolean
  plan: boolean
}): PromptCachePhase {
  if (input.svg) return 'svg'
  if (input.graph) return input.graphActive ? 'graph-active' : 'graph-planning'
  return input.plan ? 'plan' : 'agent'
}

/**
 * Builds the provider cache namespace from values that really affect the
 * stable wire prefix. Per-turn context, persona text, messages, and attachment
 * bytes are deliberately absent: they live in append-only history instead.
 */
export function buildPromptCachePartition(input: {
  model: string
  providerId?: string
  endpointFormat?: string
  responsesMode?: string
  phase: PromptCachePhase
  immutablePrefixFingerprint: string
  threadProfileInstruction?: string
  tools: readonly ModelToolSpec[]
}): PromptCachePartition {
  const toolCatalog = buildToolCatalogFingerprint(input.tools)
  const stableInstructionFingerprint = hashValue({
    immutablePrefix: input.immutablePrefixFingerprint,
    threadProfile: input.threadProfileInstruction?.trim() || null
  })
  const protocolVariant = [
    input.endpointFormat?.trim() || 'unknown',
    input.responsesMode?.trim() || 'standard'
  ].join(':')
  const hash = hashValue({
    version: 1,
    model: input.model.trim(),
    providerId: input.providerId?.trim() || 'default',
    protocolVariant,
    phase: input.phase,
    stableInstructionFingerprint,
    toolCatalogFingerprint: toolCatalog.fingerprint
  })
  return {
    hash,
    phase: input.phase,
    stableInstructionFingerprint,
    toolCatalogFingerprint: toolCatalog.fingerprint,
    protocolVariant
  }
}

export function promptCacheKey(threadId: string, partitionHash?: string): string {
  const hash = partitionHash?.trim()
  return hash ? `${threadId}:${hash}` : threadId
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}
