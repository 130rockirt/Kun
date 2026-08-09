import { z } from 'zod'
import {
  AccountSchema,
  AccountSessionSchema,
  AuthenticatedFetchRequestSchema,
  CreateAccountSessionRequestSchema,
  ListAccountsRequestSchema,
  RevealSecretRequestSchema
} from './accounts.js'
import { ProviderBindingSchema } from './accounts.js'
import {
  ArtifactHostActionRequestSchema,
  ArtifactHostActionResultSchema
} from './artifacts.js'
import {
  AgentCancelRequestSchema,
  AgentCreateRunRequestSchema,
  AgentCreateRunResponseSchema,
  AgentMutationResultSchema,
  AgentRunEventSchema,
  AgentRunSchema,
  AgentSteerRequestSchema,
  AgentSubscribeRequestSchema,
  ExtensionThreadProjectionSchema,
  ListOwnThreadsRequestSchema,
  ListOwnThreadsResponseSchema
} from './agent.js'
import {
  JsonObjectSchema,
  JsonValueSchema,
  LocalIdSchema,
  type JsonObject,
  type JsonValue
} from './common.js'
import { ExtensionApiError } from './errors.js'
import {
  ComposerContextAttachmentRequestSchema,
  ComposerContextAttachmentSchema
} from './composer-context.js'
import {
  JobCancelRequestSchema,
  JobCancellationResultSchema,
  JobEventNotificationSchema,
  JobEventSchema,
  JobGetRequestSchema,
  JobListRequestSchema,
  JobPageSchema,
  JobSnapshotSchema,
  JobSubscribeRequestSchema,
  JobSubscriptionResponseSchema,
  type JobEvent,
  type JobSnapshot
} from './jobs.js'
import {
  ActivationContextDataSchema,
  DisposableStore,
  Emitter,
  toDisposable,
  type ActivationContextData,
  type Disposable,
  type Event,
  type WorkspaceContext
} from './lifecycle.js'
import {
  ModelProviderDeclarationSchema,
  ModelProviderRequestSchema,
  ModelProviderStreamEventSchema,
  ProviderModelSchema,
  ProviderProbeResultSchema,
  ProviderStatusSchema,
  type ModelProviderAdapter
} from './providers.js'
import {
  MediaAudioAnalysisCapabilitiesSchema,
  MediaAnalyzeVisualFramesRequestSchema,
  MediaAnalyzeVisualFramesResultSchema,
  MediaEmbedVisualQueryRequestSchema,
  MediaEmbedVisualQueryResultSchema,
  MediaInstallVisualModelRequestSchema,
  MediaMetadataSchema,
  MediaCapabilitiesSchema,
  MediaCreateCacheTargetRequestSchema,
  MediaCreateCacheTargetResultSchema,
  MediaOpenViewResourceRequestSchema,
  MediaPickFilesRequestSchema,
  MediaPickFilesResultSchema,
  MediaPickSaveTargetRequestSchema,
  MediaPickSaveTargetResultSchema,
  MediaProbeRequestSchema,
  MediaProbeResultSchema,
  MediaReadTextRequestSchema,
  MediaReadTextResultSchema,
  MediaReleaseRequestSchema,
  MediaReleaseResultSchema,
  MediaResourceLeaseSchema,
  MediaStartFfmpegJobRequestSchema,
  MediaStartFfmpegJobResultSchema,
  MediaStartAudioAnalysisJobRequestSchema,
  MediaStartAudioAnalysisJobResultSchema,
  MediaStartArchiveJobRequestSchema,
  MediaStartArchiveJobResultSchema,
  MediaStatRequestSchema,
  MediaVisualModelStatusSchema
} from './media.js'
import {
  HostMessageSchema,
  ConfigurationChangeEventSchema,
  LocaleSchema,
  NetworkRequestSchema,
  NetworkResponseSchema,
  NotificationOptionsSchema,
  ThemeSchema,
  WorkspaceFileSchema,
  type AgentApi,
  type AgentRunSubscription,
  type AuthenticationApi,
  type CommandsApi,
  type ConfigurationApi,
  type HostRequestContext,
  type HostRequestOptions,
  type HostTransport,
  type JobsApi,
  type JobSubscription,
  type MediaApi,
  type ModelProvidersApi,
  type NetworkApi,
  type ScopedStorageApi,
  type StorageApi,
  type ThreadsApi,
  type ToolsApi,
  type UiApi,
  type WorkspaceApi
} from './services.js'
import {
  ExtensionToolDeclarationSchema,
  ToolInvocationSchema,
  ToolResultSchema,
  type CancellationToken,
  type ExtensionToolHandler
} from './tools.js'

import {
  ProviderInvocationSchema,
  ProviderStreamPayloadSchema,
  RegistrationResponseSchema,
  cancellationFromContext,
  fallbackProviderStreamId,
  requestParsed,
  toWire
} from './client-internals.js'

export async function registerProvider(
  transport: HostTransport,
  declaration: z.infer<typeof ModelProviderDeclarationSchema>,
  adapter: ModelProviderAdapter
): Promise<Disposable> {
    const { registrationId } = await requestParsed(
      transport,
      'modelProviders.register',
      declaration,
      RegistrationResponseSchema
    )
    const localHandler = transport.registerHandler(
      `modelProviders.invoke:${registrationId}`,
      async (params, context) => {
        const invocation = ProviderInvocationSchema.parse(params)
        const operationContext = { cancellation: cancellationFromContext(context) }
        switch (invocation.operation) {
          case 'probe':
            return toWire(
              ProviderProbeResultSchema.parse(await adapter.probe(invocation.binding, operationContext))
            )
          case 'listModels':
            return toWire(
              z.array(ProviderModelSchema).parse(await adapter.listModels(invocation.binding, operationContext))
            )
          case 'stream':
            {
              if (transport.sendStream === undefined) {
                for await (const event of adapter.stream(invocation.request, operationContext)) {
                  await transport.notify(
                    'modelProviders.streamEvent',
                    toWire({ registrationId, event: ModelProviderStreamEventSchema.parse(event) })
                  )
                }
                return { accepted: true }
              }
              const sendStream = transport.sendStream.bind(transport)
              const streamId = context.requestId ?? fallbackProviderStreamId(
                registrationId,
                invocation.request.requestId
              )
              let terminalSent = false
              try {
                for await (const rawEvent of adapter.stream(invocation.request, operationContext)) {
                  const event = ModelProviderStreamEventSchema.parse(rawEvent)
                  const terminal = event.type === 'completed' || event.type === 'error'
                  await sendStream(
                    streamId,
                    toWire(ProviderStreamPayloadSchema.parse({
                      kind: 'event',
                      registrationId,
                      requestId: invocation.request.requestId,
                      event
                    })),
                    terminal
                  )
                  if (terminal) {
                    terminalSent = true
                    break
                  }
                }
                if (!terminalSent) {
                  await sendStream(
                    streamId,
                    toWire(ProviderStreamPayloadSchema.parse({
                      kind: 'end',
                      registrationId,
                      requestId: invocation.request.requestId,
                      outcome: 'ended'
                    })),
                    true
                  )
                }
              } catch (error) {
                if (!terminalSent) {
                  await sendStream(
                    streamId,
                    toWire(ProviderStreamPayloadSchema.parse({
                      kind: 'end',
                      registrationId,
                      requestId: invocation.request.requestId,
                      outcome: 'failed'
                    })),
                    true
                  ).catch(() => undefined)
                }
                throw error
              }
            }
            return { accepted: true }
          case 'cancel':
            await adapter.cancel(invocation.requestId)
            return { accepted: true }
          case 'countTokens':
            if (!adapter.countTokens) {
              throw new ExtensionApiError({
                code: 'UNSUPPORTED_CAPABILITY',
                message: 'Provider does not implement countTokens',
                operation: 'modelProviders.countTokens',
                retryable: false
              })
            }
            return toWire({ count: await adapter.countTokens(invocation.request, operationContext) })
        }
      }
    )
    return toDisposable(async () => {
      localHandler.dispose()
      await transport.request('modelProviders.unregister', toWire({ registrationId }))
    })
}
