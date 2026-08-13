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

  it('keeps native multi-call delegation for delegate_task only', () => {
    const delegated = policy('auto', {
      delegate_task: 'delegation',
      fast_context: 'delegation'
    })

    expect(classifyToolDispatchLane(call('delegate_task'), delegated)).toBe('delegation')
    expect(classifyToolDispatchLane(call('fast_context'), delegated)).toBe('serial')
    expect(isParallelDelegationCall(call('delegate_task'), delegated)).toBe(true)
    expect(isParallelDelegationCall(call('fast_context'), delegated)).toBe(false)
    expect(isParallelDelegationCall(call('delegate_task'), policy('auto', { delegate_task: 'built-in' }))).toBe(false)
    expect(isParallelDelegationCall(call('fast_context'), policy('auto', { fast_context: 'built-in' }))).toBe(false)
  })

  it.each(['always', 'untrusted', 'never'] as const)(
    'keeps %s policy calls serial',
    (approvalPolicy) => {
      const current = policy(approvalPolicy, {
        read: 'built-in',
        delegate_task: 'delegation',
        fast_context: 'delegation'
      })
      expect(classifyToolDispatchLane(call('read'), current)).toBe('serial')
      expect(classifyToolDispatchLane(call('delegate_task'), current)).toBe('serial')
      expect(classifyToolDispatchLane(call('fast_context'), current)).toBe('serial')
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

  it('does not batch fast_context calls outside their internal task batch', () => {
    const current = policy('auto', {
      fast_context: 'delegation',
      delegate_task: 'delegation',
      read: 'built-in'
    })
    const calls = [
      call('fast_context', 'explore_1'),
      call('fast_context', 'explore_2'),
      call('fast_context', 'explore_3'),
      call('read', 'read_1')
    ]

    expect(collectParallelToolDispatchCandidates({ calls, startIndex: 0, policy: current }))
      .toBeNull()
    expect(collectParallelToolDispatchCandidates({ calls, startIndex: 3, policy: current }))
      .toEqual({ lane: 'read_only', calls: calls.slice(3) })
  })

  it('stops delegate_task batches at an fast_context boundary', () => {
    const current = policy('auto', {
      fast_context: 'delegation',
      delegate_task: 'delegation'
    })
    const calls = [
      call('delegate_task', 'delegate_1'),
      call('fast_context', 'explore_1'),
      call('delegate_task', 'delegate_2')
    ]

    expect(collectParallelToolDispatchCandidates({ calls, startIndex: 0, policy: current }))
      .toEqual({ lane: 'delegation', calls: calls.slice(0, 1) })
  })
})
