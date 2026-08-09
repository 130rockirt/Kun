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

export const extensionAccountBrokerNetworkOperations = {
async authenticatedFetch(this: ExtensionAccountBroker, input: {
    principal: ExtensionPrincipal
    accountId: string
    url: string
    init?: RequestInit
  }): Promise<Response> {
    const account = await this['requireUsableAccount'](input.principal, input.accountId)
    const provider = await this['requireProviderPermission'](input.principal, account.providerId, 'use')
    const url = new URL(input.url)
    assertBrokeredNetworkUrl(url)
    const hostname = normalizedBrokerHostname(url)
    if (!hasNetworkPermission(input.principal.permissions, hostname)) {
      throw new Error(`Missing permission: network:${hostname}`)
    }
    if (!matchesHostnamePattern(provider.credentialHosts, hostname)) {
      throw new Error(`Provider credentials are not allowed for host: ${hostname}`)
    }
    const credential = await this['resolveCredential'](account, provider)
    const headers = new Headers(input.init?.headers)
    if (headers.has('authorization') || provider.apiKey && headers.has(provider.apiKey.headerName)) {
      throw new Error('authenticated fetch cannot override broker-managed credentials')
    }
    injectCredential(headers, provider, account, credential)
    try {
      // Never automatically forward a broker-injected credential across an
      // upstream redirect. The extension may inspect Location and make a new
      // brokered request, which re-runs both network and credential-host gates.
      const response = await this['fetchImpl'](url, { ...input.init, headers, redirect: 'manual' })
      return redactCredentialResponseHeaders(response, [
        'authorization',
        'proxy-authorization',
        'cookie',
        'set-cookie',
        ...(provider.apiKey ? [provider.apiKey.headerName] : [])
      ])
    } finally {
      headers.delete('authorization')
      if (provider.apiKey) headers.delete(provider.apiKey.headerName)
    }
  },

async revealSecret(this: ExtensionAccountBroker, input: {
    principal: ExtensionPrincipal
    accountId: string
    nodeHost: boolean
    protectedConsent: boolean
    operation: string
  }): Promise<ExtensionCredentialPayload> {
    const account = await this['requireUsableAccount'](input.principal, input.accountId)
    const permission = `accounts.secrets.read:${account.providerId}`
    if (!input.nodeHost || !input.protectedConsent || !input.principal.permissions.includes(permission)) {
      await this['audit'](input.principal, 'account.secret.reveal', 'denied', {
        providerId: account.providerId, accountId: account.id, details: { operation: input.operation }
      })
      throw new Error('raw secret access requires Node host permission and protected consent')
    }
    const secret = await this['options'].credentials.get(account.credentialRef)
    if (!secret) throw new Error('account credential is unavailable')
    await this['audit'](input.principal, 'account.secret.reveal', 'allowed', {
      providerId: account.providerId, accountId: account.id, details: { operation: input.operation }
    })
    return { ...secret }
  },

async deleteAccount(this: ExtensionAccountBroker, principal: ExtensionPrincipal, accountId: string): Promise<boolean> {
    return this['serializeAccountMutation'](accountId, async () => {
      const existing = await this['options'].store.getAccount(accountId)
      if (!existing || existing.ownerExtensionId !== principal.extensionId) return false
      this['requireManage'](principal, existing.providerId)
      // Tombstone first so no new request can start while an in-flight refresh
      // is being cancelled. Keep the credential reference until secure deletion
      // succeeds so a failed cleanup remains retryable.
      await this['options'].store.updateAccount(accountId, { status: 'unavailable' })
      const refresh = this['refreshes'].get(accountId)
      if (refresh) {
        refresh.controller.abort(new Error('account deleted'))
        await refresh.promise.catch(() => undefined)
      }
      await this['options'].credentials.delete(existing.credentialRef)
      const removed = await this['options'].store.deleteAccount(principal, accountId)
      if (!removed) return false
      await this['audit'](principal, 'account.delete', 'allowed', {
        providerId: existing.providerId,
        accountId
      })
      return true
    })
  },
}
