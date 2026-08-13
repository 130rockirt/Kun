import type {
  PptCoreDesignPolicy,
  PptCoreDesignPolicyRules,
  PptPolicyExceptionRule,
  PptVisualEffect
} from './ppt-design-policy.js'

export type PptAntiPatternDetector = Readonly<{
  rule: PptPolicyExceptionRule
  label: string
  patterns: readonly RegExp[]
}>

export type PptPolicyEvaluatedPlan = Readonly<{
  colorRoles: { background: string; foreground: string }
  backgroundTreatment:
    | { kind: 'solid' }
    | { kind: 'gradient'; stops: string[] }
    | { kind: 'image' }
  effects: PptVisualEffect[]
  layoutSystem: string
  imageryStrategy: string
  policyExceptions: Array<{ rule: PptPolicyExceptionRule; evidence: string }>
}>

/** Free-text detection is a secondary lint; structured rules remain authoritative. */
export const PPT_ANTI_PATTERN_DETECTORS: readonly PptAntiPatternDetector[] = [
  { rule: 'cards-for-hierarchy', label: 'cards used for hierarchy', patterns: [/\b(?:rounded\s+)?cards?\b/i, /\brounded\s+rectangles?\b/i, /(?:卡片|圆角矩形)/] },
  {
    rule: 'equal-panel-grid',
    label: 'formulaic equal-panel grid',
    patterns: [/\b(?:equal(?:ly)?[-\s]?(?:width|sized)?\s*)?(?:panel|card|column)s?\s+grid\b/i, /\b(?:evenly divided|equal[-\s]panel|2\s*[x×]\s*2\s+(?:grid|matrix))\b/i, /(?:等宽|均分|宫格)(?:面板|卡片|网格|布局)?/]
  },
  {
    rule: 'generic-tech-gradient',
    label: 'generic blue-purple or cyan-purple gradient',
    patterns: [/\b(?:blue|cyan|teal)\s*(?:-|to|and|\/|&|\+)?\s*purple\s+(?:gradients?|neon)\b/i, /\bpurple\s*(?:-|to|and|\/|&|\+)?\s*(?:blue|cyan|teal)\s+(?:gradients?|neon)\b/i, /(?:蓝紫|青紫|紫蓝|紫青)(?:色)?(?:渐变|霓虹)/]
  },
  {
    rule: 'glow-or-glass',
    label: 'neon, glow, or glass effect',
    patterns: [/\b(?:neon|glow(?:ing)?|glassmorphism|glass[-\s]?cards?|glass(?:y)?\s+(?:effect|panel|surface)s?)\b/i, /(?:霓虹|辉光|发光|玻璃拟态|玻璃卡片|玻璃效果)/]
  },
  { rule: 'decorative-particles', label: 'decorative particles', patterns: [/\b(?:decorative\s+)?particles?\b/i, /(?:装饰性)?粒子(?:效果)?/] },
  { rule: 'ornamental-grid', label: 'ornamental grid effect', patterns: [/\b(?:ornamental|decorative)\s+grids?\b/i, /(?:装饰性)?网格(?:效果|背景)/] },
  {
    rule: 'mixed-icon-system',
    label: 'mixed icon system or emoji decoration',
    patterns: [/\b(?:mixed\s+icons?|multiple\s+icon\s+styles?|emoji(?:s)?(?:\s+decoration)?)\b/i, /(?:混用图标|多套图标|表情符号|装饰性表情)/, /\p{Extended_Pictographic}/u]
  },
  { rule: 'tiny-type', label: 'tiny type', patterns: [/\b(?:tiny|microscopic|very\s+small)\s+(?:type|text|font)s?\b/i, /(?:超小|极小|微型)(?:字号|文字|字体)/] }
]

export function detectedPptAntiPatterns(
  plan: Pick<PptPolicyEvaluatedPlan, 'layoutSystem' | 'imageryStrategy'>
): Array<{ detector: PptAntiPatternDetector; field: 'layoutSystem' | 'imageryStrategy' }> {
  return PPT_ANTI_PATTERN_DETECTORS.flatMap((detector) => {
    const field = (['layoutSystem', 'imageryStrategy'] as const).find((candidate) =>
      detector.patterns.some((pattern) => hasUnnegatedPattern(plan[candidate], pattern)))
    return field ? [{ detector, field }] : []
  })
}

/** Enforce the loaded machine-readable rules after the static plan contract is parsed. */
export function pptDesignPlanPolicyErrors(
  plan: PptPolicyEvaluatedPlan,
  policy: PptCoreDesignPolicy
): string[] {
  const errors: string[] = []
  const minimum = policy.rules.contrast.foregroundBackgroundMinimum
  const contrast = wcagContrastRatio(plan.colorRoles.background, plan.colorRoles.foreground)
  if (contrast < minimum) {
    errors.push(`colorRoles.foreground: background/foreground contrast must be at least ${minimum}:1; received ${contrast.toFixed(2)}:1`)
  }
  if (plan.backgroundTreatment.kind === 'gradient') {
    const gradientMinimum = policy.rules.contrast.foregroundGradientStopMinimum
    for (const [index, stop] of plan.backgroundTreatment.stops.entries()) {
      const stopContrast = wcagContrastRatio(stop, plan.colorRoles.foreground)
      if (stopContrast < gradientMinimum) {
        errors.push(`backgroundTreatment.stops.${index}: foreground/gradient-stop contrast must be at least ${gradientMinimum}:1; received ${stopContrast.toFixed(2)}:1`)
      }
    }
  }
  const required = requiredPptPolicyExceptions(plan, policy.rules)
  const claimed = new Set(plan.policyExceptions.map((exception) => exception.rule))
  for (const [rule, source] of required) {
    if (!claimed.has(rule)) errors.push(`${source}: policy requires source-backed exception "${rule}"`)
  }
  for (const [index, exception] of plan.policyExceptions.entries()) {
    if (!required.has(exception.rule)) {
      errors.push(`policyExceptions.${index}: exception "${exception.rule}" does not cover a declared restricted treatment`)
    }
  }
  return errors
}

function requiredPptPolicyExceptions(
  plan: PptPolicyEvaluatedPlan,
  rules: PptCoreDesignPolicyRules
): Map<PptPolicyExceptionRule, string> {
  const required = new Map<PptPolicyExceptionRule, string>()
  if (plan.backgroundTreatment.kind === 'gradient') {
    const families = new Set(plan.backgroundTreatment.stops.flatMap((color) => colorFamiliesForHex(color, rules)))
    for (const restriction of rules.backgroundRestrictions) {
      if (restriction.containsColorFamilies.every((family) => families.has(family))) {
        required.set(restriction.exceptionRule, 'backgroundTreatment.stops')
      }
    }
  }
  for (const restriction of rules.effectRestrictions) {
    if (plan.effects.includes(restriction.effect)) required.set(restriction.exceptionRule, `effects.${restriction.effect}`)
  }
  for (const { detector, field } of detectedPptAntiPatterns(plan)) required.set(detector.rule, field)
  return required
}

export function sourceRequestSupportsPptPolicyException(
  sourceRequest: string,
  exception: { rule: PptPolicyExceptionRule; evidence: string },
  rules?: PptCoreDesignPolicyRules
): boolean {
  const detector = PPT_ANTI_PATTERN_DETECTORS.find((candidate) => candidate.rule === exception.rule)
  let evidenceIndex = sourceRequest.indexOf(exception.evidence)
  while (evidenceIndex >= 0) {
    const evidenceEnd = evidenceIndex + exception.evidence.length
    const lintMatch = detector?.patterns.some((pattern) => patternMatches(sourceRequest, pattern)
      .some((match) => match.index >= evidenceIndex && match.index + match.length <= evidenceEnd)) ?? false
    const ruleMatch = rules ? machineRuleSupportsEvidence(exception.rule, exception.evidence, rules) : false
    const machineGoverned = rules ? machineRuleOwnsException(exception.rule, rules) : false
    const supported = machineGoverned ? ruleMatch : lintMatch
    if (supported && isPositivePolicyEvidence(sourceRequest, evidenceIndex, evidenceEnd)) return true
    evidenceIndex = sourceRequest.indexOf(exception.evidence, evidenceIndex + 1)
  }
  return false
}

function machineRuleOwnsException(
  rule: PptPolicyExceptionRule,
  rules: PptCoreDesignPolicyRules
): boolean {
  return rules.backgroundRestrictions.some((restriction) => restriction.exceptionRule === rule) ||
    rules.effectRestrictions.some((restriction) => restriction.exceptionRule === rule)
}

function machineRuleSupportsEvidence(
  rule: PptPolicyExceptionRule,
  evidence: string,
  rules: PptCoreDesignPolicyRules
): boolean {
  const normalized = evidence.toLocaleLowerCase()
  const colorFamilies = new Set([...evidence.matchAll(/#[0-9a-f]{6}\b/gi)]
    .flatMap((match) => colorFamiliesForHex(match[0], rules)))
  for (const [name, family] of Object.entries(rules.colorFamilies)) {
    if (family.evidenceTerms.some((term) => evidenceContainsTerm(normalized, term))) colorFamilies.add(name)
  }
  if (rules.backgroundRestrictions.some((restriction) => restriction.exceptionRule === rule &&
    restriction.evidenceTerms.some((term) => evidenceContainsTerm(normalized, term)) &&
    restriction.containsColorFamilies.every((family) => colorFamilies.has(family)))) return true
  return rules.effectRestrictions.some((restriction) => restriction.exceptionRule === rule &&
    restriction.evidenceTerms.some((term) => evidenceContainsTerm(normalized, term)))
}

function evidenceContainsTerm(normalizedEvidence: string, term: string): boolean {
  const normalizedTerm = term.toLocaleLowerCase()
  if ([...normalizedTerm].some((character) => character.codePointAt(0)! > 0x7f)) {
    return normalizedEvidence.includes(normalizedTerm)
  }
  const escaped = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu')
    .test(normalizedEvidence)
}

export function wcagContrastRatio(firstHex: string, secondHex: string): number {
  const first = relativeLuminance(firstHex)
  const second = relativeLuminance(secondHex)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

function colorFamiliesForHex(color: string, rules: PptCoreDesignPolicyRules): string[] {
  const { hue, saturation } = hslForHex(color)
  return Object.entries(rules.colorFamilies)
    .filter(([, family]) => saturation >= family.minimumSaturation &&
      family.hueRanges.some(([start, end]) => start <= end ? hue >= start && hue <= end : hue >= start || hue <= end))
    .map(([name]) => name)
}

function hslForHex(hex: string): { hue: number; saturation: number } {
  const [red, green, blue] = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const maximum = Math.max(red, green, blue)
  const minimum = Math.min(red, green, blue)
  const delta = maximum - minimum
  const lightness = (maximum + minimum) / 2
  if (delta === 0) return { hue: 0, saturation: 0 }
  const saturation = delta / (1 - Math.abs(2 * lightness - 1))
  const sector = maximum === red ? ((green - blue) / delta) % 6
    : maximum === green ? (blue - red) / delta + 2 : (red - green) / delta + 4
  return { hue: (sector * 60 + 360) % 360, saturation }
}

function relativeLuminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function hasUnnegatedPattern(value: string, pattern: RegExp): boolean {
  return patternMatches(value, pattern).some((match) => !isNegated(value, match.index))
}

function patternMatches(value: string, pattern: RegExp): Array<{ index: number; length: number }> {
  const expression = new RegExp(pattern.source, `${pattern.flags.replaceAll('g', '')}g`)
  return [...value.matchAll(expression)].map((match) => ({ index: match.index ?? 0, length: match[0].length }))
}

function isNegated(value: string, matchIndex: number): boolean {
  const prefix = value.slice(Math.max(0, matchIndex - 180), matchIndex)
  const clause = prefix.split(/(?:[.;!?。；！？]|\b(?:but|however|except|instead|yet)\b|(?:但是|但|不过|而是))/i).at(-1) ?? ''
  return /\b(?:no|not|never|avoid|avoids|avoiding|without|forbid|forbids|forbidden|exclude|reject|ban|prohibit)\b|(?:禁止|避免|不用|不使用|不要|拒绝|杜绝)/i.test(clause)
}

function isPositivePolicyEvidence(source: string, start: number, end: number): boolean {
  if (isNegated(source, start)) return false
  const clauseStart = Math.max(source.lastIndexOf('.', start - 1), source.lastIndexOf(';', start - 1), source.lastIndexOf('。', start - 1), source.lastIndexOf('；', start - 1)) + 1
  const boundary = source.slice(end).search(/[.;!?。；！？]/)
  const clause = source.slice(clauseStart, boundary < 0 ? source.length : end + boundary)
  if (/\b(?:explain|show|describe|discuss|analy[sz]e)\s+why\b|\b(?:bad|harmful|problematic|forbidden|banned|anti-pattern)\b|(?:说明|解释|展示|分析).{0,20}(?:为何|为什么).{0,40}(?:不好|有害|错误|应避免)|(?:反例|坏例子|负面案例)/i.test(clause)) return false
  return /\b(?:use|add|apply|include|feature|adopt|keep|retain|want|choose|request|with|must|should|please)\b|(?:使用|采用|添加|加入|保留|需要|请用|希望|选择)/i.test(clause)
}
