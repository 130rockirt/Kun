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

export const extensionAccountBrokerCredentialsOperations = {
async persistOAuthAccount(this: ExtensionAccountBroker,
    principal: ExtensionPrincipal,
    provider: ExtensionProviderDefinition,
    label: string,
    authType: 'oauth-pkce' | 'oauth-device',
    token: Record<string, unknown>
  ): Promise<ExtensionAccountProjection> {
    const credential = credentialFromToken(token, this['now']())
    let credentialRef: string | undefined
    try {
      credentialRef = await this['options'].credentials.create(credential)
      return await this['options'].store.createAccount({
        principal,
        providerId: provider.id,
        label,
        authType,
        credentialRef,
        ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {})
      })
    } catch (error) {
      if (credentialRef) await this['options'].credentials.delete(credentialRef).catch(() => undefined)
      throw error
    }
  },

async resolveCredential(this: ExtensionAccountBroker,
    account: ExtensionAccountRecord,
    provider: ExtensionProviderDefinition
  ): Promise<ExtensionCredentialPayload> {
    const credential = await this['options'].credentials.get(account.credentialRef)
    if (!credential) throw new Error('account credential is unavailable')
    if (!credential.expiresAt || Date.parse(credential.expiresAt) > this['now']().getTime() + 60_000) return credential
    if (!credential.refreshToken) {
      await this['options'].store.updateAccount(account.id, { status: 'interaction-required' })
      throw new Error('account interaction is required')
    }
    const pending = this['refreshes'].get(account.id)
    if (pending) return pending.promise
    const controller = new AbortController()
    const promise = this['refreshCredential'](account, provider, credential, controller.signal)
    const refresh = { promise, controller }
    this['refreshes'].set(account.id, refresh)
    try {
      return await promise
    } finally {
      if (this['refreshes'].get(account.id) === refresh) this['refreshes'].delete(account.id)
    }
  },

async refreshCredential(this: ExtensionAccountBroker,
    account: ExtensionAccountRecord,
    provider: ExtensionProviderDefinition,
    current: ExtensionCredentialPayload,
    signal: AbortSignal
  ): Promise<ExtensionCredentialPayload> {
    const config = account.authType === 'oauth-pkce' ? provider.oauthPkce : provider.oauthDevice
    if (!config) throw new Error('provider refresh configuration is unavailable')
    try {
      const token = await this['tokenRequest'](config.tokenUrl, {
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken!,
        client_id: config.clientId
      }, signal)
      const next = credentialFromToken({ ...token, refresh_token: token.refresh_token ?? current.refreshToken }, this['now']())
      const latest = await this['options'].store.getAccount(account.id)
      if (
        signal.aborted ||
        !latest ||
        latest.status !== 'connected' ||
        latest.credentialRef !== account.credentialRef
      ) throw new Error('account changed while credentials were refreshing')
      await this['options'].credentials.set(account.credentialRef, next)
      const updated = await this['options'].store.updateAccountIfCurrent(account.id, {
        status: 'connected',
        credentialRef: account.credentialRef
      }, {
        status: 'connected',
        ...(next.expiresAt ? { expiresAt: next.expiresAt } : {})
      })
      if (!updated || signal.aborted) {
        throw new Error('account changed while credentials were refreshing')
      }
      return next
    } catch (error) {
      if (!signal.aborted) {
        await this['options'].store.updateAccountIfCurrent(account.id, {
          status: 'connected',
          credentialRef: account.credentialRef
        }, { status: 'interaction-required' })
      }
      throw error
    }
  },
}
