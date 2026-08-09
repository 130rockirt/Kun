import { createHash } from 'node:crypto'
import {
  MediaStartFfmpegJobRequestSchema,
  type GeneratedArtifact,
  type JobReference,
  type MediaJobPriority,
  type MediaStartFfmpegJobRequest,
  type MediaProbeResult
} from '@kun/extension-api'
import type { JsonValue } from '../extensions/types.js'
import { extensionWorkspaceKey } from '../extensions/paths.js'
import type { ExtensionPrincipal } from './extension-agent-service.js'
import {
  ExtensionArtifactService,
  type CreateGeneratedArtifactInput
} from './extension-artifact-service.js'
import { ExtensionJobService, type ExtensionJobCoreExecutor } from './extension-job-service.js'
import type { ExtensionJobSnapshot } from './extension-job-types.js'
import {
  ExtensionMediaFfmpegService,
  type ExtensionFfmpegOutputTransaction,
  type ExtensionFfmpegProgress
} from './extension-media-ffmpeg-service.js'
import {
  ExtensionMediaProcessError,
  ExtensionMediaProcessService
} from './extension-media-process-service.js'
import { ExtensionMediaJobError, MAX_MEDIA_RETRY_DELAY_MS, REQUIRED_PERMISSIONS } from './extension-media-job-service-core.js'

export function invalidOutput(message: string): ExtensionMediaJobError {
  return new ExtensionMediaJobError('invalid_output', message)
}

export function executionPrincipal(
  snapshot: ExtensionJobSnapshot,
  workspaceRoot: string
): ExtensionPrincipal {
  return {
    extensionId: snapshot.ownerExtensionId,
    extensionVersion: snapshot.ownerExtensionVersion,
    permissions: [...REQUIRED_PERMISSIONS],
    workspaceRoots: [workspaceRoot],
    workspaceTrusted: true
  }
}

export function assertAuthorized(principal: ExtensionPrincipal): void {
  if (!principal.workspaceTrusted) {
    throw new ExtensionMediaJobError('workspace_denied', 'Workspace is not trusted')
  }
  for (const permission of REQUIRED_PERMISSIONS) {
    if (!principal.permissions.includes(permission)) {
      throw new ExtensionMediaJobError('permission_denied', `Missing permission: ${permission}`)
    }
  }
}

export function jobProgress(progress: ExtensionFfmpegProgress) {
  return {
    phase: progress.terminal ? 'finalizing' : 'encoding',
    ...(progress.outputBytes !== undefined ? {
      completed: progress.outputBytes,
      unit: 'bytes'
    } : {}),
    message: progress.terminal ? 'Validating generated media' : 'Encoding media'
  }
}

export function inferredPriority(request: MediaStartFfmpegJobRequest): MediaJobPriority {
  const renderKind = request.metadata?.renderKind
  if (renderKind === 'proof-frame' || renderKind === 'preview') return 'interactive'
  if (typeof renderKind === 'string') return 'export'
  return 'user'
}

/**
 * Bind core idempotency to the complete normalized broker request. A caller
 * reusing a friendly key with changed handles, arguments, metadata, revision,
 * source identity, or scheduling policy cannot alias the earlier durable job.
 */
export function boundIdempotencyKey(request: MediaStartFfmpegJobRequest): string {
  const { idempotencyKey, ...operation } = request
  return `ffmpeg:${createHash('sha256')
    .update(idempotencyKey ?? '')
    .update('\0')
    .update(canonicalJson(operation))
    .digest('hex')}`
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

export function isExplicitlyTransientMediaFailure(error: unknown): boolean {
  // Validation, process exit codes, output validation, publication, and any
  // unknown error may have side effects and are never retried automatically.
  return error instanceof ExtensionMediaProcessError && error.retryable === true &&
    (error.code === 'executable_unavailable' || error.code === 'process_timeout')
}

export function retryDelayMs(baseDelayMs: number, failedAttempt: number): number {
  return Math.min(
    MAX_MEDIA_RETRY_DELAY_MS,
    baseDelayMs * 2 ** Math.min(8, Math.max(0, failedAttempt - 1))
  )
}

export async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw cancelledError()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, delayMs)
    timer.unref?.()
    const abort = () => {
      clearTimeout(timer)
      reject(cancelledError())
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

export function cancelledError(message = 'Media scheduling was cancelled'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function reference(snapshot: ExtensionJobSnapshot): JobReference {
  return {
    jobId: snapshot.id,
    kind: snapshot.kind,
    state: snapshot.state,
    cursor: snapshot.latestCursor
  }
}
