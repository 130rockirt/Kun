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

export const extensionAccountBrokerPkceOperations = {
async beginPkceAuthorization(this: ExtensionAccountBroker, input: {
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
  }> {
    this['requireManage'](input.principal, input.providerId)
    this['pruneTransactions']()
    this['assertTransactionCapacity'](input.principal.extensionId)
    const provider = await this['options'].store.requireOwnedProvider(input.principal, input.providerId)
    const config = provider.oauthPkce
    if (!config) throw new Error('provider does not support OAuth PKCE')
    const scopes = requestedScopes(config.scopes, input.scopes)
    const id = `oauth_${randomUUID()}`
    const state = randomBytes(24).toString('base64url')
    const verifier = randomBytes(48).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const expiresAt = this['now']().getTime() + 10 * 60_000
    this['pkce'].set(id, {
      id,
      extensionId: input.principal.extensionId,
      providerId: provider.id,
      label: input.label,
      state,
      verifier,
      expiresAt,
      consumed: false,
      cancelled: false
    })
    const url = new URL(config.authorizationUrl)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', config.clientId)
    url.searchParams.set('redirect_uri', config.redirectUri)
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    if (scopes.length) url.searchParams.set('scope', scopes.join(' '))
    for (const [key, value] of Object.entries(config.extraAuthorizationParams ?? {})) url.searchParams.set(key, value)
    await this['audit'](input.principal, 'account.oauth.pkce.begin', 'allowed', {
      providerId: provider.id,
      details: { scopes }
    })
    void input.headless
    return {
      status: 'interaction-required',
      transactionId: id,
      authorizationUrl: url.toString(),
      expiresAt: new Date(expiresAt).toISOString()
    }
  },

async completePkceAuthorization(this: ExtensionAccountBroker, input: {
    principal: ExtensionPrincipal
    transactionId: string
    state: string
    code: string
    protectedCallback: boolean
  }): Promise<ExtensionAccountProjection> {
    if (!input.protectedCallback) throw new Error('OAuth callback must use the protected core boundary')
    const transaction = this['pkce'].get(input.transactionId)
    if (
      !transaction ||
      transaction.consumed ||
      transaction.cancelled ||
      transaction.expiresAt <= this['now']().getTime()
    ) {
      await this['audit'](input.principal, 'account.oauth.callback', 'denied', {
        details: { reason: 'missing_expired_or_replayed' }
      })
      throw new Error('OAuth transaction is missing, expired, or already consumed')
    }
    if (transaction.extensionId !== input.principal.extensionId || !timingSafeTextEqual(transaction.state, input.state)) {
      await this['audit'](input.principal, 'account.oauth.callback', 'denied', {
        providerId: transaction.providerId, details: { reason: 'state_mismatch' }
      })
      throw new Error('OAuth callback state is invalid')
    }
    transaction.consumed = true
    try {
      const provider = await this['options'].store.requireOwnedProvider(
        input.principal,
        transaction.providerId
      )
      const config = provider.oauthPkce!
      const token = await this['tokenRequest'](config.tokenUrl, {
        grant_type: 'authorization_code',
        code: input.code,
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        code_verifier: transaction.verifier
      })
      if (transaction.cancelled || this['pkce'].get(transaction.id) !== transaction) {
        throw new Error('OAuth authorization cancelled')
      }
      // Cancellation is no longer accepted once persistence begins. This
      // prevents the UI from reporting cancelled while an account commits.
      this['pkce'].delete(transaction.id)
      const account = await this['persistOAuthAccount'](
        input.principal,
        provider,
        transaction.label,
        'oauth-pkce',
        token
      )
      await this['audit'](input.principal, 'account.oauth.callback', 'allowed', {
        providerId: provider.id,
        accountId: account.id
      })
      return account
    } catch (error) {
      await this['audit'](input.principal, 'account.oauth.callback', 'failed', {
        providerId: transaction.providerId,
        details: { error: safeError(error) }
      })
      throw error
    } finally {
      if (this['pkce'].get(transaction.id) === transaction) this['pkce'].delete(transaction.id)
    }
  },
}
