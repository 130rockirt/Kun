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
import type {
  AnalysisUnavailable,
  IntelligenceRecord,
  LocalMediaIntelligenceBroker,
  MediaIntelligenceProgress,
  Operation,
  OperationFailure,
  VisualModelBrokerStatus,
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
const GRANT_BINDING_PREFIX = 'media-intelligence:grant-binding:'
const VISUAL_OPT_IN_KEY = 'media-intelligence:visual-opt-in'
const SPEAKER_REGISTRY_PREFIX = 'media-intelligence:speaker-registry:'
const MAX_RECORDS = 512

export class MediaIntelligenceServiceCore {
  protected readonly operations = new Map<string, Operation>()
  protected sequence = 0

  constructor(
    protected readonly context: ExtensionContext,
    protected readonly broker?: LocalMediaIntelligenceBroker
  ) {}

  search(project: VideoProject, request: MediaSearchRequest): MediaSearchPage {
    return searchProjectMedia(project, request)
  }

  visualCapability(input: {
    optIn: boolean
    descriptor: VisualModelDescriptor
    receipt?: VisualModelInstallReceipt
  }): ReturnType<typeof negotiateVisualAdapter> {
    return negotiateVisualAdapter({
      ...input,
      inferenceBrokerAvailable: Boolean(this.broker?.indexVisual && this.broker?.embedVisualQuery)
    })
  }


  async cancel(operationId: string): Promise<boolean> {
    const operation = this.operations.get(operationId)
    if (!operation || ['cancelled', 'ready', 'failed'].includes(operation.progress.status)) return false
    operation.controller.abort()
    await this.finish(operationId, 'cancelled', 'Local media analysis cancelled')
    return true
  }

  status(operationId: string): MediaIntelligenceProgress | undefined {
    const progress = this.operations.get(operationId)?.progress
    return progress ? structuredClone(progress) : undefined
  }

  listOperations(projectId: string): MediaIntelligenceProgress[] {
    return [...this.operations.values()]
      .map(({ progress }) => progress)
      .filter((progress) => progress.projectId === projectId)
      .sort((left, right) => right.generation - left.generation || left.operationId.localeCompare(right.operationId))
      .slice(0, 100)
      .map((progress) => structuredClone(progress))
  }

  async listRecords(projectId: string): Promise<IntelligenceRecord[]> {
    const prefix = `${RECORD_PREFIX}${safePart(projectId)}:`
    const keys = (await this.context.storage.workspace.keys())
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(0, MAX_RECORDS)
    const records: IntelligenceRecord[] = []
    for (const key of keys) {
      const value = await this.context.storage.workspace.get<JsonValue>(key)
      if (isIntelligenceRecord(value)) records.push(value as unknown as IntelligenceRecord)
    }
    return records
  }

  async readEvidence(
    projectId: string,
    recordId: string,
    request: { offset?: number; limit?: number } = {}
  ): Promise<ReturnType<typeof readMediaIntelligenceEvidence>> {
    const record = (await this.listRecords(projectId)).find(({ id }) => id === recordId)
    if (!record) throw new Error(`Media-intelligence evidence does not exist: ${recordId}`)
    return readMediaIntelligenceEvidence(record, request)
  }

  async getRecord(projectId: string, recordId: string): Promise<IntelligenceRecord | undefined> {
    return (await this.listRecords(projectId)).find(({ id }) => id === recordId)
  }

  async matchesCurrentGrantBinding(
    project: VideoProject,
    record: IntelligenceRecord
  ): Promise<boolean> {
    if (isVisualIndexRecord(record)) {
      const asset = project.assets.find(({ id }) => id === record.assetId)
      if (!asset?.mediaHandleId) return false
      return await this.matchesGrantBinding(project.id, record.id, [asset.mediaHandleId])
    }
    if (record.kind === 'audio-sync') {
      const reference = project.assets.find(({ id }) => id === record.referenceAssetId)
      const target = project.assets.find(({ id }) => id === record.targetAssetId)
      if (!reference?.mediaHandleId || !target?.mediaHandleId) return false
      return await this.matchesGrantBinding(project.id, record.id, [reference.mediaHandleId, target.mediaHandleId])
    }
    const asset = project.assets.find(({ id }) => id === record.assetId)
    if (!asset?.mediaHandleId) return false
    return await this.matchesGrantBinding(project.id, record.id, [asset.mediaHandleId])
  }

  protected startOperation(
    project: VideoProject,
    kind: MediaIntelligenceProgress['kind'],
    total: number,
    externalSignal?: AbortSignal
  ): Operation {
    const operationId = `media-analysis-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`
    const operation: Operation = {
      controller: new AbortController(),
      progress: {
        schemaVersion: 1,
        operationId,
        projectId: project.id,
        projectRevision: project.currentRevision,
        kind,
        generation: 1,
        status: 'queued',
        completed: 0,
        total: Math.max(1, total)
      }
    }
    if (externalSignal) {
      const cancel = (): void => operation.controller.abort()
      if (externalSignal.aborted) cancel()
      else {
        externalSignal.addEventListener('abort', cancel, { once: true })
        operation.detachExternalCancellation = () => externalSignal.removeEventListener('abort', cancel)
      }
    }
    this.operations.set(operationId, operation)
    if (this.operations.size > 256) {
      const removable = [...this.operations.entries()]
        .filter(([, candidate]) => ['cancelled', 'ready', 'failed'].includes(candidate.progress.status))
        .slice(0, this.operations.size - 256)
      for (const [id] of removable) this.operations.delete(id)
    }
    void this.publish(operation.progress)
    operation.progress = { ...operation.progress, generation: 2, status: 'running' }
    void this.publish(operation.progress)
    return operation
  }

  protected async resolveVisualProvisioning(): Promise<{
    projection: VisualProvisioningState
    capability?: ReturnType<typeof negotiateVisualAdapter>
  }> {
    const checkedAt = new Date().toISOString()
    const optIn = await this.visualOptIn()
    const emptyVerification = {
      brokerAttested: false,
      downloadVerified: false,
      sourceVerified: false,
      installVerified: false,
      signatureVerified: false,
      manifestVerified: false,
      errors: [] as string[]
    }
    if (!optIn) {
      return {
        projection: visualProvisioningProjection({
          optIn,
          state: 'disabled',
          code: 'visual_model_disabled',
          installSupported: Boolean(this.broker?.requestVisualModelInstall),
          verification: emptyVerification,
          remediation: 'Enable local visual indexing for this workspace before checking or installing a model.',
          checkedAt
        })
      }
    }
    if (!this.broker?.visualModelStatus) {
      return {
        projection: visualProvisioningProjection({
          optIn,
          state: 'broker-unavailable',
          code: 'visual_model_broker_unavailable',
          installSupported: false,
          verification: emptyVerification,
          remediation: 'This Kun build has no approved model download/install Broker. Update Kun or install a Host build that exposes verified local-model provisioning; filename and transcript search remain available.',
          checkedAt
        })
      }
    }
    let status: VisualModelBrokerStatus
    try {
      status = await this.broker.visualModelStatus()
    } catch {
      return {
        projection: visualProvisioningProjection({
          optIn,
          state: 'failed',
          code: 'visual_model_install_failed',
          installSupported: Boolean(this.broker.requestVisualModelInstall),
          verification: emptyVerification,
          remediation: 'The Host model Broker could not verify local installation state. Retry the check or repair the Host model runtime.',
          checkedAt
        })
      }
    }
    let model: NonNullable<VisualProvisioningState['model']>
    let capability: ReturnType<typeof negotiateVisualAdapter>
    try {
      model = visualModelProjection(status.descriptor)
      capability = this.visualCapability({
        optIn,
        descriptor: status.descriptor,
        receipt: status.receipt
      })
    } catch {
      return {
        projection: visualProvisioningProjection({
          optIn,
          state: 'unverified',
          code: 'visual_model_unverified',
          installSupported: false,
          verification: {
            ...emptyVerification,
            errors: ['The Host model descriptor failed bounded identity or manifest validation.']
          },
          remediation: 'Repair or reinstall the model through an approved Host model Broker; unvalidated model metadata will not execute.',
          checkedAt
        })
      }
    }
    if (status.state === 'downloading') {
      return {
        projection: visualProvisioningProjection({
          optIn,
          state: 'downloading',
          code: 'visual_model_downloading',
          installSupported: status.installSupported,
          model,
          verification: emptyVerification,
          remediation: boundedRemediation(status.remediation),
          checkedAt: safeCheckedAt(status.checkedAt, checkedAt)
        })
      }
    }
    const verification = status.receipt
      ? verifyVisualReceiptProjection(status.descriptor, status.receipt)
      : emptyVerification
    const state = capability.outcome === 'ready'
      ? 'ready'
      : capability.code === 'visual_model_missing'
        ? status.state === 'failed' ? 'failed' : 'missing'
      : capability.code === 'visual_model_unverified'
          ? 'unverified'
          : 'inference-unavailable'
    const code = capability.outcome === 'ready'
      ? 'visual_model_ready'
      : status.state === 'failed'
        ? 'visual_model_install_failed'
        : capability.code
    return {
      projection: visualProvisioningProjection({
        optIn,
        state,
        code,
        installSupported: status.installSupported && Boolean(this.broker.requestVisualModelInstall),
        ...(status.receipt ? { packageSource: status.receipt.packageSource ?? 'downloaded' } : {}),
        model,
        verification,
        remediation: capability.outcome === 'ready'
          ? 'Verified local visual model is ready; inference remains local and receives only opaque media handles.'
          : boundedRemediation(status.remediation || capability.remediation),
        checkedAt: safeCheckedAt(status.checkedAt, checkedAt)
      }),
      capability
    }
  }

  protected async visualOptIn(): Promise<boolean> {
    const value = await this.context.storage.workspace.get<JsonValue>(VISUAL_OPT_IN_KEY)
    return Boolean(
      value && typeof value === 'object' && !Array.isArray(value) &&
      value.schemaVersion === 1 && value.optIn === true
    )
  }

  protected async assertCurrentMediaGrant(handleId: string): Promise<void> {
    if (!this.broker?.validateMediaGrant) return
    if (!await this.broker.validateMediaGrant(handleId)) {
      throw new Error('Media grant is revoked or is not readable.')
    }
  }

  protected async report(operationId: string, completed: number, total: number, message?: string): Promise<void> {
    const operation = this.operations.get(operationId)
    if (!operation || operation.controller.signal.aborted) throw abortError()
    if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || total < 1 || completed < operation.progress.completed || completed > total) {
      throw new Error('Local analysis progress must be bounded and monotonic.')
    }
    operation.progress = {
      ...operation.progress,
      generation: operation.progress.generation + 1,
      status: 'running',
      completed,
      total,
      ...(message ? { message: message.slice(0, 512) } : {})
    }
    await this.publish(operation.progress)
  }

  protected async finish(
    operationId: string,
    status: 'cancelled' | 'ready' | 'failed',
    message: string,
    error?: MediaIntelligenceProgress['error']
  ): Promise<void> {
    const operation = this.operations.get(operationId)
    if (!operation || ['cancelled', 'ready', 'failed'].includes(operation.progress.status)) return
    operation.detachExternalCancellation?.()
    operation.detachExternalCancellation = undefined
    operation.progress = {
      ...operation.progress,
      generation: operation.progress.generation + 1,
      status,
      ...(status === 'ready' ? { completed: operation.progress.total } : {}),
      message: message.slice(0, 512),
      ...(error ? { error } : {})
    }
    await this.publish(operation.progress)
  }

  protected async handleOperationError(operationId: string, error: unknown): Promise<OperationFailure> {
    const operation = this.operations.get(operationId)
    if (operation?.controller.signal.aborted || isAbortError(error)) {
      await this.finish(operationId, 'cancelled', 'Local media analysis cancelled')
      return { outcome: 'cancelled', operationId }
    }
    const message = error instanceof Error ? error.message : String(error)
    const boundedError = { code: 'local_analysis_failed', message: message.slice(0, 1_024), retryable: true }
    await this.finish(operationId, 'failed', 'Local media analysis failed', boundedError)
    return { outcome: 'failed', operationId, error: boundedError }
  }

  protected async handleAnalysisError(operationId: string, error: unknown): Promise<OperationFailure | AnalysisUnavailable> {
    if (isUnavailableError(error)) {
      await this.finish(operationId, 'failed', error.remediation, {
        code: error.code,
        message: error.remediation,
        retryable: error.retryable
      })
      return {
        outcome: 'unavailable',
        code: error.code,
        remediation: error.remediation,
        networkUsed: false
      }
    }
    return await this.handleOperationError(operationId, error)
  }

  protected async persistImmutable(projectId: string, record: IntelligenceRecord): Promise<boolean> {
    const key = `${RECORD_PREFIX}${safePart(projectId)}:${safePart(record.id)}`
    const existing = await this.context.storage.workspace.get<JsonValue>(key)
    const value = record as unknown as JsonValue
    if (existing !== undefined) {
      const sameVisualEvidence = isVisualIndexRecord(record) && isIntelligenceRecord(existing) &&
        isVisualIndexRecord(existing as unknown as IntelligenceRecord) &&
        JSON.stringify(withoutVisualCreatedAt(existing as unknown as VisualIndexRecord)) ===
          JSON.stringify(withoutVisualCreatedAt(record))
      const sameDenoiseEvidence = isDenoiseRecord(record) && isIntelligenceRecord(existing) &&
        isDenoiseRecord(existing as unknown as IntelligenceRecord) &&
        JSON.stringify(withoutDenoiseCreatedAt(existing as unknown as DenoiseMetadataRecord)) ===
          JSON.stringify(withoutDenoiseCreatedAt(record))
      if (!sameVisualEvidence && !sameDenoiseEvidence && JSON.stringify(existing) !== JSON.stringify(value)) {
        throw new Error(`Immutable media-intelligence record changed for ${record.id}.`)
      }
      return true
    }
    await this.context.storage.workspace.set(key, value)
    return false
  }

  protected async matchesGrantBinding(
    projectId: string,
    recordId: string,
    handleIds: readonly string[]
  ): Promise<boolean> {
    const value = await this.context.storage.workspace.get<JsonValue>(grantBindingKey(projectId, recordId))
    return Boolean(
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value.schemaVersion === 1 &&
      Array.isArray(value.handleIds) &&
      value.handleIds.length === handleIds.length &&
      value.handleIds.every((handleId, index) => handleId === handleIds[index])
    )
  }

  protected async persistGrantBinding(
    projectId: string,
    recordId: string,
    handleIds: readonly string[]
  ): Promise<void> {
    await this.context.storage.workspace.set(grantBindingKey(projectId, recordId), {
      schemaVersion: 1,
      handleIds: [...handleIds]
    })
  }

  protected async publish(progress: MediaIntelligenceProgress): Promise<void> {
    await this.context.ui.postMessage({
      channel: 'kun-video-editor.media-intelligence-progress',
      payload: progress as unknown as JsonObject
    })
  }
}
