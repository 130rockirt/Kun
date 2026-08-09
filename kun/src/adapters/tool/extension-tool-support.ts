import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { ExtensionApiError, type ExtensionErrorCode } from '@kun/extension-api'
import type { ExtensionToolCatalogEntry, ExtensionToolCatalogEpoch } from '../../contracts/threads.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { ExtensionPrincipal } from '../../services/extension-agent-service.js'
import type { LocalTool } from './local-tool-host.js'
import type {
  ActiveRegistration,
  ExtensionToolDeclaration,
  ExtensionToolSideEffect
} from './extension-tool-provider.js'

const RESERVED_TOOL_NAMES = new Set([
  'request_user_input',
  'user_input',
  'extension_tool_search',
  'extension_tool_call',
  'approval',
  'approve'
])
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024
const ABSOLUTE_MAX_OUTPUT_BYTES = 1024 * 1024
const KNOWN_PRE_COMMIT_EXTENSION_API_ERROR_CODES: ReadonlySet<ExtensionErrorCode> = new Set([
  'INVALID_ARGUMENT',
  'VALIDATION_FAILED',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'CONFLICT',
  'UNSUPPORTED_CAPABILITY',
  'INCOMPATIBLE_API',
  'INCOMPATIBLE_MANIFEST',
  'INCOMPATIBLE_ENGINE',
  'INCOMPATIBLE_RPC',
  'INTERACTION_REQUIRED',
  'ACCOUNT_REQUIRED',
  'RESOURCE_LIMIT'
])

export function canonicalExtensionToolId(extensionId: string, localName: string): string {
  return `extension:${extensionId}/${localName}`
}

export function extensionToolModelAlias(extensionId: string, localName: string): string {
  const namespace = createHash('sha256').update(extensionId).digest('hex').slice(0, 10)
  const safeName = localName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
  return `ext_${namespace}_${safeName}`
}

export function extensionProviderId(extensionId: string): string {
  return `extension:${extensionId}`
}

export function catalogEntry(registration: ActiveRegistration): ExtensionToolCatalogEntry {
  return {
    canonicalToolId: registration.canonicalToolId,
    modelAlias: registration.modelAlias,
    description: registration.declaration.description,
    inputSchema: structuredClone(registration.declaration.inputSchema),
    sideEffect: registration.declaration.sideEffect
  }
}

export function registrationDigest(registration: ActiveRegistration): string {
  return `sha256:${stableHash({
    ...catalogEntry(registration),
    ...(registration.declaration.outputSchema
      ? { outputSchema: registration.declaration.outputSchema }
      : {}),
    idempotent: registration.declaration.idempotent ?? false,
    maxOutputBytes: registration.declaration.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  })}`
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)])
  )
}

export function searchTokens(value: string): string[] {
  return [...new Set(value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_.:-]+/gu) ?? [])]
}

export function scopedRegistrationKey(canonicalToolId: string, workspaceRoots: readonly string[]): string {
  return `${canonicalToolId}\u0000${JSON.stringify(normalizedWorkspaceRoots(workspaceRoots))}`
}

export function normalizedWorkspaceRoots(workspaceRoots: readonly string[]): string[] {
  return [...new Set(workspaceRoots.map((root) => resolve(root)))].sort()
}

export function principalOwnsWorkspace(principal: ExtensionPrincipal, workspace: string | undefined): boolean {
  if (!workspace || !isAbsolute(workspace)) return false
  return normalizedWorkspaceRoots(principal.workspaceRoots).includes(resolve(workspace))
}

export function registrationOwnsWorkspace(registration: ActiveRegistration, workspace: string): boolean {
  return principalOwnsWorkspace(registration.principal, workspace)
}

export function uniqueCanonicalRegistrations(registrations: ActiveRegistration[]): ActiveRegistration[] {
  const unique = new Map<string, ActiveRegistration>()
  for (const registration of registrations) {
    if (!registration.disposed && !unique.has(registration.canonicalToolId)) {
      unique.set(registration.canonicalToolId, registration)
    }
  }
  return [...unique.values()]
}

export function requiredEpoch(context: ToolHostContext): ExtensionToolCatalogEpoch {
  const epoch = context.extensionToolCatalogEpoch
  if (!epoch) throw new Error('extension tool catalog epoch is required')
  return epoch
}

export function validateDeclaration(input: ExtensionToolDeclaration): ExtensionToolDeclaration {
  const name = input.name.trim()
  const description = input.description.trim()
  if (!/^[a-z][a-z0-9._-]{0,63}$/i.test(name)) throw new Error(`invalid extension tool name: ${name}`)
  if (RESERVED_TOOL_NAMES.has(name) || name.startsWith('kun.')) throw new Error(`reserved extension tool name: ${name}`)
  if (!description || description.length > 4_000) throw new Error(`invalid extension tool description: ${name}`)
  if (!isPlainObject(input.inputSchema) || input.inputSchema.type !== 'object') {
    throw new Error(`extension tool input schema must have object type: ${name}`)
  }
  if (input.outputSchema !== undefined && !isPlainObject(input.outputSchema)) {
    throw new Error(`extension tool output schema must be an object: ${name}`)
  }
  if (input.maxOutputBytes !== undefined && (
    !Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1_024 || input.maxOutputBytes > ABSOLUTE_MAX_OUTPUT_BYTES
  )) throw new Error(`invalid extension tool maxOutputBytes: ${name}`)
  return structuredClone({ ...input, name, description })
}

export function policyForSideEffect(sideEffect: ExtensionToolSideEffect): LocalTool['policy'] {
  switch (sideEffect) {
    case 'none':
    case 'workspace-read':
      return 'auto'
    case 'workspace-write':
    case 'network':
    case 'external':
      return 'on-request'
  }
}

export function hasUnknownSideEffect(sideEffect: ExtensionToolSideEffect): boolean {
  return sideEffect === 'workspace-write' || sideEffect === 'network' || sideEffect === 'external'
}

export function isKnownFailure(error: unknown): boolean {
  if (error instanceof ExtensionApiError) {
    return KNOWN_PRE_COMMIT_EXTENSION_API_ERROR_CODES.has(error.code)
  }
  return Boolean(error && typeof error === 'object' && 'knownFailure' in error && error.knownFailure === true)
}

export function normalizeOutput(
  result: { output: unknown; isError?: boolean; declaredOutput?: unknown },
  maxBytes: number
): { output: unknown; isError?: boolean } {
  if (serializedBytes(result.output) <= maxBytes) {
    return { output: result.output, ...(result.isError ? { isError: true } : {}) }
  }
  const text = typeof result.output === 'string' ? result.output : JSON.stringify(result.output)
  const truncated = Buffer.from(text, 'utf8').subarray(0, Math.max(0, maxBytes - 256)).toString('utf8')
  return {
    output: {
      truncated: true,
      originalBytes: Buffer.byteLength(text, 'utf8'),
      content: truncated,
      message: 'Extension tool output exceeded its declared result budget.'
    },
    ...(result.isError ? { isError: true } : {})
  }
}

export function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason)
  }
  for (const signal of signals) {
    if (signal.aborted) abort(signal)
    else signal.addEventListener('abort', () => abort(signal), { once: true })
  }
  return controller.signal
}

export function abortError(): Error {
  const error = new Error('extension tool invocation aborted')
  error.name = 'AbortError'
  return error
}

export function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8')
  } catch {
    throw new Error('extension tool payload must be JSON serializable')
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
