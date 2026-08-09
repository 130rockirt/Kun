import {
  fixture,
  getExtensionIpcElectronMock,
  resetExtensionIpcHandlerTestState
} from './register-extension-ipc-handlers.test-support'
import {
  beforeEach,
  describe,
  expect,
  it
} from 'vitest'

const electronMock = getExtensionIpcElectronMock()

describe('extension IPC security bridge content and configuration', () => {
  beforeEach(resetExtensionIpcHandlerTestState)

  it('tears down content scripts and rejects protected surfaces', async () => {
    const state = fixture()
    await expect(electronMock.handlers.get('extension:sync-host-content-scripts')!(
      state.trustedEvent,
      {
        surface: null,
        protectedSurface: 'account-credentials',
        descriptors: []
      }
    )).resolves.toMatchObject({
      ok: false,
      code: 'EXTENSION_PROTECTED_SURFACE_DENIED',
      reloadScheduled: false
    })
    expect(state.contentScripts.sync).toHaveBeenCalledWith(
      state.trustedEvent.sender,
      expect.objectContaining({ protectedSurface: 'account-credentials' })
    )
    expect(state.contentScripts.clearFrame).not.toHaveBeenCalled()
  })

  it('binds preload bootstrap and the narrow bridge to the trusted main frame', async () => {
    const state = fixture()
    const bootstrapEvent = { ...state.trustedEvent, returnValue: undefined as unknown }
    electronMock.listeners.get('extension:content-script:bootstrap')!(bootstrapEvent)
    expect(bootstrapEvent.returnValue).toEqual({ version: 1, generation: 'test', bindings: [] })
    expect(state.contentScripts.bootstrap).toHaveBeenCalledWith(state.trustedEvent.sender)

    const request = {
      bindingId: 'content_script_12345678-1234-1234-1234-123456789abc',
      nonce: 'n'.repeat(43),
      method: 'reportDiagnostic',
      diagnostic: { code: 'SELECTOR_MISSING', message: 'Expected selector was absent.' }
    }
    await expect(electronMock.handlers.get('extension:content-script:bridge')!(
      state.untrustedEvent,
      request
    )).rejects.toThrow(/trusted workbench frame/)
    await expect(electronMock.handlers.get('extension:content-script:bridge')!(
      state.trustedEvent,
      request
    )).resolves.toEqual({ ok: true })
    expect(state.contentScripts.handleBridgeRequest).toHaveBeenCalledWith(
      state.trustedEvent.sender,
      expect.objectContaining({ bindingId: request.bindingId, method: 'reportDiagnostic' })
    )
  })

  it('merges bounded Main content-script diagnostics into extension doctor output', async () => {
    const state = fixture()
    state.runtimeRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: JSON.stringify({ diagnostics: [] })
    })
    const result = await electronMock.handlers.get('extension:diagnostics')!(
      state.trustedEvent,
      'acme.example'
    ) as { body: string }
    expect(JSON.parse(result.body)).toMatchObject({
      diagnostics: [],
      contentScriptDiagnostics: [expect.objectContaining({
        code: 'HOST_DOM_EXTENSION_DIAGNOSTIC',
        extensionId: 'acme.example'
      })]
    })
  })

  it('revokes only the disabled extension workspace in Main-owned surfaces', async () => {
    const state = fixture()
    const workspaceA = state.viewSessions.create({
      sessionId: 'view-workspace-a',
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'issues',
      workspaceRoot: '/workspace/a',
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })
    const workspaceB = state.viewSessions.create({
      sessionId: 'view-workspace-b',
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'issues',
      workspaceRoot: '/workspace/b',
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })
    await electronMock.handlers.get('extension:disable')!(state.trustedEvent, {
      extensionId: 'acme.example',
      workspaceRoot: '/workspace/a'
    })
    expect(state.viewSessions.get(workspaceA.sessionId)).toBeUndefined()
    expect(state.viewSessions.get(workspaceB.sessionId)).toMatchObject({
      workspaceRoot: '/workspace/b'
    })
    expect(state.contentScripts.revokeExtension).toHaveBeenCalledWith(
      state.trustedEvent.sender,
      'acme.example',
      'disable',
      '/workspace/a'
    )
  })

  it('revokes only the permission-changed extension workspace in Main-owned surfaces', async () => {
    const state = fixture()
    state.descriptors.resolvePackage.mockResolvedValue({
      extensionVersion: '1.0.0',
      grantedPermissions: ['ui.views']
    })
    const workspaceA = state.viewSessions.create({
      sessionId: 'permission-workspace-a',
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'issues',
      workspaceRoot: '/workspace/a',
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })
    const workspaceB = state.viewSessions.create({
      sessionId: 'permission-workspace-b',
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'issues',
      workspaceRoot: '/workspace/b',
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })

    await electronMock.handlers.get('extension:set-permissions')!(state.trustedEvent, {
      extensionId: 'acme.example',
      workspaceRoot: '/workspace/a',
      expectedVersion: '1.0.0',
      permissions: []
    })

    expect(state.viewSessions.get(workspaceA.sessionId)).toBeUndefined()
    expect(state.viewSessions.get(workspaceB.sessionId)).toMatchObject({
      workspaceRoot: '/workspace/b'
    })
    expect(state.contentScripts.revokeExtension).toHaveBeenCalledWith(
      state.trustedEvent.sender,
      'acme.example',
      'permission-change',
      '/workspace/a'
    )
  })

  it('forwards only the fixed command route and validated absolute workspace', async () => {
    const state = fixture()
    const result = await electronMock.handlers.get('extension:invoke-command')!(
      state.trustedEvent,
      {
        commandId: 'extension:acme.example/open',
        context: { source: 'topBar' },
        workspaceRoot: '/workspace'
      }
    )
    expect(result).toEqual({ ok: true })
    expect(state.runtimeRequest).toHaveBeenCalledWith(
      '/v1/extensions/commands/invoke',
      'POST',
      JSON.stringify({
        commandId: 'extension:acme.example/open',
        context: { source: 'topBar' },
        workspaceRoot: '/workspace'
      })
    )
  })

  it('maps trusted workbench and provider reads only onto fixed runtime routes', async () => {
    const state = fixture()

    await electronMock.handlers.get('extension:workbench:get')!(
      state.trustedEvent,
      { workspaceRoot: '/workspace one', locale: 'zh-CN' }
    )
    expect(state.runtimeRequest).toHaveBeenLastCalledWith(
      '/v1/extensions/workbench?workspace_root=%2Fworkspace+one&locale=zh-CN',
      'GET'
    )

    await electronMock.handlers.get('extension:list')!(
      state.trustedEvent,
      { limit: 50, workspaceRoot: '/workspace one', locale: 'zh-CN' }
    )
    expect(state.runtimeRequest).toHaveBeenLastCalledWith(
      '/v1/extensions?limit=50&workspace_root=%2Fworkspace+one&locale=zh-CN',
      'GET'
    )

    await electronMock.handlers.get('extension:model-providers:list')!(
      state.trustedEvent,
      undefined
    )
    expect(state.runtimeRequest).toHaveBeenLastCalledWith(
      '/v1/extensions/model-providers',
      'GET'
    )

    await electronMock.handlers.get('extension:model-providers:list-models')!(
      state.trustedEvent,
      {
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        providerId: 'models',
        accountId: 'account/with?delimiters',
        workspaceRoot: '/workspace'
      }
    )
    expect(state.runtimeRequest).toHaveBeenLastCalledWith(
      '/v1/extensions/model-providers/models?' +
        'extension_id=acme.example&extension_version=1.2.3&provider_id=models&' +
        'account_id=account%2Fwith%3Fdelimiters&workspace_root=%2Fworkspace',
      'GET'
    )
  })

  it('maps trusted configuration operations onto fixed methods and JSON bodies', async () => {
    const state = fixture()
    const load = {
      contributionIds: ['extension:acme.example/general'],
      workspaceRoot: '/workspace'
    }
    await electronMock.handlers.get('extension:configuration:load')!(state.trustedEvent, load)
    expect(state.runtimeRequest).toHaveBeenLastCalledWith(
      '/v1/extensions/configuration/snapshot',
      'POST',
      JSON.stringify(load)
    )

    const update = {
      contributionId: 'extension:acme.example/general',
      key: 'mode',
      value: 'safe',
      expectedRevision: 2,
      workspaceRoot: '/workspace'
    }
    await electronMock.handlers.get('extension:configuration:update')!(state.trustedEvent, update)
    expect(state.runtimeRequest).toHaveBeenLastCalledWith(
      '/v1/extensions/configuration',
      'PUT',
      JSON.stringify(update)
    )
  })

  it('rejects every dedicated workbench bridge before runtime dispatch for untrusted senders', async () => {
    const state = fixture()
    const calls: Array<[string, unknown]> = [
      ['extension:workbench:get', { workspaceRoot: '/workspace' }],
      ['extension:model-providers:list', { workspaceRoot: '/workspace' }],
      ['extension:model-providers:list-models', {
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        providerId: 'models',
        accountId: 'account-1',
        workspaceRoot: '/workspace'
      }],
      ['extension:configuration:load', {
        contributionIds: ['extension:acme.example/general'],
        workspaceRoot: '/workspace'
      }],
      ['extension:configuration:update', {
        contributionId: 'extension:acme.example/general',
        key: 'mode',
        value: 'safe',
        expectedRevision: 0,
        workspaceRoot: '/workspace'
      }]
    ]
    for (const [channel, payload] of calls) {
      await expect(
        electronMock.handlers.get(channel)!(state.untrustedEvent, payload)
      ).rejects.toThrow(/trusted workbench frame/)
    }
    expect(state.runtimeRequest).not.toHaveBeenCalled()
  })

  it('rejects route injection and relative workspaces before runtime dispatch', async () => {
    const state = fixture()
    await expect(electronMock.handlers.get('extension:workbench:get')!(
      state.trustedEvent,
      { workspaceRoot: 'relative', path: '/v1/usage' }
    )).rejects.toThrow(/Invalid payload/)
    await expect(electronMock.handlers.get('extension:configuration:update')!(
      state.trustedEvent,
      {
        contributionId: 'extension:acme.example/general',
        key: 'mode',
        value: 'safe',
        expectedRevision: 0,
        workspaceRoot: '/workspace',
        method: 'DELETE'
      }
    )).rejects.toThrow(/Invalid payload/)
    expect(state.runtimeRequest).not.toHaveBeenCalled()
  })

  it('rejects configuration bodies above the runtime route limit in Main', async () => {
    const state = fixture()
    await expect(electronMock.handlers.get('extension:configuration:update')!(
      state.trustedEvent,
      {
        contributionId: 'extension:acme.example/general',
        key: 'mode',
        value: 'x'.repeat(256 * 1024),
        expectedRevision: 0,
        workspaceRoot: '/workspace'
      }
    )).rejects.toThrow(/payload is too large/)
    expect(state.runtimeRequest).not.toHaveBeenCalled()
  })
})
