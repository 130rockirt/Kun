import {
  type GraphDomainEventV1,
  type GraphRunV1
} from '../contracts/graph.js'
import { steeringTargetsNode } from './graph-scheduler-policy.js'

type AppendSteeringEvent = (
  run: GraphRunV1,
  event: GraphDomainEventV1,
  idempotencyKey: string
) => Promise<GraphRunV1>

export async function deliverNodeSteering(
  initialRun: GraphRunV1,
  nodeId: string,
  append: AppendSteeringEvent
): Promise<GraphRunV1> {
  let run = initialRun
  for (const steering of run.steering.filter((entry) =>
    entry.status === 'persisted' &&
    steeringTargetsNode(entry, run.nodes[nodeId], undefined)
  )) {
    run = await append(run, {
      type: 'steering_status_changed',
      payload: {
        steeringId: steering.steeringId,
        from: 'persisted',
        to: 'delivered'
      }
    }, `steering-delivered:${run.id}:${steering.steeringId}:${nodeId}`)
  }
  return run
}

export async function handleNodeAttemptSteering(
  initialRun: GraphRunV1,
  nodeId: string,
  attemptId: string,
  append: AppendSteeringEvent
): Promise<GraphRunV1> {
  let run = initialRun
  for (const steering of run.steering.filter((entry) =>
    entry.status === 'delivered' &&
    entry.target.kind !== 'run' &&
    steeringTargetsNode(entry, run.nodes[nodeId], attemptId)
  )) {
    run = await append(run, {
      type: 'steering_status_changed',
      payload: {
        steeringId: steering.steeringId,
        from: 'delivered',
        to: 'handled'
      }
    }, `steering-handled:${run.id}:${steering.steeringId}:${attemptId}`)
  }
  return run
}
