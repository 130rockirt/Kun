import { z, type ZodType } from 'zod'
import { randomUUID } from 'node:crypto'
import {
  ApprovalDecisionResponse,
  AttachmentReleaseResponse,
  AttachmentUploadRequest,
  AttachmentUploadResponse,
  BackgroundShellListResponse,
  BackgroundShellRecord,
  BackgroundShellStopResponse,
  ClearThreadGoalResponse,
  ClearThreadTodosResponse,
  CompactResponse,
  ClaudeSdkInstallStatusSchema,
  CreateThreadRequest,
  DeleteThreadResponse,
  ForkThreadRequest,
  GraphRunStatusSchema,
  GraphRunV1Schema,
  ListThreadsResponse,
  ModelConnectionConnectRequestSchema,
  ModelConnectionCliAuthRequestSchema,
  ModelConnectionCredentialRequestSchema,
  ModelConnectionOAuthStartRequestSchema,
  ModelConnectionOAuthStatusSchema,
  ModelConnectionOAuthSubmitRequestSchema,
  ModelConnectionPatchRequestSchema,
  ModelConnectionSelectRequestSchema,
  ModelConnectionSnapshotSchema,
  McpServerConfig,
  MemoryCreateRequest,
  MemoryRecord,
  MemoryUpdateRequest,
  RuntimeInfoResponse,
  RuntimeConfigApplyRequest,
  RuntimeConfigApplyResponse,
  ReplaceSteeringRequest,
  SetThreadGoalRequest,
  SetThreadTodosRequest,
  StartTurnRequest,
  StartTurnResponse,
  SteeringQueueResponse,
  ThreadGoalResponse,
  ThreadSchema,
  ThreadTodosResponse,
  ThreadUsageResponseSchema,
  ProviderQuotaListResponseSchema,
  UpdateThreadRequest,
  UserInputAnswerSchema,
  type ApprovalDecisionRequest,
  type CreateThreadRequest as CreateThreadRequestValue,
  type RuntimeEvent as RuntimeEventValue,
  type StartTurnRequest as StartTurnRequestValue,
  type ThreadRecord,
  type ThreadSummary
} from '../contracts/index.js'
import { createApprovalConsentToken, KUN_APPROVAL_CONSENT_HEADER } from '../server/approval-consent.js'
import { isLoopbackHost } from '../server/loopback-host.js'
import { readRuntimeDiscovery, type RuntimeDiscoveryRecord } from '../server/runtime-discovery.js'
import { ensureSharedRuntime, runtimeDiscoveryDirectory } from '../cli/shared-runtime.js'
import {
  allowsDevelopmentManagerBootstrap,
  runtimeBuildIdForFlavor
} from '../cli/runtime-flavor.js'
import { readRuntimeBuildIdForEntry } from '../server/runtime-build-identity.js'
import type { TuiOptions } from './options.js'
import { defaultKunControlDir } from '../manager/manager-discovery.js'
import { ensureServiceManager } from '../manager/manager-client.js'
import { IncrementalSseParser, parseRuntimeEventFrame } from './sse.js'
import { TuiClientError, type TuiConnection } from './client-types.js'
import { KunTuiClient } from './kun-tui-client.js'

export async function resolveTuiConnection(
  options: TuiOptions,
  fetchImpl: typeof fetch = fetch,
  deps?: {
    expectedBuildId?: string
    ensureRuntime?: typeof ensureSharedRuntime
  }
): Promise<TuiConnection> {
  if (options.url) {
    return validateConnection({
      baseUrl: options.url,
      runtimeToken: options.runtimeToken,
      discovered: false
    }, fetchImpl)
  }

  const runtimeFlavor = options.runtimeFlavor ?? 'production'
  const sourceBuildId = deps?.expectedBuildId ?? await readRuntimeBuildIdForEntry(import.meta.url)
  const expectedBuildId = runtimeBuildIdForFlavor(
    sourceBuildId,
    runtimeFlavor
  )
  const ensureRuntime = deps?.ensureRuntime ?? ensureSharedRuntime
  const controlDir = process.env.KUN_MANAGER_CONTROL_DIR?.trim() || defaultKunControlDir()
  const managerSettingsPath = process.env.KUN_MANAGER_SETTINGS_PATH?.trim()
  const startExpectedRuntime = async (): Promise<TuiConnection> => {
    const manager = deps?.ensureRuntime
      ? undefined
      : await ensureServiceManager({
          flavor: runtimeFlavor,
          allowDevelopmentBootstrap: allowsDevelopmentManagerBootstrap({
            flavor: runtimeFlavor,
            env: process.env
          }),
          controlDir,
          dataDir: options.dataDir,
          ...(managerSettingsPath ? { settingsPath: managerSettingsPath } : {}),
          fetch: fetchImpl
        })
    const started = await ensureRuntime({
      dataDir: options.dataDir,
      fetch: fetchImpl,
      runtimeFlavor,
      controlDir,
      ...(manager ? { manager } : {}),
      ...(sourceBuildId ? { expectedBuildId: sourceBuildId } : {})
    })
    return {
      baseUrl: started.discovery.baseUrl,
      runtimeToken: started.discovery.runtimeToken,
      runtimeInfo: started.info,
      discovered: true
    }
  }
  const discoveryDir = runtimeDiscoveryDirectory(options.dataDir, runtimeFlavor, controlDir)
  const discovery = await readRuntimeDiscovery(discoveryDir, runtimeFlavor).catch(() => null)
  if (discovery) {
    assertSafeDiscovery(discovery)
    try {
      const connection = await validateConnection({
        baseUrl: discovery.baseUrl.replace(/\/$/, ''),
        runtimeToken: options.runtimeToken || discovery.runtimeToken,
        discovered: true,
        discovery
      }, fetchImpl)
      const buildMatches = !expectedBuildId || (
        discovery.buildId === expectedBuildId &&
        connection.runtimeInfo.buildId === expectedBuildId
      )
      if (buildMatches) return connection
      if (options.noStart) {
        throw new TuiClientError(
          'Kun runtime discovery belongs to an older application build; remove --no-start so this TUI can replace it.',
          undefined,
          'runtime_build_mismatch'
        )
      }
      return startExpectedRuntime()
    } catch (error) {
      if (!options.noStart) {
        return startExpectedRuntime()
      }
      if (error instanceof TuiClientError && error.code === 'runtime_build_mismatch') {
        throw error
      }
      throw new TuiClientError(
        `Kun runtime discovery is stale or unavailable in ${options.dataDir}. Run \`kun runtime restart\`, or remove --no-start so this client can start the shared runtime.`,
        error instanceof TuiClientError ? error.status : undefined,
        'stale_runtime_discovery'
      )
    }
  }
  if (options.noStart) {
    throw new TuiClientError(
      `No reachable Kun runtime was found in ${options.dataDir}; remove --no-start or run kun serve.`,
      undefined,
      'runtime_unavailable'
    )
  }
  return startExpectedRuntime()
}

async function validateConnection(
  input: {
    baseUrl: string
    runtimeToken: string
    discovered: boolean
    discovery?: RuntimeDiscoveryRecord
  },
  fetchImpl: typeof fetch
): Promise<TuiConnection> {
  const client = new KunTuiClient({
    baseUrl: input.baseUrl,
    runtimeToken: input.runtimeToken,
    fetch: fetchImpl
  })
  const runtimeInfo = await client.runtimeInfo()
  if (input.discovery) {
    if (runtimeInfo.pid !== undefined && runtimeInfo.pid !== input.discovery.pid) {
      throw new TuiClientError('discovered runtime process does not match the live server')
    }
    if (runtimeInfo.startedAt !== input.discovery.startedAt) {
      throw new TuiClientError('discovered runtime start time does not match the live server')
    }
    if (runtimeInfo.instanceId !== input.discovery.instanceId) {
      throw new TuiClientError('discovered runtime instance does not match the live server')
    }
  }
  return {
    baseUrl: input.baseUrl,
    runtimeToken: input.runtimeToken,
    runtimeInfo,
    discovered: input.discovered
  }
}

function assertSafeDiscovery(record: RuntimeDiscoveryRecord): void {
  let url: URL
  try {
    url = new URL(record.baseUrl)
  } catch {
    throw new TuiClientError('runtime discovery contains an invalid URL', undefined, 'unsafe_runtime_discovery')
  }
  if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname)) {
    throw new TuiClientError('runtime discovery must reference a loopback HTTP endpoint', undefined, 'unsafe_runtime_discovery')
  }
}
