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

export const extensionAccountBrokerApiKeyOperations = {
async listAccounts(this: ExtensionAccountBroker, principal: ExtensionPrincipal, providerId?: string): Promise<ExtensionAccountProjection[]> {
    return this['options'].store.listAccounts(principal, providerId)
  },

async createApiKeyAccount(this: ExtensionAccountBroker, input: {
    principal: ExtensionPrincipal
    providerId: string
    label: string
    apiKey: string
    protectedInput: boolean
    metadata?: ExtensionAccountRecord['metadata']
  }): Promise<ExtensionAccountProjection> {
    this['requireManage'](input.principal, input.providerId)
    if (!input.protectedInput) throw new Error('API keys must be entered through a protected core surface')
    const provider = await this['options'].store.requireOwnedProvider(input.principal, input.providerId)
    if (!provider.authTypes.includes('api-key')) throw new Error('provider does not support API-key accounts')
    const apiKey = input.apiKey.trim()
    if (!apiKey) throw new Error('API key is required')
    let credentialRef: string | undefined
    try {
      credentialRef = await this['options'].credentials.create({ apiKey })
      const account = await this['options'].store.createAccount({
        principal: input.principal,
        providerId: provider.id,
        label: input.label,
        authType: 'api-key',
        credentialRef,
        metadata: input.metadata
      })
      await this['audit'](input.principal, 'account.create.api-key', 'allowed', {
        providerId: provider.id, accountId: account.id
      })
      return account
    } catch (error) {
      if (credentialRef) await this['options'].credentials.delete(credentialRef).catch(() => undefined)
      await this['audit'](input.principal, 'account.create.api-key', 'failed', {
        providerId: provider.id, details: { error: safeError(error) }
      })
      throw error
    }
  },

async renameAccount(this: ExtensionAccountBroker, input: {
    principal: ExtensionPrincipal
    accountId: string
    label: string
  }): Promise<ExtensionAccountProjection> {
    return this['serializeAccountMutation'](input.accountId, async () => {
      const existing = await this['options'].store.getAccount(input.accountId)
      if (!existing || existing.ownerExtensionId !== input.principal.extensionId) {
        throw new Error('account not found')
      }
      this['requireManage'](input.principal, existing.providerId)
      const label = input.label.trim()
      if (!label || label.length > 128) throw new Error('account label must contain 1 to 128 characters')
      const updated = await this['options'].store.updateAccount(existing.id, { label })
      await this['audit'](input.principal, 'account.rename', 'allowed', {
        providerId: existing.providerId,
        accountId: existing.id
      })
      return projectExtensionAccount(updated)
    })
  },

async replaceApiKeyAccount(this: ExtensionAccountBroker, input: {
    principal: ExtensionPrincipal
    accountId: string
    apiKey: string
    protectedInput: boolean
  }): Promise<ExtensionAccountProjection> {
    return this['serializeAccountMutation'](input.accountId, async () => {
      const existing = await this['options'].store.getAccount(input.accountId)
      if (!existing || existing.ownerExtensionId !== input.principal.extensionId) {
        throw new Error('account not found')
      }
      this['requireManage'](input.principal, existing.providerId)
      if (!input.protectedInput) throw new Error('API keys must be entered through a protected core surface')
      if (existing.authType !== 'api-key') throw new Error('only API-key accounts can replace an API key')
      const provider = await this['options'].store.requireOwnedProvider(input.principal, existing.providerId)
      if (!provider.authTypes.includes('api-key')) throw new Error('provider does not support API-key accounts')
      const apiKey = input.apiKey.trim()
      if (!apiKey) throw new Error('API key is required')

      try {
        // The credential store atomically replaces the encrypted value behind
        // the existing opaque reference. This keeps the account/binding ID
        // stable and leaves no second credential reference to orphan.
        await this['options'].credentials.set(existing.credentialRef, { apiKey })
        const updated = await this['options'].store.updateAccountIfCurrent(existing.id, {
          status: existing.status,
          credentialRef: existing.credentialRef
        }, {
          status: 'connected',
          expiresAt: undefined
        })
        if (!updated) throw new Error('account changed while the API key was being replaced')
        await this['audit'](input.principal, 'account.replace.api-key', 'allowed', {
          providerId: existing.providerId,
          accountId: existing.id
        })
        return projectExtensionAccount(updated)
      } catch (error) {
        await this['audit'](input.principal, 'account.replace.api-key', 'failed', {
          providerId: existing.providerId,
          accountId: existing.id,
          details: { error: safeError(error) }
        })
        throw error
      }
    })
  },
}
