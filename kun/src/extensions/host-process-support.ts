import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CompatibilityReportSchema,
  type CompatibilityReport,
  type WorkspaceContext
} from '@kun/extension-api'
import { z } from 'zod'
import { asExtensionError, extensionError, type ExtensionErrorDetails } from './errors.js'
import { redactSecrets, redactSecretText } from '../config/secret-redaction.js'
import {
  DEFAULT_EXTENSION_CONCURRENT_REQUESTS,
  DEFAULT_EXTENSION_MESSAGE_BYTES,
  DEFAULT_EXTENSION_REQUEST_TIMEOUT_MS,
  DEFAULT_EXTENSION_STREAM_BUFFER_BYTES,
  DEFAULT_EXTENSION_STREAM_WINDOW,
  JsonRpcPeer,
  type RpcEnvelope,
  type RpcRequestContext
} from './host-protocol.js'
import {
  DEFAULT_EXTENSION_LOG_BYTES,
  DEFAULT_EXTENSION_LOG_RETENTION,
  ExtensionLogWriter
} from './log-writer.js'
import { ExtensionPaths } from './paths.js'
import {
  EXTENSION_RPC_VERSION,
  type JsonValue,
  type ResolvedExtension
} from './types.js'

import type { ExtensionBrokerRequest, ExtensionHostLimits, ExtensionPrincipal } from './host-process.js'
import {
  DEFAULT_EXTENSION_ACTIVATION_TIMEOUT_MS,
  DEFAULT_EXTENSION_CANCELLATION_GRACE_MS,
  DEFAULT_EXTENSION_EVENTS_PER_SECOND,
  DEFAULT_EXTENSION_MEMORY_BYTES,
  DEFAULT_EXTENSION_SHUTDOWN_TIMEOUT_MS
} from './host-process.js'

export function resolveHostLimits(overrides: Partial<ExtensionHostLimits> = {}): ExtensionHostLimits {
  const limits: ExtensionHostLimits = {
    activationTimeoutMs: overrides.activationTimeoutMs ?? DEFAULT_EXTENSION_ACTIVATION_TIMEOUT_MS,
    operationTimeoutMs: overrides.operationTimeoutMs ?? DEFAULT_EXTENSION_REQUEST_TIMEOUT_MS,
    cancellationGraceMs: overrides.cancellationGraceMs ?? DEFAULT_EXTENSION_CANCELLATION_GRACE_MS,
    shutdownTimeoutMs: overrides.shutdownTimeoutMs ?? DEFAULT_EXTENSION_SHUTDOWN_TIMEOUT_MS,
    maxMessageBytes: overrides.maxMessageBytes ?? DEFAULT_EXTENSION_MESSAGE_BYTES,
    maxConcurrentRequests:
      overrides.maxConcurrentRequests ?? DEFAULT_EXTENSION_CONCURRENT_REQUESTS,
    streamWindow: overrides.streamWindow ?? DEFAULT_EXTENSION_STREAM_WINDOW,
    maxStreamBufferBytes:
      overrides.maxStreamBufferBytes ?? DEFAULT_EXTENSION_STREAM_BUFFER_BYTES,
    maxMemoryBytes: overrides.maxMemoryBytes ?? DEFAULT_EXTENSION_MEMORY_BYTES,
    maxEventsPerSecond: overrides.maxEventsPerSecond ?? DEFAULT_EXTENSION_EVENTS_PER_SECOND,
    maxLogBytes: overrides.maxLogBytes ?? DEFAULT_EXTENSION_LOG_BYTES,
    logRetention: overrides.logRetention ?? DEFAULT_EXTENSION_LOG_RETENTION
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw extensionError('EXTENSION_HOST_LIMIT_INVALID', 'Extension host limit is invalid', {
        name,
        value
      })
    }
  }
  return limits
}

export function minimalExtensionEnvironment(
  additions: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  const allowed = [
    'HOME',
    'USERPROFILE',
    'PATH',
    'PATHEXT',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'WINDIR',
    'LANG',
    'LC_ALL',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR'
  ]
  const environment: NodeJS.ProcessEnv = {}
  for (const name of allowed) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  if (environment.TMPDIR === undefined && process.platform !== 'win32') environment.TMPDIR = tmpdir()
  for (const [name, value] of Object.entries(additions)) {
    if (value !== undefined) environment[name] = value
  }
  return environment
}

export function serializeError(error: unknown): {
  code: string
  message: string
  details: ExtensionErrorDetails
} {
  const normalized = asExtensionError(error)
  return {
    code: normalized.code,
    message: redactSecretText(normalized.message).slice(0, 2_000),
    details: redactSecrets(structuredClone(normalized.details))
  }
}

export function safeErrorMessage(error: unknown): string {
  return redactSecretText(error instanceof Error ? error.message : String(error)).slice(0, 1_000)
}

export function waitFor(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), timeoutMs)
    timer.unref?.()
    promise.then(
      () => {
        clearTimeout(timer)
        resolvePromise(true)
      },
      () => {
        clearTimeout(timer)
        resolvePromise(true)
      }
    )
  })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function assertHostAdmission(
  extension: ResolvedExtension,
  value: CompatibilityReport
): CompatibilityReport {
  const report = CompatibilityReportSchema.parse(value)
  const identityMatches =
    report.extensionVersion === extension.version &&
    report.extensionVersion === extension.manifest.version &&
    report.manifestVersion === extension.manifest.manifestVersion &&
    report.api.declaredApiVersion === extension.manifest.apiVersion &&
    report.kunEngine.declared === extension.manifest.engines.kun &&
    report.stateSchemaVersion === extension.manifest.stateSchemaVersion
  const compatible = report.api.compatible &&
    report.kunEngine.compatible &&
    report.rpc.compatible &&
    report.rpc.declared === EXTENSION_RPC_VERSION &&
    report.rpc.negotiated === EXTENSION_RPC_VERSION &&
    report.diagnostics.every((diagnostic) => diagnostic.compatible)
  if (!identityMatches || !compatible) {
    throw extensionError(
      'EXTENSION_HOST_ADMISSION_FAILED',
      'Extension Host cannot start without a matching compatible admission report',
      {
        extensionId: extension.id,
        version: extension.version,
        identityMatches,
        compatibility: report
      }
    )
  }
  return report
}
