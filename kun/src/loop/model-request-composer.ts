import type { ImmutablePrefix } from '../cache/immutable-prefix.js'
import type { TurnItem } from '../contracts/items.js'
import type {
  ModelRequest,
  ModelToolSpec
} from '../ports/model-client.js'
import type { ResolvedTurnAttachments } from './turn-execution-types.js'
import {
  applyTokenEconomyToRequest,
  normalizeTokenEconomyConfig,
  type NormalizedTokenEconomyConfig,
  type TokenEconomyConfig
} from './token-economy.js'
import { applyRequestHistoryHygiene } from './request-history-hygiene.js'
import { estimateModelRequestInputTokens } from './model-request-estimator.js'
import { capToolResultImages } from './tool-result-image.js'
import { buildThreadProfileInstruction } from '../prompt/kun-prompt-context.js'

const MAX_FORWARDED_TOOL_IMAGES = 3

export type ModelRequestComposerInput = Readonly<{
  threadId: string
  turnId: string
  model: string
  providerId?: string
  accountId?: string
  reasoningEffort?: string
  serviceTier?: 'priority'
  immutablePrefix: ImmutablePrefix
  threadSystemPrompt?: string
  modeInstruction?: string
  contextInstructions: readonly string[]
  history: readonly TurnItem[]
  attachments: ResolvedTurnAttachments
  tools: readonly ModelToolSpec[]
  requiredToolName?: string
  tokenEconomy?: TokenEconomyConfig
  signal: AbortSignal
}>

export type ComposedModelRequest = Readonly<{
  request: ModelRequest
  rawInputTokens: number
  sentInputTokens: number
  tokenEconomy: NormalizedTokenEconomyConfig
}>

/**
 * Pure send-time request construction. The ordering is load-bearing: image
 * payloads are capped first, token-economy transforms run next, and history
 * hygiene is the final boundary before token estimation and model transport.
 */
export function composeModelRequest(input: ModelRequestComposerInput): ComposedModelRequest {
  const tokenEconomy = normalizeTokenEconomyConfig(input.tokenEconomy)
  const threadProfileInstruction = buildThreadProfileInstruction(input.threadSystemPrompt)
  const baseRequest: ModelRequest = {
    threadId: input.threadId,
    turnId: input.turnId,
    model: input.model,
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}),
    systemPrompt: input.immutablePrefix.systemPrompt,
    ...(threadProfileInstruction ? { threadProfileInstruction } : {}),
    ...(input.modeInstruction ? { modeInstruction: input.modeInstruction } : {}),
    ...(input.contextInstructions.length
      ? { contextInstructions: [...input.contextInstructions] }
      : {}),
    prefix: input.immutablePrefix.fewShots,
    history: capToolResultImages([...input.history], MAX_FORWARDED_TOOL_IMAGES),
    ...(input.attachments.imageAttachments.length
      ? { attachments: [...input.attachments.imageAttachments] }
      : {}),
    ...(input.attachments.textFallbacks.length
      ? { attachmentTextFallbacks: [...input.attachments.textFallbacks] }
      : {}),
    ...(input.attachments.documents.length
      ? { attachmentDocuments: [...input.attachments.documents] }
      : {}),
    tools: [...input.tools],
    ...(input.requiredToolName ? { requiredToolName: input.requiredToolName } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    abortSignal: input.signal
  }
  const rawInputTokens = tokenEconomy.enabled
    ? estimateModelRequestInputTokens(baseRequest)
    : 0
  const economyRequest = applyTokenEconomyToRequest(baseRequest, tokenEconomy)
  const request: ModelRequest = {
    ...economyRequest,
    history: applyRequestHistoryHygiene(
      economyRequest.history,
      tokenEconomy.historyHygiene,
      { currentTurnId: input.turnId }
    )
  }
  return {
    request,
    rawInputTokens,
    sentInputTokens: estimateModelRequestInputTokens(request),
    tokenEconomy
  }
}
