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
import { parseCheckpoint, safeProvenanceMetadata, validateGeneratedOtioOutput, validateGeneratedOutput } from './extension-media-job-service-output-validation.js'
import { abortableDelay, assertAuthorized, boundIdempotencyKey, cancelledError, executionPrincipal, inferredPriority, isExplicitlyTransientMediaFailure, jobProgress, reference, retryDelayMs } from './extension-media-job-service-execution-support.js'

export const MEDIA_FFMPEG_JOB_KIND = 'media.ffmpeg'

export const MAX_MEDIA_RETRY_DELAY_MS = 30_000

export const REQUIRED_PERMISSIONS = [
  'jobs.manage',
  'media.read',
  'media.process',
  'media.export',
  'workspace.read',
  'workspace.write'
] as const

export class ExtensionMediaJobError extends Error {
  constructor(
    readonly code:
      | 'permission_denied'
      | 'workspace_denied'
      | 'invalid_checkpoint'
      | 'invalid_output',
    message: string
  ) {
    super(message)
  }
}

export type MediaExecutionRelease = () => void

export type MediaExecutionWaiter = {
  sequence: number
  priority: MediaJobPriority
  signal: AbortSignal
  resolve(release: MediaExecutionRelease): void
  reject(error: unknown): void
  abort(): void
}

export const MEDIA_PRIORITY_ORDER: Readonly<Record<MediaJobPriority, number>> = Object.freeze({
  background: 100,
  user: 200,
  interactive: 300,
  export: 400
})

/**
 * Runtime-owned native-media admission gate. It is intentionally independent
 * of any one extension or derived-media kind: every opted-in FFmpeg job shares
 * bounded concurrency and queued work is selected by priority then FIFO.
 */
export class MediaExecutionScheduler {
  private readonly waiting: MediaExecutionWaiter[] = []
  private active = 0
  private sequence = 0
  private disposed = false

  constructor(private readonly maxConcurrent: number) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) {
      throw new ExtensionMediaJobError(
        'invalid_checkpoint',
        'Media scheduling concurrency must be from 1 through 16'
      )
    }
  }

  async acquire(priority: MediaJobPriority, signal: AbortSignal): Promise<MediaExecutionRelease> {
    if (signal.aborted) throw cancelledError()
    if (this.disposed) throw cancelledError('Media scheduler is shutting down')
    return await new Promise<MediaExecutionRelease>((resolve, reject) => {
      const waiter: MediaExecutionWaiter = {
        sequence: this.sequence++,
        priority,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.waiting.indexOf(waiter)
          if (index >= 0) this.waiting.splice(index, 1)
          reject(cancelledError())
        }
      }
      signal.addEventListener('abort', waiter.abort, { once: true })
      this.waiting.push(waiter)
      this.waiting.sort((left, right) =>
        MEDIA_PRIORITY_ORDER[right.priority] - MEDIA_PRIORITY_ORDER[left.priority] ||
        left.sequence - right.sequence)
      this.pump()
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const waiter of this.waiting.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.reject(cancelledError('Media scheduler is shutting down'))
    }
  }

  private pump(): void {
    while (!this.disposed && this.active < this.maxConcurrent && this.waiting.length > 0) {
      const waiter = this.waiting.shift()!
      waiter.signal.removeEventListener('abort', waiter.abort)
      if (waiter.signal.aborted) {
        waiter.reject(cancelledError())
        continue
      }
      this.active += 1
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        this.active -= 1
        this.pump()
      })
    }
  }
}

/** Bridges handle-confined FFmpeg execution into the durable core job state machine. */
export class ExtensionMediaJobService {
  private readonly unregisterExecutor: () => void
  private readonly pendingOutputs = new Map<string, ExtensionFfmpegOutputTransaction>()
  private readonly scheduler: MediaExecutionScheduler
  private readonly retryDelay: (delayMs: number, signal: AbortSignal) => Promise<void>

  constructor(private readonly options: {
    jobs: ExtensionJobService
    ffmpeg: ExtensionMediaFfmpegService
    media: ExtensionMediaProcessService
    artifacts: ExtensionArtifactService
    maxConcurrent?: number
    retryDelay?: (delayMs: number, signal: AbortSignal) => Promise<void>
  }) {
    this.scheduler = new MediaExecutionScheduler(options.maxConcurrent ?? 2)
    this.retryDelay = options.retryDelay ?? abortableDelay
    const executor: ExtensionJobCoreExecutor = {
      kind: MEDIA_FFMPEG_JOB_KIND,
      execute: async (snapshot, context) => {
        const request = parseCheckpoint(context.checkpoint?.data)
        const release = await this.scheduler.acquire(
          request.scheduling?.priority ?? inferredPriority(request),
          context.signal
        )
        try {
          const principal = executionPrincipal(snapshot, context.workspaceRoot)
          let transaction: ExtensionFfmpegOutputTransaction | undefined
          let generatedArtifacts: GeneratedArtifact[] = []
          try {
            transaction = await this.executeTransactionWithRetry(
              principal,
              request,
              snapshot.id,
              context
            )
            const provenanceMetadata = safeProvenanceMetadata(request.metadata)
            const artifactInputs: CreateGeneratedArtifactInput[] = []
            for (const generated of transaction.generatedMedia) {
              // A successful ffmpeg exit is insufficient: require bounded metadata
              // while the prior user target and handle state remain reversible.
              const validated = generated.mimeType === 'application/x-otio+json'
                ? validateGeneratedOtioOutput(generated, request)
                : validateGeneratedOutput(
                    generated,
                    await this.options.media.probe(principal, generated.id, { signal: context.signal })
                  )
              artifactInputs.push({
                workspaceId: snapshot.workspaceId,
                mediaHandleId: generated.id,
                ...(validated.width !== undefined ? { width: validated.width } : {}),
                ...(validated.height !== undefined ? { height: validated.height } : {}),
                ...(validated.durationMicros !== undefined
                  ? { durationMicros: validated.durationMicros }
                  : {}),
                provenance: {
                  jobId: snapshot.id,
                  operation: snapshot.initiatingOperation,
                  ...(provenanceMetadata ? { metadata: provenanceMetadata } : {})
                }
              })
            }
            context.signal.throwIfAborted()
            generatedArtifacts = await this.options.artifacts.createMany(principal, artifactInputs)
            if (this.pendingOutputs.has(snapshot.id)) {
              throw new ExtensionMediaJobError(
                'invalid_output',
                'Media output transaction is already pending for this job'
              )
            }
            this.pendingOutputs.set(snapshot.id, transaction)
            return {
              schemaVersion: 1,
              data: {
                outputs: transaction.generatedMedia.map((media) => ({
                  mediaHandleId: media.id,
                  displayName: media.displayName,
                  mimeType: media.mimeType
                }))
              } as JsonValue,
              generatedArtifacts
            }
          } catch (error) {
            const cleanupErrors: unknown[] = []
            if (generatedArtifacts.length > 0) {
              try {
                await this.options.artifacts.discardUncommittedJobArtifacts(
                  principal,
                  snapshot.id,
                  generatedArtifacts
                )
              } catch (cleanupError) {
                cleanupErrors.push(cleanupError)
              }
            }
            if (transaction !== undefined) {
              try {
                await transaction.rollback()
              } catch (cleanupError) {
                cleanupErrors.push(cleanupError)
              }
            }
            if (cleanupErrors.length > 0) {
              throw new ExtensionMediaJobError(
                'invalid_output',
                'Media output validation failed and cleanup did not finish safely'
              )
            }
            throw error
          }
        } finally {
          release()
        }
      },
      commitResult: async (snapshot) => {
        const transaction = this.pendingOutputs.get(snapshot.id)
        if (transaction === undefined) return
        await transaction.commit()
        this.pendingOutputs.delete(snapshot.id)
      },
      discardResult: async (snapshot, result, context) => {
        const principal = executionPrincipal(snapshot, context.workspaceRoot)
        const transaction = this.pendingOutputs.get(snapshot.id)
        const cleanupErrors: unknown[] = []
        try {
          await this.options.artifacts.discardUncommittedJobArtifacts(
            principal,
            snapshot.id,
            result.generatedArtifacts
          )
        } catch (error) {
          cleanupErrors.push(error)
        }
        if (transaction !== undefined) {
          try {
            await transaction.rollback()
          } catch (error) {
            cleanupErrors.push(error)
          } finally {
            this.pendingOutputs.delete(snapshot.id)
          }
        }
        if (cleanupErrors.length > 0) {
          throw new ExtensionMediaJobError(
            'invalid_output',
            'Media output transaction could not be discarded safely'
          )
        }
      },
      cancel: async (snapshot, context) => {
        // Active attempts are aborted and awaited by ExtensionJobService. A
        // checkpoint here means the process belonged to a previous runtime, so
        // this hook must reconcile its deterministic output transaction.
        if (context.checkpoint === undefined) return
        const request = parseCheckpoint(context.checkpoint.data)
        const principal = executionPrincipal(snapshot, context.workspaceRoot)
        await this.options.ffmpeg.rollbackInterruptedTransaction(
          principal,
          request,
          snapshot.id
        )
      },
      recover: async (snapshot, checkpoint, context) => {
        const request = parseCheckpoint(checkpoint?.data)
        const principal = executionPrincipal(snapshot, context.workspaceRoot)
        await this.options.ffmpeg.rollbackInterruptedTransaction(
          principal,
          request,
          snapshot.id
        )
        return 'interrupt' as const
      },
      recoverTerminal: async (snapshot, checkpoint, context) => {
        const request = parseCheckpoint(checkpoint?.data)
        const principal = executionPrincipal(snapshot, context.workspaceRoot)
        if (snapshot.state === 'completed') {
          await this.options.ffmpeg.commitRecoveredTransaction(
            principal,
            request,
            snapshot.id
          )
          return
        }
        const cleanupErrors: unknown[] = []
        try {
          await this.options.ffmpeg.rollbackInterruptedTransaction(
            principal,
            request,
            snapshot.id
          )
        } catch (error) {
          cleanupErrors.push(error)
        }
        try {
          await this.options.artifacts.discardUncommittedJobArtifactsByJob(
            principal,
            snapshot.id
          )
        } catch (error) {
          cleanupErrors.push(error)
        }
        if (cleanupErrors.length > 0) {
          throw new ExtensionMediaJobError(
            'invalid_output',
            'Recovered terminal media cleanup did not finish safely'
          )
        }
      }
    }
    this.unregisterExecutor = options.jobs.registerCoreExecutor(executor)
  }

  private async executeTransactionWithRetry(
    principal: ExtensionPrincipal,
    request: MediaStartFfmpegJobRequest,
    operationId: string,
    context: Parameters<ExtensionJobCoreExecutor['execute']>[1]
  ): Promise<ExtensionFfmpegOutputTransaction> {
    const scheduling = request.scheduling ?? {
      priority: inferredPriority(request),
      maxAttempts: 1,
      retryBaseDelayMs: 250
    }
    for (let attempt = 1; attempt <= scheduling.maxAttempts; attempt += 1) {
      context.signal.throwIfAborted()
      try {
        return await this.options.ffmpeg.executeTransaction(principal, request, {
          // Reusing the durable job id is intentional. The FFmpeg transaction
          // fully rolls back before an explicitly transient retry; recovery can
          // therefore deterministically find the one possible staging identity.
          operationId,
          signal: context.signal,
          onProgress: (progress) => {
            void context.reportProgress(jobProgress(progress)).catch(() => undefined)
          }
        })
      } catch (error) {
        if (
          attempt >= scheduling.maxAttempts ||
          !isExplicitlyTransientMediaFailure(error) ||
          context.signal.aborted
        ) throw error
        const delayMs = retryDelayMs(scheduling.retryBaseDelayMs, attempt)
        await context.reportProgress({
          phase: `retry-backoff-${attempt}`,
          message: `Transient media admission failed; retrying attempt ${attempt + 1} of ${scheduling.maxAttempts}`
        })
        await this.retryDelay(delayMs, context.signal)
      }
    }
    throw new ExtensionMediaJobError('invalid_output', 'Media retry loop ended without an outcome')
  }

  async start(
    principal: ExtensionPrincipal,
    request: MediaStartFfmpegJobRequest
  ): Promise<JobReference> {
    assertAuthorized(principal)
    const input = MediaStartFfmpegJobRequestSchema.parse(request)
    if (principal.workspaceRoots.length !== 1) {
      throw new ExtensionMediaJobError(
        'workspace_denied',
        'Media jobs require exactly one active workspace scope'
      )
    }
    const workspaceRoot = principal.workspaceRoots[0]!
    const created = await this.options.jobs.createAndDispatch({
      owner: {
        extensionId: principal.extensionId,
        extensionVersion: principal.extensionVersion,
        workspaceId: extensionWorkspaceKey(workspaceRoot)
      },
      workspaceRoot,
      kind: MEDIA_FFMPEG_JOB_KIND,
      kindSchemaVersion: 1,
      initiatingOperation: 'media.startFfmpegJob',
      permissionsSnapshot: [...principal.permissions],
      ...(input.idempotencyKey ? { idempotencyKey: boundIdempotencyKey(input) } : {}),
      checkpoint: { schemaVersion: 1, data: input as JsonValue }
    })
    return reference(created.snapshot)
  }

  dispose(): void {
    this.scheduler.dispose()
    this.unregisterExecutor()
    for (const transaction of this.pendingOutputs.values()) {
      void transaction.rollback().catch(() => undefined)
    }
    this.pendingOutputs.clear()
  }
}
