export type ActivityVisualKind =
  | 'waiting'
  | 'thinking'
  | 'responding'
  | 'tool'
  | 'subagent'
  | 'retrying'
  | 'attention'

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const THINKING_FRAMES = ['◐', '◓', '◑', '◒'] as const
const RESPONDING_FRAMES = ['▏', '▎', '▍', '▌', '▍', '▎'] as const
const TOOL_FRAMES = ['◢', '◣', '◤', '◥'] as const
const SUBAGENT_FRAMES = ['◇', '◈', '◆', '◈'] as const
const ATTENTION_FRAMES = ['◇', '◈', '◆', '◈'] as const

const ACTIVITY_TIPS: Readonly<Record<Exclude<ActivityVisualKind, 'attention'>, readonly string[]>> = {
  waiting: [
    'Ctrl+S adds guidance while Kun is working',
    '/sessions keeps earlier work close at hand',
    '/compact makes room in a long conversation'
  ],
  thinking: [
    'Thinking stays folded; click its row to inspect it',
    'Ctrl+T changes reasoning effort for the next turn',
    'Ctrl+O reveals tool details when you need them'
  ],
  responding: [
    'The answer is printed as model fragments arrive',
    'Ctrl+S can steer the active turn',
    'Esc or Ctrl+C stops the active turn'
  ],
  tool: [
    'Ctrl+O toggles compact and expanded tool details',
    '/tasks shows subagents and background work',
    'Tool output stays bounded until you expand it'
  ],
  subagent: [
    'Click a Subagent row or use /subagents to inspect it',
    '/tasks summarizes all delegated and background work',
    'The parent turn keeps running while a child works'
  ],
  retrying: [
    'Your transcript stays intact while Kun reconnects',
    'Kun resumes the event stream from its last sequence',
    '/model can switch providers after a repeated model error'
  ]
}

export function activityFrame(kind: ActivityVisualKind, frame: number): string {
  const normalized = Math.max(0, Math.floor(frame))
  switch (kind) {
    case 'waiting':
    case 'retrying':
      return BRAILLE_FRAMES[normalized % BRAILLE_FRAMES.length]!
    case 'thinking':
      return THINKING_FRAMES[Math.floor(normalized / 2) % THINKING_FRAMES.length]!
    case 'responding':
      return RESPONDING_FRAMES[normalized % RESPONDING_FRAMES.length]!
    case 'tool':
      return TOOL_FRAMES[Math.floor(normalized / 2) % TOOL_FRAMES.length]!
    case 'subagent':
      return SUBAGENT_FRAMES[Math.floor(normalized / 3) % SUBAGENT_FRAMES.length]!
    case 'attention':
      return ATTENTION_FRAMES[Math.floor(normalized / 4) % ATTENTION_FRAMES.length]!
  }
}

export function activityTip(kind: ActivityVisualKind, identity: string): string | undefined {
  if (kind === 'attention') return undefined
  const tips = ACTIVITY_TIPS[kind]
  return tips[stableHash(`${kind}\0${identity}`) % tips.length]
}

export function formatContextGauge(totalTokens: number, contextWindowTokens: number): string {
  const total = Math.max(0, Math.floor(totalTokens))
  const context = Math.max(1, Math.floor(contextWindowTokens))
  const percentage = Math.min(999, Math.max(0, Math.round(total / context * 100)))
  return `${formatTokenCount(total)} / ${formatTokenCount(context)} · ${percentage}%`
}

export function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`
}

function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}
