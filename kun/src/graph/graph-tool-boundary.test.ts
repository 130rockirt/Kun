import { describe, expect, it } from 'vitest'
import {
  GRAPH_WORKER_TOOL_NAMES,
  graphParentAuthorityToolNames,
  graphWorkerToolNamesWithin,
  isGraphLeadContext,
  isToolAllowedInOrchestration
} from './graph-tool-boundary.js'

describe('Graph tool boundary', () => {
  it('recognizes both selected Graph turns and automatic Graph Lead turns', () => {
    expect(isGraphLeadContext({ orchestration: 'graph' })).toBe(true)
    expect(isGraphLeadContext({
      orchestration: 'direct',
      messageSource: 'graph_runtime'
    })).toBe(true)
    expect(isGraphLeadContext({ orchestration: 'direct' })).toBe(false)
  })

  it('blocks ordinary delegation providers and legacy orchestration only in Graph', () => {
    expect(isToolAllowedInOrchestration({
      toolName: 'delegate_task',
      providerId: 'delegation',
      providerKind: 'delegation'
    }, { orchestration: 'graph' })).toBe(false)
    expect(isToolAllowedInOrchestration({
      toolName: 'task_graph',
      providerId: 'planning',
      providerKind: 'built-in'
    }, { messageSource: 'graph_runtime' })).toBe(false)
    expect(isToolAllowedInOrchestration({
      toolName: 'delegate_task',
      providerId: 'delegation',
      providerKind: 'delegation'
    }, { orchestration: 'direct' })).toBe(true)
  })

  it('builds worker authority without ordinary orchestration and with coordination tools', () => {
    const names = graphParentAuthorityToolNames([
      'read',
      'delegate_task',
      'list_subagent_profiles',
      'task_graph',
      'design_component'
    ])

    expect(names).toEqual([
      ...GRAPH_WORKER_TOOL_NAMES,
      'read'
    ].sort())
    expect(graphWorkerToolNamesWithin(names)).toEqual(
      [...GRAPH_WORKER_TOOL_NAMES].sort()
    )
  })
})
