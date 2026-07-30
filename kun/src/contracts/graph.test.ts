import { describe, expect, test } from 'vitest'
import {
  GRAPH_CONTRACT_VERSION,
  GRAPH_EVENT_VERSION,
  GraphAssignmentSnapshotV1Schema,
  GraphBudgetLedgerV1Schema,
  GraphEventEnvelopeV1Schema,
  GraphLoopGateV1Schema,
  GraphPatchV1Schema,
  GraphPlanV1Schema,
  GraphWorkerResultV1Schema
} from './graph.js'
import { RuntimeEvent } from './events.js'
import { StartTurnRequest, TurnSchema } from './turns.js'

const now = '2026-07-26T00:00:00.000Z'

function plan() {
  return {
    version: GRAPH_CONTRACT_VERSION,
    revision: 1,
    title: 'Implement and verify',
    goal: 'Implement one bounded change and verify it.',
    workspaceRoot: '/workspace',
    phases: [{ id: 'implementation', title: 'Implementation', order: 0 }],
    nodes: [{
      id: 'implement',
      phaseId: 'implementation',
      kind: 'work',
      title: 'Implement',
      objective: 'Make the requested change.',
      priority: 0,
      required: true,
      riskClass: 'low',
      assignment: {
        kind: 'ephemeral',
        name: 'Implementer',
        systemPrompt: 'Implement only the assigned objective.',
        toolPolicy: 'readOnly',
        blockedTools: [],
        blockedSkills: [],
        blockedMcpServers: []
      },
      completion: {
        requiredResultFields: ['summary', 'checks'],
        acceptanceCriteria: ['Tests pass'],
        review: {
          kinds: ['deterministic'],
          requireAll: true,
          deterministicChecks: ['npm test']
        }
      },
      readScopes: ['src'],
      writeScopes: [],
      tokenBudget: 1,
      metadata: {}
    }],
    edges: [],
    budget: {
      maxNodes: 8,
      maxEdges: 16,
      maxConcurrentNodes: 2,
      maxAttemptsPerNode: 3,
      maxRevisions: 4,
      maxLoopIterations: 0,
      maxWallTimeMs: 60_000,
      maxNodeWallTimeMs: 30_000,
      maxTotalTokens: 10_000,
      maxMessages: 32,
      maxArtifactBytes: 1_000_000,
      warningRatio: 0.8
    },
    autoStart: false,
    completionNodeIds: ['implement'],
    createdBy: 'lead',
    createdAt: now
  } as const
}

describe('Graph Mode contracts', () => {
  test('parses a versioned plan, drops legacy token limits, and rejects unsafe paths', () => {
    const parsed = GraphPlanV1Schema.parse(plan())
    expect(parsed).toMatchObject({
      revision: 1,
      nodes: [{ id: 'implement' }]
    })
    expect(parsed.budget).not.toHaveProperty('maxTotalTokens')
    expect(parsed.nodes[0]).not.toHaveProperty('tokenBudget')
    expect(() => GraphPlanV1Schema.parse({
      ...plan(),
      nodes: [{ ...plan().nodes[0], writeScopes: ['../outside'] }]
    })).toThrow(/repository relative/)
  })

  test('drops legacy token limits from loops, assignments, and warning ledgers', () => {
    const gate = GraphLoopGateV1Schema.parse({
      maxIterations: 2,
      condition: {
        sourceNodeId: 'implement',
        outcomeIn: ['repair_required']
      },
      continueTargetNodeId: 'implement',
      exitTargetNodeId: 'finish',
      maxTokenBudget: 1
    })
    expect(gate).not.toHaveProperty('maxTokenBudget')

    const assignment = GraphAssignmentSnapshotV1Schema.parse({
      version: GRAPH_CONTRACT_VERSION,
      profileId: 'profile_1',
      profileVersion: 1,
      profileOrigin: 'ephemeral',
      name: 'Implementer',
      systemPrompt: 'Implement only the assigned objective.',
      model: 'test-model',
      providerId: 'test-provider',
      allowedModelProviderIds: ['test-provider'],
      allowedModels: ['test-model'],
      allowedProviderIds: ['builtin', 'mcp:facade', 'extension:com.example.tools'],
      reasoningEffort: 'off',
      toolPolicy: 'readOnly',
      allowedTools: ['read'],
      blockedTools: [],
      allowedSkills: [],
      blockedSkills: [],
      allowedMcpServers: [],
      blockedMcpServers: [],
      approvalPolicy: 'on-request',
      sandboxMode: 'read-only',
      workspaceRoot: '/workspace',
      readScopes: ['src'],
      writeScopes: [],
      networkAllowed: false,
      maxWallTimeMs: 30_000,
      maxTokens: 1,
      capturedAt: now
    })
    expect(assignment).not.toHaveProperty('maxTokens')
    expect(assignment.approvalReviewer).toBe('user')
    expect(assignment.allowedProviderIds).toEqual([
      'builtin',
      'mcp:facade',
      'extension:com.example.tools'
    ])

    expect(() => GraphAssignmentSnapshotV1Schema.parse({
      ...assignment,
      allowedProviderIds: ['extension:valid', 'invalid\u0000provider']
    })).toThrow(/control characters/)

    const ledger = GraphBudgetLedgerV1Schema.parse({
      version: GRAPH_CONTRACT_VERSION,
      limits: plan().budget,
      attempts: 1,
      revisions: 0,
      loopIterations: 0,
      elapsedMs: 1,
      totalTokens: 1_000_000_000,
      messages: 0,
      artifactBytes: 0,
      warningKinds: ['tokens', 'time'],
      closed: false
    })
    expect(ledger.totalTokens).toBe(1_000_000_000)
    expect(ledger.warningKinds).toEqual(['time'])
  })

  test('defaults old turn requests to direct and accepts explicit graph turns', () => {
    expect(StartTurnRequest.parse({ prompt: 'hello' }).orchestration).toBe('direct')
    expect(StartTurnRequest.parse({ prompt: 'hello', orchestration: 'graph' }).orchestration).toBe('graph')
  })

  test('parses optional durable Graph Lead lifecycle metadata without breaking legacy turns', () => {
    const base = {
      id: 'turn_1',
      threadId: 'thread_1',
      status: 'running',
      prompt: 'Build this with Graph.',
      orchestration: 'graph',
      createdAt: now
    }
    expect(TurnSchema.parse(base).graphLeadLifecycle).toBeUndefined()
    expect(TurnSchema.parse({
      ...base,
      graphLeadLifecycle: {
        version: 1,
        runId: 'run_1',
        state: 'supervising',
        lastDeliveredSeq: 12,
        suspendedAt: now
      }
    }).graphLeadLifecycle).toEqual({
      version: 1,
      runId: 'run_1',
      state: 'supervising',
      lastDeliveredSeq: 12,
      suspendedAt: now
    })
  })

  test('parses a strict structured worker result', () => {
    expect(GraphWorkerResultV1Schema.parse({
      version: GRAPH_CONTRACT_VERSION,
      summary: 'Implemented and tested.',
      changedFiles: ['src/example.ts'],
      checks: [{
        name: 'unit',
        status: 'passed',
        summary: 'All tests passed.',
        artifactRefs: []
      }],
      artifactRefs: [],
      evidence: [],
      risks: [],
      suggestedMessages: []
    })).toMatchObject({ summary: 'Implemented and tested.' })
    expect(() => GraphWorkerResultV1Schema.parse({
      version: GRAPH_CONTRACT_VERSION,
      summary: 'Invalid',
      unexpected: true
    })).toThrow()
  })

  test('normalizes native Windows separators without accepting absolute paths', () => {
    expect(GraphWorkerResultV1Schema.parse({
      version: GRAPH_CONTRACT_VERSION,
      summary: 'Windows worker output',
      changedFiles: ['.\\src\\feature\\index.ts', 'src//feature/./test.ts']
    }).changedFiles).toEqual([
      'src/feature/index.ts',
      'src/feature/test.ts'
    ])
    for (const unsafe of [
      'C:\\outside\\file.ts',
      '\\\\server\\share\\file.ts',
      '/outside/file.ts',
      'src\\..\\outside.ts'
    ]) {
      expect(() => GraphWorkerResultV1Schema.parse({
        version: GRAPH_CONTRACT_VERSION,
        summary: 'Unsafe worker output',
        changedFiles: [unsafe]
      })).toThrow(/repository relative/)
    }
  })

  test('requires compare-and-swap metadata for graph patches', () => {
    expect(GraphPatchV1Schema.parse({
      version: GRAPH_CONTRACT_VERSION,
      patchId: 'patch_1',
      commandId: 'command_1',
      runId: 'run_1',
      baseRevision: 1,
      requester: { kind: 'lead', id: 'lead_1' },
      reason: 'Add independent verification.',
      operations: [{
        op: 'update_review',
        nodeId: 'implement',
        review: {
          kinds: ['deterministic', 'peer'],
          requireAll: true,
          deterministicChecks: [],
          peerCapability: 'code-review'
        }
      }],
      createdAt: now
    })).toMatchObject({ baseRevision: 1 })
  })

  test('projects graph events through the existing runtime event contract', () => {
    const graph = GraphEventEnvelopeV1Schema.parse({
      version: GRAPH_EVENT_VERSION,
      eventId: 'event_1',
      runId: 'run_1',
      threadId: 'thread_1',
      graphSeq: 1,
      graphRevision: 1,
      timestamp: now,
      event: {
        type: 'run_status_changed',
        payload: { from: 'ready', to: 'running', reason: 'started' }
      }
    })
    expect(RuntimeEvent.parse({
      kind: 'graph_event',
      seq: 10,
      timestamp: now,
      threadId: 'thread_1',
      graph
    })).toMatchObject({
      kind: 'graph_event',
      graph: { event: { type: 'run_status_changed' } }
    })
  })

  test('rejects unsupported future contract versions', () => {
    expect(() => GraphPlanV1Schema.parse({ ...plan(), version: 2 })).toThrow()
    expect(() => GraphEventEnvelopeV1Schema.parse({
      version: 2,
      eventId: 'event_1',
      runId: 'run_1',
      threadId: 'thread_1',
      graphSeq: 1,
      graphRevision: 1,
      timestamp: now,
      event: {
        type: 'run_status_changed',
        payload: { from: 'ready', to: 'running' }
      }
    })).toThrow()
  })
})
