import type { ChatBlock, ToolBlock } from '../../agent/types'
import {
  extractDiffFilePath,
  extractUnifiedDiffText,
  formatFilePathForDisplay,
} from '../../lib/diff-stats'
import {
  isProcessBlock,
  splitThink,
  type Turn
} from './message-timeline-turns'

export type TurnAssistantBlock = Extract<ChatBlock, { kind: 'assistant' }>
export type TurnRuntimeErrorBlock = Extract<ChatBlock, { kind: 'system' }> & { runtimeError: true }

export type TurnSections = {
  processBlocks: ChatBlock[]
  assistantContentBlocks: TurnAssistantBlock[]
  runtimeErrorBlocks: TurnRuntimeErrorBlock[]
  componentPrototypeBlocks: ToolBlock[]
  generatedFileBlocks: ToolBlock[]
  turnFileChanges: ToolBlock[]
}

type ResolvedFileChangeBlock = ToolBlock & {
  detail: string
  filePath: string
}

type DeriveTurnSectionsInput = {
  turn: Turn
  isProcessing: boolean
  /** Reserved for call-site clarity; live thinking is rendered at the turn bottom. */
  liveProcessText: string
  /** Reserved for call-site clarity; live assistant is rendered by MessageTimeline. */
  liveContent: string
  workspaceRoot: string
}

function fileChangeGroupKey(filePath: string): string {
  return filePath.trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

function mergeFileChangeBlocks(changes: ResolvedFileChangeBlock[]): ToolBlock[] {
  const merged: ResolvedFileChangeBlock[] = []
  const indexByPath = new Map<string, number>()

  for (const change of changes) {
    const key = fileChangeGroupKey(change.filePath)
    const existingIndex = indexByPath.get(key)
    if (existingIndex === undefined) {
      indexByPath.set(key, merged.length)
      merged.push(change)
      continue
    }

    const existing = merged[existingIndex]
    merged[existingIndex] = {
      ...existing,
      detail: [existing.detail, change.detail].filter(Boolean).join('\n\n')
    }
  }

  return merged
}

function metaArrayLength(meta: Record<string, unknown> | undefined, key: string): number {
  const value = meta?.[key]
  return Array.isArray(value) ? value.length : 0
}

function hasGeneratedFiles(block: ToolBlock): boolean {
  return (
    block.status === 'success' &&
    (metaArrayLength(block.meta, 'attachments') > 0 || metaArrayLength(block.meta, 'generatedFiles') > 0)
  )
}

/**
 * Pure derivation of a turn's three view slices:
 *  - `processBlocks`: chronological reasoning/tool/compaction/approval
 *    trace. Ordinary assistant text never moves into this collapsed region.
 *  - `assistantContentBlocks`: all assistant content for the turn, merged into
 *    one stable visible message body.
 *  - `turnFileChanges`: successful file_change tool blocks whose detail
 *    is a unified diff, with paths normalised for display.
 *
 * Pulled out of `MessageTurn` so the derivation is testable in isolation
 * and the component body stays focused on rendering.
 */
export function deriveTurnSections({
  turn,
  isProcessing,
  liveProcessText: _liveProcessText,
  liveContent: _liveContent,
  workspaceRoot
}: DeriveTurnSectionsInput): TurnSections {
  const processBlocks: ChatBlock[] = []
  const assistantContentBlocks: TurnAssistantBlock[] = []
  const runtimeErrorBlocks: TurnRuntimeErrorBlock[] = []

  for (const block of turn.blocks) {
    if (block.kind === 'system' && block.runtimeError === true) {
      runtimeErrorBlocks.push(block as TurnRuntimeErrorBlock)
      continue
    }
    if (block.kind === 'assistant') {
      const split = splitThink(block.text)
      if (split.think) {
        processBlocks.push({
          kind: 'reasoning',
          id: `${block.id}-think`,
          turnId: block.turnId,
          createdAt: block.createdAt,
          text: split.think
        })
      }
      if (split.content.trim()) {
        assistantContentBlocks.push({ ...block, text: split.content })
      }
      continue
    }
    if (isProcessBlock(block)) {
      processBlocks.push(block)
    }
  }

  // Live thinking and streaming assistant text are rendered at the turn
  // bottom / as a dedicated MessageBubble by MessageTimeline. Keep them out
  // of processBlocks so loading chrome cannot interleave above later text
  // or replace completed tool summaries.

  const turnFileChanges: ToolBlock[] = isProcessing
    ? []
    : mergeFileChangeBlocks(turn.blocks.flatMap((block): ResolvedFileChangeBlock[] => {
        if (
          !(block.kind === 'tool' && block.toolKind === 'file_change' && block.status === 'success')
        ) {
          return []
        }

        const detailText = extractUnifiedDiffText(block.detail)
        if (!detailText) return []

        const resolvedFilePath = formatFilePathForDisplay(
          extractDiffFilePath(detailText, block.filePath),
          workspaceRoot
        )
        if (!resolvedFilePath) return []

        return [{ ...block, detail: detailText, filePath: resolvedFilePath }]
      }))

  const generatedFileBlocks: ToolBlock[] = turn.blocks.filter(
    (block): block is ToolBlock => block.kind === 'tool' && hasGeneratedFiles(block)
  )

  const componentPrototypeBlocks: ToolBlock[] = turn.blocks.filter((block): block is ToolBlock => (
    block.kind === 'tool' &&
    block.meta?.toolName === 'design_component' &&
    Boolean(block.meta.componentPrototype)
  ))

  const visibleAssistantBlocks: TurnAssistantBlock[] = assistantContentBlocks.length <= 1
    ? assistantContentBlocks
    : [{
        ...assistantContentBlocks[0],
        id: turn.turnId ? `assistant-turn-${turn.turnId}` : assistantContentBlocks[0].id,
        text: assistantContentBlocks.map((block) => block.text.trim()).filter(Boolean).join('\n\n')
      }]

  return {
    processBlocks,
    assistantContentBlocks: visibleAssistantBlocks,
    runtimeErrorBlocks,
    componentPrototypeBlocks,
    generatedFileBlocks,
    turnFileChanges
  }
}
