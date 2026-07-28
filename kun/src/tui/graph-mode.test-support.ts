import {
  GraphRunV1Schema,
  type GraphRunV1
} from '../contracts/graph.js'
import { replayGraphEvents } from '../graph/graph-reducer.js'
import {
  TEST_GRAPH_NOW,
  testAssignmentSnapshot,
  testGraphEnvelope,
  testGraphPlan
} from '../graph/graph-test-fixtures.test-support.js'

export function testTuiGraphRun(
  patch: Partial<GraphRunV1> = {}
): GraphRunV1 {
  const plan = testGraphPlan()
  const initial = replayGraphEvents([
    testGraphEnvelope(1, {
      type: 'run_created',
      payload: {
        plan,
        projectId: 'project_1',
        sourceTurnId: 'turn_source'
      }
    }, {
      threadId: 'thr_1'
    })
  ])
  return GraphRunV1Schema.parse({
    ...initial,
    status: 'running',
    nodes: {
      ...initial.nodes,
      research: {
        ...initial.nodes.research,
        status: 'running',
        attempts: [{
          version: 1,
          id: 'attempt_1',
          runId: initial.id,
          nodeId: 'research',
          revision: 1,
          attemptNumber: 1,
          iteration: 0,
          commandId: 'command_1',
          idempotencyKey: 'attempt_1',
          status: 'running',
          assignment: testAssignmentSnapshot(),
          childThreadId: 'child_research',
          childTurnId: 'child_turn_research',
          queuedAt: TEST_GRAPH_NOW,
          startedAt: TEST_GRAPH_NOW,
          tokenUsage: 0,
          elapsedMs: 0
        }],
        lastTransitionReason: 'Worker admitted and dispatched.'
      },
      finish: {
        ...initial.nodes.finish,
        status: 'blocked',
        lastTransitionReason: 'Waiting for research.'
      }
    },
    lastEventSeq: 4,
    updatedAt: '2026-07-26T00:00:04.000Z',
    ...patch
  })
}
