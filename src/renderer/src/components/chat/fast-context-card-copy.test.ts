import { describe, expect, it } from 'vitest'
import type { ToolBlock } from '../../agent/types'
import {
  isBareSubagentToolName,
  isFastContextToolBlock,
  resolveFastContextTaskTitle
} from './fast-context-card-copy'

describe('fast-context-card-copy', () => {
  it('rejects bare tool names as titles', () => {
    expect(isBareSubagentToolName('fast_context')).toBe(true)
    expect(isBareSubagentToolName('explore_agent')).toBe(true)
    expect(isBareSubagentToolName('delegate_task')).toBe(true)
    expect(isBareSubagentToolName('Voice transcription flow')).toBe(false)
  })

  it('detects fast context tool blocks by tool name or profile', () => {
    const byName: ToolBlock = {
      kind: 'tool',
      id: 't1',
      createdAt: '2026-08-07T00:00:00.000Z',
      summary: 'fast_context',
      status: 'running',
      toolKind: 'tool_call',
      meta: { toolName: 'fast_context' }
    }
    expect(isFastContextToolBlock(byName)).toBe(true)

    const byProfile: ToolBlock = {
      ...byName,
      meta: { toolName: 'delegate_task' },
      detail: JSON.stringify({ profile: 'explore', title: 'Find tokens' })
    }
    expect(isFastContextToolBlock(byProfile)).toBe(true)
  })

  it('resolves a human title and never falls back to fast_context', () => {
    expect(resolveFastContextTaskTitle({
      blockSummary: 'fast_context',
      fallback: 'Fast Context task'
    })).toBe('Fast Context task')

    expect(resolveFastContextTaskTitle({
      childLabel: undefined,
      title: undefined,
      query: 'Locate where save tokens is rendered',
      summary: 'found FloatingComposer.tsx',
      blockSummary: 'fast_context',
      fallback: 'Fast Context task'
    })).toBe('Locate where save tokens is rendered')

    expect(resolveFastContextTaskTitle({
      title: 'Token save label',
      query: 'longer query text',
      fallback: 'Fast Context task'
    })).toBe('Token save label')
  })
})
