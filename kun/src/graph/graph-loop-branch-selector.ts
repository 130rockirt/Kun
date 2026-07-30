import type {
  GraphNodeProjectionV1,
  GraphRunV1
} from '../contracts/graph.js'
import {
  loopSelectedBranchReason,
  loopUnselectedBranchReason
} from './graph-loop-policy.js'

export async function selectLoopGateBranch(
  runInput: GraphRunV1,
  gateNodeId: string,
  exhausted: boolean,
  transition: (
    run: GraphRunV1,
    nodeId: string,
    to: GraphNodeProjectionV1['status'],
    reason: string
  ) => Promise<GraphRunV1>
): Promise<GraphRunV1> {
  let run = runInput
  const gate = run.nodes[gateNodeId]?.node.loopGate
  if (!gate) return run
  const selectedTargetId = exhausted
    ? gate.exhaustionTargetNodeId ?? gate.exitTargetNodeId
    : gate.exitTargetNodeId
  const branchTargetIds = [
    ...new Set([
      gate.exitTargetNodeId,
      gate.exhaustionTargetNodeId
    ].filter((nodeId): nodeId is string => Boolean(nodeId)))
  ]
  for (const targetId of branchTargetIds) {
    const target = run.nodes[targetId]
    if (!target) continue
    if (targetId === selectedTargetId) {
      if (target.status === 'blocked') {
        run = await transition(
          run,
          targetId,
          'pending',
          loopSelectedBranchReason(gateNodeId)
        )
      }
      continue
    }
    if (target.status === 'pending' || target.status === 'blocked') {
      run = await transition(
        run,
        targetId,
        'skipped',
        loopUnselectedBranchReason(gateNodeId)
      )
    }
  }
  return run
}
