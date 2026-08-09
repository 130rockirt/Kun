import {
  ipcMain
} from 'electron'
import {
  createHash
} from 'node:crypto'
import {
  join
} from 'node:path'
import {
  extensionAccountSessionRequestSchema,
  extensionCompleteAccountSessionRequestSchema,
  extensionCreateAccountSessionRequestSchema,
  extensionCreateApiKeyAccountRequestSchema,
  extensionDeleteAccountRequestSchema,
  extensionListAccountsRequestSchema,
  extensionRenameAccountRequestSchema,
  extensionReplaceApiKeyAccountRequestSchema,
  extensionSetProviderBindingRequestSchema
} from './app-ipc-schemas/extensions'
import type { RegisterExtensionIpcHandlersOptions } from './extension-ipc-handler-options'
import {
  assertTrustedWorkbenchSender,
  parsePayload,
  performProtectedRuntimeOperation,
  runtimeFailure,
  runtimeResultError
} from './extension-ipc-common'
import {
  presentProtectedAccountAuthorization,
  redactAccountSessionInteraction
} from './extension-ipc-account-utils'

export function registerExtensionAccountIpcHandlers(options: RegisterExtensionIpcHandlersOptions): void {
  ipcMain.handle('extension:accounts:list', async (event, payload: unknown) => {
    assertTrustedWorkbenchSender(event, options.getMainWindow)
    const request = parsePayload(
      'extension:accounts:list',
      extensionListAccountsRequestSchema,
      payload
    )
    const query = new URLSearchParams({ extension_id: request.extensionId })
    if (request.providerId) query.set('provider_id', request.providerId)
    if (request.includeUnavailable !== undefined) {
      query.set('include_unavailable', String(request.includeUnavailable))
    }
    return options.runtimeRequest(`/v1/extensions/accounts?${query}`, 'GET')
  })

  ipcMain.handle('extension:accounts:create-session', async (event, payload: unknown) => {
    assertTrustedWorkbenchSender(event, options.getMainWindow)
    const request = parsePayload(
      'extension:accounts:create-session',
      extensionCreateAccountSessionRequestSchema,
      payload
    )
    const extension = await options.descriptors.resolvePackage(
      request.extensionId,
      request.workspaceRoot
    )
    if (extension.extensionVersion !== request.extensionVersion) {
      return runtimeFailure(
        'EXTENSION_VERSION_CONFLICT',
        'Extension version changed; repeat the protected action.',
        409
      )
    }
    const provider = extension.manifest.contributes.modelProviders.find(
      (candidate) => candidate.id === request.providerId
    )
    const authentication = extension.manifest.contributes.authentication.find(
      (candidate) => candidate.id === request.authenticationProviderId
    )
    if (
      !provider ||
      !authentication ||
      provider.authenticationProviderId !== authentication.id
    ) {
      return runtimeFailure(
        'EXTENSION_AUTHENTICATION_MISMATCH',
        'Authentication contribution does not match the selected provider.',
        400
      )
    }
    const declaredScopes = authentication.scopes ?? []
    const effectiveScopes = [...new Set(request.scopes ?? declaredScopes)]
    if (effectiveScopes.some((scope) => !declaredScopes.includes(scope))) {
      return runtimeFailure(
        'EXTENSION_AUTHENTICATION_SCOPE_INVALID',
        'Requested authentication scope is not declared by the provider.',
        400
      )
    }
    const normalizedRequest = { ...request, scopes: effectiveScopes }
    const result = await performProtectedRuntimeOperation(options, event, {
      extensionId: request.extensionId,
      extensionVersion: extension.extensionVersion,
      operationKind: 'account.create-session',
      parameters: normalizedRequest,
      workspaceRoot: request.workspaceRoot,
      senderId: event.sender.id
    }, undefined, {
      title: 'Connect provider account',
      message: `Start account authorization for ${request.providerId}?`,
      detail: [
        `Kun will activate ${request.extensionId} for the declared authentication flow. Extension Webviews cannot approve this action.`,
        effectiveScopes.length ? `OAuth scopes: ${effectiveScopes.join(', ')}` : undefined
      ].filter(Boolean).join('\n\n')
    }, () => options.runtimeRequest(
      '/v1/extensions/accounts/sessions',
      'POST',
      JSON.stringify(normalizedRequest)
    ))
    return presentProtectedAccountAuthorization(
      options,
      result,
      request.extensionId,
      request.providerId
    )
  })

  ipcMain.handle('extension:accounts:get-session', async (event, payload: unknown) => {
    assertTrustedWorkbenchSender(event, options.getMainWindow)
    const request = parsePayload(
      'extension:accounts:get-session',
      extensionAccountSessionRequestSchema,
      payload
    )
    const result = await options.runtimeRequest(
      `/v1/extensions/accounts/sessions/${encodeURIComponent(request.sessionId)}?extension_id=${encodeURIComponent(request.extensionId)}`,
      'GET'
    )
    return redactAccountSessionInteraction(result)
  })

  ipcMain.handle('extension:accounts:complete-session', async (event, payload: unknown) => {
    assertTrustedWorkbenchSender(event, options.getMainWindow)
    const request = parsePayload(
      'extension:accounts:complete-session',
      extensionCompleteAccountSessionRequestSchema,
      payload
    )
    const extension = await options.descriptors.resolvePackage(
      request.extensionId,
      request.workspaceRoot
    )
    if (extension.extensionVersion !== request.extensionVersion) {
      return runtimeFailure(
        'EXTENSION_VERSION_CONFLICT',
        'Extension version changed; repeat the protected action.',
        409
      )
    }
    const callback = await options.credentialSurface.prompt(options.getMainWindow(), {
      title: 'Complete provider authorization',
      message: 'Paste the final OAuth callback URL from your browser.',
      detail: `Kun will validate the authorization state and connect it to ${request.extensionId}. The callback URL is never exposed to extension code or Webviews.`,
      label: 'OAuth callback URL',
      placeholder: 'https://callback.example/?code=...&state=...',
      submitLabel: 'Complete authorization'
    })
    if (!callback.submitted) {
      return runtimeFailure('EXTENSION_CONSENT_DENIED', 'Account authorization was cancelled.', 403)
    }
    const parameters = {
      ...request,
      callbackDigest: createHash('sha256').update(callback.value).digest('hex')
    }
    return options.protectedActions.performAfterProtectedDecision({
      extensionId: request.extensionId,
      extensionVersion: extension.extensionVersion,
      operationKind: 'account.complete-session',
      parameters,
      workspaceRoot: request.workspaceRoot,
      senderId: event.sender.id
    }, callback.protectedWindowSessionId, () => options.runtimeRequest(
      `/v1/extensions/accounts/sessions/${encodeURIComponent(request.sessionId)}/complete`,
      'POST',
      JSON.stringify({
        extensionId: request.extensionId,
        extensionVersion: request.extensionVersion,
        callbackUrl: callback.value,
        ...(request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {})
      })
    ))
  })

  ipcMain.handle('extension:accounts:cancel-session', async (event, payload: unknown) => {
    assertTrustedWorkbenchSender(event, options.getMainWindow)
    const request = parsePayload(
      'extension:accounts:cancel-session',
      extensionAccountSessionRequestSchema,
      payload
    )
    return options.runtimeRequest(
      `/v1/extensions/accounts/sessions/${encodeURIComponent(request.sessionId)}/cancel`,
      'POST',
      JSON.stringify({ extensionId: request.extensionId })
    )
  })

  ipcMain.handle('extension:accounts:delete', async (event, payload: unknown) => {
    assertTrustedWorkbenchSender(event, options.getMainWindow)
    const request = parsePayload(
      'extension:accounts:delete',
      extensionDeleteAccountRequestSchema,
      payload
    )
    const { consentRequestId, ...body } = request
    const extension = await options.descriptors.resolvePackage(
      request.extensionId,
      request.workspaceRoot
    )
    if (extension.extensionVersion !== request.extensionVersion) {
      return runtimeFailure(
        'EXTENSION_VERSION_CONFLICT',
        'Extension version changed; repeat the protected action.',
        409
      )
    }
    return performProtectedRuntimeOperation(options, event, {
      extensionId: request.extensionId,
      extensionVersion: request.extensionVersion,
      operationKind: 'account.delete',
      parameters: body,
      workspaceRoot: request.workspaceRoot,
      senderId: event.sender.id
    }, consentRequestId, {
      title: 'Delete provider account',
      message: `Delete the selected ${request.providerId} account?`,
      detail: 'Stored credentials will be deleted and dependent provider bindings will require another account.'
    }, () => options.runtimeRequest(
      `/v1/extensions/accounts/${encodeURIComponent(request.accountId)}`,
      'DELETE',
      JSON.stringify({
        extensionId: request.extensionId,
        extensionVersion: request.extensionVersion,
        providerId: request.providerId,
        ...(request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {})
      })
    ))
  })

  ipcMain.handle('extension:accounts:create-api-key', async (event, payload: unknown) => {
    assertTrustedWorkbenchSender(event, options.getMainWindow)
    const request = parsePayload(
      'extension:accounts:create-api-key',
      extensionCreateApiKeyAccountRequestSchema,
      payload
    )
    const extension = await options.descriptors.resolvePackage(
      request.extensionId,
      request.workspaceRoot
    )
    if (extension.extensionVersion !== request.extensionVersion) {
      return runtimeFailure(
        'EXTENSION_VERSION_CONFLICT',
        'Extension version changed; repeat the protected action.',
        409
      )
    }
    const credential = await options.credentialSurface.prompt(options.getMainWindow(), {
      title: 'Add provider account',
      message: `Enter an API key for ${request.providerId}.`,
      detail: `The key will be stored by Kun and associated with ${request.extensionId}. Extension Webviews never receive it.`,
      label: 'API key',
      placeholder: 'Paste API key',
      submitLabel: 'Save account'
    })
    if (!credential.submitted) {
      return runtimeFailure('EXTENSION_CONSENT_DENIED', 'Account creation was cancelled.', 403)
    }
    const parameters = {
      ...request,
      secretDigest: createHash('sha256').update(credential.value).digest('hex')
    }
    return options.protectedActions.performAfterProtectedDecision({
      extensionId: request.extensionId,
      extensionVersion: request.extensionVersion,
      operationKind: 'account.create-api-key',
      parameters,
      workspaceRoot: request.workspaceRoot,
      senderId: event.sender.id
    }, credential.protectedWindowSessionId, () => options.runtimeRequest(
      '/v1/extensions/accounts/api-key',
      'POST',
      JSON.stringify({ ...request, secret: credential.value })
    ))
  })

  ipcMain.handle('extension:accounts:rename', async (event, payload: unknown) => {
    assertTrustedWorkbenchSender(event, options.getMainWindow)
    const request = parsePayload(
      'extension:accounts:rename',
      extensionRenameAccountRequestSchema,
      payload
    )
    const extension = await options.descriptors.resolvePackage(
      request.extensionId,
      request.workspaceRoot
    )
    if (extension.extensionVersion !== request.extensionVersion) {
      return runtimeFailure(
        'EXTENSION_VERSION_CONFLICT',
        'Extension version changed; repeat the protected action.',
        409
      )
    }
    const label = await options.credentialSurface.prompt(options.getMainWindow(), {
      title: 'Rename provider account',
      message: `Choose a new label for the selected ${request.providerId} account.`,
      detail: 'The stable account reference and existing provider bindings will not change.',
      label: 'Account label',
      placeholder: 'Account label',
      submitLabel: 'Rename account',
      secret: false
    })
    if (!label.submitted) {
      return runtimeFailure('EXTENSION_CONSENT_DENIED', 'Account rename was cancelled.', 403)
    }
    const parameters = { ...request, label: label.value }
    return options.protectedActions.performAfterProtectedDecision({
      extensionId: request.extensionId,
      extensionVersion: request.extensionVersion,
      operationKind: 'account.rename',
      parameters,
      workspaceRoot: request.workspaceRoot,
      senderId: event.sender.id
    }, label.protectedWindowSessionId, () => options.runtimeRequest(
      `/v1/extensions/accounts/${encodeURIComponent(request.accountId)}/label`,
      'PATCH',
      JSON.stringify({ ...request, label: label.value })
    ))
  })

  ipcMain.handle('extension:accounts:replace-api-key', async (event, payload: unknown) => {
    assertTrustedWorkbenchSender(event, options.getMainWindow)
    const request = parsePayload(
      'extension:accounts:replace-api-key',
      extensionReplaceApiKeyAccountRequestSchema,
      payload
    )
    const extension = await options.descriptors.resolvePackage(
      request.extensionId,
      request.workspaceRoot
    )
    if (extension.extensionVersion !== request.extensionVersion) {
      return runtimeFailure(
        'EXTENSION_VERSION_CONFLICT',
        'Extension version changed; repeat the protected action.',
        409
      )
    }
    const credential = await options.credentialSurface.prompt(options.getMainWindow(), {
      title: 'Replace provider API key',
      message: `Enter the replacement API key for the selected ${request.providerId} account.`,
      detail: 'Kun replaces the protected credential atomically. The account reference and existing provider bindings stay unchanged.',
      label: 'Replacement API key',
      placeholder: 'Paste replacement API key',
      submitLabel: 'Replace API key'
    })
    if (!credential.submitted) {
      return runtimeFailure('EXTENSION_CONSENT_DENIED', 'API-key replacement was cancelled.', 403)
    }
    const parameters = {
      ...request,
      secretDigest: createHash('sha256').update(credential.value).digest('hex')
    }
    return options.protectedActions.performAfterProtectedDecision({
      extensionId: request.extensionId,
      extensionVersion: request.extensionVersion,
      operationKind: 'account.replace-api-key',
      parameters,
      workspaceRoot: request.workspaceRoot,
      senderId: event.sender.id
    }, credential.protectedWindowSessionId, () => options.runtimeRequest(
      `/v1/extensions/accounts/${encodeURIComponent(request.accountId)}/api-key`,
      'PUT',
      JSON.stringify({ ...request, secret: credential.value })
    ))
  })

  ipcMain.handle('extension:providers:set-binding', async (event, payload: unknown) => {
    assertTrustedWorkbenchSender(event, options.getMainWindow)
    const request = parsePayload(
      'extension:providers:set-binding',
      extensionSetProviderBindingRequestSchema,
      payload
    )
    const extension = await options.descriptors.resolvePackage(
      request.extensionId,
      request.workspaceRoot
    )
    if (extension.extensionVersion !== request.extensionVersion) {
      return runtimeFailure(
        'EXTENSION_VERSION_CONFLICT',
        'Extension version changed; repeat the protected action.',
        409
      )
    }
    const provider = extension.manifest.contributes.modelProviders.find(
      (candidate) => candidate.id === request.providerId
    )
    if (!provider) {
      return runtimeFailure(
        'EXTENSION_PROVIDER_NOT_FOUND',
        'The selected model provider is not declared by this extension.',
        404
      )
    }
    const body = request
    const inputKinds = [...new Set(provider.models.flatMap((model) => model.capabilities.input))]
    const dataCategories = [
      'complete conversation history',
      'system and mode instructions',
      `attachments when present (${inputKinds.join(', ') || 'declared input types'})`,
      'advertised tool names, descriptions, and input schemas'
    ]
    return performProtectedRuntimeOperation(options, event, {
      extensionId: request.extensionId,
      extensionVersion: request.extensionVersion,
      operationKind: 'provider.bind',
      parameters: body,
      workspaceRoot: request.workspaceRoot,
      senderId: event.sender.id
    }, undefined, {
      title: 'Use extension model provider',
      message: `Allow ${extension.manifest.displayName ?? request.extensionId} to handle Kun model requests?`,
      detail: [
        `Provider: ${provider.displayName} (${request.providerId})`,
        `Model: ${request.modelId}`,
        `Account reference: ${request.accountId}`,
        'The extension Node adapter can receive:',
        ...dataCategories.map((category) => `• ${category}`),
        'Kun stores only the provider, opaque account reference, model, extension version, and acknowledgement. Credential material is not copied into this binding. Requests will fail explicitly if this exact provider/account/model becomes unavailable.'
      ].join('\n')
    }, () => options.runtimeRequest(
      '/v1/extensions/model-providers/binding',
      'PUT',
      JSON.stringify({ ...body, acknowledgedDataAccess: true })
    ))
  })
}
