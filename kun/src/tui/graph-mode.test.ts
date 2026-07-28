import { describe, expect, it } from 'vitest'
import {
  graphNodeAssignmentLabel,
  isTerminalGraphRun,
  latestTuiGraphRun,
  moveTuiGraphBoardSelection,
  projectTuiGraphBoard,
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

  it('projects responsive board nodes, dependencies, and stable selection', () => {
    const run = testTuiGraphRun()
    const wide = projectTuiGraphBoard(run, { width: 120, height: 36 })
    expect(wide.renderMode).toBe('topology')
    expect(wide.selectedNodeId).toBe('research')
    expect(wide.nodes.find((node) => node.id === 'research')).toMatchObject({
      marker: '▶',
      assignment: 'Researcher (profile_1)',
      attemptNumber: 1,
      childThreadId: 'child_research'
    })
    expect(wide.nodes.find((node) => node.id === 'finish')?.dependencies).toEqual([
      expect.objectContaining({ from: 'research', to: 'finish', kind: 'control' })
    ])

    const selectedFinish = projectTuiGraphBoard(run, {
      selectedNodeId: 'finish',
      width: 72,
      height: 20
    })
    expect(selectedFinish.renderMode).toBe('list')
    expect(selectedFinish.selectedNodeId).toBe('finish')
    expect(moveTuiGraphBoardSelection(selectedFinish, -1)).toBe('research')

    expect(projectTuiGraphBoard(run, {
      selectedNodeId: 'removed',
      width: 120,
      height: 36
    }).selectedNodeId).toBe('research')
  })

  it('projects every node status with a textual state and stable marker', () => {
    const markers = {
      pending: '·',
      blocked: '×',
      ready: '○',
      queued: '◌',
      running: '▶',
      submitted: '◇',
      reviewing: '◆',
      accepted: '✓',
      repair_required: '↻',
      failed: '!',
      cancelled: '−',
      skipped: '↷',
      superseded: '≈'
    } as const

    for (const [status, marker] of Object.entries(markers)) {
      const run = testTuiGraphRun()
      run.nodes.research!.status = status as keyof typeof markers
      const node = projectTuiGraphBoard(run).nodes.find((candidate) => candidate.id === 'research')
      expect(node, status).toMatchObject({ status, marker })
    }
  })

  it('preserves control, data, and message edge types and their readable labels', () => {
    const run = testTuiGraphRun()
    run.plans[0]!.edges = [
      ...run.plans[0]!.edges,
      {
        id: 'edge_data',
        kind: 'data',
        from: 'research',
        to: 'finish',
        artifactName: 'report.json',
        required: true
      },
      {
        id: 'edge_message',
        kind: 'message',
        from: 'research',
        to: 'finish',
        allowedTypes: ['finding']
      }
    ]
    const dependencies = projectTuiGraphBoard(run).nodes
      .find((node) => node.id === 'finish')!.dependencies
    expect(dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'control', label: 'control' }),
      expect.objectContaining({ kind: 'data', label: 'report.json' }),
      expect.objectContaining({ kind: 'message', label: 'message' })
    ]))
  })
})
