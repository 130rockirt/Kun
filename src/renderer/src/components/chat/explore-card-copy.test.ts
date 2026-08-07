import { describe, expect, it } from 'vitest'
import type { ToolBlock } from '../../agent/types'
import {
  isBareSubagentToolName,
  isExploreToolBlock,
  resolveExploreTaskTitle
} from './explore-card-copy'

describe('explore-card-copy', () => {
  it('rejects bare tool names as titles', () => {
    expect(isBareSubagentToolName('explore_agent')).toBe(true)
    expect(isBareSubagentToolName('delegate_task')).toBe(true)
    expect(isBareSubagentToolName('Voice transcription flow')).toBe(false)
  })

  it('detects explore tool blocks by tool name or profile', () => {
    const byName: ToolBlock = {
      kind: 'tool',
      id: 't1',
      createdAt: '2026-08-07T00:00:00.000Z',
      summary: 'explore_agent',
      status: 'running',
      toolKind: 'tool_call',
      meta: { toolName: 'explore_agent' }
    }
    expect(isExploreToolBlock(byName)).toBe(true)

    const byProfile: ToolBlock = {
      ...byName,
      meta: { toolName: 'delegate_task' },
      detail: JSON.stringify({ profile: 'explore', title: 'Find tokens' })
    }
    expect(isExploreToolBlock(byProfile)).toBe(true)
  })

  it('resolves a human title and never falls back to explore_agent', () => {
    expect(resolveExploreTaskTitle({
      blockSummary: 'explore_agent',
      fallback: 'Explore task'
    })).toBe('Explore task')

    expect(resolveExploreTaskTitle({
      childLabel: undefined,
      title: undefined,
      query: 'Locate where save tokens is rendered',
      summary: 'found FloatingComposer.tsx',
      blockSummary: 'explore_agent',
      fallback: 'Explore task'
    })).toBe('Locate where save tokens is rendered')

    expect(resolveExploreTaskTitle({
      title: 'Token save label',
      query: 'longer query text',
      fallback: 'Explore task'
    })).toBe('Token save label')
  })
})
