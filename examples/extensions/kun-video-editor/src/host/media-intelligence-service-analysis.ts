import type {
  ExtensionContext,
  JsonObject,
  JsonValue,
  MediaAudioAnalysisCapabilities
} from '@kun/extension-api'
import {
  containsAsciiControlCharacters,
  replaceAsciiControlCharacters
} from '../text-safety.js'
import {
  SpeakerIdentityRegistry,
  SpeakerRegistry,
  VisualIndexProgressTracker,
  analyzeAudioSynchronization,
  audioSyncAnalysisId,
  analyzeBeatEvidence,
  analyzeVadEvidence,
  buildFrameSamplingPlan,
  createVisualIndexRecord,
  combineAudioSourceFingerprints,
  createDenoiseMetadataRecord,
  diarizeSpeakerEvidence,
  defaultSpeakerDiarizationAdapterRegistry,
  fingerprintAssetIdentity,
  importSpeakerDiarizationEvidence,
  isValidVisualIndexRecord,
  isValidDenoiseMetadataAdapterDescriptor,
  isValidDenoiseMetadataRecord,
  negotiateSpeakerAdapter,
  negotiateVisualAdapter,
  readMediaIntelligenceEvidence,
  searchProjectMedia,
  searchVisualMoments,
  verifyVisualModelInstallation,
  type AudioSyncAnalysis,
  type BeatAnalysisRecord,
  type BeatObservation,
  type DiarizationRecord,
  type DiarizationTurnEvidence,
  type DenoiseMetadataCapability,
  type DenoiseMetadataRecord,
  type DenoiseNoiseProfileEvidence,
  type MediaSearchPage,
  type MediaSearchRequest,
  type SourceIdentity,
  type ImportedDiarizationTurn,
  type SpeakerDiarizationAdapterStatus,
  type SpeakerIdentity,
  type SpeakerModelDescriptor,
  type VadAnalysisRecord,
  type VadFrameEvidence,
  type VideoProject,
  type VisualEmbeddingEvidence,
  type VisualIndexRecord,
  type VisualModelDescriptor,
  type VisualModelInstallReceipt,
  type VisualMomentPage
} from '../engine/index.js'
import { MediaIntelligenceServiceCore } from './media-intelligence-service-core.js'
import type {
  AnalysisOutcome,
  IntelligenceRecord,
  LocalMediaIntelligenceBroker,
  MediaIntelligenceProgress,
  VisualProvisioningState
} from './media-intelligence-service-model.js'
import {
  abortError,
  boundedConfidence,
  boundedRemediation,
  cachedOutcome,
  grantBindingKey,
  isAbortError,
  isAudioSyncRecord,
  isBeatRecord,
  isDenoiseRecord,
  isDiarizationRecord,
  isIntelligenceRecord,
  isUnavailableError,
  isVadRecord,
  isVisualIndexRecord,
  requiredAsset,
  requiredHandle,
  restoreStorageValue,
  safeCheckedAt,
  safePart,
  sourceFingerprint,
  speakerRegistryKey,
  unavailableAnalysis,
  unavailableError,
  verifyVisualReceiptProjection,
  visualModelProjection,
  visualProvisioningProjection,
  withoutDenoiseCreatedAt,
  withoutVisualCreatedAt,
  yieldToCancellation
} from './media-intelligence-service-support.js'

const RECORD_PREFIX = 'media-intelligence:record:'
const VISUAL_OPT_IN_KEY = 'media-intelligence:visual-opt-in'

export class MediaIntelligenceServiceAnalysis extends MediaIntelligenceServiceCore {
  async visualProvisioning(): Promise<VisualProvisioningState> {
    return (await this.resolveVisualProvisioning()).projection
  }

  async setVisualOptIn(optIn: boolean): Promise<VisualProvisioningState> {
    await this.context.storage.workspace.set(VISUAL_OPT_IN_KEY, {
      schemaVersion: 1,
      optIn
    })
    return await this.visualProvisioning()
  }

  async requestVisualModelInstall(signal?: AbortSignal): Promise<
    | { outcome: 'ready'; capability: VisualProvisioningState }
    | { outcome: 'unavailable'; capability: VisualProvisioningState }
  > {
    const before = await this.resolveVisualProvisioning()
    if (before.capability?.outcome === 'ready') {
      return { outcome: 'ready', capability: before.projection }
    }
    if (!before.projection.optIn || !this.broker?.requestVisualModelInstall) {
      return { outcome: 'unavailable', capability: before.projection }
    }
    const controller = new AbortController()
    const cancel = (): void => controller.abort()
    if (signal?.aborted) cancel()
    else signal?.addEventListener('abort', cancel, { once: true })
    try {
      await this.broker.requestVisualModelInstall({ signal: controller.signal })
      const after = await this.resolveVisualProvisioning()
      return after.capability?.outcome === 'ready'
        ? { outcome: 'ready', capability: after.projection }
        : { outcome: 'unavailable', capability: after.projection }
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }

  async audioCapabilities(): Promise<MediaAudioAnalysisCapabilities> {
    if (this.broker?.capabilities) return await this.broker.capabilities()
    const remediation = 'Install or enable Kun\'s verified local audio-analysis runtime; no media was uploaded and no evidence was fabricated.'
    return {
      schemaVersion: 1,
      probedAt: new Date().toISOString(),
      analyses: (['silence', 'beat-grid', 'sync-features'] as const).map((analysis) => ({
        analysis,
        available: false as const,
        code: 'AUDIO_ANALYSIS_ALGORITHM_UNAVAILABLE' as const,
        remediation,
        retryable: false,
        local: true as const,
        networkUsed: false as const
      }))
    }
  }

  async denoiseMetadataCapability(): Promise<DenoiseMetadataCapability> {
    const fallback = (): Extract<DenoiseMetadataCapability, { outcome: 'unavailable' }> => ({
      outcome: 'unavailable',
      code: 'denoise_metadata_broker_unavailable',
      remediation: 'This Kun Host does not expose verified local noise-profile analysis. No media was uploaded or modified, and no denoise values were fabricated.',
      retryable: false,
      local: true,
      networkUsed: false
    })
    if (!this.broker?.denoiseMetadataCapability) return fallback()
    let capability: DenoiseMetadataCapability
    try {
      capability = await this.broker.denoiseMetadataCapability()
    } catch {
      return {
        ...fallback(),
        remediation: 'The Host could not negotiate its local noise-profile analyzer. Repair or update the approved Host analysis runtime and retry.',
        retryable: true
      }
    }
    if (capability.outcome === 'unavailable') {
      if (
        ![
          'denoise_metadata_broker_unavailable',
          'denoise_metadata_algorithm_unavailable',
          'denoise_metadata_model_unverified'
        ].includes(capability.code) ||
        capability.local !== true || capability.networkUsed !== false
      ) return fallback()
      return {
        ...structuredClone(capability),
        remediation: boundedRemediation(capability.remediation)
      }
    }
    if (!this.broker.analyzeDenoiseMetadata) return fallback()
    if (
      capability.local !== true || capability.networkUsed !== false ||
      !isValidDenoiseMetadataAdapterDescriptor(capability.descriptor)
    ) {
      return {
        outcome: 'unavailable',
        code: 'denoise_metadata_model_unverified',
        remediation: 'The Host denoise analyzer did not provide a bounded algorithm/model identity and version. No analysis was run.',
        retryable: false,
        local: true,
        networkUsed: false
      }
    }
    return structuredClone(capability)
  }

  speakerAdapters(): SpeakerDiarizationAdapterStatus[] {
    const localAvailable = Boolean(this.broker?.diarize)
    return defaultSpeakerDiarizationAdapterRegistry({
      localDescriptor: {
        adapterId: 'kun.host.local-speaker',
        adapterVersion: this.broker?.version ?? '1.0.0',
        modelId: 'speaker-diarization',
        modelVersion: this.broker?.version ?? 'unavailable',
        embeddingDimensions: 512
      },
      localInstallationVerified: localAvailable,
      localInferenceBrokerAvailable: localAvailable
    }).list()
  }

  async listSpeakerIdentities(projectId: string): Promise<SpeakerIdentity[]> {
    const value = await this.context.storage.workspace.get<JsonValue>(speakerRegistryKey(projectId))
    if (value === undefined) return []
    if (!Array.isArray(value)) throw new Error('Stored speaker identity registry is unreadable.')
    try {
      return new SpeakerIdentityRegistry(value as unknown as SpeakerIdentity[]).list()
    } catch {
      throw new Error('Stored speaker identity registry failed bounded validation.')
    }
  }

  async importSpeakerEvidence(input: {
    project: VideoProject
    assetId: string
    identities: readonly SpeakerIdentity[]
    turns: readonly ImportedDiarizationTurn[]
    confidenceThreshold?: number
    completeness?: 'complete' | 'partial'
    signal?: AbortSignal
  }): Promise<AnalysisOutcome<DiarizationRecord>> {
    const asset = requiredAsset(input.project, input.assetId)
    const handleId = requiredHandle(asset)
    const existingIdentities = await this.listSpeakerIdentities(input.project.id)
    const identities = new SpeakerIdentityRegistry(existingIdentities)
    for (const identity of input.identities) identities.upsert(identity)
    const adapter = defaultSpeakerDiarizationAdapterRegistry()
      .requireReady('kun.imported-speaker-labels')
    const total = Math.max(1, input.turns.length + 1)
    const operation = this.startOperation(input.project, 'speaker', total, input.signal)
    try {
      for (let offset = 0; offset < input.turns.length; offset += 128) {
        operation.controller.signal.throwIfAborted()
        await yieldToCancellation()
        await this.report(
          operation.progress.operationId,
          Math.min(input.turns.length, offset + 128),
          total,
          'Validating imported speaker turns'
        )
      }
      operation.controller.signal.throwIfAborted()
      const record = importSpeakerDiarizationEvidence({
        assetId: asset.id,
        sourceFingerprint: sourceFingerprint(asset),
        adapter,
        identities,
        turns: input.turns,
        confidenceThreshold: input.confidenceThreshold,
        completeness: input.completeness
      })
      const stored = await this.getRecord(input.project.id, record.id)
      if (stored && isDiarizationRecord(stored) &&
        await this.matchesGrantBinding(input.project.id, stored.id, [handleId])) {
        await this.finish(operation.progress.operationId, 'ready', 'Cached imported speaker evidence ready')
        return { outcome: 'ready', operationId: operation.progress.operationId, record: stored, deduplicated: true }
      }
      const recordKey = `${RECORD_PREFIX}${safePart(input.project.id)}:${safePart(record.id)}`
      const grantKey = grantBindingKey(input.project.id, record.id)
      const registryKey = speakerRegistryKey(input.project.id)
      const previousRecord = await this.context.storage.workspace.get<JsonValue>(recordKey)
      const previousGrant = await this.context.storage.workspace.get<JsonValue>(grantKey)
      const previousRegistry = await this.context.storage.workspace.get<JsonValue>(registryKey)
      try {
        const deduplicated = await this.persistImmutable(input.project.id, record)
        await this.persistGrantBinding(input.project.id, record.id, [handleId])
        await this.context.storage.workspace.set(registryKey, identities.list() as unknown as JsonValue)
        await this.report(operation.progress.operationId, total, total, 'Imported speaker evidence ready')
        await this.finish(operation.progress.operationId, 'ready', 'Imported speaker evidence ready')
        return { outcome: 'ready', operationId: operation.progress.operationId, record, deduplicated }
      } catch (error) {
        await restoreStorageValue(this.context, recordKey, previousRecord)
        await restoreStorageValue(this.context, grantKey, previousGrant)
        await restoreStorageValue(this.context, registryKey, previousRegistry)
        throw error
      }
    } catch (error) {
      return await this.handleAnalysisError(operation.progress.operationId, error)
    }
  }

  async startVisualIndex(input: {
    project: VideoProject
    assetId: string
    intervalUs?: number
    maxFrames?: number
    allowPartial?: boolean
    signal?: AbortSignal
  }): Promise<
    | { outcome: 'ready'; operationId: string; record: VisualIndexRecord; deduplicated: boolean }
    | { outcome: 'cancelled'; operationId: string }
    | { outcome: 'failed'; operationId: string; error: { code: string; message: string; retryable: boolean } }
    | { outcome: 'unavailable'; capability: VisualProvisioningState }
  > {
    const provisioning = await this.resolveVisualProvisioning()
    const capability = provisioning.capability
    if (!capability || capability.outcome !== 'ready') {
      return { outcome: 'unavailable', capability: provisioning.projection }
    }
    const broker = this.broker?.indexVisual
    if (!broker) throw new Error('Visual capability negotiation and broker availability diverged.')
    const asset = requiredAsset(input.project, input.assetId)
    const handleId = requiredHandle(asset)
    await this.assertCurrentMediaGrant(handleId)
    const plan = buildFrameSamplingPlan({
      assetId: asset.id,
      durationUs: asset.durationUs,
      sourceFingerprint: sourceFingerprint(asset),
      intervalUs: input.intervalUs,
      maxFrames: input.maxFrames
    })
    const cached = (await this.listRecords(input.project.id)).find((record): record is VisualIndexRecord =>
      isVisualIndexRecord(record) &&
      record.assetId === asset.id &&
      record.sourceFingerprint.value === plan.sourceFingerprint.value &&
      record.adapter.id === capability.adapter.id &&
      record.adapter.version === capability.adapter.version &&
      record.adapter.modelId === capability.adapter.modelId &&
      record.adapter.modelVersion === capability.adapter.modelVersion &&
      record.adapter.packageId === capability.adapter.packageId &&
      record.adapter.manifestSha256 === capability.adapter.manifestSha256 &&
      record.parameters.intervalUs === plan.intervalUs &&
      record.parameters.durationUs === plan.durationUs &&
      record.parameters.maxFrames === plan.maxFrames &&
      record.parameters.samplingStrategy === plan.strategy &&
      record.parameters.embeddingDimensions === capability.adapter.embeddingDimensions &&
      record.plannedSampleCount === plan.samples.length
    )
    if (cached && await this.matchesGrantBinding(input.project.id, cached.id, [handleId])) {
      return {
        outcome: 'ready',
        operationId: `cached-${cached.id}`.slice(0, 512),
        record: cached,
        deduplicated: true
      }
    }
    const operation = this.startOperation(input.project, 'visual-index', plan.samples.length, input.signal)
    const tracker = new VisualIndexProgressTracker(plan.samples.length)
    tracker.start('Starting verified local visual indexing')
    try {
      const embeddings = await broker.call(this.broker, {
        mediaHandleId: handleId,
        samples: plan.samples,
        adapter: capability.adapter,
        signal: operation.controller.signal,
        report: async (completed, total, message) => {
          tracker.report(completed, message)
          await this.report(operation.progress.operationId, completed, total, message)
        }
      })
      if (operation.controller.signal.aborted) {
        tracker.cancel()
        await this.finish(operation.progress.operationId, 'cancelled', 'Local visual indexing cancelled')
        return { outcome: 'cancelled', operationId: operation.progress.operationId }
      }
      const record = createVisualIndexRecord({
        capability,
        plan,
        embeddings,
        allowPartial: input.allowPartial
      })
      const deduplicated = await this.persistImmutable(input.project.id, record)
      await this.persistGrantBinding(input.project.id, record.id, [handleId])
      tracker.complete()
      await this.finish(operation.progress.operationId, 'ready', 'Visual index ready')
      const canonical = deduplicated
        ? await this.getRecord(input.project.id, record.id)
        : record
      if (!canonical || !isVisualIndexRecord(canonical)) {
        throw new Error('Immutable visual index could not be reloaded after persistence.')
      }
      return { outcome: 'ready', operationId: operation.progress.operationId, record: canonical, deduplicated }
    } catch (error) {
      return await this.handleOperationError(operation.progress.operationId, error)
    }
  }

  async searchVisual(input: {
    project: VideoProject
    indexId: string
    query: string
    minimumScore?: number
    offset?: number
    pageSize?: number
  }): Promise<
    | { outcome: 'ready'; page: VisualMomentPage }
    | {
        outcome: 'unavailable'
        code: 'visual_query_broker_unavailable' | 'visual_query_unsupported' | 'visual_index_stale' | 'visual_model_changed'
        remediation: string
        networkUsed: false
      }
  > {
    const query = input.query.normalize('NFKC').trim()
    if (!query || query.length > 256 || containsAsciiControlCharacters(query)) {
      throw new Error('Visual moment query must contain 1 through 256 printable characters.')
    }
    const index = await this.getRecord(input.project.id, input.indexId)
    if (!index || !isVisualIndexRecord(index)) {
      return {
        outcome: 'unavailable',
        code: 'visual_index_stale',
        remediation: 'The requested immutable visual index is missing. Refresh records and index the current media grant.',
        networkUsed: false
      }
    }
    const asset = input.project.assets.find(({ id }) => id === index.assetId)
    if (
      !asset?.mediaHandleId ||
      sourceFingerprint(asset).value !== index.sourceFingerprint.value ||
      !await this.matchesGrantBinding(input.project.id, index.id, [asset.mediaHandleId])
    ) {
      return {
        outcome: 'unavailable',
        code: 'visual_index_stale',
        remediation: 'The visual index belongs to older source evidence or a revoked media grant. Reauthorize and index again.',
        networkUsed: false
      }
    }
    try {
      await this.assertCurrentMediaGrant(asset.mediaHandleId)
    } catch {
      return {
        outcome: 'unavailable',
        code: 'visual_index_stale',
        remediation: 'The authorized media file changed or is no longer readable. Reauthorize it and build a new immutable visual index.',
        networkUsed: false
      }
    }
    const provisioning = await this.resolveVisualProvisioning()
    const capability = provisioning.capability
    if (
      !capability || capability.outcome !== 'ready' ||
      capability.adapter.id !== index.adapter.id ||
      capability.adapter.version !== index.adapter.version ||
      capability.adapter.modelId !== index.adapter.modelId ||
      capability.adapter.modelVersion !== index.adapter.modelVersion ||
      capability.adapter.packageId !== index.adapter.packageId ||
      capability.adapter.manifestSha256 !== index.adapter.manifestSha256
    ) {
      return {
        outcome: 'unavailable',
        code: 'visual_model_changed',
        remediation: 'The verified local model no longer matches this immutable index. Re-index before searching.',
        networkUsed: false
      }
    }
    const broker = this.broker?.embedVisualQuery
    if (!broker) {
      return {
        outcome: 'unavailable',
        code: 'visual_query_broker_unavailable',
        remediation: 'Install and enable a verified local visual model and approved inference broker; no result was fabricated.',
        networkUsed: false
      }
    }
    const controller = new AbortController()
    let queryVector: number[]
    try {
      queryVector = await broker.call(this.broker, {
        query,
        adapter: index.adapter,
        signal: controller.signal
      })
    } catch (error) {
      if (!isUnavailableError(error)) throw error
      return {
        outcome: 'unavailable',
        code: error.code === 'VISUAL_QUERY_UNSUPPORTED'
          ? 'visual_query_unsupported'
          : 'visual_query_broker_unavailable',
        remediation: error.remediation,
        networkUsed: false
      }
    }
    return {
      outcome: 'ready',
      page: searchVisualMoments({
        index,
        queryVector,
        minimumScore: input.minimumScore,
        offset: input.offset,
        pageSize: input.pageSize
      })
    }
  }

}
