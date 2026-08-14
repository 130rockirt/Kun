import type { PptDirectionBundleV1 } from '../../ppt/ppt-direction-workflow.js'

type Direction = PptDirectionBundleV1['directions'][number]

export type PptPromptDirectionSelection = Pick<Direction, 'directionId' | 'revision'>

export type PptPromptDirectionSelectionResult =
  | { ok: true; selection: PptPromptDirectionSelection }
  | { ok: false; reason: 'acceptance_required' | 'direction_required' | 'ambiguous' }

/**
 * Resolve a conversational direction confirmation against the persisted host
 * bundle. Structured canvas selection wins, but is optional: a user can reply
 * with a direction number/name or explicitly accept the recommendation in the
 * normal conversation composer. No model-authored id is trusted here.
 */
export function resolvePptPromptDirectionSelection(input: {
  prompt: string
  directions: readonly Direction[]
  structuredSelection?: readonly PptPromptDirectionSelection[]
}): PptPromptDirectionSelectionResult {
  const prompt = input.prompt.trim()
  if (!explicitDirectionAcceptance(prompt)) {
    return { ok: false, reason: 'acceptance_required' }
  }
  const structured = input.structuredSelection ?? []
  if (structured.length === 1) return { ok: true, selection: structured[0] }

  return resolveDirectionReference(prompt, input.directions)
}

/** A submitted single-choice user-input answer is itself explicit consent. */
export function resolvePptUserInputDirectionSelection(input: {
  answer: string
  directions: readonly Direction[]
}): PptPromptDirectionSelectionResult {
  return resolveDirectionReference(input.answer.trim(), input.directions)
}

function resolveDirectionReference(
  prompt: string,
  directions: readonly Direction[]
): PptPromptDirectionSelectionResult {
  const matches = new Map<string, Direction>()
  const add = (direction: Direction | undefined): void => {
    if (direction) matches.set(direction.directionId, direction)
  }
  if (mentionsRecommendation(prompt)) {
    add(directions.find((direction) => direction.recommended))
  }
  const ordinal = directionOrdinal(prompt)
  if (ordinal !== undefined) add(directions[ordinal - 1])
  for (const direction of directions) {
    if (mentionsDirectionIdentity(prompt, direction)) add(direction)
  }
  if (matches.size > 1) return { ok: false, reason: 'ambiguous' }
  const selected = matches.values().next().value as Direction | undefined
  return selected
    ? { ok: true, selection: { directionId: selected.directionId, revision: selected.revision } }
    : { ok: false, reason: 'direction_required' }
}

function explicitDirectionAcceptance(prompt: string): boolean {
  if (!prompt || rejectsDirectionAcceptance(prompt)) return false
  const affirmativeVerb =
    /\b(?:accept|adopt|use|choose|select|pick|take|go with|proceed with|continue with|move forward with)\b/i.test(prompt) ||
    /(?:采用|接受|选择|选定|选中|使用|就用|按这个|按该|确定用|确认用|继续用|定第|选第)/i.test(prompt) ||
    /^(?:那就|就)\s*(?:方向|方案|风格|卡片|选项)\s*[一二三123ABCabc]/i.test(prompt)
  if (affirmativeVerb) return true
  return /^(?:就|那就)?\s*(?:第\s*)?[一二三123ABCabc]\s*(?:个|套|种|款|号)?\s*(?:方向|方案|风格|卡片)?\s*(?:吧|就好|可以|没问题|继续)?[。！!\s]*$/i.test(prompt) ||
    /^(?:就|那就)?\s*(?:这个|该方向|选中的?|它)\s*(?:吧|就好|可以|没问题|继续)[。！!\s]*$/i.test(prompt) ||
    /^(?:(?:this|that|the selected)\s+(?:one|direction)\s+)?(?:works|looks good|is good)(?:[;,]\s*(?:continue|proceed))?[.!\s]*$/i.test(prompt) ||
    /^(?:direction|option|concept|style)\s*(?:#|no\.?\s*)?[123ABC]\s*(?:works|please|is good|looks good)?[.!\s]*$/i.test(prompt)
}

function rejectsDirectionAcceptance(prompt: string): boolean {
  return /\?/.test(prompt) || /[？吗呢]\s*$/.test(prompt) ||
    /\b(?:do not|don't|never|refuse(?:d)? to|might|maybe|may|not|no)\b.{0,40}\b(?:accept|adopt|use|choose|select|pick|direction|style|concept|recommended|recommendation)\b/i.test(prompt) ||
    /(?:不要|不接受|不采用|不选择|不使用|别|拒绝|可能|也许|暂不).{0,20}(?:方向|方案|风格|卡片|推荐|建议|采用|选择)/i.test(prompt)
}

function mentionsRecommendation(prompt: string): boolean {
  return /\b(?:recommended|recommendation|your recommendation)\b/i.test(prompt) ||
    /(?:推荐|建议)(?:的)?(?:方向|方案|风格|选项)?/i.test(prompt)
}

function directionOrdinal(prompt: string): number | undefined {
  const optionLabel = prompt.match(/^\s*([123ABC])\s*[.)、:：-]\s*/i)
  if (optionLabel) return ordinalValue(optionLabel[1])
  const bare = prompt.match(/^(?:那就|就)?\s*(?:(?:方向|方案|风格|卡片|选项)\s*)?(?:第\s*)?([一二三123ABC])\s*(?:个|套|种|款|号)?(?:方向|方案|风格|卡片|选项)?\s*(?:吧|就好|可以|没问题|继续)?[。！!.\s]*$/i)
  if (bare) return ordinalValue(bare[1])
  const chinese = prompt.match(/第\s*([一二三123])\s*(?:个|套|种|款|号)?(?:方向|方案|风格|卡片|选项)?/i)
  if (chinese) return ordinalValue(chinese[1])
  const numbered = prompt.match(/(?:方向|方案|风格|卡片|选项|direction|option|concept|style)\s*(?:#|no\.?\s*)?([123ABC])\b/i)
  if (numbered) return ordinalValue(numbered[1])
  const leading = prompt.match(/\b([123ABC])(?:st|nd|rd)?\s+(?:direction|option|concept|style)\b/i)
  if (leading) return ordinalValue(leading[1])
  const numberedSuffix = prompt.match(/(?:^|\s)([123])\s*(?:号|款|个)(?:方向|方案|风格|卡片|选项)?(?:\s|$)/i)
  return numberedSuffix ? ordinalValue(numberedSuffix[1]) : undefined
}

function ordinalValue(value: string): number | undefined {
  const normalized = value.toLowerCase()
  if (normalized === '1' || normalized === '一' || normalized === 'a') return 1
  if (normalized === '2' || normalized === '二' || normalized === 'b') return 2
  if (normalized === '3' || normalized === '三' || normalized === 'c') return 3
  return undefined
}

function mentionsDirectionIdentity(prompt: string, direction: Direction): boolean {
  const haystack = normalizedIdentity(prompt)
  return [direction.directionId, direction.name].some((value) => {
    const needle = normalizedIdentity(value)
    return needle.length >= 3 && haystack.includes(needle)
  })
}

function normalizedIdentity(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s_\-–—:：/\\]+/g, '')
}
