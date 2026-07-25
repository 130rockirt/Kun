import type { TurnItem } from '../contracts/items.js'
import type { ModelClient, ModelRequest } from '../ports/model-client.js'
import type { RolesConfig } from '../config/kun-config.js'
import { normalizeRoleReasoningEffort } from './reasoning-effort.js'

export const DEFAULT_TITLE_TIMEOUT_MS = 12_000
export const DEFAULT_TITLE_MAX_TOKENS = 64
export const MAX_TITLE_CHARS = 50
const MAX_TITLE_INPUT_CHARS = 4_000

const TITLE_SYSTEM_PROMPT = [
  'You generate a concise title for a chat conversation.',
  'Output rules:',
  '- Output ONLY the title text on a single line. No quotes, no markdown, no prefix like "Title:".',
  `- Maximum ${MAX_TITLE_CHARS} characters.`,
  '- Summarize the user\'s intent, not the assistant\'s actions.',
  '- Never include tool names, file paths, code, or punctuation-only output.',
  '- Write in the same language as the user\'s message.'
].join('\n')

/**
 * Resolve the model + providerId for a one-shot internal role call using the
 * precedence: role override -> global smallModel -> main conversation model.
 * Returns undefined when no model is resolvable at all.
 */
export function resolveRoleModel(input: {
  roleModel?: string
  roleProviderId?: string
  roleAccountId?: string
  roles?: RolesConfig
  mainModel?: string
  mainProviderId?: string
  mainAccountId?: string
}): { model: string; providerId?: string; accountId?: string } | undefined {
  const role = trim(input.roleModel)
  if (role) {
    return {
      model: role,
      ...(trim(input.roleProviderId) ? { providerId: trim(input.roleProviderId) } : {}),
      ...(trim(input.roleAccountId) ? { accountId: trim(input.roleAccountId) } : {})
    }
  }
  const small = trim(input.roles?.smallModel)
  if (small) {
    return {
      model: small,
      ...(trim(input.roles?.smallModelProviderId) ? { providerId: trim(input.roles?.smallModelProviderId) } : {}),
      ...(trim(input.roles?.smallModelAccountId) ? { accountId: trim(input.roles?.smallModelAccountId) } : {})
    }
  }
  const main = trim(input.mainModel)
  if (main) {
    return {
      model: main,
      ...(trim(input.mainProviderId) ? { providerId: trim(input.mainProviderId) } : {}),
      ...(trim(input.mainAccountId) ? { accountId: trim(input.mainAccountId) } : {})
    }
  }
  return undefined
}

/**
 * One-shot internal LLM call that produces a single-line thread title.
 * Mirrors the compaction-summary one-shot pattern (timeout + abort + collect
 * text). Returns undefined on any failure so callers can silently keep the
 * existing default title.
 */
export async function generateThreadTitle(input: {
  threadId: string
  turnId: string
  modelClient: ModelClient
  /** Resolved model id for the title role (see resolveRoleModel). */
  model: string
  /** Optional per-provider routing id. */
  providerId?: string
  accountId?: string
  systemPrompt?: string
  /** First user message text (intent). Required for a meaningful title. */
  userText: string
  /** Reasoning depth for the title call. Invalid/missing => 'off'. */
  reasoningEffort?: string
  timeoutMs?: number
  abortSignal?: AbortSignal
}): Promise<string | undefined> {
  const userText = trim(input.userText)
  if (!userText) return undefined
  if (input.abortSignal?.aborted) return undefined

  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs ?? DEFAULT_TITLE_TIMEOUT_MS))
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  input.abortSignal?.addEventListener('abort', onAbort, { once: true })

  try {
    const promptText = buildTitlePrompt(userText)
    const requestItem: TurnItem = {
      id: `item_${input.turnId}_title_request`,
      turnId: input.turnId,
      threadId: input.threadId,
      role: 'user',
      status: 'completed',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      kind: 'user_message',
      text: promptText
    }
    const request: ModelRequest = {
      threadId: input.threadId,
      turnId: `${input.turnId}_title`,
      model: input.model,
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      contextInstructions: [TITLE_SYSTEM_PROMPT],
      prefix: [],
      history: [requestItem],
      tools: [],
      stream: true,
      maxTokens: DEFAULT_TITLE_MAX_TOKENS,
      temperature: 0,
      reasoningEffort: normalizeRoleReasoningEffort(input.reasoningEffort),
      abortSignal: controller.signal
    }
    let text = ''
    for await (const chunk of input.modelClient.stream(request)) {
      if (input.abortSignal?.aborted || controller.signal.aborted) return undefined
      if (chunk.kind === 'assistant_text_delta') text += chunk.text
      if (chunk.kind === 'error') return undefined
    }
    return sanitizeTitle(text)
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
    input.abortSignal?.removeEventListener('abort', onAbort)
  }
}

function buildTitlePrompt(userText: string): string {
  return [
    'User message:',
    clip(userText, MAX_TITLE_INPUT_CHARS),
    '',
    `Title (single line, <= ${MAX_TITLE_CHARS} chars):`
  ].join('\n')
}

/** Strip quotes/markdown/leading "Title:" and clamp to the char cap. */
export function sanitizeTitle(raw: string): string | undefined {
  let title = raw.replace(/\r/g, '').split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  title = title.replace(/^title\s*[:：]\s*/i, '')
  title = title.replace(/^["'“”『』「」]+|["'“”『』「」]+$/g, '')
  title = title.replace(/^#+\s*/, '').replace(/^\*+|\*+$/g, '')
  title = title.replace(/\s+/g, ' ').trim()
  if (!title) return undefined
  if (title.length > MAX_TITLE_CHARS) {
    title = title.slice(0, MAX_TITLE_CHARS).trim()
  }
  return title || undefined
}

function clip(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= maxChars ? compact : `${compact.slice(0, Math.max(0, maxChars - 3)).trim()}...`
}

function trim(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}
