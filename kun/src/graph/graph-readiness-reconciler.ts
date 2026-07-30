import type {
  GraphNodeProjectionV1,
  GraphRunV1
} from '../contracts/graph.js'
import {
  isLoopSchedulerEdge,
  loopGateControlsBranchTarget
} from './graph-loop-policy.js'
import { dependencyDecision } from './graph-scheduler-policy.js'

export async function reconcileGraphReadiness(
  runInput: GraphRunV1,
  transition: (
    run: GraphRunV1,
    nodeId: string,
    to: GraphNodeProjectionV1['status'],
    reason: string
  ) => Promise<GraphRunV1>
): Promise<GraphRunV1> {
  let run = runInput
  const plan = run.plans.at(-1)!
  for (const projection of Object.values(run.nodes)) {
    if (
      loopGateControlsBranchTarget(run, projection.node.id) &&
      (
        projection.status === 'pending' ||
        projection.status === 'blocked' ||
        projection.status === 'ready'
      )
    ) {
      if (projection.status !== 'blocked') {
        run = await transition(
          run,
          projection.node.id,
          'blocked',
          'waiting for LoopGate branch decision'
        )
      }
      continue
    }
    if (projection.status !== 'pending' && projection.status !== 'blocked') continue
    const incoming = plan.edges.filter((edge) =>
      edge.to === projection.node.id &&
      !isLoopSchedulerEdge(run, edge.from, edge.to))
    const decision = dependencyDecision(run, incoming)
    if (decision === 'unsatisfiable') {
      run = await transition(
        run,
        projection.node.id,
        'skipped',
        'a required dependency ended without an accepted outcome or artifact'
      )
      continue
    }
    const target = decision === 'ready' ? 'ready' : 'blocked'
    if (projection.status !== target) {
      run = await transition(
        run,
        projection.node.id,
        target,
        decision === 'blocked' ? 'waiting for dependencies' : 'dependencies satisfied'
      )
    }
  }
  return run
}
