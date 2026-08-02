import type { GraphNodeProjectionV1, GraphRunV1 } from '../contracts/graph.js'
import { LOOP_GATE_EXHAUSTED_REASON, LOOP_GATE_EXIT_REASON, loopResetNodeIds, outcomeOf } from './graph-loop-policy.js'
import { selectLoopGateBranch } from './graph-loop-branch-selector.js'

export async function evaluateGraphLoopGates(
  initialRun: GraphRunV1,
  options: {
    appendLoopAdvance: (run: GraphRunV1, projection: GraphNodeProjectionV1, resetNodeIds: string[]) => Promise<GraphRunV1>
    bumpLoopBudget: (run: GraphRunV1) => Promise<GraphRunV1>
    transitionNode: (run: GraphRunV1, nodeId: string, to: GraphNodeProjectionV1['status'], reason: string) => Promise<GraphRunV1>
  }
): Promise<GraphRunV1> {
  let run = initialRun
  for (const projection of Object.values(run.nodes)) {
    if (projection.node.kind !== 'loop_gate' || projection.status !== 'ready') continue
    const gate = projection.node.loopGate!
    const source = run.nodes[gate.condition.sourceNodeId]
    const sourceOutcome = source ? outcomeOf(source) : undefined
    if (!sourceOutcome) continue
    const continues = new Set<string>(gate.condition.outcomeIn).has(sourceOutcome)
    const exhausted = continues && projection.loopIteration >= Math.min(gate.maxIterations, run.budget.limits.maxLoopIterations)
    if (continues && !exhausted) {
      const resetNodeIds = loopResetNodeIds(run.plans.at(-1)!, projection.node.id, gate.continueTargetNodeId, gate.condition.sourceNodeId)
      run = await options.appendLoopAdvance(run, projection, resetNodeIds)
      run = await options.bumpLoopBudget(run)
    } else {
      run = await selectLoopGateBranch(run, projection.node.id, exhausted, options.transitionNode)
    }
    if (!continues || exhausted) {
      run = await options.transitionNode(
        run,
        projection.node.id,
        'skipped',
        exhausted ? LOOP_GATE_EXHAUSTED_REASON : LOOP_GATE_EXIT_REASON
      )
    }
  }
  return run
}
