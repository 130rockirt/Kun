import type {
  GraphArtifactReferenceV1,
  GraphRunV1
} from '../contracts/graph.js'

/**
 * A worker result may reference only immutable artifacts already published by
 * the host for that exact attempt. Model-authored metadata is never promoted
 * into a capability or durable GraphRun fact.
 */
export function canonicalWorkerArtifactRefs(
  run: GraphRunV1,
  nodeId: string,
  attemptId: string,
  requested: readonly GraphArtifactReferenceV1[]
): GraphArtifactReferenceV1[] {
  const canonical = new Map(
    run.artifacts
      .filter((artifact) =>
        artifact.producerNodeId === nodeId &&
        artifact.producerAttemptId === attemptId)
      .map((artifact) => [artifact.artifactId, artifact])
  )
  const seen = new Set<string>()
  return requested.map((artifact) => {
    const stored = canonical.get(artifact.artifactId)
    if (!stored) {
      throw new Error(
        `worker result artifact was not published by attempt ${attemptId}: ${artifact.artifactId}`
      )
    }
    if (
      artifact.contentHash !== stored.contentHash ||
      artifact.byteLength !== stored.byteLength ||
      artifact.mimeType !== stored.mimeType
    ) {
      throw new Error(`worker result artifact metadata does not match durable truth: ${artifact.artifactId}`)
    }
    if (seen.has(stored.artifactId)) {
      throw new Error(`worker result contains duplicate artifact: ${stored.artifactId}`)
    }
    seen.add(stored.artifactId)
    return stored
  })
}
