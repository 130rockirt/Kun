import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type {
  ExtensionAccountProjection,
  ExtensionAccountRecord,
  ExtensionProviderDefinition
} from '../contracts/extension-providers.js'
import type { ExtensionPrincipal } from './extension-agent-service.js'
import {
  assertBrokeredNetworkUrl,
  createSafeNetworkFetch,
  normalizedBrokerHostname
} from '../extensions/safe-network-fetch.js'
import {
  ExtensionCredentialStore,
  redactExtensionSecrets,
  type ExtensionCredentialPayload
} from './extension-credential-store.js'
import {
  ExtensionProviderAccountStore,
  projectExtensionAccount
} from './extension-provider-account-store.js'
import { installServiceOperations } from './service-operation-install.js'
import { extensionAccountBrokerApiKeyOperations } from './extension-account-broker-api-key-operations.js'
import { extensionAccountBrokerPkceOperations } from './extension-account-broker-pkce-operations.js'
import { extensionAccountBrokerDeviceOperations } from './extension-account-broker-device-operations.js'
import { extensionAccountBrokerNetworkOperations } from './extension-account-broker-network-operations.js'
import { extensionAccountBrokerCredentialsOperations } from './extension-account-broker-credentials-operations.js'
import { extensionAccountBrokerSupportOperations } from './extension-account-broker-support-operations.js'

export type OAuthPkceTransaction = {
  id: string
  extensionId: string
  providerId: string
  label: string
  state: string
  verifier: string
  expiresAt: number
  consumed: boolean
  cancelled: boolean
}

export type DeviceTransaction = {
  id: string
  extensionId: string
  providerId: string
  label: string
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalMs: number
  expiresAt: number
  cancelled: boolean
}

export type ExtensionAccountAuditEvent = {
  timestamp: string
  extensionId: string
  operation: string
  providerId?: string
  accountId?: string
  outcome: 'allowed' | 'denied' | 'failed'
  details?: Record<string, unknown>
}

export type ExtensionAccountBrokerOptions = {
  store: ExtensionProviderAccountStore
  credentials: ExtensionCredentialStore
  fetch?: typeof fetch
  now?: () => Date
  audit?: (event: ExtensionAccountAuditEvent) => Promise<void> | void
  maxPendingTransactions?: number
}

/** Core-owned account/authentication boundary. No method serializes secrets. */
export class ExtensionAccountBroker {
  declare private persistOAuthAccount: (typeof extensionAccountBrokerCredentialsOperations)['persistOAuthAccount']
  declare private resolveCredential: (typeof extensionAccountBrokerCredentialsOperations)['resolveCredential']
  declare private refreshCredential: (typeof extensionAccountBrokerCredentialsOperations)['refreshCredential']
  declare private requireUsableAccount: (typeof extensionAccountBrokerSupportOperations)['requireUsableAccount']
  declare private requireProviderPermission: (typeof extensionAccountBrokerSupportOperations)['requireProviderPermission']
  declare private requireManage: (typeof extensionAccountBrokerSupportOperations)['requireManage']
  declare private serializeAccountMutation: (typeof extensionAccountBrokerSupportOperations)['serializeAccountMutation']
  declare private tokenRequest: (typeof extensionAccountBrokerSupportOperations)['tokenRequest']
  declare private formRequest: (typeof extensionAccountBrokerSupportOperations)['formRequest']
  declare private pruneTransactions: (typeof extensionAccountBrokerSupportOperations)['pruneTransactions']
  declare private assertTransactionCapacity: (typeof extensionAccountBrokerSupportOperations)['assertTransactionCapacity']
  declare private audit: (typeof extensionAccountBrokerSupportOperations)['audit']

  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date
  private readonly pkce = new Map<string, OAuthPkceTransaction>()
  private readonly devices = new Map<string, DeviceTransaction>()
  private readonly refreshes = new Map<string, {
    promise: Promise<ExtensionCredentialPayload>
    controller: AbortController
  }>()
  private readonly accountMutations = new Map<string, Promise<void>>()
  private readonly maxPendingTransactions: number
  private readonly maxGlobalPendingTransactions: number

  constructor(private readonly options: ExtensionAccountBrokerOptions) {
    this.fetchImpl = options.fetch ?? createSafeNetworkFetch()
    this.now = options.now ?? (() => new Date())
    this.maxPendingTransactions = Math.max(1, options.maxPendingTransactions ?? 32)
    this.maxGlobalPendingTransactions = Math.max(64, this.maxPendingTransactions * 16)
  }
}

export interface ExtensionAccountBroker {
  listAccounts(principal: ExtensionPrincipal, providerId?: string): Promise<ExtensionAccountProjection[]>;
  createApiKeyAccount(input: {
    principal: ExtensionPrincipal
    providerId: string
    label: string
    apiKey: string
    protectedInput: boolean
    metadata?: ExtensionAccountRecord['metadata']
  }): Promise<ExtensionAccountProjection>;
  renameAccount(input: {
    principal: ExtensionPrincipal
    accountId: string
    label: string
  }): Promise<ExtensionAccountProjection>;
  replaceApiKeyAccount(input: {
    principal: ExtensionPrincipal
    accountId: string
    apiKey: string
    protectedInput: boolean
  }): Promise<ExtensionAccountProjection>;
  beginPkceAuthorization(input: {
    principal: ExtensionPrincipal
    providerId: string
    label: string
    scopes?: string[]
    headless?: boolean
  }): Promise<{
    status: 'interaction-required'
    transactionId: string
    authorizationUrl: string
    expiresAt: string
  }>;
  completePkceAuthorization(input: {
    principal: ExtensionPrincipal
    transactionId: string
    state: string
    code: string
    protectedCallback: boolean
  }): Promise<ExtensionAccountProjection>;
  beginDeviceAuthorization(input: {
    principal: ExtensionPrincipal
    providerId: string
    label: string
    scopes?: string[]
  }): Promise<{
    status: 'interaction-required'
    transactionId: string
    userCode: string
    verificationUri: string
    expiresAt: string
    intervalMs: number
  }>;
  completeDeviceAuthorization(input: {
    principal: ExtensionPrincipal
    transactionId: string
    signal?: AbortSignal
  }): Promise<ExtensionAccountProjection>;
  cancelAuthorization(principal: ExtensionPrincipal, transactionId: string): boolean;
  authenticatedFetch(input: {
    principal: ExtensionPrincipal
    accountId: string
    url: string
    init?: RequestInit
  }): Promise<Response>;
  revealSecret(input: {
    principal: ExtensionPrincipal
    accountId: string
    nodeHost: boolean
    protectedConsent: boolean
    operation: string
  }): Promise<ExtensionCredentialPayload>;
  deleteAccount(principal: ExtensionPrincipal, accountId: string): Promise<boolean>;
}

installServiceOperations(
  ExtensionAccountBroker.prototype,
  extensionAccountBrokerApiKeyOperations,
  extensionAccountBrokerPkceOperations,
  extensionAccountBrokerDeviceOperations,
  extensionAccountBrokerNetworkOperations,
  extensionAccountBrokerCredentialsOperations,
  extensionAccountBrokerSupportOperations
)


export function injectCredential(
  headers: Headers,
  provider: ExtensionProviderDefinition,
  account: ExtensionAccountRecord,
  credential: ExtensionCredentialPayload
): void {
  if (account.authType === 'api-key') {
    if (!credential.apiKey) throw new Error('API-key credential is unavailable')
    headers.set(provider.apiKey?.headerName ?? 'Authorization', `${provider.apiKey?.prefix ?? 'Bearer '}${credential.apiKey}`)
    return
  }
  if (!credential.accessToken) throw new Error('OAuth access token is unavailable')
  headers.set('Authorization', `${credential.tokenType ?? 'Bearer'} ${credential.accessToken}`)
}

export function credentialFromToken(token: Record<string, unknown>, now: Date): ExtensionCredentialPayload {
  const accessToken = requiredString(token.access_token, 'access_token')
  const expiresIn = boundedPositiveNumber(token.expires_in, 3_600, 365 * 24 * 60 * 60)
  return {
    accessToken,
    ...(typeof token.refresh_token === 'string' ? { refreshToken: token.refresh_token } : {}),
    ...(typeof token.token_type === 'string' ? { tokenType: token.token_type } : { tokenType: 'Bearer' }),
    ...(typeof token.scope === 'string' ? { scope: token.scope } : {}),
    expiresAt: new Date(now.getTime() + expiresIn * 1_000).toISOString()
  }
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 64 * 1024) {
    throw new Error(`provider response is missing or exceeds the limit for ${name}`)
  }
  return value
}

export function boundedPositiveNumber(value: unknown, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, maximum)
    : fallback
}

export async function readBoundedAuthenticationBody(response: Response, maximum: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let retained = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (retained + next.value.byteLength > maximum) {
        await reader.cancel('Provider authentication response exceeded the limit').catch(() => undefined)
        throw new Error('provider authentication response exceeds 1 MiB')
      }
      chunks.push(Buffer.from(next.value))
      retained += next.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, retained).toString('utf8')
}

export function timingSafeTextEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest()
  const rightHash = createHash('sha256').update(right).digest()
  return leftHash.equals(rightHash)
}

export function cancellableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('operation cancelled'))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('operation cancelled'))
    }, { once: true })
  })
}

export function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function hasNetworkPermission(permissions: readonly string[], hostnameInput: string): boolean {
  const hostname = hostnameInput.toLowerCase()
  return permissions.some((permission) => {
    if (!permission.startsWith('network:')) return false
    const pattern = permission.slice('network:'.length).toLowerCase()
    if (!pattern.startsWith('*.')) return hostname === pattern
    const suffix = pattern.slice(1)
    return hostname.endsWith(suffix) && hostname !== pattern.slice(2)
  })
}

export function matchesHostnamePattern(patterns: readonly string[], hostnameInput: string): boolean {
  const hostname = hostnameInput.toLowerCase()
  return patterns.some((value) => {
    const pattern = value.toLowerCase()
    if (!pattern.startsWith('*.')) return hostname === pattern
    const suffix = pattern.slice(1)
    return hostname.endsWith(suffix) && hostname !== pattern.slice(2)
  })
}

export function requestedScopes(declared: readonly string[], requested: readonly string[] | undefined): string[] {
  const effective = [...new Set(requested ?? declared)]
  if (effective.some((scope) => !declared.includes(scope))) {
    throw new Error('requested OAuth scope is not declared by the provider')
  }
  return effective
}

export function redactCredentialResponseHeaders(response: Response, names: readonly string[]): Response {
  const headers = new Headers(response.headers)
  for (const name of names) headers.delete(name)
  const bodyless = response.body === null || [101, 103, 204, 205, 304].includes(response.status)
  return new Response(bodyless ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}
