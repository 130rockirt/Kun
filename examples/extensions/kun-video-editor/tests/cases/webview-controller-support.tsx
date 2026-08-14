import type { ExtensionHostClient, HostMessage, JobSnapshot, JsonValue, Locale, Theme } from '@kun/extension-api'
import { vi } from 'vitest'
import { useEditorController, type EditorController } from '../../src/webview/controller.js'
import { formatMessage, messagesFor } from '../../src/webview/i18n.js'
import type { EditorNotice } from '../../src/webview/model.js'

export function generationCatalogProjection(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    revision: 'catalog-controller-test',
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
        limits: { maxPromptCharacters: 2_000, minReferences: 1, maxReferences: 2, maxVariants: 2 },
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

export function generationRecordProjection(projectId: string, projectRevision: number) {
  return {
    schemaVersion: 1,
    id: 'generation_controller_test',
    generation: 3,
    projectId,
    projectRevision,
    providerId: 'remote-provider',
    modelId: 'remote-video',
    task: 'video',
    promptDigest: 'a'.repeat(64),
    referenceAssetIds: ['asset-interview'],
    variantsRequested: 1,
    quote: {
      quoteId: 'quote-controller-test',
      currency: 'USD',
      minimumMinor: 10,
      maximumMinor: 25,
      estimateOnly: true
    },
    placeholder: {
      assetId: 'generated-controller-placeholder',
      displayName: 'Generated video',
      kind: 'video',
      state: 'failed'
    },
    state: 'failed',
    attempt: 1,
    outputs: [],
    error: { code: 'provider-failed', message: 'Provider failed safely.', retryable: true },
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:01:00.000Z'
  }
}

export function makeArchiveJob(id: string, state: JobSnapshot['state']): JobSnapshot {
  return {
    schemaVersion: 1,
    id,
    kind: 'media.archive',
    kindSchemaVersion: 1,
    ownerExtensionId: 'kun-examples.kun-video-editor',
    ownerExtensionVersion: '0.4.0',
    workspaceId: 'workspace-1',
    initiatingOperation: 'media.startArchiveJob',
    state,
    executionAttempt: 1,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:01.000Z',
    latestCursor: 'cursor_package_1',
    progress: {
      percentage: 40,
      phase: 'archiving',
      message: 'Archiving',
      updatedAt: '2026-07-14T00:00:01.000Z'
    }
  }
}

export function CaptureController(props: {
  client: ExtensionHostClient
  capture(controller: EditorController): void
}): null {
  props.capture(useEditorController(props.client))
  return null
}

export function fakeClient(input: {
  openViewResource?: ReturnType<typeof vi.fn>
  performArtifactAction?: ReturnType<typeof vi.fn>
  executeCommand?: ReturnType<typeof vi.fn>
  getTheme?: () => Promise<Theme>
  getLocale?: () => Promise<Locale>
  pickFiles?: ReturnType<typeof vi.fn>
  pickSaveTarget?: ReturnType<typeof vi.fn>
  readText?: ReturnType<typeof vi.fn>
  release?: ReturnType<typeof vi.fn>
  getJob?: ReturnType<typeof vi.fn>
  subscribeJob?: ReturnType<typeof vi.fn>
  attachComposerContext?: ReturnType<typeof vi.fn>
  listJobs?: ReturnType<typeof vi.fn>
  getViewState?: ReturnType<typeof vi.fn>
  setViewState?: ReturnType<typeof vi.fn>
} = {}): {
  client: ExtensionHostClient
  emitTheme(value: Theme): void
  emitLocale(value: Locale): void
  emitMessage(value: HostMessage): void
} {
  const themeListeners = new Set<(value: Theme) => void>()
  const localeListeners = new Set<(value: Locale) => void>()
  const messageListeners = new Set<(value: HostMessage) => void>()
  const event = () => ({ dispose: () => undefined })
  const executeCommand = input.executeCommand ?? vi.fn(async (_id: string, args?: JsonValue) => {
    const action = isRecord(args) ? args.action : undefined
    return action === 'project.list' ? { content: { projects: [] } } : { content: {} }
  })
  const client = {
    commands: { executeCommand },
    media: {
      getCapabilities: vi.fn(async () => ({
        probedAt: '2026-01-01T00:00:00.000Z',
        ffmpeg: {
          name: 'ffmpeg', available: true,
          features: ['libx264-encoder', 'aac-encoder']
        },
        ffprobe: { name: 'ffprobe', available: true, features: [] }
      })),
      pickFiles: input.pickFiles ?? vi.fn(),
      pickSaveTarget: input.pickSaveTarget ?? vi.fn(),
      readText: input.readText ?? vi.fn(),
      openViewResource: input.openViewResource ?? vi.fn(),
      performArtifactAction: input.performArtifactAction ?? vi.fn(),
      release: input.release ?? vi.fn(async () => ({ released: true }))
    },
    jobs: {
      list: input.listJobs ?? vi.fn(async () => ({ items: [] })),
      get: input.getJob ?? vi.fn(),
      subscribe: input.subscribeJob ?? vi.fn()
    },
    agent: {},
    ui: {
      getTheme: vi.fn(input.getTheme ?? (async () => darkTheme())),
      getLocale: vi.fn(input.getLocale ?? (async () => enLocale())),
      getViewState: input.getViewState ?? vi.fn(async () => undefined),
      setViewState: input.setViewState ?? vi.fn(async () => undefined),
      attachComposerContext: input.attachComposerContext ?? vi.fn(),
      onDidChangeTheme: (listener: (value: Theme) => void) => {
        themeListeners.add(listener)
        return { dispose: () => themeListeners.delete(listener) }
      },
      onDidChangeLocale: (listener: (value: Locale) => void) => {
        localeListeners.add(listener)
        return { dispose: () => localeListeners.delete(listener) }
      },
      onDidReceiveMessage: (listener: (value: HostMessage) => void) => {
        messageListeners.add(listener)
        return { dispose: () => messageListeners.delete(listener) }
      }
    },
    onDidError: event
  } as unknown as ExtensionHostClient
  return {
    client,
    emitTheme: (value) => { for (const listener of themeListeners) listener(value) },
    emitLocale: (value) => { for (const listener of localeListeners) listener(value) },
    emitMessage: (value) => { for (const listener of messageListeners) listener(value) }
  }
}

export function darkTheme(): Theme {
  return { kind: 'dark', tokens: {}, zoomFactor: 1, reducedMotion: false }
}

export function lightTheme(): Theme {
  return { kind: 'light', tokens: {}, zoomFactor: 1, reducedMotion: false }
}

export function enLocale(): Locale {
  return { language: 'en', direction: 'ltr', messages: {} }
}

export function zhLocale(): Locale {
  return { language: 'zh-CN', direction: 'ltr', messages: {} }
}

export function projectChangedMessage(projectId: string): HostMessage {
  return {
    channel: 'kun-video-editor.active-project-changed',
    payload: {
      schemaVersion: 1,
      projectId,
      revision: 0,
      reason: 'active-project-changed',
      changedIds: ['active-project']
    }
  }
}

export async function flushAsync(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function localizedNotice(notice: EditorNotice, locale: Locale | undefined): string {
  return notice.messageKey
    ? formatMessage(messagesFor(locale)[notice.messageKey], notice.messageValues)
    : notice.message
}
