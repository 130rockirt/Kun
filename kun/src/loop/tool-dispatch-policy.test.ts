import { describe, expect, it } from 'vitest'
import type { ToolCallLike, ToolProviderKind } from '../ports/tool-host.js'
import {
  classifyToolDispatchLane,
  collectParallelToolDispatchCandidates,
  isParallelDelegationCall,
  isParallelSafeToolCall,
  type ToolDispatchPolicy
} from './tool-dispatch-policy.js'

const call = (
  toolName: string,
  callId = `call_${toolName}`,
  toolKind?: ToolCallLike['toolKind']
): ToolCallLike => ({
  callId,
  toolName,
  ...(toolKind ? { toolKind } : {}),
  arguments: {}
})

const policy = (
  approvalPolicy: ToolDispatchPolicy['approvalPolicy'] = 'auto',
  kinds: Record<string, ToolProviderKind | undefined> = {}
): ToolDispatchPolicy => ({
  approvalPolicy,
  toolProviderKinds: new Map(Object.entries(kinds))
})

describe('tool dispatch policy', () => {
  it('classifies only supported built-in read calls as parallel read-only', () => {
    const builtIn = policy('auto', { read: 'built-in', grep: 'built-in' })

    expect(classifyToolDispatchLane(call('read'), builtIn)).toBe('read_only')
    expect(classifyToolDispatchLane(call('grep'), builtIn)).toBe('read_only')
    expect(classifyToolDispatchLane(call('read', 'call_command', 'command_execution'), builtIn)).toBe('serial')
    expect(classifyToolDispatchLane(call('read'), policy('auto', { read: 'mcp' }))).toBe('serial')
    expect(classifyToolDispatchLane(call('write'), builtIn)).toBe('serial')
  })

  it('classifies delegation-provider delegate_task and explore_agent as parallel delegation', () => {
    const delegated = policy('auto', {
      delegate_task: 'delegation',
      explore_agent: 'delegation'
    })

    expect(classifyToolDispatchLane(call('delegate_task'), delegated)).toBe('delegation')
    expect(classifyToolDispatchLane(call('explore_agent'), delegated)).toBe('delegation')
    expect(isParallelDelegationCall(call('delegate_task'), delegated)).toBe(true)
    expect(isParallelDelegationCall(call('explore_agent'), delegated)).toBe(true)
    expect(isParallelDelegationCall(call('delegate_task'), policy('auto', { delegate_task: 'built-in' }))).toBe(false)
    expect(isParallelDelegationCall(call('explore_agent'), policy('auto', { explore_agent: 'built-in' }))).toBe(false)
  })

  it.each(['always', 'untrusted', 'never'] as const)(
    'keeps %s policy calls serial',
    (approvalPolicy) => {
      const current = policy(approvalPolicy, {
        read: 'built-in',
        delegate_task: 'delegation',
        explore_agent: 'delegation'
      })
      expect(classifyToolDispatchLane(call('read'), current)).toBe('serial')
      expect(classifyToolDispatchLane(call('delegate_task'), current)).toBe('serial')
      expect(classifyToolDispatchLane(call('explore_agent'), current)).toBe('serial')
      expect(isParallelSafeToolCall(call('read'), current)).toBe(false)
    }
  )

  it('keeps contiguous read-only calls bounded and stops at a lane boundary', () => {
    const current = policy('auto', {
      read: 'built-in',
      grep: 'built-in',
      delegate_task: 'delegation'
    })
    const calls = [
      call('read', 'read_1'),
      call('grep', 'grep_1'),
      call('read', 'read_2'),
      call('read', 'read_3'),
      call('delegate_task', 'delegate_1')
    ]

    expect(collectParallelToolDispatchCandidates({ calls, startIndex: 0, policy: current }))
      .toEqual({ lane: 'read_only', calls: calls.slice(0, 3) })
    expect(collectParallelToolDispatchCandidates({ calls, startIndex: 4, policy: current }))
      .toEqual({ lane: 'delegation', calls: calls.slice(4) })
  })

  it('keeps delegation batches contiguous and returns null for serial or missing heads', () => {
    const current = policy('auto', { delegate_task: 'delegation', read: 'built-in' })
    const calls = [call('delegate_task', 'a'), call('delegate_task', 'b'), call('read', 'read')]

    expect(collectParallelToolDispatchCandidates({ calls, startIndex: 0, policy: current }))
      .toEqual({ lane: 'delegation', calls: calls.slice(0, 2) })
    expect(collectParallelToolDispatchCandidates({ calls: [call('write')], startIndex: 0, policy: current })).toBeNull()
    expect(collectParallelToolDispatchCandidates({ calls, startIndex: 9, policy: current })).toBeNull()
  })

  it('batches contiguous explore_agent calls on the delegation lane', () => {
    const current = policy('auto', {
      explore_agent: 'delegation',
      delegate_task: 'delegation',
      read: 'built-in'
    })
    const calls = [
      call('explore_agent', 'explore_1'),
      call('explore_agent', 'explore_2'),
      call('explore_agent', 'explore_3'),
      call('read', 'read_1')
    ]

    expect(collectParallelToolDispatchCandidates({ calls, startIndex: 0, policy: current }))
      .toEqual({ lane: 'delegation', calls: calls.slice(0, 3) })
    expect(collectParallelToolDispatchCandidates({ calls, startIndex: 3, policy: current }))
      .toEqual({ lane: 'read_only', calls: calls.slice(3) })
  })

  it('batches mixed contiguous delegate_task and explore_agent on the same delegation lane', () => {
    const current = policy('auto', {
      explore_agent: 'delegation',
      delegate_task: 'delegation'
    })
    const calls = [
      call('explore_agent', 'explore_1'),
      call('delegate_task', 'delegate_1'),
      call('explore_agent', 'explore_2')
    ]

    expect(collectParallelToolDispatchCandidates({ calls, startIndex: 0, policy: current }))
      .toEqual({ lane: 'delegation', calls })
  })
})
