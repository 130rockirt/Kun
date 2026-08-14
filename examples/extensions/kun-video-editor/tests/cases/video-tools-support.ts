import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseExtensionManifest, type ExtensionManifest, type JsonObject, type ToolResult } from '@kun/extension-api'
import { createExtensionTestHarness, createGeneratedArtifactFixture, type ExtensionTestHarness } from '@kun/extension-test'
import { afterEach } from 'vitest'
import { activate, VIDEO_TOOL_IDS } from '../../src/host/extension.js'
import { VideoEditorTools } from '../../src/host/video-tools.js'
import type { GenerationAuthorizationChallenge, GenerationExecutionBroker } from '../../src/host/generation-service.js'

export const roots: string[] = []
export const permissions = [
  'commands.register',
  'ui.views',
  'ui.actions',
  'webview',
  'agent.run',
  'tools.register',
  'storage.workspace',
  'workspace.read',
  'workspace.write',
  'media.read',
  'media.process',
  'media.export',
  'jobs.manage'
]

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

export async function generationHarness(broker: GenerationExecutionBroker): Promise<{
  harness: ExtensionTestHarness
  tools: VideoEditorTools
}> {
  const root = await mkdtemp(join(tmpdir(), 'kun-video-generation-tools-'))
  roots.push(root)
  const harness = createExtensionTestHarness({
    identity: {
      id: 'kun-examples.kun-video-editor',
      publisher: 'kun-examples',
      name: 'kun-video-editor',
      version: '0.4.0'
    },
    permissions,
    workspace: { id: 'video-workspace', name: 'Video Workspace', root, trusted: true, active: true }
  })
  const tools = new VideoEditorTools(harness.context, { generationBroker: broker })
  await tools.register()
  return { harness, tools }
}

export function generationCatalogFixture(): JsonObject {
  return {
    schemaVersion: 1,
    revision: 'generation-catalog-fixture',
    generatedAt: '2026-07-14T00:00:00.000Z',
    providers: [{
      id: 'remote-provider',
      displayName: 'Remote provider',
      version: '1.0.0',
      kind: 'remote',
      status: 'available',
      models: [{
        id: 'remote-video',
        displayName: 'Remote video',
        version: '1.0.0',
        tasks: ['video'],
        outputKinds: ['video'],
        referenceKinds: ['video'],
        limits: {
          maxPromptCharacters: 2_000,
          minReferences: 1,
          maxReferences: 2,
          maxVariants: 2,
          maxWidth: 3_840,
          maxHeight: 2_160,
          maxDurationUs: 30_000_000
        },
        permissions: {
          permissionIds: ['network:provider.example.test'],
          credential: 'host-account',
          mediaUpload: 'explicit'
        },
        privacy: {
          processing: 'provider',
          promptRetention: 'provider-policy',
          mediaRetention: 'provider-policy'
        },
        cost: { currency: 'USD', minimumMinor: 10, maximumMinor: 25, estimateOnly: true }
      }]
    }]
  }
}

export function generationAuthorization(challenge: GenerationAuthorizationChallenge): JsonObject {
  const issuedAtMs = Date.now() - 1_000
  return {
    schemaVersion: 1,
    authorizationId: `authorization_${challenge.requestDigest.slice(0, 16)}`,
    owner: challenge.owner,
    requestDigest: challenge.requestDigest,
    quoteId: challenge.quoteId,
    providerId: challenge.providerId,
    modelId: challenge.modelId,
    permissionIds: challenge.permissionIds,
    uploadAssetIds: challenge.uploadAssetIds,
    currency: challenge.currency,
    approvedMaximumMinor: challenge.maximumMinor,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + 60 * 60 * 1_000).toISOString()
  }
}

export function generationBrokerSnapshot(
  requestValue: unknown,
  state: 'prepared' | 'running' | 'completed' | 'cancelled',
  outputs?: JsonObject[]
): JsonObject {
  const request = requestValue as Record<string, unknown>
  return {
    schemaVersion: 1,
    jobId: 'job_generation_tools_0001',
    executionId: String(request.executionId),
    owner: request.owner as JsonObject,
    state,
    ...(state === 'running' ? {
      progress: {
        completed: 1,
        total: 1,
        unit: 'variant',
        message: 'Generating one variant',
        updatedAt: new Date().toISOString()
      }
    } : {}),
    ...(outputs ? { outputs } : {})
  }
}

export function generationOutputFixture(): JsonObject[] {
  return [{
    id: 'variant-primary',
    assetId: 'generated-primary',
    outputHandleId: 'generation_output_handle_0001',
    displayName: 'generated-primary.mp4',
    kind: 'video',
    mimeType: 'video/mp4',
    byteSize: 1_024,
    completionIdentity: 'completion-primary',
    width: 1_920,
    height: 1_080,
    durationUs: 5_000_000,
    primary: true,
    createdAt: new Date().toISOString()
  }]
}

export function multiGenerationOutputFixture(): JsonObject[] {
  return [
    ...generationOutputFixture(),
    {
      id: 'variant-secondary',
      assetId: 'generated-secondary',
      outputHandleId: 'generation_output_handle_0002',
      displayName: 'generated-secondary.mp4',
      kind: 'video',
      mimeType: 'video/mp4',
      byteSize: 2_048,
      completionIdentity: 'completion-secondary',
      width: 1_920,
      height: 1_080,
      durationUs: 5_000_000,
      primary: false,
      createdAt: new Date().toISOString()
    }
  ]
}

export async function activatedHarness(): Promise<ExtensionTestHarness> {
  const root = await mkdtemp(join(tmpdir(), 'kun-video-tools-'))
  roots.push(root)
  const harness = createExtensionTestHarness({
    identity: {
      id: 'kun-examples.kun-video-editor',
      publisher: 'kun-examples',
      name: 'kun-video-editor',
      version: '0.1.0'
    },
    permissions,
    workspace: { id: 'video-workspace', name: 'Video Workspace', root, trusted: true, active: true }
  })
  await harness.activate(activate)
  return harness
}

export async function projectWithMedia(): Promise<ExtensionTestHarness> {
  const harness = await activatedHarness()
  await invoke(harness, 'video-project', {
    action: 'create', projectId: 'agent-demo', name: 'Agent Demo'
  })
  const sourceHandle = 'fake_media_source_0001'
  harness.media.addHandle(mediaHandle(sourceHandle, 'read', 'interview.mp4', 'video'))
  harness.media.setProbe(sourceHandle, videoProbe(sourceHandle))
  await invoke(harness, 'video-probe', {
    projectId: 'agent-demo',
    expectedRevision: 0,
    mediaHandleId: sourceHandle,
    assetId: 'interview'
  })
  return harness
}

export async function projectWithTwoAudioAssets(): Promise<ExtensionTestHarness> {
  const harness = await activatedHarness()
  await invoke(harness, 'video-project', {
    action: 'create', projectId: 'audio-demo', name: 'Audio Demo'
  })
  const sources = [
    { id: 'reference', handleId: 'fake_audio_reference_0001', name: 'Reference.wav' },
    { id: 'target', handleId: 'fake_audio_target_0000001', name: 'Target.wav' }
  ]
  for (const [index, source] of sources.entries()) {
    harness.media.addHandle(mediaHandle(source.handleId, 'read', source.name, 'audio'))
    harness.media.setProbe(source.handleId, audioProbe(source.handleId))
    await invoke(harness, 'video-probe', {
      projectId: 'audio-demo',
      expectedRevision: index,
      mediaHandleId: source.handleId,
      assetId: source.id
    })
  }
  return harness
}

export async function nextAudioAnalysisJob(
  harness: ExtensionTestHarness,
  excluded = new Set<string>()
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const match = [...harness.jobs.snapshots.values()].find((snapshot) =>
      snapshot.kind === 'media.audio-analysis' && !excluded.has(snapshot.id)
    )
    if (match) return match.id
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for local audio-analysis job')
}

export function visualModelStatus(state: 'missing' | 'installed') {
  const descriptor = {
    adapterId: 'kun.local.visual-features', adapterVersion: '1.0.0',
    modelId: 'kun-visual-features', modelVersion: '1.0.0',
    packageId: 'kun-bundled.visual-features-v1', manifestSha256: 'a'.repeat(64),
    files: [{ name: 'visual-features-v1.json', sha256: 'b'.repeat(64), byteSize: 582 }],
    embeddingDimensions: 24, execution: 'local' as const,
    querySemantics: 'bounded-visual-features-v1' as const
  }
  return {
    schemaVersion: 1 as const,
    state,
    descriptor,
    ...(state === 'installed' ? {
      receipt: {
        broker: 'kun-model-broker' as const,
        packageSource: 'bundled' as const,
        packageId: descriptor.packageId,
        modelId: descriptor.modelId,
        modelVersion: descriptor.modelVersion,
        manifestSha256: descriptor.manifestSha256,
        files: descriptor.files,
        downloadVerified: false,
        sourceVerified: true as const,
        installVerified: true as const,
        signatureVerified: true as const,
        installedAt: '2026-07-14T00:00:00.000Z'
      }
    } : {}),
    installSupported: true,
    checkedAt: '2026-07-14T00:00:00.000Z',
    remediation: state === 'installed'
      ? 'Verified signed bundled local visual features are ready.'
      : 'Install the signed bundled local visual feature package with the Host.',
    local: true as const,
    networkUsedForInference: false as const,
    rawPathsExposed: false as const,
    urlsAccepted: false as const
  }
}

export async function waitForVisualOperation(harness: ExtensionTestHarness): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const progress = harness.webview.messages
      .filter(isJsonObject)
      .filter((message) => message.channel === 'kun-video-editor.media-intelligence-progress')
      .map((message) => message.payload as JsonObject)
      .find((message) => message.kind === 'visual-index' && message.status === 'running')
    if (progress && typeof progress.operationId === 'string') return progress.operationId
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for visual-index operation progress')
}

export async function invoke(
  harness: ExtensionTestHarness,
  id: (typeof VIDEO_TOOL_IDS)[number],
  input: JsonObject
): Promise<ToolResult> {
  const registration = [...harness.tools.registrations]
    .find(([, declaration]) => declaration.id === id)?.[0]
  if (!registration) throw new Error(`Tool ${id} was not registered`)
  return await harness.tools.invoke(registration, input) as ToolResult
}

export function contentObject(result: ToolResult): JsonObject {
  if (result.content === null || typeof result.content !== 'object' || Array.isArray(result.content)) {
    throw new Error('Expected a tool result object')
  }
  return result.content
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function mediaHandle(
  handleId: string,
  mode: 'read' | 'export',
  displayName: string,
  kind: 'video' | 'audio' | 'image' | 'subtitle'
): JsonObject {
  return {
    handleId,
    mode,
    kind,
    displayName,
    mimeType: kind === 'video'
      ? 'video/mp4'
      : kind === 'audio'
        ? 'audio/mp4'
        : kind === 'subtitle'
          ? 'application/x-subrip'
          : 'image/png',
    byteSize: mode === 'read' ? 4096 : 0
  }
}

export function subtitleProbe(handleId: string): JsonObject {
  return {
    schemaVersion: 1,
    handleId,
    container: { formatNames: ['srt'], durationMicros: 1_500_000 },
    streams: [{
      index: 0,
      kind: 'subtitle',
      codecName: 'subrip',
      durationMicros: 1_500_000,
      disposition: { default: true }
    }]
  }
}

export function videoProbe(handleId: string): JsonObject {
  return {
    schemaVersion: 1,
    handleId,
    container: { formatNames: ['mp4'], durationMicros: 3_000_000 },
    streams: [
      {
        index: 0,
        kind: 'video',
        codecName: 'h264',
        durationMicros: 3_000_000,
        frameRate: { numerator: 30, denominator: 1 },
        width: 1920,
        height: 1080,
        disposition: { default: true }
      },
      {
        index: 1,
        kind: 'audio',
        codecName: 'aac',
        durationMicros: 3_000_000,
        sampleRate: 48_000,
        channelCount: 2,
        disposition: { default: true }
      }
    ]
  }
}

export function audioProbe(handleId: string): JsonObject {
  return {
    schemaVersion: 1,
    handleId,
    container: { formatNames: ['wav'], durationMicros: 3_000_000 },
    streams: [{
      index: 0,
      kind: 'audio',
      codecName: 'pcm_s16le',
      durationMicros: 3_000_000,
      sampleRate: 48_000,
      channelCount: 1,
      disposition: { default: true }
    }]
  }
}

export function silenceAnalysisResult(handleId: string, fingerprint: string): JsonObject {
  return {
    schemaVersion: 1,
    analysis: 'silence',
    source: { handleId, fingerprint, fingerprintAlgorithm: 'sha256-file-identity-v1' },
    provenance: {
      algorithm: 'ffmpeg.silencedetect', algorithmVersion: '1.0.0',
      local: true, networkUsed: false
    },
    parameters: { noiseThresholdDb: -35, minimumSilenceMicros: 300_000 },
    intervals: [{
      startMicros: 200_000,
      endMicros: 600_000,
      confidence: 1,
      confidenceSemantics: 'threshold-classification'
    }],
    analyzedDurationMicros: 3_000_000,
    truncated: false
  }
}

export function beatAnalysisResult(handleId: string, fingerprint: string): JsonObject {
  return {
    schemaVersion: 1,
    analysis: 'beat-grid',
    source: { handleId, fingerprint, fingerprintAlgorithm: 'sha256-file-identity-v1' },
    provenance: {
      algorithm: 'kun.pcm-onset-autocorrelation', algorithmVersion: '1.0.0',
      local: true, networkUsed: false
    },
    tempoBpm: 120,
    markers: [
      { timeMicros: 500_000, kind: 'downbeat', confidence: 0.91, strength: 0.94 },
      { timeMicros: 1_000_000, kind: 'beat', confidence: 0.86, strength: 0.89 }
    ],
    analyzedDurationMicros: 3_000_000,
    truncated: false
  }
}

export function syncAnalysisResult(
  referenceHandleId: string,
  targetHandleId: string,
  seed: number,
  referenceFeatures: number[],
  targetFeatures: number[]
): JsonObject {
  return {
    schemaVersion: 1,
    analysis: 'sync-features',
    reference: {
      handleId: referenceHandleId,
      fingerprint: 'b'.repeat(64),
      fingerprintAlgorithm: 'sha256-file-identity-v1'
    },
    target: {
      handleId: targetHandleId,
      fingerprint: 'c'.repeat(64),
      fingerprintAlgorithm: 'sha256-file-identity-v1'
    },
    provenance: {
      algorithm: 'kun.pcm-energy-envelope', algorithmVersion: '1.0.0',
      local: true, networkUsed: false
    },
    seed,
    samplePeriodMicros: 100_000,
    referenceFeatures,
    targetFeatures,
    referenceAnalyzedDurationMicros: referenceFeatures.length * 100_000,
    targetAnalyzedDurationMicros: targetFeatures.length * 100_000,
    truncated: false
  }
}

export function imageDerivedArtifact(
  harness: ExtensionTestHarness,
  input: {
    jobId: string
    handleId: string
    displayName: string
    byteSize: number
    metadata: JsonObject
  }
) {
  const completionIdentity = `derived-${createSafeSuffix(input.jobId)}-complete`
  harness.media.addHandle({
    ...mediaHandle(input.handleId, 'read', input.displayName, 'image'),
    byteSize: input.byteSize,
    completionIdentity
  })
  return createGeneratedArtifactFixture({
    artifactId: `artifact_derived_${createSafeSuffix(input.jobId)}`,
    ownerExtensionId: harness.identity.id,
    ownerExtensionVersion: harness.identity.version,
    workspaceId: harness.context.workspaceContext!.id,
    mediaHandleId: input.handleId,
    displayName: input.displayName,
    mediaKind: 'image',
    mimeType: 'image/png',
    byteSize: input.byteSize,
    completionIdentity,
    provenance: {
      jobId: input.jobId,
      operation: 'media.startFfmpegJob',
      metadata: input.metadata
    }
  })
}

export function artifactFor(
  harness: ExtensionTestHarness,
  jobId: string,
  mediaHandleId: string,
  displayName: string
) {
  return createGeneratedArtifactFixture({
    artifactId: `artifact_${createSafeSuffix(jobId)}_0001`,
    ownerExtensionId: harness.identity.id,
    ownerExtensionVersion: harness.identity.version,
    workspaceId: harness.context.workspaceContext!.id,
    mediaHandleId,
    displayName,
    byteSize: 8192,
    completionIdentity: 'render-complete-0001',
    provenance: {
      jobId,
      operation: 'media.startFfmpegJob',
      metadata: latestRenderMetadata(harness)
    }
  })
}

export function latestRenderMetadata(harness: ExtensionTestHarness): JsonObject {
  const metadata = harness.transport.requests
    .filter(({ method }) => method === 'media.startFfmpegJob')
    .at(-1)?.params as JsonObject | undefined
  if (!metadata || metadata.metadata === undefined) {
    throw new Error('No submitted render metadata was recorded by the Host harness')
  }
  return structuredClone(metadata.metadata as JsonObject)
}

export function createSafeSuffix(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, '_')
}

export async function loadManifest(): Promise<ExtensionManifest> {
  const path = join(import.meta.dirname, '..', '..', 'kun-extension.json')
  return parseExtensionManifest(JSON.parse(await readFile(path, 'utf8')))
}
