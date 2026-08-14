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
import { TuiClientError } from './client-types.js'

export function isTerminalGraphStatus(status: z.infer<typeof GraphRunStatusSchema>): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export async function responseError(response: Response, path: string, runtimeToken = ''): Promise<TuiClientError> {
  let code: string | undefined
  let message = `Kun runtime request failed (${response.status}) for ${safePath(path)}`
  try {
    const body = await response.json() as { code?: unknown; message?: unknown }
    if (typeof body.code === 'string') code = body.code.slice(0, 128)
    if (typeof body.message === 'string' && body.message.trim()) {
      message = redactKnownSecret(body.message.slice(0, 1_024), runtimeToken)
    }
  } catch {
    // Do not echo arbitrary upstream HTML/text into the terminal.
  }
  return new TuiClientError(message, response.status, code, safePath(path))
}

export function redactKnownSecret(value: string, secret: string): string {
  return secret ? value.split(secret).join('[REDACTED]') : value
}

export function segment(value: string): string {
  return encodeURIComponent(value)
}

export function safePath(path: string): string {
  return path.split('?')[0] ?? path
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(done, ms)
    function done(): void {
      signal.removeEventListener('abort', aborted)
      resolve()
    }
    function aborted(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      reject(signal.reason)
    }
    signal.addEventListener('abort', aborted, { once: true })
  })
}
