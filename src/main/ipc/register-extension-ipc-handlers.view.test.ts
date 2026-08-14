import {
  fixture,
  getExtensionIpcElectronMock,
  resetExtensionIpcHandlerTestState
} from './register-extension-ipc-handlers.test-support'
import {
  createHash
} from 'node:crypto'
import {
  resolve
} from 'node:path'
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'

const electronMock = getExtensionIpcElectronMock()

describe('extension IPC security bridge view context and media', () => {
  beforeEach(resetExtensionIpcHandlerTestState)

  it('binds guest requests to the Main-owned session and forwards nonce headers', async () => {
    const state = fixture()
    const record = state.viewSessions.create({
      sessionId: 'view_12345678-1234-1234-1234-123456789abc',
      runtimeSessionId: 'view_12345678-1234-1234-1234-123456789abc',
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

    const response = await electronMock.handlers.get('extension:view:request')!(
      { sender: guest },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-123',
        method: 'ui.getViewState',
        params: {}
      }
    )

    expect(response).toEqual({ ok: true })
    expect(state.runtimeRequest).toHaveBeenCalledWith(
      `/v1/extensions/view-sessions/${record.runtimeSessionId}/requests`,
      'POST',
      expect.stringContaining('ui.getViewState'),
      {
        'x-kun-extension-session-id': record.runtimeSessionId,
        'x-kun-extension-session-nonce': record.nonce
      }
    )
  })

  it('attaches bounded View context through the owning workbench with Host provenance', async () => {
    const state = fixture()
    const workspaceRoot = '/tmp/workspace'
    const canonicalWorkspaceRoot = resolve(workspaceRoot)
    const record = state.viewSessions.create({
      sessionId: 'view_12345678-1234-1234-1234-123456789abc',
      runtimeSessionId: 'view_12345678-1234-1234-1234-123456789abc',
      nonce: 'n'.repeat(43),
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'extension:acme.example/issues',
      workspaceRoot,
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })
    state.viewSessions.prepareAttach(1, record.sourceUrl)
    const mainFrame = { processId: 300, routingId: 400 }
    const guest = { id: 20, mainFrame, once: vi.fn() }
    state.viewSessions.bindNextGuest(1, guest as never)
    state.descriptors.resolveView.mockResolvedValue({
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'issues',
      grantedPermissions: ['webview', 'ui.views', 'ui.actions'],
      enabled: true,
      workspaceTrusted: true
    })

    const response = await electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-attach-context',
        method: 'ui.attachComposerContext',
        params: {
          schemaVersion: 1,
          id: 'video-selection',
          title: 'Interview selection',
          summary: 'Revision 4, two preview sources',
          reference: { projectId: 'project-1', selectedItemIds: ['clip-1'] },
          revision: 4,
          generation: 7
        }
      }
    )

    const workspaceId = createHash('sha256').update(canonicalWorkspaceRoot).digest('hex')
    expect(response).toMatchObject({
      schemaVersion: 1,
      title: 'Interview selection',
      provenance: {
        extensionId: 'acme.example',
        extensionVersion: '1.0.0',
        viewContributionId: 'extension:acme.example/issues',
        workspaceId
      }
    })
    expect(response).toMatchObject({ attachmentId: expect.stringMatching(/^extension-context:[a-f0-9]{64}$/) })
    expect(JSON.stringify(response)).not.toContain(workspaceRoot)
    expect(state.mainContents.send).toHaveBeenCalledWith(
      'extension:composer-context-attached',
      expect.objectContaining({ workspaceRoot: canonicalWorkspaceRoot, attachment: response })
    )
    expect(state.runtimeRequest).not.toHaveBeenCalled()
  })

  it('denies composer context attachment without ui.actions or from a stale frame', async () => {
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
    const mainFrame = { processId: 300, routingId: 400 }
    const guest = { id: 20, mainFrame, once: vi.fn() }
    state.viewSessions.bindNextGuest(1, guest as never)
    state.descriptors.resolveView.mockResolvedValue({
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'issues',
      grantedPermissions: ['webview', 'ui.views'],
      enabled: true,
      workspaceTrusted: true
    })
    const payload = {
      sessionId: record.sessionId,
      sessionNonce: record.nonce,
      requestId: 'request-attach-context',
      method: 'ui.attachComposerContext',
      params: {
        schemaVersion: 1,
        id: 'selection',
        title: 'Selection',
        summary: 'One selected clip',
        reference: { selectedItemIds: ['clip-1'] },
        revision: 1,
        generation: 1
      }
    }

    await expect(electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      payload
    )).rejects.toThrow(/permission is not granted/i)
    await expect(electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: { processId: 999, routingId: 999 } },
      payload
    )).rejects.toThrow(/current guest main frame/i)
    expect(state.mainContents.send).not.toHaveBeenCalled()
  })

  it('keeps protected media paths and one-time operation tokens in Main while returning opaque handles', async () => {
    const state = fixture()
    const record = state.viewSessions.create({
      sessionId: 'view_12345678-1234-1234-1234-123456789abc',
      runtimeSessionId: 'view_12345678-1234-1234-1234-123456789abc',
      nonce: 'n'.repeat(43),
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'extension:acme.example/issues',
      workspaceRoot: '/tmp/workspace',
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })
    state.viewSessions.prepareAttach(1, record.sourceUrl)
    const mainFrame = { processId: 300, routingId: 400 }
    const guest = { id: 20, mainFrame, once: vi.fn() }
    state.viewSessions.bindNextGuest(1, guest as never)
    electronMock.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/private/media/interview.mp4']
    })
    state.runtimeRequest.mockResolvedValue({
      ok: true,
      status: 201,
      body: JSON.stringify({
        selections: [{
          handleId: 'media_handle_0000000001',
          mode: 'read',
          kind: 'video',
          displayName: 'interview.mp4',
          mimeType: 'video/mp4',
          byteSize: 1234,
          revoked: false
        }]
      })
    })

    const response = await electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-media-pick',
        method: 'media.pickFiles',
        params: {
          multiple: true,
          maxFiles: 2,
          filters: [{ name: 'Videos', extensions: ['mp4'], mimeTypes: ['video/mp4'] }]
        }
      }
    )

    expect(response).toMatchObject({
      outcome: 'selected',
      files: [{ handleId: 'media_handle_0000000001', displayName: 'interview.mp4' }]
    })
    expect(JSON.stringify(response)).not.toContain('/private/media')
    expect(JSON.stringify(response)).not.toContain('operationToken')
    expect(electronMock.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: 'Select media files for acme.example',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Videos', extensions: ['mp4'] }]
      })
    )
    const [path, method, body] = state.runtimeRequest.mock.calls[0]!
    expect({ path, method }).toEqual({ path: '/v1/extensions/media/selections', method: 'POST' })
    const registration = JSON.parse(body as string)
    expect(registration).toMatchObject({
      mode: 'read',
      binding: {
        sessionId: record.sessionId,
        runtimeSessionId: record.runtimeSessionId,
        extensionId: record.extensionId,
        extensionVersion: record.extensionVersion,
        contributionId: record.contributionId,
        workspaceRoot: record.workspaceRoot,
        senderWebContentsId: guest.id,
        senderMainFrameProcessId: mainFrame.processId,
        senderMainFrameRoutingId: mainFrame.routingId
      },
      selections: [{
        absolutePath: '/private/media/interview.mp4',
        displayName: 'interview.mp4'
      }]
    })
    expect(registration.operationToken).toMatch(/^[A-Za-z0-9_-]{32,}$/)
  })

  it('mints and releases sender-bound kun-media leases without returning a path', async () => {
    const state = fixture()
    const record = state.viewSessions.create({
      sessionId: 'view_12345678-1234-1234-1234-123456789abc',
      runtimeSessionId: 'view_12345678-1234-1234-1234-123456789abc',
      nonce: 'n'.repeat(43),
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'extension:acme.example/issues',
      workspaceRoot: '/tmp/workspace',
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })
    state.viewSessions.prepareAttach(1, record.sourceUrl)
    const attachFrame = { processId: 299, routingId: 399 }
    const mainFrame = { processId: 300, routingId: 400 }
    const guest = { id: 20, mainFrame: attachFrame, once: vi.fn() }
    state.viewSessions.bindNextGuest(1, guest as never)
    guest.mainFrame = mainFrame
    state.runtimeRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: JSON.stringify({
        binding: {
          sessionId: record.sessionId,
          runtimeSessionId: record.runtimeSessionId,
          sessionNonce: record.nonce,
          extensionId: record.extensionId,
          extensionVersion: record.extensionVersion,
          contributionId: record.contributionId,
          workspaceRoot: record.workspaceRoot,
          senderWebContentsId: guest.id,
          senderMainFrameProcessId: mainFrame.processId,
          senderMainFrameRoutingId: mainFrame.routingId
        },
        handleId: 'media_handle_0000000001',
        absolutePath: '/private/media/interview.mp4',
        mimeType: 'video/mp4',
        fileIdentity: { byteSize: 1234, modifiedAtMs: 1000, device: 2, inode: 3 },
        expiresAt: '2026-07-13T00:05:00.000Z'
      })
    })

    const opened = await electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-media-open',
        method: 'media.openViewResource',
        params: { handleId: 'media_handle_0000000001' }
      }
    )
    expect(opened).toEqual({
      leaseId: 'lease_123456789012',
      handleId: 'media_handle_0000000001',
      url: 'kun-media://lease/opaque-lease-token',
      mimeType: 'video/mp4',
      expiresAt: '2026-07-13T00:05:00.000Z'
    })
    expect(JSON.stringify(opened)).not.toContain('/private/media')
    expect(state.runtimeRequest).toHaveBeenCalledWith(
      '/v1/extensions/media/leases/resolve',
      'POST',
      expect.stringContaining('media_handle_0000000001')
    )
    expect(JSON.parse(state.runtimeRequest.mock.calls[0]![2] as string).binding).toMatchObject({
      senderWebContentsId: guest.id,
      senderMainFrameProcessId: mainFrame.processId,
      senderMainFrameRoutingId: mainFrame.routingId
    })
    expect(state.mediaProtocols.createLease).toHaveBeenCalledWith(expect.objectContaining({
      viewSessionId: record.sessionId,
      absolutePath: '/private/media/interview.mp4',
      fileIdentity: { byteSize: 1234, modifiedAtMs: 1000, device: 2, inode: 3 }
    }))

    await expect(electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: attachFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-media-open-stale-frame',
        method: 'media.openViewResource',
        params: { handleId: 'media_handle_0000000001' }
      }
    )).rejects.toMatchObject({ code: 'MEDIA_SCOPE_DENIED' })
    expect(state.runtimeRequest).toHaveBeenCalledTimes(1)

    const released = await electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-media-release',
        method: 'media.release',
        params: { resource: 'lease', leaseId: 'lease_123456789012' }
      }
    )
    expect(released).toEqual({ released: true })
    expect(state.mediaProtocols.revokeLease).toHaveBeenCalledWith(
      'lease_123456789012',
      'released'
    )
  })

  it('rechecks the original media frame after resolution and lease creation awaits', async () => {
    const state = fixture()
    const record = state.viewSessions.create({
      sessionId: 'view_12345678-1234-1234-1234-123456789abc',
      runtimeSessionId: 'view_12345678-1234-1234-1234-123456789abc',
      nonce: 'n'.repeat(43),
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'extension:acme.example/issues',
      workspaceRoot: '/tmp/workspace',
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })
    state.viewSessions.prepareAttach(1, record.sourceUrl)
    const mainFrame = { processId: 300, routingId: 400 }
    const nextFrame = { processId: 301, routingId: 401 }
    const guest = { id: 20, mainFrame, once: vi.fn() }
    state.viewSessions.bindNextGuest(1, guest as never)
    const resolution = {
      ok: true,
      status: 200,
      body: JSON.stringify({
        binding: {
          sessionId: record.sessionId,
          runtimeSessionId: record.runtimeSessionId,
          sessionNonce: record.nonce,
          extensionId: record.extensionId,
          extensionVersion: record.extensionVersion,
          contributionId: record.contributionId,
          workspaceRoot: record.workspaceRoot,
          senderWebContentsId: guest.id,
          senderMainFrameProcessId: mainFrame.processId,
          senderMainFrameRoutingId: mainFrame.routingId
        },
        handleId: 'media_handle_0000000001',
        absolutePath: '/private/media/interview.mp4',
        mimeType: 'video/mp4',
        fileIdentity: { byteSize: 1234, modifiedAtMs: 1000 },
        expiresAt: '2026-07-13T00:05:00.000Z'
      })
    }
    const invoke = () => electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-media-navigation-race',
        method: 'media.openViewResource',
        params: { handleId: 'media_handle_0000000001' }
      }
    )

    state.runtimeRequest.mockImplementationOnce(async () => {
      guest.mainFrame = nextFrame
      return resolution
    })
    await expect(invoke()).rejects.toMatchObject({ code: 'MEDIA_SCOPE_DENIED' })
    expect(state.mediaProtocols.createLease).not.toHaveBeenCalled()

    guest.mainFrame = mainFrame
    state.runtimeRequest.mockResolvedValueOnce(resolution)
    state.mediaProtocols.createLease.mockImplementationOnce(async () => {
      guest.mainFrame = nextFrame
      return {
        leaseId: 'lease_123456789012',
        handleId: 'media_handle_0000000001',
        url: 'kun-media://lease/opaque-lease-token',
        mimeType: 'video/mp4',
        expiresAt: '2026-07-13T00:05:00.000Z'
      }
    })
    await expect(invoke()).rejects.toMatchObject({ code: 'MEDIA_SCOPE_DENIED' })
    expect(state.mediaProtocols.revokeLease).toHaveBeenCalledWith(
      'lease_123456789012',
      'released'
    )
  })

  it('opens and reveals owned artifacts from the authenticated View binding without exposing paths', async () => {
    const state = fixture()
    const workspaceRoot = '/tmp/workspace'
    const canonicalWorkspaceRoot = resolve(workspaceRoot)
    const record = state.viewSessions.create({
      sessionId: 'view_12345678-1234-1234-1234-123456789abc',
      runtimeSessionId: 'view_12345678-1234-1234-1234-123456789abc',
      nonce: 'n'.repeat(43),
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'extension:acme.example/issues',
      workspaceRoot,
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })
    state.viewSessions.prepareAttach(1, record.sourceUrl)
    const mainFrame = { processId: 300, routingId: 400 }
    const guest = { id: 20, mainFrame, once: vi.fn() }
    state.viewSessions.bindNextGuest(1, guest as never)
    state.runtimeRequest.mockResolvedValue({
      ok: true,
      status: 200,
      body: JSON.stringify({
        artifactId: 'artifact_subtitle_1234567890',
        absolutePath: '/private/generated/captions.srt',
        displayName: 'captions.srt',
        mimeType: 'application/x-subrip'
      })
    })

    const invoke = (action: 'open' | 'reveal') =>
      electronMock.handlers.get('extension:view:request')!(
        { sender: guest, senderFrame: mainFrame },
        {
          sessionId: record.sessionId,
          sessionNonce: record.nonce,
          requestId: `request-artifact-${action}`,
          method: 'media.performArtifactAction',
          params: { artifactId: 'artifact_subtitle_1234567890', action }
        }
      )

    await expect(invoke('open')).resolves.toEqual({ performed: true })
    await expect(invoke('reveal')).resolves.toEqual({ performed: true })
    expect(electronMock.openPath).toHaveBeenCalledWith('/private/generated/captions.srt')
    expect(electronMock.showItemInFolder).toHaveBeenCalledWith('/private/generated/captions.srt')
    const [, , body] = state.runtimeRequest.mock.calls[0]!
    expect(JSON.parse(body as string)).toEqual({
      artifactId: 'artifact_subtitle_1234567890',
      ownerExtensionId: record.extensionId,
      ownerExtensionVersion: record.extensionVersion,
      workspaceId: createHash('sha256').update(canonicalWorkspaceRoot).digest('hex'),
      workspaceRoot: canonicalWorkspaceRoot
    })
    expect(JSON.stringify(await invoke('open'))).not.toContain('/private/generated')

    await expect(electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-artifact-forged-owner',
        method: 'media.performArtifactAction',
        params: {
          artifactId: 'artifact_subtitle_1234567890',
          action: 'open',
          ownerExtensionId: 'other.extension'
        }
      }
    )).rejects.toThrow()
    await expect(electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: { processId: 301, routingId: 401 } },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-artifact-subframe',
        method: 'media.performArtifactAction',
        params: { artifactId: 'artifact_subtitle_1234567890', action: 'reveal' }
      }
    )).rejects.toMatchObject({ code: 'MEDIA_SCOPE_DENIED' })
  })

  it('does not invoke the desktop shell when artifact ownership resolution fails', async () => {
    const state = fixture()
    const record = state.viewSessions.create({
      sessionId: 'view_12345678-1234-1234-1234-123456789abc',
      nonce: 'n'.repeat(43),
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'extension:acme.example/issues',
      workspaceRoot: '/tmp/workspace',
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })
    state.viewSessions.prepareAttach(1, record.sourceUrl)
    const mainFrame = { processId: 300, routingId: 400 }
    const guest = { id: 20, mainFrame, once: vi.fn() }
    state.viewSessions.bindNextGuest(1, guest as never)
    state.runtimeRequest.mockResolvedValue({
      ok: false,
      status: 404,
      body: JSON.stringify({ error: { message: 'Generated artifact is unavailable' } })
    })

    await expect(electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-artifact-unavailable',
        method: 'media.performArtifactAction',
        params: { artifactId: 'artifact_subtitle_1234567890', action: 'open' }
      }
    )).rejects.toThrow()
    expect(electronMock.openPath).not.toHaveBeenCalled()
    expect(electronMock.showItemInFolder).not.toHaveBeenCalled()
  })

})
