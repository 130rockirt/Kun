import type {
  GraphArtifactReferenceV1,
  GraphRunV1
} from '../contracts/graph.js'

export type WorkerArtifactRefRejection = {
  artifactId: string
  reason: 'not_published_by_attempt' | 'metadata_mismatch' | 'duplicate'
}

/**
 * A worker result may reference only immutable artifacts already published by
 * the host for that exact attempt. Model-authored metadata is never promoted
 * into a capability or durable GraphRun fact. Invalid optional references are
 * discarded and reported to host validation; they never turn completed work
 * into an executor retry.
 */
export function canonicalWorkerArtifactRefs(
  run: GraphRunV1,
  nodeId: string,
  attemptId: string,
  requested: readonly GraphArtifactReferenceV1[]
): GraphArtifactReferenceV1[] {
  return resolveCanonicalWorkerArtifactRefs(
    run,
    nodeId,
    attemptId,
    requested
  ).artifactRefs
}

export function resolveCanonicalWorkerArtifactRefs(
  run: GraphRunV1,
  nodeId: string,
  attemptId: string,
  requested: readonly GraphArtifactReferenceV1[]
): {
  artifactRefs: GraphArtifactReferenceV1[]
  rejected: WorkerArtifactRefRejection[]
} {
  const canonical = new Map(
    run.artifacts
      .filter((artifact) =>
        artifact.producerNodeId === nodeId &&
        artifact.producerAttemptId === attemptId)
      .map((artifact) => [artifact.artifactId, artifact])
  )
  const seen = new Set<string>()
  const artifactRefs: GraphArtifactReferenceV1[] = []
  const rejected: WorkerArtifactRefRejection[] = []
  for (const artifact of requested) {
    const stored = canonical.get(artifact.artifactId)
    if (!stored) {
      rejected.push({
        artifactId: artifact.artifactId,
        reason: 'not_published_by_attempt'
      })
      continue
    }
    if (
      artifact.contentHash !== stored.contentHash ||
      artifact.byteLength !== stored.byteLength ||
      artifact.mimeType !== stored.mimeType
    ) {
      rejected.push({
        artifactId: artifact.artifactId,
        reason: 'metadata_mismatch'
      })
      continue
    }
    if (seen.has(stored.artifactId)) {
      rejected.push({
        artifactId: stored.artifactId,
        reason: 'duplicate'
      })
      continue
    }
    seen.add(stored.artifactId)
    artifactRefs.push(stored)
  }
  return { artifactRefs, rejected }
}
