import {
  buildKunTurnContextInstructions,
  buildPersonaBlockContent,
  type KunTurnContextBlock
} from './kun-prompt-context.js'
import type { RuntimeContextSourceTurnItem, TurnItem } from '../contracts/items.js'

export type TurnDynamicContext = Readonly<{
  blocks: readonly KunTurnContextBlock[]
  instructions: readonly string[]
  privateValues: readonly string[]
  historyItems: readonly TurnItem[]
}>

/**
 * Keep a turn-selected persona in chronological request context. It must never
 * be promoted to the immutable system prompt or a delegated session fingerprint.
 */
export function turnPersonaContextBlock(
  persona: string | undefined
): KunTurnContextBlock | null {
  const content = persona?.trim()
  return content
    ? { kind: 'persona', authority: 'user', content: buildPersonaBlockContent(content) }
    : null
}

/**
 * Project request-local persona and trusted host control without allowing the
 * private source record into replay history or delegated session identity.
 */
export function projectTurnDynamicContext(input: {
  turnId: string
  persona?: string
  items: readonly TurnItem[]
}): TurnDynamicContext {
  const currentSources = input.items.filter(
    (item): item is RuntimeContextSourceTurnItem =>
      item.kind === 'runtime_context_source' && item.turnId === input.turnId
  )
  const persona = turnPersonaContextBlock(input.persona)
  const blocks: KunTurnContextBlock[] = [
    ...(persona ? [persona] : []),
    ...currentSources.map((item) => ({
      kind: item.contextKind,
      authority: 'runtime' as const,
      content: item.content
    }))
  ]
  return {
    blocks,
    instructions: buildKunTurnContextInstructions(blocks),
    privateValues: [...new Set(currentSources.map((item) => item.content))],
    historyItems: input.items.filter((item) => item.kind !== 'runtime_context_source')
  }
}
