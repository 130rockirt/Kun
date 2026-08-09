import {
  AccountSchema,
  ComposerContextAttachmentRequestSchema,
  ComposerContextAttachmentSchema,
  AgentCreateRunRequestSchema,
  AgentRunEventSchema,
  ExtensionApiError,
  ExtensionHostClient,
  ExtensionToolDeclarationSchema,
  GeneratedArtifactSchema,
  HostMessageSchema,
  JobCancelRequestSchema,
  JobEventSchema,
  JobFilterSchema,
  JobListRequestSchema,
  JobResultSchema,
  JobSnapshotSchema,
  JsonObjectSchema,
  JsonValueSchema,
  MediaAudioAnalysisCapabilitiesSchema,
  MediaAnalyzeVisualFramesRequestSchema,
  MediaEmbedVisualQueryRequestSchema,
  MediaCapabilitiesSchema,
  MediaCreateCacheTargetRequestSchema,
  MediaMetadataSchema,
  MediaOpenViewResourceRequestSchema,
  MediaPickFilesRequestSchema,
  MediaPickSaveTargetRequestSchema,
  MediaProbeRequestSchema,
  MediaProbeResultSchema,
  MediaReadTextRequestSchema,
  MediaReadTextResultSchema,
  MediaReleaseRequestSchema,
  MediaStartFfmpegJobRequestSchema,
  MediaStartAudioAnalysisJobRequestSchema,
  MediaStartArchiveJobRequestSchema,
  MediaVisualModelStatusSchema,
  ModelProviderDeclarationSchema,
  NetworkRequestSchema,
  NetworkResponseSchema,
  NotificationOptionsSchema,
  ProviderStatusSchema,
  ThemeSchema,
  LocaleSchema,
  createExtensionContext,
  hasPermission,
  toDisposable,
  type Account,
  type Activate,
  type AgentCreateRunRequest,
  type AgentRun,
  type AgentRunEvent,
  type Deactivate,
  type Disposable,
  type ExtensionContext,
  type ExtensionIdentity,
  type ExtensionToolDeclaration,
  type HostNotification,
  type HostRequestContext,
  type HostRequestHandler,
  type HostRequestOptions,
  type HostTransport,
  type GeneratedArtifact,
  type JobEvent,
  type JobListRequest,
  type JobResult,
  type JobResultInput,
  type JobSnapshot,
  type JsonObject,
  type JsonValue,
  type MediaAudioAnalysisCapabilities,
  type MediaVisualModelStatus,
  type MediaCapabilities,
  type ModelProviderDeclaration,
  type ModelProviderStreamEvent,
  type MediaMetadata,
  type MediaProbeResult,
  type NetworkResponse,
  type Permission,
  type ProviderStatus,
  type Theme,
  type Locale,
  type WorkspaceContext,
  type WorkspaceFile
} from '@kun/extension-api'
import { createHash } from 'node:crypto'


export function storagePermission(params: JsonValue | undefined): string {
  return JsonObjectSchema.parse(params).scope === 'global' ? 'storage.global' : 'storage.workspace'
}

export function notFound(message: string, operation: string): ExtensionApiError {
  return new ExtensionApiError({
    code: 'NOT_FOUND',
    message,
    operation,
    retryable: false
  })
}

export function isTerminal(state: AgentRun['state']): boolean {
  return ['completed', 'failed', 'cancelled', 'budget-exhausted'].includes(state)
}

export function isTerminalJob(state: JobSnapshot['state']): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(state)
}

export function unavailable(operation: string): ExtensionApiError {
  return new ExtensionApiError({
    code: 'HOST_UNAVAILABLE',
    message: 'Fake media executables are unavailable',
    operation,
    retryable: true
  })
}
