import type {
  GraphNodeAttemptV1,
  GraphNodeProjectionV1,
  GraphRunV1,
  GraphVerifiedCheckResultV1,
  GraphWorkerResultV1
} from '../contracts/graph.js'
import type { ChildRunRecord } from '../delegation/delegation-runtime.js'
import { resolveCanonicalWorkerArtifactRefs } from './graph-artifact-policy.js'
import {
  normalizeWorkerResult,
  parseWorkerResult,
  validateWorkerResult
} from './graph-scheduler-policy.js'
import type { GraphSchedulerOptions } from './graph-scheduler-types.js'
import type {
  FileGraphWriteCoordinator,
  GraphChangedFilesObservation
} from './graph-write-coordinator.js'

type GraphWorkerCheckVerifier = NonNullable<GraphSchedulerOptions['verifyChecks']>

export async function finalizeGraphWorkerResult(input: {
  run: GraphRunV1
  node: GraphNodeProjectionV1
  attempt: GraphNodeAttemptV1
  child: ChildRunRecord
  writes: FileGraphWriteCoordinator
  verifyChecks?: GraphWorkerCheckVerifier
  existingResult?: GraphWorkerResultV1
}) {
  const parsed = input.existingResult ?? parseWorkerResult(input.child)
  const artifacts = resolveCanonicalWorkerArtifactRefs(
    input.run,
    input.node.node.id,
    input.attempt.id,
    parsed.artifactRefs
  )
  const observed = await observeChangedFiles(input)
  const checkNames = input.node.node.completion.review.deterministicChecks
  let checkVerificationError: string | undefined
  let verifiedChecks: GraphVerifiedCheckResultV1[]
  try {
    verifiedChecks = input.verifyChecks
      ? await input.verifyChecks({
          run: input.run,
          node: input.node,
          attempt: input.attempt,
          checkNames
        })
      : notRunChecks(checkNames, 'No host verifier was configured.')
  } catch (error) {
    checkVerificationError = boundedError(error)
    verifiedChecks = notRunChecks(
      checkNames,
      `Host check verification could not run: ${checkVerificationError}`
    )
  }
  const result = normalizeWorkerResult({
    ...parsed,
    artifactRefs: artifacts.artifactRefs,
    changedFiles: observed.status === 'observed' ? observed.changedFiles : [],
    verifiedChecks
  }, parsed.summary)
  const validation = validateWorkerResult(input.node, result, {
    ...(observed.status === 'observed'
      ? { observedChangedFiles: observed.changedFiles }
      : { changedFilesObservationError: observed.error }),
    ...(checkVerificationError ? { checkVerificationError } : {}),
    rejectedArtifactRefs: artifacts.rejected
  })
  return { result, validation }
}

async function observeChangedFiles(input: {
  node: GraphNodeProjectionV1
  attempt: GraphNodeAttemptV1
  writes: FileGraphWriteCoordinator
}): Promise<GraphChangedFilesObservation> {
  if (!input.node.node.writeScopes.length) {
    return { status: 'observed', changedFiles: [] }
  }
  try {
    return await input.writes.captureChangedFiles(input.attempt.id)
  } catch (error) {
    return { status: 'unavailable', error: boundedError(error) }
  }
}

function notRunChecks(
  names: readonly string[],
  summary: string
): GraphVerifiedCheckResultV1[] {
  const bounded = summary.slice(0, 4_096)
  return names.map((name) => ({
    name,
    status: 'not_run',
    summary: bounded,
    artifactRefs: [],
    command: ['not-run'],
    exitCode: null,
    workspaceRevision: 'unknown',
    outputSummary: bounded
  }))
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_048)
}
