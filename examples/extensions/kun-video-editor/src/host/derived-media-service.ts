import type { ExtensionContext, JsonObject } from '@kun/extension-api'
import type { DerivedMediaRecord, MediaAsset, VideoProject } from '../engine/index.js'
import { DerivedMediaServiceCore } from './derived-media-service-core.js'
import type {
  DerivedMediaListResult,
  PendingOutput,
  DerivedMediaServiceOptions,
  DerivedMediaStartInput
} from './derived-media-service-model.js'
import {
  derivedRecordProjection,
  effectiveSourceFingerprint,
  opaqueHandle,
  requiredAsset
} from './derived-media-service-support.js'

const TERMINAL_STATUSES = new Set(['ready', 'failed', 'cancelled', 'interrupted', 'invalid'])

export * from './derived-media-service-model.js'
export { derivedRecordProjection } from './derived-media-service-support.js'

export class DerivedMediaService extends DerivedMediaServiceCore {
  async list(projectId: string): Promise<DerivedMediaListResult> {
    const store = await this.store()
    const project = await this.loadProject(projectId)
    if (project) await this.synchronizeProject(project)
    else await this.synchronizeRecordAccess(store, projectId)
    await this.reconcile({ projectId })
    await this.scheduleQueued(projectId)
    const records = await store.list({ owner: this.owner({ projectId }) })
    const usage = await store.usage()
    return {
      records: records.map(derivedRecordProjection),
      usage: usage as unknown as JsonObject,
      recoveryDiagnostics: store.recoveryDiagnostics.slice(0, 32)
    }
  }

  async start(input: DerivedMediaStartInput): Promise<{
    outcome: 'queued' | 'deduplicated' | 'backoff' | 'unavailable'
    record: JsonObject
    jobId?: string
    message?: string
  }> {
    const asset = requiredAsset(input.project, input.assetId)
    if (!asset.mediaHandleId) {
      throw new Error(`Asset ${asset.id} must be reauthorized before derived media can be generated.`)
    }
    await this.synchronizeProject(input.project)
    const requested = await this.requestRecord(input, asset)
    if (requested.deduplicated) {
      return {
        outcome: requested.backoffActive ? 'backoff' : 'deduplicated',
        record: derivedRecordProjection(requested.record),
        ...(requested.record.jobId ? { jobId: requested.record.jobId } : {})
      }
    }
    const capabilities = await this.context.media.getCapabilities()
    if (!capabilities.ffmpeg.available) {
      const unavailable = await (await this.store()).fail(requested.record.id, {
        code: 'ffmpeg_unavailable',
        message: 'FFmpeg is unavailable. Install or configure the local media tools and retry.',
        retryable: true
      })
      await this.publish(unavailable, 'capability-unavailable')
      return {
        outcome: 'unavailable',
        record: derivedRecordProjection(unavailable),
        message: 'FFmpeg is unavailable. Install or configure the local media tools and retry.'
      }
    }

    let pending: PendingOutput
    try {
      pending = {
        schemaVersion: 3,
        recordId: requested.record.id,
        sourceHandleId: opaqueHandle(asset.mediaHandleId, 'sourceHandleId'),
        pinnedRevision: input.project.currentRevision,
        stages: await this.createStages(input.kind, input.outputHandleId),
        stageIndex: 0,
        durationUs: Math.max(1, asset.durationUs),
        createdAt: new Date().toISOString()
      }
    } catch (error) {
      const interrupted = await (await this.store()).interrupt(
        requested.record.id,
        'The Host could not allocate bounded derived cache targets; retry to request fresh grants.'
      )
      await this.publish(interrupted, 'cache-allocation-interrupted')
      throw error
    }
    await this.savePendingOutput(pending)
    const scheduled = await this.scheduleRecord(requested.record, pending)
    return {
      outcome: 'queued',
      record: derivedRecordProjection(scheduled),
      ...(scheduled.jobId ? { jobId: scheduled.jobId } : {})
    }
  }

  async cancel(projectId: string, recordId: string): Promise<JsonObject> {
    const store = await this.store()
    const record = await this.scopedRecord(store, projectId, recordId)
    if (TERMINAL_STATUSES.has(record.status)) {
      if (record.status !== 'ready') await this.discardPending(record)
      return derivedRecordProjection(record)
    }
    if (record.jobId) {
      await this.context.jobs.cancel({
        jobId: record.jobId,
        reason: 'Derived media generation cancelled from the video editor sidebar'
      })
    }
    const cancelled = await store.cancel(record.id)
    await this.discardPending(record)
    await this.publish(cancelled, 'cancelled')
    return derivedRecordProjection(cancelled)
  }

  async cleanup(projectId: string, includeReady: boolean): Promise<{
    removedIds: string[]
    usage: JsonObject
  }> {
    const store = await this.store()
    const removed = await store.cleanup({
      owner: this.owner({ projectId }),
      includeReady,
      includeFailed: true,
      includeInvalid: true,
      includeCancelled: true
    })
    return {
      removedIds: removed.map(({ id }) => id),
      usage: await store.usage() as unknown as JsonObject
    }
  }

  /**
   * Reconciles real cache records against the authoritative project grant and
   * source identity. This is safe to call after every relink/reauthorize and is
   * also invoked by list/start so stale persisted results cannot be reused.
   */
  async synchronizeProject(project: VideoProject): Promise<JsonObject[]> {
    const store = await this.store()
    await this.synchronizeRecordAccess(store, project.id)
    const records = await store.list({ owner: this.owner({ projectId: project.id }) })
    if (records.length === 0) return []

    const invalidated = new Map<string, DerivedMediaRecord>()
    const assetIds = new Set(records.flatMap(({ owner }) => owner.assetId ? [owner.assetId] : []))
    for (const assetId of assetIds) {
      const owner = this.owner({ projectId: project.id, assetId })
      const asset = project.assets.find(({ id }) => id === assetId)
      if (!asset || !asset.mediaHandleId || (asset.availability !== undefined && asset.availability !== 'online')) {
        for (const record of await store.invalidateOwner(owner, {
          code: 'source_unavailable',
          message: 'Source media is missing, revoked, or changed; reauthorize it before recomputing this result.'
        })) invalidated.set(record.id, record)
        continue
      }

      const currentFingerprint = effectiveSourceFingerprint(asset)
      for (const record of await store.invalidateOwnerSourceChange(owner, currentFingerprint)) {
        invalidated.set(record.id, record)
      }
      try {
        const metadata = await this.context.media.stat({ handleId: asset.mediaHandleId })
        if (metadata.revoked) throw new Error('source grant was revoked')
      } catch {
        for (const record of await store.invalidateOwner(owner, {
          code: 'source_unavailable',
          message: 'The Host rejected the source grant because it was revoked, replaced, or changed.'
        })) invalidated.set(record.id, record)
      }
    }

    const finalized: JsonObject[] = []
    for (const record of invalidated.values()) {
      const result = await this.finalizeInvalidation(store, record)
      await this.publish(result, record.error?.code ?? 'source-invalidated')
      finalized.push(derivedRecordProjection(result))
    }
    return finalized
  }

}
