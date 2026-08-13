import type { ChatBlock } from '../../agent/types'
import { isBackgroundShellNoticeUserMessage } from '@shared/background-shell-notice'
import { isBackgroundSubagentNoticeUserMessage } from '@shared/background-subagent-notice'
import { hasPendingRuntimeWork } from '../../store/chat-store-runtime-helpers'

export type Turn = {
  turnId?: string
  user?: Extract<ChatBlock, { kind: 'user' }>
  blocks: ChatBlock[]
}

/** Resolve historical turn intent from its durable user-item projection. */
export function turnTaskSurface(turn: Turn): 'code' | 'design' {
  const meta = turn.user?.meta
  if (meta?.agentSurface === 'design' || meta?.designProfile || meta?.guiDesignMode) return 'design'
  return 'code'
}

export function isBackgroundShellNoticeBlock(block: ChatBlock): boolean {
  return block.kind === 'user' && isBackgroundShellNoticeUserMessage(block)
}

export function isBackgroundSubagentNoticeBlock(block: ChatBlock): boolean {
  return block.kind === 'user' && isBackgroundSubagentNoticeUserMessage(block)
}

export function isGraphRuntimeNoticeBlock(block: ChatBlock): boolean {
  return block.kind === 'user' && block.meta?.messageSource === 'graph_runtime'
}

export function isDesignContinuationBlock(block: ChatBlock): boolean {
  return block.kind === 'user' && block.meta?.messageSource === 'design_continuation'
}

export function isBackgroundNoticeBlock(block: ChatBlock): boolean {
  return (
    isBackgroundShellNoticeBlock(block) ||
    isBackgroundSubagentNoticeBlock(block) ||
    isGraphRuntimeNoticeBlock(block) ||
    isDesignContinuationBlock(block)
  )
}

export function groupTurns(blocks: ChatBlock[]): Turn[] {
  const turns: Turn[] = []
  const turnsById = new Map<string, Turn>()
  let current: Turn | null = null

  for (const block of blocks) {
    const turnId = block.turnId?.trim()
    if (turnId) {
      let turn = turnsById.get(turnId)
      if (!turn) {
        turn = { turnId, blocks: [] }
        turnsById.set(turnId, turn)
        turns.push(turn)
      }
      if (block.kind === 'user' && !isBackgroundNoticeBlock(block) && !turn.user) {
        turn.user = block
      } else {
        turn.blocks.push(block)
      }
      if (block.kind === 'user' && !isBackgroundNoticeBlock(block)) current = turn
      continue
    }
    if (block.kind === 'user') {
      if (isBackgroundNoticeBlock(block)) {
        if (!current) current = { blocks: [] }
        current.blocks.push(block)
        continue
      }
      current = { user: block, blocks: [] }
      turns.push(current)
      continue
    }
    if (!current) {
      current = { blocks: [] }
      turns.push(current)
    }
    current.blocks.push(block)
  }

  return turns
}

export function stableTurnKey(turn: Turn, fallbackIndex: number): string {
  return turn.turnId ?? turn.user?.id ?? turn.blocks[0]?.id ?? `turn-${fallbackIndex}`
}

export function sameTurnContent(left: Turn, right: Turn): boolean {
  if (left.turnId !== right.turnId) return false
  if (left.user !== right.user) return false
  if (left.blocks.length !== right.blocks.length) return false
  for (let index = 0; index < left.blocks.length; index += 1) {
    if (left.blocks[index] !== right.blocks[index]) return false
  }
  return true
}

export function splitThink(text: string): { think: string; content: string } {
  const match = text.match(/<think>([\s\S]*?)(?:<\/think>|$)/)
  if (!match) return { think: '', content: text }
  return {
    think: match[1].trim(),
    content: text.replace(/<think>[\s\S]*?(?:<\/think>|$)/, '').trim()
  }
}

export function blockHasPendingRuntimeWork(block: ChatBlock): boolean {
  return hasPendingRuntimeWork(block)
}

export function isProcessBlock(block: ChatBlock): boolean {
  return (
    isBackgroundShellNoticeBlock(block) ||
    isBackgroundSubagentNoticeBlock(block) ||
    block.kind === 'reasoning' ||
    block.kind === 'tool' ||
    block.kind === 'compaction' ||
    block.kind === 'approval' ||
    block.kind === 'approval_review' ||
    block.kind === 'user_input' ||
    block.kind === 'system'
  )
}

export function findTrailingAssistantContentStart(blocks: ChatBlock[]): number {
  let start = blocks.length

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    // Completed reasoning may be persisted after final text; it should not hide the answer bubble.
    if (block.kind === 'reasoning' && start === blocks.length) continue
    if (block.kind !== 'assistant') break

    const split = splitThink(block.text)
    if (!split.content.trim()) break
    start = index
  }

  return start
}
