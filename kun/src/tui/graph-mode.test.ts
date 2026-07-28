import { describe, expect, it } from 'vitest'
import {
  graphNodeAssignmentLabel,
  isTerminalGraphRun,
  latestTuiGraphRun,
  renderTuiGraphStatus,
  summarizeTuiGraphRun
} from './graph-mode.js'
import { testTuiGraphRun } from './graph-mode.test-support.js'

describe('TUI Graph projection', () => {
  it('summarizes durable run progress and effective subagent assignment', () => {
    const run = testTuiGraphRun()
    expect(summarizeTuiGraphRun(run)).toMatchObject({
      runId: 'run_1',
      title: 'Test graph',
      status: 'running',
      accepted: 0,
      settled: 0,
      active: 1,
      activeAgents: 1,
      total: 2
    })
    expect(graphNodeAssignmentLabel(run.nodes.research!))
      .toBe('Researcher (profile_1)')
  })

  it('renders a bounded phase, dependency, assignment, child, and reason view', () => {
    const lines = renderTuiGraphStatus(testTuiGraphRun())
    const text = lines.join('\n')
    expect(text).toContain('[Phase 1] Implementation')
    expect(text).toContain('Research · running · agent Researcher (profile_1)')
    expect(text).toContain('child: child_research')
    expect(text).toContain('depends: research')
    expect(text).toContain('reason: Waiting for research.')

    const bounded = renderTuiGraphStatus(testTuiGraphRun(), 1).join('\n')
    expect(bounded).toContain('1 more nodes omitted')
  })

  it('prefers an active attached run and keeps the latest terminal run inspectable', () => {
    const active = testTuiGraphRun()
    const terminal = testTuiGraphRun({
      id: 'run_terminal',
      status: 'completed',
      updatedAt: '2026-07-26T01:00:00.000Z'
    })
    expect(latestTuiGraphRun([terminal, active])?.id).toBe(active.id)
    expect(isTerminalGraphRun(active)).toBe(false)
    expect(isTerminalGraphRun(terminal)).toBe(true)
    expect(latestTuiGraphRun([terminal])?.id).toBe('run_terminal')
  })
})
