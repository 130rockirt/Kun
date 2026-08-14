import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ExtensionManifestSchema,
  MediaCreateCacheTargetResultSchema,
  type MediaAnalyzeVisualFramesRequest,
  type MediaEmbedVisualQueryRequest,
  type ModelProviderAdapter
} from '@kun/extension-api'
import type { ExtensionToolHandler } from '../adapters/tool/extension-tool-provider.js'
import type { ExtensionBrokerRequest, ExtensionPrincipal as HostPrincipal } from '../extensions/host-process.js'
import { extensionWorkspaceKey } from '../extensions/paths.js'
import {
  ExtensionHostBroker,
  requiredExtensionBrokerPermission
} from './extension-host-broker.js'
import { ExtensionMediaHandleService } from './extension-media-handle-service.js'

const WORKSPACE_ROOT = resolve('/tmp/workspace')

const WORKSPACE_ID = extensionWorkspaceKey(WORKSPACE_ROOT)

const manifest = ExtensionManifestSchema.parse({
  manifestVersion: 1,
  apiVersion: '1.0.0',
  name: 'broker',
  publisher: 'acme',
  version: '1.0.0',
  engines: { kun: '>=0.1.0' },
  main: 'dist/extension.js',
  activationEvents: [
    'onCommand:hello',
    'onTool:summarize',
    'onProvider:echo',
    'onAuthentication:echo-auth'
  ],
  contributes: {
    commands: [{
      id: 'hello',
      title: 'Hello',
      inputSchema: { type: 'object' },
      outputSchema: {
        type: 'object',
        properties: { invoked: { type: 'boolean' } },
        required: ['invoked'],
        additionalProperties: false
      }
    }],
    tools: [{
      id: 'summarize',
      description: 'Summarize input',
      inputSchema: { type: 'object' },
      outputSchema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
        additionalProperties: false
      },
      sideEffects: 'external'
    }],
    modelProviders: [{
      id: 'echo',
      displayName: 'Echo',
      authenticationProviderId: 'echo-auth',
      credentialHosts: ['api.example.test'],
      models: [{
        id: 'echo-1',
        displayName: 'Echo 1',
        capabilities: { input: ['text'], output: ['text'] }
      }]
    }],
    authentication: [{
      id: 'echo-auth',
      displayName: 'Echo API key',
      type: 'api-key'
    }],
    settings: [{
      id: 'general',
      title: 'General',
      properties: { mode: { type: 'string', default: 'safe' } }
    }]
  },
  permissions: [
    'commands.register',
    'tools.register',
    'providers.register',
    'ui.actions',
    'network:api.example.test'
  ],
  stateSchemaVersion: 1
})

const principal: HostPrincipal = {
  extensionId: 'acme.broker',
  version: '1.0.0',
  apiVersion: '1.0.0',
  lifecycleNonce: 'de7c65b3-f455-4199-aa83-1722fdf8309d',
  grantedPermissions: manifest.permissions,
  workspaceRoots: [WORKSPACE_ROOT],
  development: true
}

function request(method: string, params: unknown): ExtensionBrokerRequest {
  return {
    principal,
    method,
    params: JSON.parse(JSON.stringify(params ?? null)),
    signal: new AbortController().signal,
    requestId: `request_${method}`
  }
}

function createBroker(overrides: Record<string, unknown> = {}): ExtensionHostBroker {
  const state = new Map<string, unknown>()
  return new ExtensionHostBroker({
    agent: {} as never,
    profiles: { register: () => () => undefined } as never,
    tools: { register: vi.fn() } as never,
    modelProviders: { register: vi.fn() } as never,
    providerAccounts: {
      registerProvider: vi.fn(),
      unregisterProvider: vi.fn(),
      getAccount: vi.fn(),
      requireOwnedProvider: vi.fn(),
      validateBinding: vi.fn()
    } as never,
    accounts: {} as never,
    credentials: { protection: async () => ({ mode: 'encrypted-fallback' }) } as never,
    state: {
      read: async () => ({
        global: Object.fromEntries(state),
        workspaces: {}
      }),
      getGlobal: async (_id: string, key: string) => state.get(key),
      setGlobal: async (_id: string, key: string, value: unknown) => {
        if (value === undefined) state.delete(key)
        else state.set(key, value)
      }
    } as never,
    invokeExtension: vi.fn(async () => null),
    notifyExtension: vi.fn(async () => undefined),
    resolveManifest: async () => manifest,
    ...overrides
  } as never)
}

function cancellationContext() {
  return {
    cancellation: {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} })
    }
  }
}

describe('ExtensionHostBroker', () => {
  it('routes opaque media operations without exposing Host paths', async () => {
      const mediaPrincipal = {
        extensionId: 'acme.broker',
        extensionVersion: '1.0.0',
        permissions: [
          'media.read', 'media.process', 'media.export',
          'workspace.read', 'workspace.write', 'jobs.manage'
        ],
        workspaceRoots: ['/tmp/workspace'],
        workspaceTrusted: true,
        viewSessionId: 'view-session-1',
        viewContributionId: 'editor'
      }
      const stat = vi.fn(async () => ({
        id: 'media_123456789012',
        displayName: 'clip.mp4',
        mode: 'read',
        source: 'picker',
        mimeType: 'video/mp4',
        byteSize: 123,
        completionIdentity: 'identity_1234567890',
        available: true,
        createdAt: '2026-01-01T00:00:00.000Z'
      }))
      const touch = vi.fn(async () => ({
        ...(await stat()),
        lastAccessedAt: '2026-01-01T00:01:00.000Z'
      }))
      const probe = vi.fn(async () => ({
        schemaVersion: 1,
        handleId: 'media_123456789012',
        container: { formatNames: ['mov', 'mp4'], durationMicros: 1_000_000 },
        streams: []
      }))
      const start = vi.fn(async () => ({
        jobId: 'job_12345678',
        kind: 'media.ffmpeg',
        state: 'queued',
        cursor: 'cursor_12345678'
      }))
      const onUiRequest = vi.fn(async ({ method }: { method: string }) => {
        if (method === 'media.pickFiles') {
          return {
            outcome: 'selected',
            files: [{
              handleId: 'media_123456789012',
              mode: 'read',
              kind: 'video',
              displayName: 'clip.mp4',
              mimeType: 'video/mp4',
              revoked: false
            }]
          }
        }
        if (method === 'media.openViewResource') {
          return {
            leaseId: 'lease_123456789012',
            handleId: 'media_123456789012',
            url: 'kun-media://resource/opaque-token',
            mimeType: 'video/mp4',
            expiresAt: '2026-01-01T00:05:00.000Z'
          }
        }
        if (method === 'media.performArtifactAction') return { performed: true }
        return undefined
      })
      const capabilities = vi.fn(async () => ({
        probedAt: '2026-01-01T00:00:00.000Z',
        ffprobe: { name: 'ffprobe', available: true, source: 'configured', version: '8.0.1' },
        ffmpeg: {
          name: 'ffmpeg',
          available: true,
          source: 'configured',
          version: '8.0.1',
          features: ['libx264-encoder', 'aac-encoder']
        }
      }))
      const audioCapabilities = vi.fn(async () => ({
        schemaVersion: 1,
        probedAt: '2026-01-01T00:00:00.000Z',
        analyses: [
          {
            analysis: 'silence', available: true,
            algorithm: 'ffmpeg.silencedetect', algorithmVersion: '1.0.0',
            local: true, networkUsed: false
          },
          {
            analysis: 'beat-grid', available: false,
            code: 'AUDIO_ANALYSIS_ALGORITHM_UNAVAILABLE',
            remediation: 'No verified analyzer is installed.', retryable: false,
            local: true, networkUsed: false
          },
          {
            analysis: 'sync-features', available: true,
            algorithm: 'kun.pcm-energy-envelope', algorithmVersion: '1.0.0',
            local: true, networkUsed: false
          }
        ]
      }))
      const startAudioAnalysis = vi.fn(async () => ({
        outcome: 'started' as const,
        job: {
          jobId: 'job_audio_12345678',
          kind: 'media.audio-analysis',
          state: 'queued' as const,
          cursor: 'cursor_audio_12345678'
        }
      }))
      const startArchive = vi.fn(async () => ({
        outcome: 'started' as const,
        job: {
          jobId: 'job_archive_12345678',
          kind: 'media.archive',
          state: 'queued' as const,
          cursor: 'cursor_archive_12345678'
        }
      }))
      const visualDescriptor = {
        adapterId: 'kun.local.visual-features', adapterVersion: '1.0.0',
        modelId: 'kun-visual-features', modelVersion: '1.0.0',
        packageId: 'kun-bundled.visual-features-v1', manifestSha256: 'a'.repeat(64),
        files: [{ name: 'visual-features-v1.json', sha256: 'b'.repeat(64), byteSize: 10 }],
        embeddingDimensions: 2, execution: 'local' as const,
        querySemantics: 'bounded-visual-features-v1' as const
      }
      const visualReceipt = {
        broker: 'kun-model-broker' as const, packageSource: 'bundled' as const,
        packageId: visualDescriptor.packageId, modelId: visualDescriptor.modelId,
        modelVersion: visualDescriptor.modelVersion,
        manifestSha256: visualDescriptor.manifestSha256,
        files: visualDescriptor.files, downloadVerified: false, sourceVerified: true as const,
        installVerified: true as const, signatureVerified: true as const,
        installedAt: '2026-01-01T00:00:00.000Z'
      }
      const visualStatus = vi.fn(async () => ({
        schemaVersion: 1 as const, state: 'installed' as const,
        descriptor: visualDescriptor, receipt: visualReceipt, installSupported: true,
        checkedAt: '2026-01-01T00:00:00.000Z', remediation: 'Verified local adapter ready.',
        local: true as const, networkUsedForInference: false as const,
        rawPathsExposed: false as const, urlsAccepted: false as const
      }))
      const analyzeVisualFrames = vi.fn(async (
        _principal: unknown,
        request: MediaAnalyzeVisualFramesRequest
      ) => ({
        outcome: 'ready' as const,
        source: {
          handleId: request.inputHandleId,
          fingerprint: 'c'.repeat(64),
          fingerprintAlgorithm: 'sha256-file-identity-v1' as const
        },
        adapter: request.adapter,
        embeddings: request.samples.map(({ sampleId }) => ({ sampleId, vector: [1, 0] })),
        provenance: {
          algorithm: 'kun.rgb-edge-features' as const, algorithmVersion: '1.0.0' as const,
          decodedFrameWidth: 32 as const, decodedFrameHeight: 32 as const,
          local: true as const, networkUsed: false as const
        }
      }))
      const embedVisualQuery = vi.fn(async (
        _principal: unknown,
        request: MediaEmbedVisualQueryRequest
      ) => ({
        outcome: 'ready' as const, adapter: request.adapter, vector: [1, 0],
        matchedConcepts: ['red'], scoreSemantics: 'uncalibrated-cosine' as const,
        local: true as const, networkUsed: false as const
      }))
      const broker = createBroker({
        mediaHandles: { stat, touch, release: vi.fn(async () => true) } as never,
        mediaProcesses: { probe, capabilities } as never,
        mediaJobs: { start } as never,
        audioAnalysisJobs: {
          capabilities: audioCapabilities,
          start: startAudioAnalysis
        } as never,
        archiveJobs: { start: startArchive } as never,
        visualAnalysis: {
          status: visualStatus,
          install: visualStatus,
          analyzeFrames: analyzeVisualFrames,
          embedQuery: embedVisualQuery
        } as never,
        onUiRequest
      })
      const call = (method: string, params: unknown) => broker.handlePrincipal({
        principal: mediaPrincipal,
        method,
        params: params as never,
        signal: new AbortController().signal,
        requestId: `request-${method}`
      })
      await expect(call('media.pickFiles', {})).resolves.toMatchObject({
        outcome: 'selected', files: [{ handleId: 'media_123456789012' }]
      })
      await expect(call('media.stat', { handleId: 'media_123456789012' })).resolves.toEqual({
        handleId: 'media_123456789012',
        mode: 'read',
        kind: 'video',
        displayName: 'clip.mp4',
        mimeType: 'video/mp4',
        byteSize: 123,
        completionIdentity: 'identity_1234567890',
        revoked: false
      })
      await expect(call('media.probe', { handleId: 'media_123456789012' }))
        .resolves.toMatchObject({ handleId: 'media_123456789012' })
      await expect(call('media.getCapabilities', {})).resolves.toEqual({
        probedAt: '2026-01-01T00:00:00.000Z',
        ffprobe: { name: 'ffprobe', available: true, version: '8.0.1', features: [] },
        ffmpeg: {
          name: 'ffmpeg',
          available: true,
          version: '8.0.1',
          features: ['libx264-encoder', 'aac-encoder']
        }
      })
      expect(JSON.stringify(await call('media.getCapabilities', {}))).not.toContain('configured')
      await expect(call('media.getAudioAnalysisCapabilities', {})).resolves.toMatchObject({
        analyses: [
          { analysis: 'silence', available: true },
          { analysis: 'beat-grid', available: false, networkUsed: false },
          { analysis: 'sync-features', available: true }
        ]
      })
      const visual = await call('media.getVisualModelStatus', {})
      await expect(visual).toMatchObject({
        state: 'installed',
        receipt: { packageSource: 'bundled', downloadVerified: false, signatureVerified: true },
        networkUsedForInference: false,
        rawPathsExposed: false,
        urlsAccepted: false
      })
      expect(JSON.stringify(visual)).not.toMatch(/\/(?:Users|private|tmp)\//u)
      await expect(call('media.installVisualModel', {})).resolves.toMatchObject({ state: 'installed' })
      await expect(call('media.installVisualModel', { modelUrl: 'https://example.invalid/model.bin' }))
        .rejects.toThrow()
      const visualAdapter = {
        id: visualDescriptor.adapterId, version: visualDescriptor.adapterVersion,
        modelId: visualDescriptor.modelId, modelVersion: visualDescriptor.modelVersion,
        packageId: visualDescriptor.packageId, manifestSha256: visualDescriptor.manifestSha256,
        embeddingDimensions: visualDescriptor.embeddingDimensions, execution: 'local'
      }
      await expect(call('media.analyzeVisualFrames', {
        inputHandleId: 'media_123456789012',
        samples: [{
          sampleId: 'frame:asset-1:0', startMicros: 0, endMicros: 1_000_000,
          representativeMicros: 500_000
        }],
        adapter: visualAdapter
      })).resolves.toMatchObject({
        outcome: 'ready', embeddings: [{ sampleId: 'frame:asset-1:0', vector: [1, 0] }]
      })
      await expect(call('media.embedVisualQuery', {
        query: 'red', adapter: visualAdapter
      })).resolves.toMatchObject({ outcome: 'ready', matchedConcepts: ['red'] })
      await expect(call('media.openViewResource', { handleId: 'media_123456789012' }))
        .resolves.toMatchObject({ url: 'kun-media://resource/opaque-token' })
      expect(touch).toHaveBeenCalledWith(mediaPrincipal, 'media_123456789012')
      await expect(call('media.performArtifactAction', {
        artifactId: 'artifact_1234567890',
        action: 'reveal'
      })).resolves.toEqual({ performed: true })
      expect(onUiRequest).toHaveBeenCalledWith(expect.objectContaining({
        principal: mediaPrincipal,
        method: 'media.performArtifactAction',
        params: { artifactId: 'artifact_1234567890', action: 'reveal' }
      }))
      await expect(call('media.startFfmpegJob', {
        arguments: ['-i', '{{input:source}}', '{{output:video}}'],
        inputs: { source: 'media_123456789012' },
        outputs: { video: 'media_abcdefghijkl' }
      })).resolves.toMatchObject({ job: { jobId: 'job_12345678' } })
      await expect(call('media.startAudioAnalysisJob', {
        analysis: 'sync-features',
        referenceHandleId: 'media_123456789012',
        targetHandleId: 'media_abcdefghijkl',
        seed: 42
      })).resolves.toMatchObject({
        outcome: 'started',
        job: { jobId: 'job_audio_12345678', kind: 'media.audio-analysis' }
      })
      expect(startAudioAnalysis).toHaveBeenCalledWith(
        mediaPrincipal,
        expect.objectContaining({
          analysis: 'sync-features',
          seed: 42,
          samplePeriodMicros: 100_000,
          maxFeaturePoints: 4_096
        })
      )
      await expect(call('media.startArchiveJob', {
        format: 'zip',
        outputHandleId: 'media_archive_output_123456',
        entries: [
          {
            kind: 'inline-text',
            archivePath: 'manifest/project.json',
            content: '{"schemaVersion":2}',
            mimeType: 'application/json'
          },
          {
            kind: 'media',
            inputHandleId: 'media_123456789012',
            archivePath: 'media/clip.mp4'
          }
        ],
        idempotencyKey: 'archive-project-revision-7'
      })).resolves.toMatchObject({
        outcome: 'started',
        job: { jobId: 'job_archive_12345678', kind: 'media.archive' }
      })
      expect(startArchive).toHaveBeenCalledWith(
        mediaPrincipal,
        expect.objectContaining({
          format: 'zip',
          outputHandleId: 'media_archive_output_123456',
          entries: expect.arrayContaining([
            expect.objectContaining({ archivePath: 'manifest/project.json' }),
            expect.objectContaining({ archivePath: 'media/clip.mp4' })
          ])
        })
      )
      expect(JSON.stringify(await call('media.stat', { handleId: 'media_123456789012' })))
        .not.toContain('/tmp/workspace')
    })

  it('allocates a Host-owned cache target without returning its workspace path', async () => {
      const root = await mkdtemp(join(tmpdir(), 'kun-cache-target-'))
      const workspace = join(root, 'workspace')
      const dataDir = join(root, 'data')
      await mkdir(workspace)
      const principal = {
        extensionId: 'acme.broker',
        extensionVersion: '1.0.0',
        permissions: ['media.process', 'workspace.write'],
        workspaceRoots: [workspace],
        workspaceTrusted: true
      }
      const mediaHandles = new ExtensionMediaHandleService({ dataDir })
      const broker = createBroker({ mediaHandles })
      try {
        const result = MediaCreateCacheTargetResultSchema.parse(await broker.handlePrincipal({
          principal,
          method: 'media.createCacheTarget',
          params: { format: 'png', purpose: 'derived-waveform-partial' },
          signal: new AbortController().signal,
          requestId: 'create-cache-target'
        }))
        expect(result).toEqual({
          target: {
            handleId: expect.stringMatching(/^media_[0-9a-f-]+$/u),
            mode: 'export',
            kind: 'image',
            displayName: expect.stringMatching(/^derived-waveform-partial-[a-f0-9-]+\.png$/u),
            mimeType: 'image/png',
            revoked: false
          }
        })
        const [stored] = await mediaHandles.list(principal, workspace)
        expect(stored).toMatchObject({
          id: result.target.handleId,
          mode: 'write',
          source: 'workspace',
          lifecycle: 'cache',
          mimeType: 'image/png'
        })
        expect(stored?.workspaceRelativePath).toMatch(
          /^\.kun\/extension-cache\/acme\.broker\/derived-waveform-partial\//u
        )
        expect(JSON.stringify(result)).not.toContain(workspace)
        expect(requiredExtensionBrokerPermission('media.createCacheTarget', {
          format: 'png', purpose: 'derived-waveform-partial'
        })).toBe('media.process')
        expect(requiredExtensionBrokerPermission('media.getAudioAnalysisCapabilities', {}))
          .toBe('media.process')
        for (const method of [
          'media.getVisualModelStatus',
          'media.installVisualModel',
          'media.analyzeVisualFrames',
          'media.embedVisualQuery'
        ]) expect(requiredExtensionBrokerPermission(method, {})).toBe('media.process')
        expect(requiredExtensionBrokerPermission('media.startAudioAnalysisJob', {
          analysis: 'silence', inputHandleId: 'media_123456789012'
        })).toBe('media.process')
        expect(requiredExtensionBrokerPermission('media.startArchiveJob', {
          format: 'zip', outputHandleId: 'media_archive_output_123456', entries: []
        })).toBe('media.export')
        await expect(broker.handlePrincipal({
          principal,
          method: 'media.release',
          params: { resource: 'handle', handleId: result.target.handleId },
          signal: new AbortController().signal,
          requestId: 'release-cache-target'
        })).resolves.toEqual({ released: true })
        await expect(mediaHandles.list(principal, workspace)).resolves.toEqual([
          expect.objectContaining({ id: result.target.handleId, available: false })
        ])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

  it('reads bounded UTF-8 from an owned media handle and rejects invalid text', async () => {
      const root = await mkdtemp(join(tmpdir(), 'kun-media-text-'))
      const validPath = join(root, 'captions.srt')
      const invalidPath = join(root, 'invalid.srt')
      await writeFile(validPath, '1\n00:00:00,000 --> 00:00:01,000\n你好\n')
      await writeFile(invalidPath, Buffer.from([0xff, 0xfe, 0xfd]))
      const mediaPrincipal = {
        extensionId: 'acme.broker',
        extensionVersion: '1.0.0',
        permissions: ['media.read', 'workspace.read'],
        workspaceRoots: [root],
        workspaceTrusted: true,
        viewSessionId: 'view-session-1',
        viewContributionId: 'editor'
      }
      const resolve = vi.fn(async (_principal, handleId: string) => ({
        id: handleId,
        displayName: handleId.includes('invalid') ? 'invalid.srt' : 'captions.srt',
        mode: 'read',
        source: 'picker',
        mimeType: 'application/x-subrip',
        byteSize: handleId.includes('invalid') ? 3 : undefined,
        available: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        absolutePath: handleId.includes('invalid') ? invalidPath : validPath,
        workspaceRoot: root,
        ownerExtensionId: 'acme.broker',
        ownerExtensionVersion: '1.0.0'
      }))
      const broker = createBroker({ mediaHandles: { resolve } as never })
      const call = (handleId: string, maxBytes: number) => broker.handlePrincipal({
        principal: mediaPrincipal,
        method: 'media.readText',
        params: { handleId, maxBytes },
        signal: new AbortController().signal,
        requestId: `request-${handleId}`
      })
      try {
        await expect(call('media_text_123456789', 1024)).resolves.toMatchObject({
          handleId: 'media_text_123456789',
          displayName: 'captions.srt',
          content: expect.stringContaining('你好')
        })
        await expect(call('media_text_123456789', 4)).rejects.toMatchObject({
          code: 'MEDIA_LIMIT_EXCEEDED'
        })
        await expect(call('media_invalid_123456', 1024)).rejects.toMatchObject({
          code: 'MEDIA_INVALID_ARGUMENT'
        })
        expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
          extensionId: 'acme.broker',
          workspaceRoots: [root]
        }), 'media_text_123456789', 'read')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

  it('returns an explicit interaction-required error for headless picker calls', async () => {
      const broker = createBroker()
      await expect(broker.handle(request('media.pickFiles', {}))).rejects.toMatchObject({
        code: 'MEDIA_INTERACTION_REQUIRED',
        details: { operation: 'media.pickFiles' }
      })
      await expect(broker.handle(request('media.pickSaveTarget', {}))).rejects.toMatchObject({
        code: 'MEDIA_INTERACTION_REQUIRED',
        details: { operation: 'media.pickSaveTarget' }
      })
      await expect(broker.handle(request('media.performArtifactAction', {
        artifactId: 'artifact_1234567890',
        action: 'open'
      }))).rejects.toThrow(/authenticated View Session/)
    })
})
