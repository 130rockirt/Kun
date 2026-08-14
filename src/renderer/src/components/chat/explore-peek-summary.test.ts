import { describe, expect, it } from 'vitest'
import type { ChatBlock } from '../../agent/types'
import {
  formatChildActivityLabel,
  readChildActivityFromBlock,
  summarizeExplorePeekBlocks
} from './explore-peek-summary'

describe('formatChildActivityLabel', () => {
  it('joins label and toolName when the tool name is not already present', () => {
    expect(formatChildActivityLabel({
      phase: 'tool',
      label: 'Searching the repository',
      toolName: 'grep',
      startedAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:01.000Z'
    })).toBe('Searching the repository · grep')
  })

  it('keeps the label alone when toolName is already embedded as a token', () => {
    expect(formatChildActivityLabel({
      phase: 'tool',
      label: 'Running grep across src',
      toolName: 'grep',
      startedAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:01.000Z'
    })).toBe('Running grep across src')
  })

  it('does not treat a substring like Reading as the read tool name', () => {
    expect(formatChildActivityLabel({
      phase: 'tool',
      label: 'Reading tool timeline UI',
      toolName: 'read',
      startedAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:01.000Z'
    })).toBe('Reading tool timeline UI · read')
  })
})

describe('readChildActivityFromBlock', () => {
  it('reads activity from tool child metadata', () => {
    const block: ChatBlock = {
      kind: 'tool',
      id: 'tool_1',
      createdAt: '2026-08-07T00:00:00.000Z',
      summary: 'Explore voice flow',
      status: 'running',
      toolKind: 'tool_call',
      meta: {
        toolName: 'fast_context',
        child: {
          childId: 'child_1',
          parentThreadId: 'thr_parent',
          parentTurnId: 'turn_1',
          childStatus: 'running',
          childSeq: 1,
          activity: {
            phase: 'tool',
            label: 'Reading tool timeline UI',
            toolName: 'read',
            startedAt: '2026-08-07T00:00:00.000Z',
            updatedAt: '2026-08-07T00:00:02.000Z'
          }
        }
      }
    }
    expect(readChildActivityFromBlock(block)).toMatchObject({
      phase: 'tool',
      label: 'Reading tool timeline UI',
      toolName: 'read'
    })
  })
})

describe('summarizeExplorePeekBlocks', () => {
  it('keeps the latest tool and reasoning steps for the peek popover', () => {
    const blocks: ChatBlock[] = [
      {
        kind: 'reasoning',
        id: 'r1',
        createdAt: '2026-08-07T00:00:00.000Z',
        text: 'I will inspect the voice transcription module next.'
      },
      {
        kind: 'tool',
        id: 't1',
        createdAt: '2026-08-07T00:00:01.000Z',
        summary: 'grep voice',
        status: 'success',
        toolKind: 'tool_call',
        meta: { toolName: 'grep' }
      },
      {
        kind: 'tool',
        id: 't2',
        createdAt: '2026-08-07T00:00:02.000Z',
        summary: 'read src/main/voice.ts',
        status: 'running',
        toolKind: 'tool_call',
        meta: { toolName: 'read' }
      }
    ]
    const peek = summarizeExplorePeekBlocks(blocks)
    expect(peek.reasoningPreview).toContain('voice transcription')
    expect(peek.steps.map((step) => step.id)).toEqual(['r1', 't1', 't2'])
    expect(peek.steps.at(-1)).toMatchObject({
      id: 't2',
      kind: 'tool',
      status: 'running'
    })
  })
})
