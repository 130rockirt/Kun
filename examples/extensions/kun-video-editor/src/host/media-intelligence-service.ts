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
import { MediaIntelligenceServiceAnalysis } from './media-intelligence-service-analysis.js'
import type {
  AnalysisOutcome,
  IntelligenceRecord,
  MediaIntelligenceProgress
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
const MAX_RECORDS = 512

export * from './media-intelligence-service-model.js'

export class MediaIntelligenceService extends MediaIntelligenceServiceAnalysis {
  async analyzeVad(input: { project: VideoProject; assetId: string; signal?: AbortSignal }): Promise<AnalysisOutcome<VadAnalysisRecord>> {
    const broker = this.broker?.analyzeVad
    if (!broker) return unavailableAnalysis('vad_broker_unavailable', 'No approved local VAD broker is available.')
    const asset = requiredAsset(input.project, input.assetId)
    const handleId = requiredHandle(asset)
    const cached = (await this.listRecords(input.project.id)).find((record): record is VadAnalysisRecord =>
      isVadRecord(record) &&
      record.assetId === asset.id &&
      record.provenance.sourceFingerprint.value === sourceFingerprint(asset).value &&
      record.provenance.adapterId === this.broker!.id &&
      record.provenance.adapterVersion === this.broker!.version
    )
    if (cached && await this.matchesGrantBinding(input.project.id, cached.id, [handleId])) {
      return cachedOutcome(cached)
    }
    const operation = this.startOperation(input.project, 'vad', 100, input.signal)
    try {
      const evidence = await broker.call(this.broker, {
        mediaHandleId: handleId,
        signal: operation.controller.signal,
        report: (completed, total, message) => this.report(operation.progress.operationId, completed, total, message)
      })
      if (operation.controller.signal.aborted) return { outcome: 'cancelled', operationId: operation.progress.operationId }
      const record = analyzeVadEvidence({
        assetId: asset.id,
        sourceFingerprint: evidence.sourceFingerprint ?? sourceFingerprint(asset),
        frames: evidence.frames,
        completeness: evidence.completeness,
        adapterId: this.broker!.id,
        adapterVersion: this.broker!.version
      })
      const existing = await this.getRecord(input.project.id, record.id)
      if (existing && isVadRecord(existing)) {
        await this.persistGrantBinding(input.project.id, existing.id, [handleId])
        await this.finish(operation.progress.operationId, 'ready', 'Cached VAD evidence ready')
        return { outcome: 'ready', operationId: operation.progress.operationId, record: existing, deduplicated: true }
      }
      const deduplicated = await this.persistImmutable(input.project.id, record)
      await this.persistGrantBinding(input.project.id, record.id, [handleId])
      await this.finish(operation.progress.operationId, 'ready', 'VAD evidence ready')
      return { outcome: 'ready', operationId: operation.progress.operationId, record, deduplicated }
    } catch (error) {
      return await this.handleAnalysisError(operation.progress.operationId, error)
    }
  }

  async analyzeSpeakers(input: {
    project: VideoProject
    assetId: string
    optIn: boolean
    descriptor: SpeakerModelDescriptor
    installationVerified: boolean
    registry: SpeakerRegistry
    signal?: AbortSignal
  }): Promise<AnalysisOutcome<DiarizationRecord> | { outcome: 'unavailable'; capability: Exclude<ReturnType<typeof negotiateSpeakerAdapter>, { outcome: 'ready' }> }> {
    const capability = negotiateSpeakerAdapter({
      optIn: input.optIn,
      descriptor: input.descriptor,
      installationVerified: input.installationVerified,
      inferenceBrokerAvailable: Boolean(this.broker?.diarize)
    })
    if (capability.outcome !== 'ready') return { outcome: 'unavailable', capability }
    const broker = this.broker!.diarize!
    const asset = requiredAsset(input.project, input.assetId)
    const handleId = requiredHandle(asset)
    const cached = (await this.listRecords(input.project.id)).find((record): record is DiarizationRecord =>
      isDiarizationRecord(record) &&
      record.assetId === asset.id &&
      record.provenance.sourceFingerprint.value === sourceFingerprint(asset).value &&
      record.provenance.adapterId === capability.adapter.adapterId &&
      record.provenance.adapterVersion === capability.adapter.adapterVersion &&
      record.provenance.modelId === `${capability.adapter.modelId}@${capability.adapter.modelVersion}`
    )
    if (cached && await this.matchesGrantBinding(input.project.id, cached.id, [handleId])) {
      return cachedOutcome(cached)
    }
    const operation = this.startOperation(input.project, 'speaker', 100, input.signal)
    try {
      const evidence = await broker.call(this.broker, {
        mediaHandleId: handleId,
        adapter: capability.adapter,
        signal: operation.controller.signal,
        report: (completed, total, message) => this.report(operation.progress.operationId, completed, total, message)
      })
      if (operation.controller.signal.aborted) return { outcome: 'cancelled', operationId: operation.progress.operationId }
      const record = diarizeSpeakerEvidence({
        assetId: asset.id,
        sourceFingerprint: sourceFingerprint(asset),
        capability,
        registry: input.registry,
        turns: evidence.turns,
        completeness: evidence.completeness
      })
      const existing = await this.getRecord(input.project.id, record.id)
      if (existing && isDiarizationRecord(existing)) {
        await this.persistGrantBinding(input.project.id, existing.id, [handleId])
        await this.finish(operation.progress.operationId, 'ready', 'Cached speaker evidence ready')
        return { outcome: 'ready', operationId: operation.progress.operationId, record: existing, deduplicated: true }
      }
      const deduplicated = await this.persistImmutable(input.project.id, record)
      await this.persistGrantBinding(input.project.id, record.id, [handleId])
      await this.finish(operation.progress.operationId, 'ready', 'Speaker evidence ready')
      return { outcome: 'ready', operationId: operation.progress.operationId, record, deduplicated }
    } catch (error) {
      return await this.handleAnalysisError(operation.progress.operationId, error)
    }
  }

  async analyzeBeats(input: { project: VideoProject; assetId: string; signal?: AbortSignal }): Promise<AnalysisOutcome<BeatAnalysisRecord>> {
    const broker = this.broker?.analyzeBeats
    if (!broker) return unavailableAnalysis('beat_broker_unavailable', 'No approved local beat-analysis broker is available.')
    const asset = requiredAsset(input.project, input.assetId)
    const handleId = requiredHandle(asset)
    const cached = (await this.listRecords(input.project.id)).find((record): record is BeatAnalysisRecord =>
      isBeatRecord(record) &&
      record.assetId === asset.id &&
      record.provenance.sourceFingerprint.value === sourceFingerprint(asset).value &&
      record.provenance.adapterId === this.broker!.id &&
      record.provenance.adapterVersion === this.broker!.version
    )
    if (cached && await this.matchesGrantBinding(input.project.id, cached.id, [handleId])) {
      return cachedOutcome(cached)
    }
    const operation = this.startOperation(input.project, 'beats', 100, input.signal)
    try {
      const evidence = await broker.call(this.broker, {
        mediaHandleId: handleId,
        signal: operation.controller.signal,
        report: (completed, total, message) => this.report(operation.progress.operationId, completed, total, message)
      })
      if (operation.controller.signal.aborted) return { outcome: 'cancelled', operationId: operation.progress.operationId }
      const record = analyzeBeatEvidence({
        assetId: asset.id,
        sourceFingerprint: evidence.sourceFingerprint ?? sourceFingerprint(asset),
        observations: evidence.observations,
        tempoBpm: evidence.tempoBpm,
        completeness: evidence.completeness,
        adapterId: this.broker!.id,
        adapterVersion: this.broker!.version
      })
      const existing = await this.getRecord(input.project.id, record.id)
      if (existing && isBeatRecord(existing)) {
        await this.persistGrantBinding(input.project.id, existing.id, [handleId])
        await this.finish(operation.progress.operationId, 'ready', 'Cached beat evidence ready')
        return { outcome: 'ready', operationId: operation.progress.operationId, record: existing, deduplicated: true }
      }
      const deduplicated = await this.persistImmutable(input.project.id, record)
      await this.persistGrantBinding(input.project.id, record.id, [handleId])
      await this.finish(operation.progress.operationId, 'ready', 'Beat evidence ready')
      return { outcome: 'ready', operationId: operation.progress.operationId, record, deduplicated }
    } catch (error) {
      return await this.handleAnalysisError(operation.progress.operationId, error)
    }
  }

  async analyzeDenoiseMetadata(input: {
    project: VideoProject
    assetId: string
    confidenceThreshold?: number
    signal?: AbortSignal
  }): Promise<AnalysisOutcome<DenoiseMetadataRecord>> {
    const capability = await this.denoiseMetadataCapability()
    if (capability.outcome === 'unavailable') {
      return unavailableAnalysis(capability.code, capability.remediation)
    }
    const broker = this.broker
    const analyze = broker?.analyzeDenoiseMetadata
    if (!broker || !analyze) {
      return unavailableAnalysis(
        'denoise_metadata_broker_unavailable',
        'The negotiated local denoise analyzer is no longer available. No media was uploaded or modified.'
      )
    }
    const confidenceThreshold = boundedConfidence(input.confidenceThreshold ?? 0.7, 'confidenceThreshold')
    const asset = requiredAsset(input.project, input.assetId)
    const handleId = requiredHandle(asset)
    const expectedFingerprint = sourceFingerprint(asset)
    await this.assertCurrentMediaGrant(handleId)
    const cached = (await this.listRecords(input.project.id)).find((record): record is DenoiseMetadataRecord =>
      isDenoiseRecord(record) &&
      record.assetId === asset.id &&
      record.provenance.sourceFingerprint.value === expectedFingerprint.value &&
      record.provenance.adapterId === capability.descriptor.adapterId &&
      record.provenance.adapterVersion === capability.descriptor.adapterVersion &&
      record.provenance.algorithm === capability.descriptor.algorithm &&
      record.provenance.algorithmVersion === capability.descriptor.algorithmVersion &&
      record.provenance.modelId === capability.descriptor.modelId &&
      record.provenance.modelVersion === capability.descriptor.modelVersion &&
      record.confidenceThreshold === confidenceThreshold
    )
    if (cached && await this.matchesGrantBinding(input.project.id, cached.id, [handleId])) {
      return cachedOutcome(cached)
    }
    const operation = this.startOperation(input.project, 'denoise-metadata', 100, input.signal)
    try {
      const measured = await analyze.call(broker, {
        mediaHandleId: handleId,
        signal: operation.controller.signal,
        report: (completed, total, message) => this.report(operation.progress.operationId, completed, total, message)
      })
      if (operation.controller.signal.aborted) {
        return { outcome: 'cancelled', operationId: operation.progress.operationId }
      }
      if (
        measured.sourceFingerprint.algorithm !== 'sha256' ||
        measured.sourceFingerprint.value !== expectedFingerprint.value
      ) {
        throw unavailableError(
          'denoise_metadata_source_mismatch',
          'The local denoise result does not match the current source fingerprint. Reauthorize the source and analyze again.',
          false
        )
      }
      const record = createDenoiseMetadataRecord({
        assetId: asset.id,
        sourceFingerprint: measured.sourceFingerprint,
        descriptor: capability.descriptor,
        evidence: measured.evidence,
        confidenceThreshold
      })
      const existing = await this.getRecord(input.project.id, record.id)
      if (existing && isDenoiseRecord(existing)) {
        await this.persistGrantBinding(input.project.id, existing.id, [handleId])
        await this.finish(operation.progress.operationId, 'ready', 'Cached denoise metadata ready')
        return { outcome: 'ready', operationId: operation.progress.operationId, record: existing, deduplicated: true }
      }
      const deduplicated = await this.persistImmutable(input.project.id, record)
      await this.persistGrantBinding(input.project.id, record.id, [handleId])
      await this.finish(
        operation.progress.operationId,
        'ready',
        record.status === 'ready'
          ? 'Local denoise metadata ready; no audio was modified'
          : 'Low-confidence denoise metadata ready for review; no audio was modified'
      )
      const canonical = deduplicated
        ? await this.getRecord(input.project.id, record.id)
        : record
      if (!canonical || !isDenoiseRecord(canonical)) {
        throw new Error('Immutable denoise metadata could not be reloaded after persistence.')
      }
      return {
        outcome: 'ready',
        operationId: operation.progress.operationId,
        record: canonical,
        deduplicated
      }
    } catch (error) {
      return await this.handleAnalysisError(operation.progress.operationId, error)
    }
  }

  async analyzeSync(input: {
    project: VideoProject
    referenceAssetId: string
    targetAssetId: string
    seed: number
    maximumOffsetUs: number
    threshold?: number
    minimumSeparation?: number
    signal?: AbortSignal
  }): Promise<AnalysisOutcome<AudioSyncAnalysis>> {
    const broker = this.broker?.extractSyncFeatures
    if (!broker) return unavailableAnalysis('sync_broker_unavailable', 'No approved local audio-feature broker is available.')
    const reference = requiredAsset(input.project, input.referenceAssetId)
    const target = requiredAsset(input.project, input.targetAssetId)
    const referenceHandleId = requiredHandle(reference)
    const targetHandleId = requiredHandle(target)
    const referenceSource = sourceFingerprint(reference)
    const targetSource = sourceFingerprint(target)
    const combinedSource = combineAudioSourceFingerprints(referenceSource, targetSource)
    const cached = (await this.listRecords(input.project.id)).find((record): record is AudioSyncAnalysis =>
      isAudioSyncRecord(record) &&
      record.referenceAssetId === reference.id &&
      record.targetAssetId === target.id &&
      record.seed === input.seed &&
      record.threshold === (input.threshold ?? 0.82) &&
      record.minimumSeparation === (input.minimumSeparation ?? 0.03) &&
      record.provenance.sourceFingerprint.value === combinedSource.value &&
      record.provenance.adapterId === this.broker!.id &&
      record.provenance.adapterVersion === this.broker!.version &&
      record.id === audioSyncAnalysisId({
        referenceAssetId: reference.id,
        targetAssetId: target.id,
        referenceFingerprint: referenceSource,
        targetFingerprint: targetSource,
        samplePeriodUs: record.samplePeriodUs,
        maximumOffsetUs: input.maximumOffsetUs,
        seed: input.seed,
        threshold: input.threshold,
        minimumSeparation: input.minimumSeparation,
        adapterId: this.broker!.id,
        adapterVersion: this.broker!.version
      })
    )
    if (
      cached &&
      await this.matchesGrantBinding(input.project.id, cached.id, [referenceHandleId, targetHandleId])
    ) return cachedOutcome(cached)
    const operation = this.startOperation(input.project, 'audio-sync', 100, input.signal)
    try {
      const evidence = await broker.call(this.broker, {
        referenceHandleId,
        targetHandleId,
        seed: input.seed,
        signal: operation.controller.signal,
        report: (completed, total, message) => this.report(operation.progress.operationId, completed, total, message)
      })
      if (operation.controller.signal.aborted) return { outcome: 'cancelled', operationId: operation.progress.operationId }
      const record = analyzeAudioSynchronization({
        referenceAssetId: reference.id,
        targetAssetId: target.id,
        referenceFeatures: evidence.referenceFeatures,
        targetFeatures: evidence.targetFeatures,
        samplePeriodUs: evidence.samplePeriodUs,
        maximumOffsetUs: input.maximumOffsetUs,
        seed: input.seed,
        threshold: input.threshold,
        minimumSeparation: input.minimumSeparation,
        referenceFingerprint: evidence.referenceFingerprint ?? referenceSource,
        targetFingerprint: evidence.targetFingerprint ?? targetSource,
        adapterId: this.broker!.id,
        adapterVersion: this.broker!.version
      })
      const existing = await this.getRecord(input.project.id, record.id)
      if (existing && isAudioSyncRecord(existing)) {
        await this.persistGrantBinding(input.project.id, existing.id, [referenceHandleId, targetHandleId])
        await this.finish(operation.progress.operationId, 'ready', 'Cached audio synchronization evidence ready')
        return { outcome: 'ready', operationId: operation.progress.operationId, record: existing, deduplicated: true }
      }
      const deduplicated = await this.persistImmutable(input.project.id, record)
      await this.persistGrantBinding(input.project.id, record.id, [referenceHandleId, targetHandleId])
      await this.finish(operation.progress.operationId, 'ready', 'Audio synchronization evidence ready')
      return { outcome: 'ready', operationId: operation.progress.operationId, record, deduplicated }
    } catch (error) {
      return await this.handleAnalysisError(operation.progress.operationId, error)
    }
  }

}
