import {
  GRAPH_CONTRACT_VERSION,
  GraphArtifactReferenceV1Schema,
  GraphIdentifierSchema,
  GraphReviewResultV1Schema,
  type GraphArtifactReferenceV1,
  type GraphReviewResultV1
} from '../contracts/graph.js'

const MAX_REVIEW_SUMMARY_CHARS = 4_096
const MAX_REPAIR_INSTRUCTIONS_CHARS = 32_768
const MAX_REVIEW_EVIDENCE = 128
const MAX_REVIEW_ARTIFACTS = 64
const MAX_ARTIFACT_CANDIDATES = 128

type GraphReviewNormalizationInput = {
  reviewId: GraphReviewResultV1['reviewId']
  nodeId: GraphReviewResultV1['nodeId']
  attemptId: GraphReviewResultV1['attemptId']
  reviewerKind: GraphReviewResultV1['reviewerKind']
  reviewerInstanceId?: unknown
  outcome: GraphReviewResultV1['outcome']
  summary: unknown
  evidence?: unknown
  artifactRefs?: unknown
  repairInstructions?: unknown
  createdAt: GraphReviewResultV1['createdAt']
}

/**
 * Converts model- or host-produced review details into the durable review
 * contract. Narrative fields and optional artifact references are untrusted:
 * malformed entries are dropped and oversized entries are clipped instead of
 * turning an otherwise completed review into another worker or peer attempt.
 */
export function normalizeGraphReviewResult(
  input: GraphReviewNormalizationInput,
  fallbackSummary = 'Reviewer returned no summary.'
): GraphReviewResultV1 {
  const reviewerInstanceId = GraphIdentifierSchema.safeParse(input.reviewerInstanceId)
  return GraphReviewResultV1Schema.parse({
    version: GRAPH_CONTRACT_VERSION,
    reviewId: input.reviewId,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    reviewerKind: input.reviewerKind,
    ...(reviewerInstanceId.success
      ? { reviewerInstanceId: reviewerInstanceId.data }
      : {}),
    outcome: input.outcome,
    summary: boundedReviewSummary(input.summary, fallbackSummary),
    evidence: boundedReviewEvidence(input.evidence),
    artifactRefs: boundedReviewArtifacts(input.artifactRefs),
    ...(typeof input.repairInstructions === 'string'
      ? {
          repairInstructions: input.repairInstructions.slice(
            0,
            MAX_REPAIR_INSTRUCTIONS_CHARS
          )
        }
      : {}),
    createdAt: input.createdAt
  })
}

function boundedReviewSummary(value: unknown, fallback: string): string {
  return (typeof value === 'string' ? value : fallback).slice(
    0,
    MAX_REVIEW_SUMMARY_CHARS
  )
}

function boundedReviewEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, MAX_REVIEW_EVIDENCE)
    .flatMap((entry) =>
      typeof entry === 'string'
        ? [entry.slice(0, MAX_REVIEW_SUMMARY_CHARS)]
        : [])
}

function boundedReviewArtifacts(value: unknown): GraphArtifactReferenceV1[] {
  if (!Array.isArray(value)) return []
  const artifacts: GraphArtifactReferenceV1[] = []
  for (const entry of value.slice(0, MAX_ARTIFACT_CANDIDATES)) {
    const artifact = normalizeArtifactReference(entry)
    if (artifact) artifacts.push(artifact)
    if (artifacts.length === MAX_REVIEW_ARTIFACTS) break
  }
  return artifacts
}

function normalizeArtifactReference(value: unknown): GraphArtifactReferenceV1 | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entry = value as Record<string, unknown>
  const logicalNames = Array.isArray(entry.logicalNames)
    ? entry.logicalNames
      .slice(0, 128)
      .flatMap((name) => {
        if (typeof name !== 'string') return []
        const normalized = name.trim().slice(0, 256)
        return normalized ? [normalized] : []
      })
    : undefined
  const candidate = {
    version: entry.version,
    artifactId: entry.artifactId,
    contentHash: entry.contentHash,
    mimeType: typeof entry.mimeType === 'string'
      ? entry.mimeType.trim().slice(0, 256)
      : entry.mimeType,
    byteLength: entry.byteLength,
    summary: typeof entry.summary === 'string'
      ? entry.summary.slice(0, MAX_REVIEW_SUMMARY_CHARS)
      : entry.summary,
    ...(logicalNames ? { logicalNames } : {}),
    ...(entry.producerNodeId !== undefined
      ? { producerNodeId: entry.producerNodeId }
      : {}),
    ...(entry.producerAttemptId !== undefined
      ? { producerAttemptId: entry.producerAttemptId }
      : {}),
    visibility: entry.visibility,
    ...(entry.retention !== undefined ? { retention: entry.retention } : {}),
    createdAt: entry.createdAt
  }
  const parsed = GraphArtifactReferenceV1Schema.safeParse(candidate)
  return parsed.success ? parsed.data : undefined
}
