import { createElement } from 'react'
import type { RefObject } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompactionBlock } from '../../agent/types'
import { CompactionTimelineEntry, ProcessSectionRow } from './message-timeline-process'

vi.mock('react-i18next', () => {
  const labels: Record<string, string> = {
    compactionRunning: 'Compacting context',
    compactionManualCompleted: 'Compacted context',
    compactionAutoCompleted: 'Auto-compacted context',
    compactionFailed: 'Context compaction failed',
    compactionTriggerManual: 'Manual',
    compactionTriggerAuto: 'Auto',
    compactionReleasedTokens: '~{{tokens}} tokens freed',
    compactionMessagesReduced: '{{before}} → {{after}} messages',
    compactionSummaryLabel: 'Compaction summary',
    processExpandDetail: 'Expand details',
    processCollapseDetail: 'Collapse details'
  }
  return {
    initReactI18next: { type: '3rdParty', init: () => undefined },
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        const template = labels[key] ?? key
        if (!opts) return template
        return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(opts[name] ?? ''))
      },
      i18n: { language: 'en', resolvedLanguage: 'en' }
    })
  }
})

function block(overrides: Partial<CompactionBlock>): CompactionBlock {
  return {
    kind: 'compaction',
    id: 'compaction_1',
    summary: 'Summarized the earlier conversation about the build pipeline.',
    status: 'success',
    ...overrides
  }
}

function instanceText(instance: ReactTestInstance): string {
  return instance.children.map((child) => typeof child === 'string' ? child : instanceText(child)).join('')
}

describe('CompactionTimelineEntry', () => {
  let renderer: ReactTestRenderer

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount())
  })

  function renderEntry(input: CompactionBlock, processing = false): ReactTestInstance {
    act(() => {
      renderer = create(createElement(CompactionTimelineEntry, { block: input, processing }))
    })
    return renderer.root.findByProps({ 'data-compaction-timeline-entry': 'true' })
  }

  it('labels a manual compaction and shows the released token estimate', () => {
    const row = renderEntry(block({ auto: false, messagesBefore: 120 }))
    const text = instanceText(row)
    expect(text).toContain('Compacted context')
    expect(text).toContain('Manual')
    expect(text).toContain('~120 tokens freed')
  })

  it('labels an automatic compaction as auto', () => {
    const row = renderEntry(block({ auto: true, messagesBefore: 200 }))
    const text = instanceText(row)
    expect(text).toContain('Auto-compacted context')
    expect(text).toContain('Auto')
    expect(text).toContain('~200 tokens freed')
  })

  it('treats a missing auto flag as automatic per the runtime contract', () => {
    const row = renderEntry(block({ auto: undefined, messagesBefore: 200 }))
    expect(instanceText(row)).toContain('Auto')
  })

  it('shows message counts when both bounds are present', () => {
    const row = renderEntry(block({ auto: false, messagesBefore: 40, messagesAfter: 12 }))
    expect(instanceText(row)).toContain('40 → 12 messages')
  })

  it('omits the meta line when no released tokens were reported', () => {
    const row = renderEntry(block({ auto: false, messagesBefore: undefined, messagesAfter: undefined }))
    const text = instanceText(row)
    expect(text).not.toContain('tokens freed')
  })

  it('renders a running compaction as a live status row with details open', () => {
    const row = renderEntry(block({ status: 'running', summary: 'Summarizing…' }), true)
    const text = instanceText(row)
    expect(text).toContain('Compacting context')
    // The live summary is force-open while processing.
    expect(text).toContain('Summarizing…')
    const title = row.findAll((node) => node.props.role === 'status')
    expect(title.length).toBeGreaterThan(0)
  })

  it('renders a failed compaction with error tone and expands its reason', () => {
    const row = renderEntry(block({ status: 'error', summary: 'Model summarizer timed out' }))
    expect(instanceText(row)).toContain('Context compaction failed')
    // Error tone lives on the title line, not the row container.
    const dangerTitles = row.findAll((node) =>
      typeof node.props.className === 'string' && node.props.className.includes('text-ds-danger')
    )
    expect(dangerTitles.length).toBeGreaterThan(0)
    // Collapsed by default: summary is not visible until expanded.
    expect(instanceText(row)).not.toContain('Model summarizer timed out')
    act(() => {
      row.props.onClick()
    })
    expect(instanceText(row)).toContain('Model summarizer timed out')
  })

  it('stays non-interactive when there is nothing to expand', () => {
    const row = renderEntry(block({ summary: '', detail: '', status: 'success', messagesBefore: 0 }))
    expect(row.props.role).toBeUndefined()
    expect(row.props.tabIndex).toBeUndefined()
    expect(renderer.root.findAllByType('button')).toHaveLength(0)
  })

  it('toggles the summary on click and keyboard Enter', () => {
    const row = renderEntry(block({ auto: false }))
    expect(instanceText(row)).not.toContain('Compaction summary')

    act(() => {
      row.props.onClick()
    })
    expect(instanceText(row)).toContain('Compaction summary')

    act(() => {
      row.props.onKeyDown({ key: 'Enter', preventDefault: () => undefined })
    })
    expect(instanceText(row)).not.toContain('Compaction summary')

    act(() => {
      row.props.onKeyDown({ key: ' ', preventDefault: () => undefined })
    })
    expect(instanceText(row)).toContain('Compaction summary')
  })

  it('routes a single compaction execution section to the dedicated entry', () => {
    const viewportRef = { current: null } as RefObject<HTMLDivElement | null>
    act(() => {
      renderer = create(createElement(ProcessSectionRow, {
        section: { id: 'compaction-1', kind: 'execution', blocks: [block({ auto: false, messagesBefore: 120 })] },
        processing: false,
        reasoningDurationMs: undefined,
        singleReasoningSection: false,
        workspaceRoot: '',
        viewportRef,
        onOpenChildThread: undefined,
        allowThreadActions: true
      }))
    })
    const rows = renderer.root.findAllByProps({ 'data-compaction-timeline-entry': 'true' })
    expect(rows).toHaveLength(1)
    expect(instanceText(rows[0])).toContain('Compacted context')
  })
})
