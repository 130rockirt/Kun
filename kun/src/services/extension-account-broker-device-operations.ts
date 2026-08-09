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

export const extensionAccountBrokerDeviceOperations = {
async beginDeviceAuthorization(this: ExtensionAccountBroker, input: {
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
  }> {
    this['requireManage'](input.principal, input.providerId)
    this['pruneTransactions']()
    this['assertTransactionCapacity'](input.principal.extensionId)
    const provider = await this['options'].store.requireOwnedProvider(input.principal, input.providerId)
    const config = provider.oauthDevice
    if (!config) throw new Error('provider does not support OAuth device authorization')
    const scopes = requestedScopes(config.scopes, input.scopes)
    const response = await this['formRequest'](config.deviceAuthorizationUrl, {
      client_id: config.clientId,
      ...(scopes.length ? { scope: scopes.join(' ') } : {})
    })
    const deviceCode = requiredString(response.device_code, 'device_code')
    const userCode = requiredString(response.user_code, 'user_code')
    const verificationUri = requiredString(
      response.verification_uri ?? response.verification_url,
      'verification_uri'
    )
    if (userCode.length > 128) throw new Error('provider user_code exceeds 128 characters')
    if (verificationUri.length > 4_096) throw new Error('provider verification_uri exceeds 4096 characters')
    assertBrokeredNetworkUrl(new URL(verificationUri))
    const expiresIn = boundedPositiveNumber(response.expires_in, 600, 86_400)
    const intervalMs = Math.max(
      1_000,
      boundedPositiveNumber(response.interval, 5, 60) * 1_000
    )
    const id = `device_${randomUUID()}`
    const expiresAt = this['now']().getTime() + expiresIn * 1_000
    this['devices'].set(id, {
      id,
      extensionId: input.principal.extensionId,
      providerId: provider.id,
      label: input.label,
      deviceCode,
      userCode,
      verificationUri,
      intervalMs,
      expiresAt,
      cancelled: false
    })
    await this['audit'](input.principal, 'account.oauth.device.begin', 'allowed', {
      providerId: provider.id,
      details: { scopes }
    })
    return {
      status: 'interaction-required', transactionId: id, userCode, verificationUri,
      expiresAt: new Date(expiresAt).toISOString(), intervalMs
    }
  },

async completeDeviceAuthorization(this: ExtensionAccountBroker, input: {
    principal: ExtensionPrincipal
    transactionId: string
    signal?: AbortSignal
  }): Promise<ExtensionAccountProjection> {
    const transaction = this['devices'].get(input.transactionId)
    if (!transaction || transaction.extensionId !== input.principal.extensionId) throw new Error('device transaction not found')
    const provider = await this['options'].store.requireOwnedProvider(input.principal, transaction.providerId)
    const config = provider.oauthDevice!
    let interval = transaction.intervalMs
    while (!transaction.cancelled && this['now']().getTime() < transaction.expiresAt) {
      if (input.signal?.aborted) throw new Error('device authorization cancelled')
      const response = await this['formRequest'](config.tokenUrl, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: transaction.deviceCode,
        client_id: config.clientId
      }, true, input.signal)
      if (typeof response.access_token === 'string') {
        if (transaction.cancelled || this['devices'].get(transaction.id) !== transaction) {
          throw new Error('device authorization cancelled')
        }
        // As with PKCE, cancellation stops being accepted before the secure
        // credential/account commit begins.
        this['devices'].delete(transaction.id)
        const account = await this['persistOAuthAccount'](
          input.principal,
          provider,
          transaction.label,
          'oauth-device',
          response
        )
        await this['audit'](input.principal, 'account.oauth.device.complete', 'allowed', {
          providerId: provider.id,
          accountId: account.id
        })
        return account
      }
      const error = typeof response.error === 'string' ? response.error : 'authorization_pending'
      if (error === 'slow_down') interval += 5_000
      else if (error !== 'authorization_pending') throw new Error(`device authorization failed: ${error}`)
      await cancellableDelay(interval, input.signal)
    }
    this['devices'].delete(transaction.id)
    await this['audit'](input.principal, 'account.oauth.device.complete', 'failed', {
      providerId: transaction.providerId,
      details: { reason: transaction.cancelled ? 'cancelled' : 'expired' }
    })
    throw new Error(transaction.cancelled ? 'device authorization cancelled' : 'device authorization expired')
  },

cancelAuthorization(this: ExtensionAccountBroker, principal: ExtensionPrincipal, transactionId: string): boolean {
    const pkce = this['pkce'].get(transactionId)
    if (pkce?.extensionId === principal.extensionId && !pkce.consumed) {
      pkce.cancelled = true
      this['pkce'].delete(transactionId)
      void this['audit'](principal, 'account.authorization.cancel', 'allowed', {
        providerId: pkce.providerId,
        details: { type: 'oauth-pkce' }
      })
      return true
    }
    const device = this['devices'].get(transactionId)
    if (device?.extensionId === principal.extensionId) {
      device.cancelled = true
      this['devices'].delete(transactionId)
      void this['audit'](principal, 'account.authorization.cancel', 'allowed', {
        providerId: device.providerId,
        details: { type: 'oauth-device' }
      })
      return true
    }
    return false
  },
}
