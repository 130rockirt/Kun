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
import { type ExtensionAccountBroker, type OAuthPkceTransaction, type DeviceTransaction, type ExtensionAccountAuditEvent, type ExtensionAccountBrokerOptions, injectCredential, credentialFromToken, requiredString, boundedPositiveNumber, readBoundedAuthenticationBody, timingSafeTextEqual, cancellableDelay, safeError, hasNetworkPermission, matchesHostnamePattern, requestedScopes, redactCredentialResponseHeaders } from './extension-account-broker-core.js'

export const extensionAccountBrokerSupportOperations = {
async requireUsableAccount(this: ExtensionAccountBroker,
    principal: ExtensionPrincipal,
    accountId: string
  ): Promise<ExtensionAccountRecord> {
    const account = await this['options'].store.getAccount(accountId)
    if (!account || account.ownerExtensionId !== principal.extensionId) throw new Error('account not found')
    if (account.status !== 'connected') throw new Error(`account is ${account.status}`)
    return account
  },

async requireProviderPermission(this: ExtensionAccountBroker,
    principal: ExtensionPrincipal,
    providerId: string,
    operation: 'use' | 'manage'
  ): Promise<ExtensionProviderDefinition> {
    const permission = `accounts.${operation}:${providerId}`
    if (!principal.permissions.includes(permission)) throw new Error(`Missing permission: ${permission}`)
    return this['options'].store.requireOwnedProvider(principal, providerId)
  },

requireManage(this: ExtensionAccountBroker, principal: ExtensionPrincipal, providerId: string): void {
    const permission = `accounts.manage:${providerId}`
    if (!principal.permissions.includes(permission)) throw new Error(`Missing permission: ${permission}`)
  },

serializeAccountMutation<T>(this: ExtensionAccountBroker, accountId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this['accountMutations'].get(accountId) ?? Promise.resolve()
    const run = previous.then(operation, operation)
    const settled = run.then(() => undefined, () => undefined)
    this['accountMutations'].set(accountId, settled)
    void settled.finally(() => {
      if (this['accountMutations'].get(accountId) === settled) this['accountMutations'].delete(accountId)
    })
    return run
  },

async tokenRequest(this: ExtensionAccountBroker,
    url: string,
    fields: Record<string, string>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const response = await this['formRequest'](url, fields, true, signal)
    if (typeof response.error === 'string') throw new Error(`OAuth token exchange failed: ${response.error}`)
    requiredString(response.access_token, 'access_token')
    return response
  },

async formRequest(this: ExtensionAccountBroker,
    url: string,
    fields: Record<string, string>,
    allowErrorBody = false,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(30_000)
    const response = await this['fetchImpl'](url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields),
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
    const text = await readBoundedAuthenticationBody(response, 1024 * 1024)
    let parsed: unknown = {}
    try {
      parsed = text ? JSON.parse(text) : {}
    } catch {
      parsed = {}
    }
    const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
    if (!response.ok && !(allowErrorBody && typeof body.error === 'string')) {
      throw new Error(`provider authentication request failed (${response.status})`)
    }
    return body
  },

pruneTransactions(this: ExtensionAccountBroker): void {
    const now = this['now']().getTime()
    for (const [id, transaction] of this['pkce']) if (transaction.expiresAt <= now) this['pkce'].delete(id)
    for (const [id, transaction] of this['devices']) if (transaction.expiresAt <= now) this['devices'].delete(id)
  },

assertTransactionCapacity(this: ExtensionAccountBroker, extensionId: string): void {
    const all = [...this['pkce'].values(), ...this['devices'].values()]
    if (all.length >= this['maxGlobalPendingTransactions']) {
      throw new Error('global account authorization transaction limit reached')
    }
    if (all.filter((transaction) => transaction.extensionId === extensionId).length >= this['maxPendingTransactions']) {
      throw new Error('account authorization transaction limit reached')
    }
  },

async audit(this: ExtensionAccountBroker,
    principal: ExtensionPrincipal,
    operation: string,
    outcome: ExtensionAccountAuditEvent['outcome'],
    input: { providerId?: string; accountId?: string; details?: Record<string, unknown> }
  ): Promise<void> {
    await this['options'].audit?.({
      timestamp: this['now']().toISOString(),
      extensionId: principal.extensionId,
      operation,
      outcome,
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.details ? { details: redactExtensionSecrets(input.details) as Record<string, unknown> } : {})
    })
  },
}
