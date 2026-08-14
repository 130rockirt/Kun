import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ExtensionApiError,
  MediaAnalyzeVisualFramesRequestSchema,
  MediaEmbedVisualQueryRequestSchema,
  type JsonObject
} from '@kun/extension-api'
import { createGeneratedArtifactFixture, type ExtensionTestHarness } from '@kun/extension-test'
import { describe, expect, it } from 'vitest'
import { VIDEO_TOOL_DECLARATIONS, VIDEO_TOOL_IDS } from '../../src/host/extension.js'
import { DerivedMediaService } from '../../src/host/derived-media-service.js'
import type { GenerationExecutionBroker } from '../../src/host/generation-service.js'
import {
  activatedHarness,
  artifactFor,
  audioProbe,
  beatAnalysisResult,
  contentObject,
  generationAuthorization,
  generationBrokerSnapshot,
  generationCatalogFixture,
  generationHarness,
  generationOutputFixture,
  imageDerivedArtifact,
  invoke,
  isJsonObject,
  latestRenderMetadata,
  loadManifest,
  mediaHandle,
  multiGenerationOutputFixture,
  nextAudioAnalysisJob,
  permissions,
  projectWithMedia,
  projectWithTwoAudioAssets,
  roots,
  silenceAnalysisResult,
  subtitleProbe,
  syncAnalysisResult,
  videoProbe,
  visualModelStatus,
  waitForVisualOperation
} from './video-tools-support.js'

describe('video editor manifest and Agent catalog', () => {
  it('declares one private profile, stable tools, complete activation, and least privilege', async () => {
    const manifest = await loadManifest()
    expect(manifest.apiVersion).toBe('1.2.0')
    expect(manifest.version).toBe('0.4.4')
    expect(manifest.contributes['views.rightSidebar']).toEqual([
      expect.objectContaining({
        id: 'editor',
        entry: 'dist/webview/index.html',
        icon: 'assets/video-editor.svg'
      })
    ])
    expect(manifest.contributes['views.fullPage']).toEqual([])
    expect(manifest.contributes['actions.composer']).toEqual([])
    const editorCommand = manifest.contributes.commands.find(({ id }) => id === 'editor-request')
    const properties = editorCommand?.inputSchema?.properties
    const actionProperty = properties && typeof properties === 'object' && !Array.isArray(properties)
      ? properties.action
      : undefined
    expect(actionProperty && typeof actionProperty === 'object' && !Array.isArray(actionProperty)
      ? actionProperty.enum
      : undefined).toEqual([
      'project.list', 'project.active', 'project.get', 'project.select', 'project.create',
      'project.update', 'context.update', 'context.attach-selection', 'project.undo', 'project.redo',
      'sequence.decompose', 'script.read', 'script.apply', 'media.list', 'media.import',
      'media.import-batch', 'media.reauthorize',
      'media.folder.create', 'media.folder.update', 'media.folder.delete', 'media.organize',
      'transcript.import', 'caption.generate', 'preview.list', 'preview.add', 'preview.select',
      'preview.compare', 'preview.replace', 'export-capabilities', 'otio-export-preview',
      'otio-import-preview', 'interchange.export', 'interchange.status', 'interchange.cancel',
      'interchange.import-preview', 'interchange.import', 'project-package-preflight', 'project-package.export',
      'project-package.status', 'project-package.cancel', 'render.list', 'render.start', 'render.status',
      'render.cancel', 'derived.list', 'derived.start', 'derived.retry', 'derived.cancel',
      'derived.cleanup', 'analysis.capabilities', 'analysis.visual-opt-in', 'analysis.visual-install',
      'analysis.visual-index', 'analysis.visual-search', 'analysis.list', 'analysis.evidence',
      'analysis.vad', 'analysis.vad-apply', 'analysis.speaker-import', 'analysis.speaker-preview',
      'analysis.speaker-apply', 'analysis.beats', 'analysis.denoise-metadata', 'analysis.sync-preview',
      'analysis.sync-apply', 'analysis.status', 'analysis.cancel',
      'generation.catalog', 'generation.list', 'generation.request', 'generation.retry',
      'generation.status', 'generation.cancel', 'generation.insert', 'multicam.inspect',
      'multicam.create', 'multicam.labels', 'multicam.sync-confirm', 'multicam.layout-upsert',
      'multicam.delete', 'multicam.switch', 'multicam.layout', 'multicam.merge'
    ])
    expect(manifest.contributes.agentProfiles).toHaveLength(1)
    const profile = manifest.contributes.agentProfiles[0]!
    expect(profile).toMatchObject({ id: 'video-editor', visibility: 'private' })
    expect(profile.allowedTools).toEqual(VIDEO_TOOL_IDS)
    expect(profile.instructions).toContain('video-inspect with action context')
    expect(profile.instructions).toContain('video-project with action select')
    expect(profile.instructions).toContain('video-render-cancel')
    expect(profile.instructions).toContain('video-analysis-status capabilities')
    expect(profile.instructions).toContain('never invent markers')
    expect(profile.instructions).toContain('Reviewed speaker evidence can only be imported')
    expect(profile.instructions).toContain('must remain explicitly unlabelled')
    expect(profile.instructions).toContain('not arbitrary visual-scene understanding')
    expect(profile.instructions).toContain('interaction-required')
    expect(manifest.contributes.tools).toEqual(VIDEO_TOOL_DECLARATIONS)
    expect(manifest.activationEvents).toEqual(expect.arrayContaining([
      'onView:editor',
      'onView:render-preview',
      'onCommand:editor-request',
      'onAgentProfile:video-editor',
      ...VIDEO_TOOL_IDS.map((id) => `onTool:${id}`)
    ]))
    expect(new Set(manifest.permissions)).toEqual(new Set(permissions))
    expect(manifest.permissions.some((permission) => permission.startsWith('network:'))).toBe(false)
  })

  it('keeps read/write/destructive approval classes truthful and cache-stable', () => {
    expect(Object.fromEntries(VIDEO_TOOL_DECLARATIONS.map((tool) => [tool.id, tool.sideEffects])))
      .toEqual({
        'video-project': 'write',
        'video-inspect': 'read',
        'video-probe': 'write',
        'video-transcribe': 'write',
        'video-read-script': 'read',
        'video-apply-script': 'destructive',
        'video-update-timeline': 'write',
        'video-analyze-visual': 'write',
        'video-analyze-audio': 'write',
        'video-analysis-status': 'read',
        'video-analysis-cancel': 'destructive',
        'video-interchange': 'write',
        'video-interchange-status': 'read',
        'video-interchange-cancel': 'destructive',
        'video-generation-catalog': 'read',
        'video-generation-request': 'external',
        'video-generation-status': 'read',
        'video-generation-cancel': 'destructive',
        'video-project-package': 'write',
        'video-project-package-status': 'read',
        'video-project-package-cancel': 'destructive',
        'video-render': 'write',
        'video-render-status': 'read',
        'video-render-cancel': 'destructive',
        'video-undo': 'destructive'
      })
    const fingerprint = JSON.stringify(VIDEO_TOOL_DECLARATIONS)
    expect(JSON.stringify(VIDEO_TOOL_DECLARATIONS)).toBe(fingerprint)
    expect(VIDEO_TOOL_DECLARATIONS).toHaveLength(25)
  })

  it('keeps the manifest and Host command catalog aligned without artifact shell commands', async () => {
    const manifest = await loadManifest()
    const harness = await activatedHarness()
    const declared = manifest.contributes.commands.map(({ id }) => id).sort()
    const registered = harness.transport.requests
      .filter(({ method }) => method === 'commands.register')
      .map(({ params }) => String((params as JsonObject).id))
      .sort()
    expect(declared).toEqual(['editor-request'])
    expect(registered).toEqual(declared)
    expect(registered).not.toContain('reveal-artifact')
    await harness.dispose()
  })
})
