import {
  fixture,
  getExtensionIpcElectronMock,
  resetExtensionIpcHandlerTestState
} from './register-extension-ipc-handlers.test-support'
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'

const electronMock = getExtensionIpcElectronMock()

describe('extension IPC security bridge accounts', () => {
  beforeEach(resetExtensionIpcHandlerTestState)

  it('denies protected account methods from a Webview before runtime dispatch', async () => {
    const state = fixture()
    const record = state.viewSessions.create({
      sessionId: 'view_12345678-1234-1234-1234-123456789abc',
      nonce: 'n'.repeat(43),
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'extension:acme.example/issues',
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })
    state.viewSessions.prepareAttach(1, record.sourceUrl)
    const guest = { id: 20, once: vi.fn() }
    state.viewSessions.bindNextGuest(1, guest as never)

    await expect(electronMock.handlers.get('extension:view:request')!(
      { sender: guest },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-123',
        method: 'authentication.createSession',
        params: {}
      }
    )).rejects.toThrow(/not available/)
    expect(state.runtimeRequest).not.toHaveBeenCalled()
  })

  it('collects OAuth callbacks only in a protected Main surface', async () => {
    const state = fixture()
    state.descriptors.resolvePackage.mockResolvedValue({
      extensionVersion: '1.2.3',
      manifest: {
        contributes: {
          modelProviders: [{ id: 'models', authenticationProviderId: 'oauth' }],
          authentication: [{ id: 'oauth', scopes: ['models.read'] }]
        }
      }
    })
    state.credentialSurface.prompt.mockResolvedValue({
      submitted: true,
      value: 'https://callback.example/?code=secret-code&state=expected-state',
      protectedWindowSessionId: 'protected-session-123456'
    })

    const response = await electronMock.handlers.get('extension:accounts:complete-session')!(
      state.trustedEvent,
      {
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        sessionId: 'account-session-123456',
        workspaceRoot: '/workspace'
      }
    )

    expect(response).toMatchObject({ ok: true, status: 200 })
    expect(state.credentialSurface.prompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ label: 'OAuth callback URL' })
    )
    expect(state.protectedActions.performAfterProtectedDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        operationKind: 'account.complete-session',
        parameters: expect.objectContaining({
          extensionId: 'acme.example',
          extensionVersion: '1.2.3',
          sessionId: 'account-session-123456',
          callbackDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
        })
      }),
      'protected-session-123456',
      expect.any(Function)
    )
    const runtimeBody = JSON.parse(state.runtimeRequest.mock.calls.at(-1)?.[2] as string)
    expect(runtimeBody).toEqual({
      extensionId: 'acme.example',
      extensionVersion: '1.2.3',
      callbackUrl: 'https://callback.example/?code=secret-code&state=expected-state',
      workspaceRoot: '/workspace'
    })
    expect(JSON.stringify(state.protectedActions.performAfterProtectedDecision.mock.calls[0]?.[0]))
      .not.toContain('secret-code')
  })

  it('binds account-session creation to the selected workspace version', async () => {
    const state = fixture()
    state.descriptors.resolvePackage.mockResolvedValue({
      extensionVersion: '1.2.3',
      manifest: {
        contributes: {
          modelProviders: [{ id: 'models', authenticationProviderId: 'oauth' }],
          authentication: [{ id: 'oauth', scopes: ['models.read'] }]
        }
      }
    })

    const response = await electronMock.handlers.get('extension:accounts:create-session')!(
      state.trustedEvent,
      {
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        providerId: 'models',
        authenticationProviderId: 'oauth',
        scopes: ['models.read'],
        workspaceRoot: '/workspace'
      }
    )

    expect(response).toMatchObject({ ok: true, status: 200 })
    expect(state.descriptors.resolvePackage).toHaveBeenCalledWith('acme.example', '/workspace')
    expect(state.protectedActions.authorizeAndPerform).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        operationKind: 'account.create-session',
        workspaceRoot: '/workspace'
      }),
      expect.any(Object),
      expect.any(Function)
    )
    expect(state.runtimeRequest).toHaveBeenCalledWith(
      '/v1/extensions/accounts/sessions',
      'POST',
      JSON.stringify({
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        providerId: 'models',
        authenticationProviderId: 'oauth',
        scopes: ['models.read'],
        workspaceRoot: '/workspace'
      })
    )
  })

  it('shows full model-input disclosure before persisting an exact provider binding', async () => {
    const state = fixture()
    state.descriptors.resolvePackage.mockResolvedValue({
      extensionVersion: '1.2.3',
      manifest: {
        displayName: 'Example models',
        contributes: {
          modelProviders: [{
            id: 'models',
            displayName: 'Example Provider',
            models: [{
              id: 'model-a',
              capabilities: { input: ['text', 'image'] }
            }]
          }]
        }
      }
    })

    const response = await electronMock.handlers.get('extension:providers:set-binding')!(
      state.trustedEvent,
      {
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        providerId: 'models',
        accountId: 'account-123',
        modelId: 'model-a',
        workspaceRoot: '/workspace'
      }
    )

    expect(response).toMatchObject({ ok: true, status: 200 })
    expect(state.protectedActions.authorizeAndPerform).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        operationKind: 'provider.bind',
        workspaceRoot: '/workspace',
        parameters: expect.objectContaining({
          providerId: 'models',
          accountId: 'account-123',
          modelId: 'model-a'
        })
      }),
      expect.objectContaining({
        detail: expect.stringMatching(/complete conversation history[\s\S]*system and mode instructions[\s\S]*attachments[\s\S]*tool names/i)
      }),
      expect.any(Function)
    )
    expect(state.runtimeRequest).toHaveBeenCalledWith(
      '/v1/extensions/model-providers/binding',
      'PUT',
      JSON.stringify({
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        providerId: 'models',
        accountId: 'account-123',
        modelId: 'model-a',
        workspaceRoot: '/workspace',
        acknowledgedDataAccess: true
      })
    )
  })

  it('keeps OAuth and device verification material inside the protected Main window', async () => {
    const state = fixture()
    state.descriptors.resolvePackage.mockResolvedValue({
      extensionVersion: '1.2.3',
      manifest: {
        contributes: {
          modelProviders: [{ id: 'models', authenticationProviderId: 'device-auth' }],
          authentication: [{
            id: 'device-auth',
            type: 'device-code',
            scopes: ['models.read']
          }]
        }
      }
    })
    state.runtimeRequest.mockResolvedValue({
      ok: true,
      status: 201,
      body: JSON.stringify({
        schemaVersion: 1,
        session: {
          id: 'account-session-device',
          status: 'pending',
          verificationUrl: 'https://auth.example/device',
          userCode: 'ABCD-EFGH',
          expiresAt: '2099-07-11T10:10:00.000Z'
        }
      })
    })
    state.credentialSurface.presentAuthorization.mockResolvedValue(undefined)

    const response = await electronMock.handlers.get('extension:accounts:create-session')!(
      state.trustedEvent,
      {
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        providerId: 'models',
        authenticationProviderId: 'device-auth',
        workspaceRoot: '/workspace'
      }
    ) as { body: string }

    expect(state.credentialSurface.presentAuthorization).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        verificationUrl: 'https://auth.example/device',
        userCode: 'ABCD-EFGH'
      })
    )
    expect(JSON.parse(response.body).session).toEqual({
      id: 'account-session-device',
      status: 'pending',
      expiresAt: '2099-07-11T10:10:00.000Z'
    })
    expect(response.body).not.toContain('ABCD-EFGH')
    expect(response.body).not.toContain('auth.example')

    const refreshed = await electronMock.handlers.get('extension:accounts:get-session')!(
      state.trustedEvent,
      { extensionId: 'acme.example', sessionId: 'account-session-device' }
    ) as { body: string }
    expect(refreshed.body).not.toContain('ABCD-EFGH')
    expect(refreshed.body).not.toContain('auth.example')
  })

  it('replaces an API key through the protected surface while binding only its digest to consent', async () => {
    const state = fixture()
    state.descriptors.resolvePackage.mockResolvedValue({ extensionVersion: '1.2.3' })
    state.credentialSurface.prompt.mockResolvedValue({
      submitted: true,
      value: 'replacement-secret-key',
      protectedWindowSessionId: 'protected-session-replace'
    })

    await electronMock.handlers.get('extension:accounts:replace-api-key')!(state.trustedEvent, {
      extensionId: 'acme.example',
      extensionVersion: '1.2.3',
      providerId: 'models',
      accountId: 'account-123',
      workspaceRoot: '/workspace'
    })

    const binding = state.protectedActions.performAfterProtectedDecision.mock.calls.at(-1)?.[0]
    expect(binding).toMatchObject({
      operationKind: 'account.replace-api-key',
      parameters: expect.objectContaining({
        accountId: 'account-123',
        secretDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    })
    expect(JSON.stringify(binding)).not.toContain('replacement-secret-key')
    expect(state.runtimeRequest).toHaveBeenCalledWith(
      '/v1/extensions/accounts/account-123/api-key',
      'PUT',
      expect.stringContaining('replacement-secret-key')
    )
  })

})
