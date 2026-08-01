import { createHash } from 'node:crypto'
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import {
  ConnectorsCapabilityConfig,
  type ConnectorsCapabilityConfig as ConnectorsCapabilityConfigType
} from '../../contracts/capabilities.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import {
  CONNECTOR_INSTANCE_PROOF_KEY_ENV,
  CONNECTOR_RUNTIME_TOKEN_ENV,
  ConnectorApiError,
  ConnectorHttpClient,
  type ConnectorActionMetadata,
  type ConnectorClientDiagnostic,
  type ConnectorSideEffect
} from './connector-client.js'
import { resolveWorkspacePath } from './builtin-tool-utils.js'
import { assertCanWritePath } from './sandbox-policy.js'
import { withFileMutationQueue } from './file-mutation-queue.js'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'

const CONNECTOR_PROVIDER_ID = 'open-connector'
const HEALTH_POLL_INTERVAL_MS = 5_000

export type ConnectorToolProviderBundle = {
  providers: CapabilityToolProvider[]
  client: ConnectorHttpClient
  diagnostics(): ConnectorClientDiagnostic
  close(): void
}

export type BuildConnectorToolProviderOptions = {
  runtimeToken?: string
  instanceProofKey?: string
  fetcher?: typeof fetch
  nowIso?: () => string
  healthPollIntervalMs?: number
}

type CapturedConnectorAuthority = {
  runtimeToken?: string
  instanceProofKey?: string
}

let capturedConnectorAuthority: CapturedConnectorAuthority | undefined

/**
 * Capture host-owned connector authority once, then scrub it before any
 * provider SDK or model-controlled subprocess can inherit the Kun process env.
 * Module state keeps capability hot-rebuilds connected without republishing it.
 */
function captureConnectorAuthority(): CapturedConnectorAuthority {
  if (capturedConnectorAuthority) return capturedConnectorAuthority
  const captured: CapturedConnectorAuthority = {
    ...(process.env[CONNECTOR_RUNTIME_TOKEN_ENV]
      ? { runtimeToken: process.env[CONNECTOR_RUNTIME_TOKEN_ENV] }
      : {}),
    ...(process.env[CONNECTOR_INSTANCE_PROOF_KEY_ENV]
      ? { instanceProofKey: process.env[CONNECTOR_INSTANCE_PROOF_KEY_ENV] }
      : {})
  }
  delete process.env[CONNECTOR_RUNTIME_TOKEN_ENV]
  delete process.env[CONNECTOR_INSTANCE_PROOF_KEY_ENV]
  if (Object.keys(captured).length === 0) return captured
  capturedConnectorAuthority = Object.freeze(captured)
  return capturedConnectorAuthority
}

export async function buildConnectorToolProviders(
  rawConfig: ConnectorsCapabilityConfigType | undefined,
  options: BuildConnectorToolProviderOptions = {}
): Promise<ConnectorToolProviderBundle> {
  const config = ConnectorsCapabilityConfig.parse(rawConfig ?? {})
  const capturedAuthority = captureConnectorAuthority()
  const runtimeToken = options.runtimeToken ?? capturedAuthority.runtimeToken
  const instanceProofKey = options.instanceProofKey ?? capturedAuthority.instanceProofKey
  const client = new ConnectorHttpClient({
    config,
    runtimeToken,
    instanceProofKey,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.nowIso ? { nowIso: options.nowIso } : {})
  })
  if (config.enabled && runtimeToken?.trim()) {
    const initialProbe = new AbortController()
    const initialProbeTimer = setTimeout(
      () => initialProbe.abort(new Error('initial OpenConnector health probe timed out')),
      Math.min(config.timeoutMs, 1_000)
    )
    initialProbeTimer.unref()
    await client.probeHealth(initialProbe.signal)
    clearTimeout(initialProbeTimer)
  }

  let probing = false
  let closed = false
  let activeProbe: AbortController | undefined
  const intervalMs = Math.max(250, options.healthPollIntervalMs ?? HEALTH_POLL_INTERVAL_MS)
  const healthTimer = config.enabled && runtimeToken?.trim()
    ? setInterval(() => {
        if (closed || probing) return
        probing = true
        activeProbe = new AbortController()
        void client.probeHealth(activeProbe.signal).finally(() => {
          activeProbe = undefined
          probing = false
        })
      }, intervalMs)
    : undefined
  healthTimer?.unref()

  const diagnostic = client.diagnostics()
  const provider: CapabilityToolProvider = {
    id: CONNECTOR_PROVIDER_ID,
    kind: 'connector',
    enabled: config.enabled,
    // Availability is refined per tool through shouldAdvertise so a sidecar
    // can recover without replacing the process-global registry mid-turn.
    available: config.enabled && diagnostic.configured,
    ...(!diagnostic.configured && diagnostic.lastError ? { reason: diagnostic.lastError } : {}),
    tools: buildConnectorTools(client, config)
  }
  return {
    providers: config.enabled ? [provider] : [],
    client,
    diagnostics: () => client.diagnostics(),
    close: () => {
      closed = true
      if (healthTimer) clearInterval(healthTimer)
      activeProbe?.abort(new Error('OpenConnector health monitor closed'))
    }
  }
}

function buildConnectorTools(
  client: ConnectorHttpClient,
  config: ConnectorsCapabilityConfigType
): LocalTool[] {
  const available = () => client.canAdvertiseTools()
  const readEffects = {
    network: true,
    externalWrite: false,
    processExecution: false,
    guiAutomation: false
  }
  const externalEffects = {
    network: true,
    externalWrite: true,
    processExecution: false,
    guiAutomation: false
  }

  return [
    LocalToolHost.defineTool({
      name: 'connector_list_apps',
      description: 'List apps available through the local OpenConnector catalog. Returns metadata only; load an Action separately when needed.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: 'Optional app/category search text.' },
          limit: { type: 'integer', minimum: 1, maximum: 50 }
        },
        additionalProperties: false
      },
      policy: 'auto',
      toolKind: 'tool_call',
      sideEffect: 'read-only',
      effects: readEffects,
      shouldAdvertise: available,
      execute: async (args, context) => connectorBoundary(async () => {
        const apps = await client.listProviders(optionalString(args.query), context.abortSignal)
        const limit = Math.min(positiveInteger(args.limit) ?? config.maxSearchResults, config.maxSearchResults)
        return {
          output: {
            apps: apps.slice(0, limit),
            returned: Math.min(apps.length, limit),
            total_matches: apps.length
          }
        }
      })
    }),
    LocalToolHost.defineTool({
      name: 'connector_list_connections',
      description: 'List safe account profiles connected to OpenConnector without exposing credentials.',
      inputSchema: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Optional app service id to filter.' }
        },
        additionalProperties: false
      },
      policy: 'auto',
      toolKind: 'tool_call',
      sideEffect: 'read-only',
      effects: readEffects,
      shouldAdvertise: available,
      execute: async (args, context) => connectorBoundary(async () => ({
        output: {
          connections: await client.listConnections(optionalString(args.service), context.abortSignal)
        }
      }))
    }),
    LocalToolHost.defineTool({
      name: 'connector_search_actions',
      description: 'Search the OpenConnector Action catalog. Results omit full schemas; use connector_get_action for one selected Action.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1 },
          service: { type: 'string', description: 'Optional app service id.' },
          limit: { type: 'integer', minimum: 1, maximum: 50 }
        },
        required: ['query'],
        additionalProperties: false
      },
      policy: 'auto',
      toolKind: 'tool_call',
      sideEffect: 'read-only',
      effects: readEffects,
      shouldAdvertise: available,
      execute: async (args, context) => connectorBoundary(async () => {
        const query = requiredString(args.query, 'query')
        const results = await client.searchActions({
          query,
          ...(optionalString(args.service) ? { service: optionalString(args.service) } : {}),
          ...(positiveInteger(args.limit) ? { limit: positiveInteger(args.limit) } : {}),
          signal: context.abortSignal
        })
        return {
          output: {
            actions: results.map(({ inputSchema: _input, outputSchema: _output, ...action }) => ({
              ...action,
              sideEffect: normalizeSideEffect(action.sideEffect)
            })),
            returned: results.length,
            max_results: config.maxSearchResults
          }
        }
      })
    }),
    LocalToolHost.defineTool({
      name: 'connector_get_action',
      description: 'Load one OpenConnector Action description, permissions, side-effect classification, and input/output schemas.',
      inputSchema: actionIdSchema(),
      policy: 'auto',
      toolKind: 'tool_call',
      sideEffect: 'read-only',
      effects: readEffects,
      shouldAdvertise: available,
      execute: async (args, context) => connectorBoundary(async () => ({
        output: {
          action: normalizeAction(await client.getAction(requiredString(args.action_id, 'action_id'), context.abortSignal))
        }
      }))
    }),
    LocalToolHost.defineTool({
      name: 'connector_read_action',
      description: 'Run an Action only when OpenConnector explicitly classifies it as read-only. Unknown or mutating Actions are rejected.',
      inputSchema: actionExecutionSchema(),
      policy: 'auto',
      toolKind: 'tool_call',
      sideEffect: 'read-only',
      effects: readEffects,
      shouldAdvertise: available,
      execute: async (args, context) => connectorBoundary(async () => {
        const actionId = requiredString(args.action_id, 'action_id')
        const action = await client.getAction(actionId, context.abortSignal)
        const sideEffect = normalizeSideEffect(action.sideEffect)
        if (sideEffect !== 'read') {
          return {
            output: {
              code: 'connector_action_not_read_only',
              error: `Action ${actionId} is classified as ${sideEffect} and must use connector_execute_action with approval.`,
              action_id: actionId,
              side_effect: sideEffect
            },
            isError: true
          }
        }
        const result = await client.executeAction({
          actionId,
          actionInput: optionalObject(args.input),
          ...(optionalString(args.connection_name)
            ? { connectionName: optionalString(args.connection_name) }
            : {}),
          signal: context.abortSignal
        })
        return {
          output: {
            action_id: actionId,
            side_effect: 'read',
            result: result.data,
            meta: result.meta
          }
        }
      })
    }),
    LocalToolHost.defineTool({
      name: 'connector_execute_action',
      description: 'Execute an OpenConnector Action that may write, send, delete, or have unknown effects. Kun always requires approval, including in Full access.',
      inputSchema: actionExecutionSchema(),
      policy: 'on-request',
      toolKind: 'tool_call',
      sideEffect: 'unknown',
      effects: externalEffects,
      shouldAdvertise: available,
      requiresExplicitApproval: true,
      requiresApprovalInFullAccess: true,
      execute: async (args, context) => connectorBoundary(async () => {
        const actionId = requiredString(args.action_id, 'action_id')
        const action = await client.getAction(actionId, context.abortSignal)
        const result = await client.executeAction({
          actionId,
          actionInput: optionalObject(args.input),
          ...(optionalString(args.connection_name)
            ? { connectionName: optionalString(args.connection_name) }
            : {}),
          idempotencyKey: connectorIdempotencyKey(context, actionId),
          signal: context.abortSignal,
          outcomeMayBeUnknown: true
        })
        return {
          output: {
            action_id: actionId,
            side_effect: normalizeSideEffect(action.sideEffect),
            result: result.data,
            meta: result.meta
          }
        }
      })
    }),
    LocalToolHost.defineTool({
      name: 'connector_upload_file',
      description: 'Upload an authorized workspace file to short-lived OpenConnector transit storage for a later Action.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, description: 'Workspace-relative file path.' },
          mime_type: { type: 'string', minLength: 1 }
        },
        required: ['path'],
        additionalProperties: false
      },
      policy: 'on-request',
      toolKind: 'tool_call',
      sideEffect: 'unknown',
      effects: externalEffects,
      shouldAdvertise: available,
      requiresExplicitApproval: true,
      requiresApprovalInFullAccess: true,
      execute: async (args, context) => connectorBoundary(async () => {
        const rawPath = requiredString(args.path, 'path')
        const resolved = await resolveWorkspacePath(rawPath, context, { enforceWorkspaceBoundary: true })
        const fileStat = await stat(resolved.absolutePath)
        if (!fileStat.isFile()) {
          throw new ConnectorApiError('connector upload path must be a regular file', 400, 'invalid_file')
        }
        if (fileStat.size > config.maxFileBytes) {
          throw new ConnectorApiError(
            `connector file exceeds configured ${config.maxFileBytes}-byte limit`,
            413,
            'file_too_large'
          )
        }
        const content = await readFile(resolved.absolutePath)
        if (content.byteLength > config.maxFileBytes) {
          throw new ConnectorApiError(
            `connector file exceeds configured ${config.maxFileBytes}-byte limit`,
            413,
            'file_too_large'
          )
        }
        const file = await client.uploadFile({
          content,
          name: basename(resolved.absolutePath),
          mimeType: optionalString(args.mime_type) ?? 'application/octet-stream',
          signal: context.abortSignal
        })
        return {
          output: {
            file,
            source_path: resolved.relativePath
          }
        }
      })
    }),
    LocalToolHost.defineTool({
      name: 'connector_save_file',
      description: 'Download a short-lived OpenConnector transit file into the workspace. Kun always requires file-change approval.',
      inputSchema: {
        type: 'object',
        properties: {
          file_id: { type: 'string', minLength: 1 },
          path: { type: 'string', minLength: 1, description: 'Workspace-relative destination path.' },
          overwrite: { type: 'boolean', default: false }
        },
        required: ['file_id', 'path'],
        additionalProperties: false
      },
      policy: 'on-request',
      toolKind: 'file_change',
      sideEffect: 'unknown',
      effects: {
        network: true,
        externalWrite: false,
        processExecution: false,
        guiAutomation: false
      },
      shouldAdvertise: available,
      requiresExplicitApproval: true,
      requiresApprovalInFullAccess: true,
      execute: async (args, context) => connectorBoundary(async () => {
        const fileId = requiredString(args.file_id, 'file_id')
        const rawPath = requiredString(args.path, 'path')
        const resolved = await resolveWorkspacePath(rawPath, context, { enforceWorkspaceBoundary: true })
        assertCanWritePath(resolved.absolutePath, context)
        const downloaded = await client.downloadFile(fileId, context.abortSignal)
        await withFileMutationQueue(resolved.absolutePath, async () => {
          // The transit download is an attacker-controlled scheduling window:
          // a workspace directory could be replaced by an outward-pointing
          // symlink after the first validation. Re-resolve on both sides of
          // mkdir so neither directory creation nor the file write can reuse
          // that stale boundary decision.
          const beforeMkdir = await resolveWorkspacePath(rawPath, context, {
            enforceWorkspaceBoundary: true
          })
          assertCanWritePath(beforeMkdir.absolutePath, context)
          await mkdir(dirname(beforeMkdir.absolutePath), { recursive: true })
          const beforeWrite = await resolveWorkspacePath(rawPath, context, {
            enforceWorkspaceBoundary: true
          })
          assertCanWritePath(beforeWrite.absolutePath, context)
          await writeFile(
            beforeWrite.absolutePath,
            downloaded.content,
            args.overwrite === true ? undefined : { flag: 'wx' }
          )
        })
        return {
          output: {
            file_id: fileId,
            path: resolved.relativePath,
            bytes_written: downloaded.content.byteLength,
            mime_type: downloaded.mimeType ?? null
          }
        }
      })
    })
  ]
}

function actionIdSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      action_id: { type: 'string', minLength: 1 }
    },
    required: ['action_id'],
    additionalProperties: false
  }
}

function actionExecutionSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      action_id: { type: 'string', minLength: 1 },
      input: { type: 'object', additionalProperties: true, default: {} },
      connection_name: { type: 'string', minLength: 1, description: 'Optional named account alias.' }
    },
    required: ['action_id'],
    additionalProperties: false
  }
}

function normalizeAction(action: ConnectorActionMetadata): ConnectorActionMetadata & {
  sideEffect: ConnectorSideEffect
} {
  return { ...action, sideEffect: normalizeSideEffect(action.sideEffect) }
}

function normalizeSideEffect(value: ConnectorSideEffect | undefined): ConnectorSideEffect {
  return value ?? 'unknown'
}

function connectorIdempotencyKey(context: ToolHostContext, actionId: string): string {
  const callId = context.activeToolCallId
  if (!callId) {
    throw new Error('connector execution is missing the host-owned tool-call id')
  }
  const digest = createHash('sha256')
    .update(`${context.threadId}\u0000${context.turnId}\u0000${callId}\u0000${actionId}`)
    .digest('hex')
  return `kun-${digest}`
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConnectorApiError(`${field} is required`, 400, 'invalid_input')
  }
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined
}

function optionalObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConnectorApiError('input must be an object', 400, 'invalid_input')
  }
  return value as Record<string, unknown>
}

async function connectorBoundary(
  run: () => Promise<{ output: unknown; isError?: boolean }>
): Promise<{ output: unknown; isError?: boolean }> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ConnectorApiError) {
      return {
        output: {
          code: error.code,
          error: error.message,
          status: error.status,
          ...(error.data === undefined ? {} : { details: error.data })
        },
        isError: true
      }
    }
    // Unknown-outcome errors deliberately cross the tool boundary so
    // LocalToolHost records the operation as ambiguous and refuses replay.
    throw error
  }
}
