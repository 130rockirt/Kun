import type { ChatBlock, RuntimeChildActivity, ToolBlock } from '../../agent/types'

export type ExplorePeekStep = {
  id: string
  kind: 'tool' | 'reasoning' | 'assistant'
  label: string
  status?: ToolBlock['status']
}

const MAX_PEEK_STEPS = 12
const MAX_REASONING_CHARS = 280

export function formatChildActivityLabel(
  activity: RuntimeChildActivity | undefined | null
): string | undefined {
  if (!activity?.label?.trim()) return undefined
  const label = activity.label.trim()
  const toolName = activity.toolName?.trim()
  if (toolName && !labelMentionsToolName(label, toolName)) {
    return `${label} · ${toolName}`
  }
  return label
}

function labelMentionsToolName(label: string, toolName: string): boolean {
  const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`, 'i').test(label)
}

export function readChildActivityFromBlock(block: ChatBlock): RuntimeChildActivity | undefined {
  if (block.kind !== 'tool' && block.kind !== 'approval') return undefined
  const child = block.meta?.child
  if (!child || typeof child !== 'object' || Array.isArray(child)) return undefined
  const activity = (child as Record<string, unknown>).activity
  if (!activity || typeof activity !== 'object' || Array.isArray(activity)) return undefined
  const record = activity as Record<string, unknown>
  const phase = record.phase
  const label = typeof record.label === 'string' ? record.label.trim() : ''
  if (!label) return undefined
  if (
    phase !== 'starting' &&
    phase !== 'thinking' &&
    phase !== 'responding' &&
    phase !== 'tool' &&
    phase !== 'retrying' &&
    phase !== 'compacting' &&
    phase !== 'waiting'
  ) {
    return undefined
  }
  return {
    phase,
    label,
    ...(typeof record.toolName === 'string' && record.toolName.trim()
      ? { toolName: record.toolName.trim() }
      : {}),
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : ''
  }
}

export function summarizeExplorePeekBlocks(blocks: ChatBlock[]): {
  steps: ExplorePeekStep[]
  reasoningPreview?: string
  assistantPreview?: string
} {
  const steps: ExplorePeekStep[] = []
  let reasoningPreview: string | undefined
  let assistantPreview: string | undefined

  for (const block of blocks) {
    if (block.kind === 'tool') {
      const toolName =
        typeof block.meta?.toolName === 'string' && block.meta.toolName.trim()
          ? block.meta.toolName.trim()
          : 'tool'
      const summary = block.summary?.trim()
      steps.push({
        id: block.id,
        kind: 'tool',
        label: summary && summary !== toolName ? summary : toolName,
        status: block.status
      })
      continue
    }
    if (block.kind === 'reasoning') {
      const text = block.text.trim()
      if (!text) continue
      if (!reasoningPreview) reasoningPreview = truncatePeekText(text, MAX_REASONING_CHARS)
      steps.push({
        id: block.id,
        kind: 'reasoning',
        label: truncatePeekText(text, 96)
      })
      continue
    }
    if (block.kind === 'assistant') {
      const text = stripThinkTags(block.text).trim()
      if (!text) continue
      if (!assistantPreview) assistantPreview = truncatePeekText(text, MAX_REASONING_CHARS)
      steps.push({
        id: block.id,
        kind: 'assistant',
        label: truncatePeekText(text, 96)
      })
    }
  }

  return {
    steps: steps.slice(-MAX_PEEK_STEPS),
    ...(reasoningPreview ? { reasoningPreview } : {}),
    ...(assistantPreview ? { assistantPreview } : {})
  }
}

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '').trim()
}

function truncatePeekText(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}
