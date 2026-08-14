import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { InMemoryEventBus } from '../../src/adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../../src/adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../../src/adapters/in-memory-thread-store.js'
import { LocalToolHost, echoTool, type LocalTool } from '../../src/adapters/tool/local-tool-host.js'
import { InMemoryArtifactStore } from '../../src/artifacts/artifact-store.js'
import { createImmutablePrefix } from '../../src/cache/immutable-prefix.js'
import { DEFAULT_GRAPH_RUNTIME_CONFIG } from '../../src/config/kun-config.js'
import { emptyUsageSnapshot } from '../../src/contracts/usage.js'
import { createThreadRecord } from '../../src/domain/thread.js'
import type { ApprovalRequest } from '../../src/domain/approval.js'
import { InflightTracker } from '../../src/loop/inflight-tracker.js'
import { SteeringQueue } from '../../src/loop/steering-queue.js'
import { ContextCompactor } from '../../src/loop/context-compactor.js'
import {
  AgentLoop,
  buildRuntimeContextInstruction,
  isStalePlanContext,
  resolvePlanModeToolSpecs,
  shouldInjectInitialRuntimeContext,
  svgArtifactCompletionState,
  turnHasUnverifiedSourceChanges
} from '../../src/loop/agent-loop.js'
import { SequentialIdGenerator } from '../../src/ports/id-generator.js'
import type { ModelClient, ModelRequest, ModelStreamChunk, ModelToolSpec } from '../../src/ports/model-client.js'
import type { UserInputGate, UserInputRequest, UserInputResolution } from '../../src/ports/user-input-gate.js'
import { GraphRuntimeComposition } from '../../src/server/graph-runtime-factory.js'
import { RuntimeEventRecorder } from '../../src/services/runtime-event-recorder.js'
import { TurnService } from '../../src/services/turn-service.js'
import { UsageService } from '../../src/services/usage-service.js'

function spec(name: string): ModelToolSpec {
  return {
    name,
    description: `Tool: ${name}`,
    toolKind: name === 'create_plan' || name === 'write' || name === 'edit'
      ? 'file_change'
      : 'tool_call',
    inputSchema: { type: 'object', properties: {} }
  }
}

function result(input: {
  id: string
  toolName: string
  toolKind: 'file_change' | 'command_execution'
  path?: string
  turnId?: string
  isError?: boolean
}) {
  return {
    id: input.id,
    threadId: 'thread_1',
    turnId: input.turnId ?? 'turn_1',
    role: 'tool' as const,
    kind: 'tool_result' as const,
    toolName: input.toolName,
    callId: `call_${input.id}`,
    toolKind: input.toolKind,
    output: input.path ? { relative_path: input.path } : {},
    isError: input.isError ?? false,
    status: 'completed' as const,
    createdAt: '2000-01-02T03:04:05.000Z'
  }
}

function svgResult(
  id: string,
  toolName: 'design_svg_edit' | 'design_svg_animate' | 'design_svg_validate',
  revision: string,
  options: { isError?: boolean; ok?: boolean; turnId?: string } = {}
) {
  return {
    id,
    threadId: 'thread_1',
    turnId: options.turnId ?? 'turn_1',
    role: 'tool' as const,
    kind: 'tool_result' as const,
    toolName,
    callId: `call_${id}`,
    toolKind: toolName === 'design_svg_validate' ? 'tool_call' as const : 'file_change' as const,
    output: { ok: options.ok ?? true, revision },
    isError: options.isError ?? false,
    status: 'completed' as const,
    createdAt: '2000-01-02T03:04:05.000Z'
  }
}

const ALL_TOOLS: ModelToolSpec[] = [
  spec('read'),
  spec('write'),
  spec('edit'),
  spec('ls'),
  spec('glob'),
  spec('grep'),
  spec('bash'),
  spec('web_search'),
  spec('web_fetch'),
  spec('create_plan')
]

const READ_ONLY_TOOLS = new Set([
  'read', 'ls', 'glob', 'grep', 'web_search', 'web_fetch'
])

describe('svgArtifactCompletionState', () => {
  it('requires a successful mutation followed by matching-revision validation', () => {
    expect(svgArtifactCompletionState([
      svgResult('edit', 'design_svg_edit', 'r1'),
      svgResult('validate', 'design_svg_validate', 'r1')
    ], 'turn_1')).toMatchObject({
      mutationSucceeded: true,
      validationAfterMutation: true,
      mutationRevision: 'r1',
      validationRevision: 'r1'
    })
  })

  it('rejects validation before mutation, stale revisions, failed results, and other turns', () => {
    expect(svgArtifactCompletionState([
      svgResult('before', 'design_svg_validate', 'r0'),
      svgResult('failed', 'design_svg_edit', 'r1', { isError: true }),
      svgResult('other', 'design_svg_edit', 'r2', { turnId: 'turn_2' }),
      svgResult('edit', 'design_svg_animate', 'r2'),
      svgResult('stale', 'design_svg_validate', 'r1')
    ], 'turn_1')).toMatchObject({
      mutationSucceeded: true,
      validationAfterMutation: false,
      mutationRevision: 'r2',
      validationRevision: 'r1'
    })
  })
})

describe('turnHasUnverifiedSourceChanges', () => {
  it('flags an unverified source edit so the optional nudge can appear', () => {
    expect(turnHasUnverifiedSourceChanges([
      result({ id: 'write', toolName: 'write', toolKind: 'file_change', path: 'src/app.ts' })
    ], 'turn_1')).toBe(true)
  })

  it('ignores non-source changes (docs/HTML written in write/design/SDD modes)', () => {
    expect(turnHasUnverifiedSourceChanges([
      result({ id: 'doc', toolName: 'write', toolKind: 'file_change', path: 'notes.md' }),
      result({ id: 'page', toolName: 'write', toolKind: 'file_change', path: '.kun-design/a/v1.html' })
    ], 'turn_1')).toBe(false)
  })

  it('ignores failed edits and create_plan artifacts', () => {
    expect(turnHasUnverifiedSourceChanges([
      result({ id: 'failed', toolName: 'edit', toolKind: 'file_change', path: 'src/a.ts', isError: true }),
      result({ id: 'plan', toolName: 'create_plan', toolKind: 'file_change', path: 'plan.md' })
    ], 'turn_1')).toBe(false)
  })

  it('clears after a verify_changes run and re-arms on the next source edit', () => {
    expect(turnHasUnverifiedSourceChanges([
      result({ id: 'write', toolName: 'write', toolKind: 'file_change', path: 'src/a.ts' }),
      result({ id: 'verify', toolName: 'verify_changes', toolKind: 'command_execution' })
    ], 'turn_1')).toBe(false)

    expect(turnHasUnverifiedSourceChanges([
      result({ id: 'write', toolName: 'write', toolKind: 'file_change', path: 'src/a.ts' }),
      result({ id: 'verify', toolName: 'verify_changes', toolKind: 'command_execution' }),
      result({ id: 'repair', toolName: 'edit', toolKind: 'file_change', path: 'src/a.ts' })
    ], 'turn_1')).toBe(true)
  })

  it('ignores changes from other turns', () => {
    expect(turnHasUnverifiedSourceChanges([
      result({ id: 'other', toolName: 'write', toolKind: 'file_change', path: 'src/a.ts', turnId: 'turn_2' })
    ], 'turn_1')).toBe(false)
  })
})

describe('isStalePlanContext', () => {
  it('treats a workspace-mismatched plan context as stale (the fork bug)', () => {
    // A fork keeps the source thread's workspace; a plan context pointing at a
    // different workspace must be ignored, not passed to create_plan.
    expect(isStalePlanContext({ workspaceRoot: '/work/a' }, '/work/b')).toBe(true)
  })

  it('keeps a matching plan context (normalizing trailing slash / case)', () => {
    expect(isStalePlanContext({ workspaceRoot: '/work/a' }, '/work/a')).toBe(false)
    expect(isStalePlanContext({ workspaceRoot: '/work/a/' }, '/work/a')).toBe(false)
    expect(isStalePlanContext({ workspaceRoot: '/Work/A' }, '/work/a')).toBe(false)
  })

  it('is not stale when there is no plan context', () => {
    expect(isStalePlanContext(undefined, '/work/a')).toBe(false)
  })
})

describe('resolvePlanModeToolSpecs', () => {
  it('keeps only read-only tools available while the plan is unsaved', () => {
    const result = resolvePlanModeToolSpecs(ALL_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 0,
      readOnlyToolNames: READ_ONLY_TOOLS
    })
    const names = result.map((t) => t.name)
    expect(names).toContain('read')
    expect(names).toContain('ls')
    expect(names).toContain('glob')
    expect(names).toContain('grep')
    expect(names).toContain('web_search')
    expect(names).toContain('web_fetch')
    expect(names).toContain('create_plan')
    expect(names).not.toContain('write')
    expect(names).not.toContain('edit')
    expect(names).not.toContain('bash')
  })

  it('step 0: allows host-classified read-only MCP tools but not unknown calls', () => {
    const tools: ModelToolSpec[] = [
      { ...spec('mcp_read_resource'), sideEffect: 'read-only', providerKind: 'mcp' },
      { ...spec('mcp_call'), providerKind: 'mcp' },
      spec('create_plan')
    ]
    const result = resolvePlanModeToolSpecs(tools, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 0,
      readOnlyToolNames: new Set()
    })

    expect(result.map((tool) => tool.name)).toEqual(['mcp_read_resource', 'create_plan'])
  })

  it('step > 0: preserves investigation tools instead of forcing create_plan immediately', () => {
    const result = resolvePlanModeToolSpecs(ALL_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 1,
      readOnlyToolNames: READ_ONLY_TOOLS
    })
    expect(result.map((tool) => tool.name)).toEqual([
      'read',
      'ls',
      'glob',
      'grep',
      'web_search',
      'web_fetch',
      'create_plan'
    ])
  })

  it('plan satisfied: keeps read-only tools but removes create_plan and mutation tools', () => {
    const result = resolvePlanModeToolSpecs(ALL_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: true,
      stepIndex: 0,
      readOnlyToolNames: READ_ONLY_TOOLS
    })
    expect(result.map((tool) => tool.name)).toEqual([
      'read',
      'ls',
      'glob',
      'grep',
      'web_search',
      'web_fetch'
    ])
  })

  it('not plan-active: returns all tools unchanged (pass-through)', () => {
    const result = resolvePlanModeToolSpecs(ALL_TOOLS, {
      planTurnActive: false,
      createPlanSatisfied: false,
      stepIndex: 0,
      readOnlyToolNames: READ_ONLY_TOOLS
    })
    expect(result).toBe(ALL_TOOLS)
  })

  it('uses PLAN_READ_ONLY_TOOL_NAMES default when readOnlyToolNames omitted', () => {
    const result = resolvePlanModeToolSpecs(ALL_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 0
    })
    const names = result.map((t) => t.name)
    // Default set excludes bash
    expect(names).not.toContain('bash')
    expect(names).toContain('create_plan')
    expect(names).toContain('read')
  })

  it('uses CREATE_PLAN_TOOL_NAME default when planToolName omitted', () => {
    const result = resolvePlanModeToolSpecs(ALL_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 1
    })
    expect(result.map((tool) => tool.name)).toContain('create_plan')
  })

  it('custom readOnlyToolNames and planToolName', () => {
    const customTools: ModelToolSpec[] = [
      spec('custom-read'),
      spec('custom-plan'),
      spec('write'),
      spec('bash')
    ]
    const result = resolvePlanModeToolSpecs(customTools, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 0,
      readOnlyToolNames: new Set(['custom-read']),
      planToolName: 'custom-plan'
    })
    const names = result.map((t) => t.name)
    expect(names).toContain('custom-read')
    expect(names).toContain('custom-plan')
    expect(names).not.toContain('write')
    expect(names).not.toContain('bash')
  })

  const WITH_INPUT_TOOLS: ModelToolSpec[] = [
    spec('read'),
    spec('write'),
    spec('create_plan'),
    spec('user_input'),
    spec('request_user_input')
  ]

  it('step 0: allows the structured user-input tools (so plan turns can ask)', () => {
    const result = resolvePlanModeToolSpecs(WITH_INPUT_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 0,
      readOnlyToolNames: READ_ONLY_TOOLS
    })
    const names = result.map((t) => t.name)
    expect(names).toContain('user_input')
    expect(names).toContain('request_user_input')
    expect(names).toContain('create_plan')
    expect(names).not.toContain('write')
  })

  it('step > 0: keeps investigation and user-input tools available', () => {
    const result = resolvePlanModeToolSpecs(WITH_INPUT_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 1,
      readOnlyToolNames: READ_ONLY_TOOLS
    })
    expect(result.map((t) => t.name)).toEqual([
      'read',
      'create_plan',
      'user_input',
      'request_user_input'
    ])
  })

  it('custom interactiveToolNames overrides the default user-input set', () => {
    const result = resolvePlanModeToolSpecs(WITH_INPUT_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 0,
      readOnlyToolNames: READ_ONLY_TOOLS,
      interactiveToolNames: new Set(['user_input'])
    })
    const names = result.map((t) => t.name)
    expect(names).toContain('user_input')
    expect(names).not.toContain('request_user_input')
  })
})

describe('buildRuntimeContextInstruction', () => {
  it('includes the opened project absolute path and formatted local time context', () => {
    const instruction = buildRuntimeContextInstruction({
      workspace: '/tmp/kun-test-project',
      nowIso: '2000-01-02T03:04:05.000Z',
      timeZone: 'UTC'
    })

    expect(instruction).toContain('Current opened project absolute path: `/tmp/kun-test-project`')
    expect(instruction).toContain('Current user local time: 2000-01-02 03:04:05 Sunday (UTC')
    expect(instruction).toContain('GMT')
    expect(instruction).toContain('Treat this block as environment context')
  })

  it('normalizes relative workspace paths to absolute paths', () => {
    const instruction = buildRuntimeContextInstruction({
      workspace: 'relative-project',
      nowIso: '2026-06-21T04:30:15.000Z',
      timeZone: 'UTC'
    })

    expect(instruction).toContain(`Current opened project absolute path: \`${resolve('relative-project')}\``)
  })
})

describe('shouldInjectInitialRuntimeContext', () => {
  it('injects only for the first model step of the first thread turn', () => {
    expect(shouldInjectInitialRuntimeContext({
      stepIndex: 0,
      turnId: 'turn_1',
      historyItems: [
        {
          id: 'item_turn_1_user',
          threadId: 'thread_1',
          turnId: 'turn_1',
          role: 'user',
          kind: 'user_message',
          text: 'hello',
          status: 'completed',
          createdAt: '2000-01-02T03:04:05.000Z'
        }
      ]
    })).toBe(true)
  })

  it('does not inject for tool continuations or later turns', () => {
    const currentTurnItem = {
      id: 'item_turn_2_user',
      threadId: 'thread_1',
      turnId: 'turn_2',
      role: 'user' as const,
      kind: 'user_message' as const,
      text: 'next',
      status: 'completed' as const,
      createdAt: '2000-01-02T03:04:05.000Z'
    }
    expect(shouldInjectInitialRuntimeContext({
      stepIndex: 1,
      turnId: 'turn_2',
      historyItems: [currentTurnItem]
    })).toBe(false)
    expect(shouldInjectInitialRuntimeContext({
      stepIndex: 0,
      turnId: 'turn_2',
      historyItems: [
        {
          ...currentTurnItem,
          id: 'item_turn_1_user',
          turnId: 'turn_1',
          text: 'previous'
        },
        currentTurnItem
      ]
    })).toBe(false)
  })
})
