import {
  fixture,
  getExtensionIpcElectronMock,
  resetExtensionIpcHandlerTestState
} from './register-extension-ipc-handlers.test-support'
import {
  ExtensionManifestSchema
} from '@kun/extension-api'
import {
  beforeEach,
  describe,
  expect,
  it
} from 'vitest'

const electronMock = getExtensionIpcElectronMock()

describe('extension IPC security bridge management', () => {
  beforeEach(resetExtensionIpcHandlerTestState)

  it('presents source, digest, signature, and high-risk contributions before installation', async () => {
    const state = fixture()
    const manifest = ExtensionManifestSchema.parse({
      manifestVersion: 1,
      apiVersion: '1.0.0',
      publisher: 'acme',
      name: 'example',
      version: '1.2.3',
      engines: { kun: '*' },
      main: 'dist/main.mjs',
      activationEvents: ['onStartup'],
      contributes: {
        hostContentScripts: [{
          id: 'direct-dom',
          matches: ['workbench:code'],
          scripts: ['dist/content.js']
        }]
      },
      permissions: ['hostDom'],
      stateSchemaVersion: 0
    })
    state.runtimeRequest.mockImplementation(async (path: string) => path === '/v1/extensions/inspect'
      ? {
          ok: true,
          status: 200,
          body: JSON.stringify({
            inspection: {
              id: 'acme.example',
              version: '1.2.3',
              archiveSha256: 'a'.repeat(64),
              signatureStatus: 'present-unverified',
              manifest
            }
          })
        }
      : { ok: true, status: 201, body: JSON.stringify({ extension: { id: 'acme.example' } }) })

    await electronMock.handlers.get('extension:install')!(state.trustedEvent, {
      source: 'archive',
      path: '/tmp/example.kunx'
    })

    expect(state.protectedActions.authorizeAndPerform).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        operationKind: 'extension.install'
      }),
      expect.objectContaining({
        detail: expect.stringMatching(/Local \.kunx archive[\s\S]*a{64}[\s\S]*not verified[\s\S]*Direct DOM/i)
      }),
      expect.any(Function)
    )
  })

  it('rejects extension management calls from a non-workbench sender', async () => {
    const state = fixture()
    await expect(
      electronMock.handlers.get('extension:list')!(state.untrustedEvent, undefined)
    ).rejects.toThrow(/trusted workbench frame/)
    expect(state.runtimeRequest).not.toHaveBeenCalled()
  })

  it('binds permission consent to the expected version and discloses the actual workspace delta', async () => {
    const state = fixture()
    state.descriptors.resolvePackage.mockResolvedValue({
      extensionId: 'acme.example',
      extensionVersion: '1.2.3',
      grantedPermissions: ['media.read'],
      workspaceTrusted: true
    })

    await electronMock.handlers.get('extension:set-permissions')!(state.trustedEvent, {
      extensionId: 'acme.example',
      expectedVersion: '1.2.3',
      permissions: ['workspace.write'],
      workspaceRoot: '/workspace'
    })

    expect(state.protectedActions.authorizeAndPerform).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        operationKind: 'extension.permissions',
        parameters: expect.objectContaining({ expectedVersion: '1.2.3' })
      }),
      expect.objectContaining({
        detail: expect.stringMatching(
          /Added broker permissions:[\s\S]*workspace\.write[\s\S]*Removed broker permissions:[\s\S]*media\.read[\s\S]*Workspace write permission/
        )
      }),
      expect.any(Function)
    )
    expect(state.runtimeRequest).toHaveBeenCalledWith(
      '/v1/extensions/acme.example/permissions',
      'PUT',
      JSON.stringify({
        workspaceRoot: '/workspace',
        permissions: ['workspace.write'],
        expectedVersion: '1.2.3'
      })
    )
  })

  it.each([
    ['global', '{}'],
    ['workspace', JSON.stringify({ workspaceRoot: '/workspace' })]
  ] as const)('applies reviewed permissions and enables the %s scope in one protected decision', async (
    enableAfterApply,
    expectedEnableBody
  ) => {
    const state = fixture()
    state.descriptors.resolvePackage.mockResolvedValue({
      extensionId: 'acme.example',
      extensionVersion: '1.2.3',
      grantedPermissions: [],
      workspaceTrusted: false
    })

    await electronMock.handlers.get('extension:set-permissions')!(state.trustedEvent, {
      extensionId: 'acme.example',
      expectedVersion: '1.2.3',
      permissions: ['ui.views', 'webview'],
      workspaceRoot: '/workspace',
      enableAfterApply
    })

    expect(state.protectedActions.authorizeAndPerform).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKind: 'extension.permissions',
        parameters: {
          extensionId: 'acme.example',
          expectedVersion: '1.2.3',
          permissions: ['ui.views', 'webview'],
          workspaceRoot: '/workspace',
          enableAfterApply
        }
      }),
      expect.objectContaining({
        title: 'Review permissions and enable extension',
        detail: expect.stringMatching(/apply these permissions[\s\S]*Resulting broker permissions/i)
      }),
      expect.any(Function)
    )
    expect(state.runtimeRequest).toHaveBeenNthCalledWith(
      1,
      '/v1/extensions/acme.example/permissions',
      'PUT',
      JSON.stringify({
        workspaceRoot: '/workspace',
        permissions: ['ui.views', 'webview'],
        expectedVersion: '1.2.3'
      })
    )
    expect(state.runtimeRequest).toHaveBeenNthCalledWith(
      2,
      '/v1/extensions/acme.example/enable',
      'POST',
      expectedEnableBody
    )
  })

  it('does not change permissions or enable when the combined review is cancelled', async () => {
    const state = fixture()
    state.descriptors.resolvePackage.mockResolvedValue({
      extensionId: 'acme.example',
      extensionVersion: '1.2.3',
      grantedPermissions: [],
      workspaceTrusted: false
    })
    state.protectedActions.authorizeAndPerform.mockResolvedValueOnce(undefined)

    const result = await electronMock.handlers.get('extension:set-permissions')!(state.trustedEvent, {
      extensionId: 'acme.example',
      expectedVersion: '1.2.3',
      permissions: ['ui.views'],
      workspaceRoot: '/workspace',
      enableAfterApply: 'global'
    })

    expect(result).toMatchObject({ ok: false, status: 403 })
    expect(state.runtimeRequest).not.toHaveBeenCalled()
  })

  it('does not enable when the reviewed permission update fails', async () => {
    const state = fixture()
    state.descriptors.resolvePackage.mockResolvedValue({
      extensionId: 'acme.example',
      extensionVersion: '1.2.3',
      grantedPermissions: [],
      workspaceTrusted: false
    })
    state.runtimeRequest.mockResolvedValueOnce({
      ok: false,
      status: 409,
      body: JSON.stringify({ code: 'EXTENSION_VERSION_CONFLICT' })
    })

    const result = await electronMock.handlers.get('extension:set-permissions')!(state.trustedEvent, {
      extensionId: 'acme.example',
      expectedVersion: '1.2.3',
      permissions: ['ui.views'],
      workspaceRoot: '/workspace',
      enableAfterApply: 'workspace'
    })

    expect(result).toMatchObject({ ok: false, status: 409 })
    expect(state.runtimeRequest).toHaveBeenCalledTimes(1)
    expect(state.runtimeRequest).not.toHaveBeenCalledWith(
      '/v1/extensions/acme.example/enable',
      expect.anything(),
      expect.anything()
    )
  })

  it('omits an absent workspace from the protected enable binding', async () => {
    const state = fixture()
    state.descriptors.resolvePackage.mockResolvedValue({
      extensionId: 'acme.example',
      extensionVersion: '1.2.3',
      grantedPermissions: [],
      workspaceTrusted: true
    })

    await electronMock.handlers.get('extension:enable')!(state.trustedEvent, {
      extensionId: 'acme.example'
    })

    expect(state.protectedActions.authorizeAndPerform).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKind: 'extension.enable',
        parameters: { extensionId: 'acme.example' }
      }),
      expect.any(Object),
      expect.any(Function)
    )
  })

  it('rejects a stale permission review before presenting native consent', async () => {
    const state = fixture()
    state.descriptors.resolvePackage.mockResolvedValue({
      extensionId: 'acme.example',
      extensionVersion: '2.0.0',
      grantedPermissions: [],
      workspaceTrusted: false
    })

    await expect(electronMock.handlers.get('extension:set-permissions')!(state.trustedEvent, {
      extensionId: 'acme.example',
      expectedVersion: '1.0.0',
      permissions: ['ui.views'],
      workspaceRoot: '/workspace'
    })).rejects.toThrow(/version changed/i)

    expect(state.protectedActions.authorizeAndPerform).not.toHaveBeenCalled()
    expect(state.runtimeRequest).not.toHaveBeenCalled()
  })

  it('treats an identical persisted workspace grant as an idempotent no-op', async () => {
    const state = fixture()
    state.descriptors.resolvePackage.mockResolvedValue({
      extensionId: 'acme.example',
      extensionVersion: '1.2.3',
      grantedPermissions: ['webview', 'ui.views'],
      workspaceTrusted: true
    })
    const view = state.viewSessions.create({
      sessionId: 'permission-noop-view',
      extensionId: 'acme.example',
      extensionVersion: '1.2.3',
      contributionId: 'issues',
      workspaceRoot: '/workspace',
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })

    const result = await electronMock.handlers.get('extension:set-permissions')!(state.trustedEvent, {
      extensionId: 'acme.example',
      expectedVersion: '1.2.3',
      permissions: ['ui.views', 'webview'],
      workspaceRoot: '/workspace'
    })

    expect(result).toEqual({
      ok: true,
      status: 200,
      body: JSON.stringify({ unchanged: true })
    })
    expect(state.protectedActions.authorizeAndPerform).not.toHaveBeenCalled()
    expect(state.runtimeRequest).not.toHaveBeenCalled()
    expect(state.viewSessions.get(view.sessionId)).toMatchObject({ workspaceRoot: '/workspace' })
    expect(state.contentScripts.revokeExtension).not.toHaveBeenCalled()
  })

})
