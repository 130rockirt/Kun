import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TrajectoryRecord } from '../../agent/trajectory'
import { trajectoryUiState } from '../../store/trajectory-ui-store'
import { mergeRecords } from './useTrajectoryData'
import { TrajectoryTimeline } from './TrajectoryTimeline'

const base = {
  schemaVersion: 1 as const,
  threadId: 'thread-1', turnId: 'turn-1', roundId: 'round-1', step: 0,
  status: 'completed' as const, detailState: 'not_captured' as const, preview: ''
}

function request(id: string, startedAt: string): TrajectoryRecord {
  return {
    ...base, id, kind: 'llm_request', requestId: id, attempt: 1,
    attemptReason: 'initial', purpose: 'assistant', provider: 'test', model: 'model',
    endpointFormat: 'chat_completions', startedAt
  }
}

describe('trajectory renderer primitives', () => {
  it('merges refreshes by stable id and keeps chronological order', () => {
    const records = mergeRecords(
      [request('new', '2026-01-02T00:00:00.000Z')],
      [request('old', '2026-01-01T00:00:00.000Z'), { ...request('new', '2026-01-02T00:00:00.000Z'), status: 'failed' }]
    )
    expect(records.map((record) => record.id)).toEqual(['old', 'new'])
    expect(records[1]?.status).toBe('failed')
  })

  it('isolates default UI state by thread and renders all three timeline lanes', () => {
    expect(trajectoryUiState({}, 'thread-a')).toMatchObject({ view: 'chat', filter: 'all' })
    const html = renderToStaticMarkup(createElement(TrajectoryTimeline, {
      records: [request('request-1', '2026-01-01T00:00:00.000Z')],
      selectedId: null,
      mode: 'actual',
      onSelect: () => undefined
    }))
    expect(html).toContain('data-testid="trajectory-timeline"')
    expect(html).toContain('trajectoryLaneInput')
    expect(html).toContain('trajectoryLaneModel')
    expect(html).toContain('trajectoryLaneTool')
  })
})
