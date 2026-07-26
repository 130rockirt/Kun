import {
  DEFAULT_GRAPH_RUNTIME_CONFIG,
  GraphRuntimeConfigSchema,
  type GraphRuntimeConfig
} from '../config/kun-config.js'
import {
  GRAPH_CONTRACT_VERSION,
  GRAPH_EVENT_VERSION,
  GraphAssignmentSnapshotV1Schema,
  GraphEventEnvelopeV1Schema,
  GraphPlanV1Schema,
  type GraphAssignmentSnapshotV1,
  type GraphDomainEventV1,
  type GraphEventEnvelopeV1,
  type GraphPlanV1
} from '../contracts/graph.js'
import type { ChildRunRecord } from '../delegation/delegation-runtime.js'

export const TEST_GRAPH_NOW = '2026-07-26T00:00:00.000Z'

export function testCompletedChild(id: string, summary: string): ChildRunRecord {
  const now = new Date().toISOString()
  return {
    id,
    parentThreadId: 'thread_harness',
    parentTurnId: 'turn_harness',
    prompt: 'test prompt',
    status: 'completed',
    returnFormat: 'evidence',
    summary: JSON.stringify({
      summary,
      changedFiles: [],
      checks: [{ name: 'verification', status: 'passed', summary: 'Passed.' }],
      evidence: ['bounded evidence'],
      risks: []
    }),
    evidence: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    durationMs: 1,
    createdAt: now,
    updatedAt: now
  }
}

type GraphConfigPatch = Partial<Omit<GraphRuntimeConfig,
  'scheduler' | 'context' | 'mailbox' | 'supervision' | 'writeIsolation' |
  'routing' | 'learning' | 'retention'
>> & {
  scheduler?: Partial<GraphRuntimeConfig['scheduler']>
  context?: Partial<GraphRuntimeConfig['context']>
  mailbox?: Partial<GraphRuntimeConfig['mailbox']>
  supervision?: Partial<GraphRuntimeConfig['supervision']>
  writeIsolation?: Partial<GraphRuntimeConfig['writeIsolation']>
  routing?: Partial<GraphRuntimeConfig['routing']>
  learning?: Partial<GraphRuntimeConfig['learning']>
  retention?: Partial<GraphRuntimeConfig['retention']>
}

export function testGraphConfig(patch: GraphConfigPatch = {}): GraphRuntimeConfig {
  return GraphRuntimeConfigSchema.parse({
    ...DEFAULT_GRAPH_RUNTIME_CONFIG,
    ...patch,
    enabled: patch.enabled ?? true,
    rolloutStage: patch.rolloutStage ?? 'stable',
    scheduler: { ...DEFAULT_GRAPH_RUNTIME_CONFIG.scheduler, ...patch.scheduler },
    context: { ...DEFAULT_GRAPH_RUNTIME_CONFIG.context, ...patch.context },
    mailbox: { ...DEFAULT_GRAPH_RUNTIME_CONFIG.mailbox, ...patch.mailbox },
    supervision: { ...DEFAULT_GRAPH_RUNTIME_CONFIG.supervision, ...patch.supervision },
    writeIsolation: { ...DEFAULT_GRAPH_RUNTIME_CONFIG.writeIsolation, ...patch.writeIsolation },
    routing: { ...DEFAULT_GRAPH_RUNTIME_CONFIG.routing, ...patch.routing },
    learning: { ...DEFAULT_GRAPH_RUNTIME_CONFIG.learning, ...patch.learning },
    retention: { ...DEFAULT_GRAPH_RUNTIME_CONFIG.retention, ...patch.retention }
  })
}

export function testGraphPlan(patch: Partial<GraphPlanV1> = {}): GraphPlanV1 {
  return GraphPlanV1Schema.parse({
    version: GRAPH_CONTRACT_VERSION,
    revision: 1,
    title: 'Test graph',
    goal: 'Implement and verify the requested work.',
    workspaceRoot: '/workspace',
    phases: [{ id: 'phase_1', title: 'Implementation', order: 0 }],
    nodes: [
      {
        id: 'research',
        phaseId: 'phase_1',
        kind: 'work',
        title: 'Research',
        objective: 'Inspect the relevant code.',
        priority: 1,
        required: true,
        riskClass: 'low',
        assignment: {
          kind: 'ephemeral',
          name: 'Researcher',
          systemPrompt: 'Inspect only the assigned scope.',
          toolPolicy: 'readOnly',
          blockedTools: [],
          blockedSkills: [],
          blockedMcpServers: []
        },
        completion: {
          requiredResultFields: ['summary', 'evidence'],
          acceptanceCriteria: ['Relevant code is identified'],
          review: {
            kinds: ['deterministic'],
            requireAll: true,
            deterministicChecks: []
          }
        },
        readScopes: ['src'],
        writeScopes: [],
        maxAttempts: 2,
        metadata: {}
      },
      {
        id: 'finish',
        phaseId: 'phase_1',
        kind: 'work',
        title: 'Finish',
        objective: 'Produce the accepted result.',
        priority: 0,
        required: true,
        riskClass: 'low',
        assignment: {
          kind: 'ephemeral',
          name: 'Finisher',
          systemPrompt: 'Finish only the assigned scope.',
          toolPolicy: 'readOnly',
          blockedTools: [],
          blockedSkills: [],
          blockedMcpServers: []
        },
        completion: {
          requiredResultFields: ['summary', 'checks'],
          acceptanceCriteria: ['Result is verified'],
          review: {
            kinds: ['deterministic'],
            requireAll: true,
            deterministicChecks: []
          }
        },
        readScopes: ['src'],
        writeScopes: [],
        maxAttempts: 2,
        metadata: {}
      }
    ],
    edges: [{
      id: 'edge_1',
      kind: 'control',
      from: 'research',
      to: 'finish',
      requiredOutcomes: ['accepted']
    }],
    budget: {
      maxNodes: 32,
      maxEdges: 128,
      maxConcurrentNodes: 4,
      maxAttemptsPerNode: 3,
      maxRevisions: 8,
      maxLoopIterations: 4,
      maxWallTimeMs: 60 * 60 * 1_000,
      maxNodeWallTimeMs: 30 * 60 * 1_000,
      maxTotalTokens: 100_000,
      maxMessages: 512,
      maxArtifactBytes: 100 * 1024 * 1024,
      warningRatio: 0.8
    },
    autoStart: false,
    completionNodeIds: ['finish'],
    createdBy: 'lead',
    createdAt: TEST_GRAPH_NOW,
    ...patch
  })
}

export function testGraphEnvelope(
  graphSeq: number,
  event: GraphDomainEventV1,
  patch: Partial<GraphEventEnvelopeV1> = {}
): GraphEventEnvelopeV1 {
  return GraphEventEnvelopeV1Schema.parse({
    version: GRAPH_EVENT_VERSION,
    eventId: `graph_event_${graphSeq}`,
    runId: 'run_1',
    threadId: 'thread_1',
    graphSeq,
    graphRevision: 1,
    timestamp: new Date(Date.parse(TEST_GRAPH_NOW) + graphSeq * 1_000).toISOString(),
    event,
    ...patch
  })
}

export function testAssignmentSnapshot(): GraphAssignmentSnapshotV1 {
  return GraphAssignmentSnapshotV1Schema.parse({
    version: GRAPH_CONTRACT_VERSION,
    profileId: 'profile_1',
    profileVersion: 1,
    profileOrigin: 'ephemeral',
    name: 'Researcher',
    systemPrompt: 'Inspect only the assigned scope.',
    model: 'test-model',
    providerId: 'test-provider',
    reasoningEffort: 'off',
    toolPolicy: 'readOnly',
    allowedTools: ['read', 'rg'],
    blockedTools: ['bash'],
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
    maxTokens: 10_000,
    capturedAt: TEST_GRAPH_NOW
  })
}
