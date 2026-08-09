import {
  fixture,
  getExtensionIpcElectronMock,
  resetExtensionIpcHandlerTestState
} from './register-extension-ipc-handlers.test-support'
import {
  join
} from 'node:path'
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import {
  type ExtensionWorkbenchEnvironment
} from './register-extension-ipc-handlers'

const electronMock = getExtensionIpcElectronMock()

describe('extension IPC security bridge media picker', () => {
  beforeEach(resetExtensionIpcHandlerTestState)

  it('treats native picker cancellation as no consent and creates no grant', async () => {
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
    electronMock.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })

    await expect(electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-media-cancel',
        method: 'media.pickFiles',
        params: {}
      }
    )).resolves.toEqual({ outcome: 'cancelled', files: [] })
    expect(state.runtimeRequest).not.toHaveBeenCalled()
  })

  it('localizes protected native media picker titles from the current Host locale', async () => {
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
    electronMock.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    electronMock.showSaveDialog.mockResolvedValue({ canceled: true })

    state.setWorkbenchEnvironment({
      theme: {
        kind: 'light',
        tokens: { foreground: '#233659' },
        zoomFactor: 1,
        reducedMotion: false
      },
      locale: { language: 'zh', direction: 'ltr', messages: {} }
    })
    await electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-localized-media-import',
        method: 'media.pickFiles',
        params: {}
      }
    )
    state.setWorkbenchEnvironment({
      theme: {
        kind: 'light',
        tokens: { foreground: '#233659' },
        zoomFactor: 1,
        reducedMotion: false
      },
      locale: { language: 'zh-CN', direction: 'ltr', messages: {} }
    })
    await electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-localized-media-export',
        method: 'media.pickSaveTarget',
        params: {}
      }
    )

    state.setWorkbenchEnvironment({
      theme: {
        kind: 'light',
        tokens: { foreground: '#233659' },
        zoomFactor: 1,
        reducedMotion: false
      },
      locale: { language: 'en', direction: 'ltr', messages: {} }
    })
    await electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-english-media-import',
        method: 'media.pickFiles',
        params: {}
      }
    )
    await electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-english-media-export',
        method: 'media.pickSaveTarget',
        params: {}
      }
    )

    expect(electronMock.showOpenDialog).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ title: '为 acme.example 选择媒体文件' })
    )
    expect(electronMock.showSaveDialog).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ title: '为 acme.example 选择导出位置' })
    )
    expect(electronMock.showOpenDialog).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ title: 'Select media files for acme.example' })
    )
    expect(electronMock.showSaveDialog).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ title: 'Choose export destination for acme.example' })
    )
    expect(state.runtimeRequest).not.toHaveBeenCalled()
  })

  it('does not open a native picker if its View navigates while Main resolves the locale', async () => {
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
    state.options.getWorkbenchEnvironment = vi.fn(async (): Promise<ExtensionWorkbenchEnvironment> => {
      guest.mainFrame = { processId: 301, routingId: 401 }
      return {
        theme: {
          kind: 'light',
          tokens: { foreground: '#233659' },
          zoomFactor: 1,
          reducedMotion: false
        },
        locale: { language: 'zh-CN', direction: 'ltr', messages: {} }
      }
    })

    await expect(electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-picker-locale-navigation-race',
        method: 'media.pickFiles',
        params: {}
      }
    )).rejects.toMatchObject({ code: 'MEDIA_SCOPE_DENIED' })
    expect(electronMock.showOpenDialog).not.toHaveBeenCalled()
    expect(state.runtimeRequest).not.toHaveBeenCalled()
  })

  it('does not register a picker selection after its originating frame navigates', async () => {
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
    electronMock.showOpenDialog.mockImplementationOnce(async () => {
      guest.mainFrame = { processId: 301, routingId: 401 }
      return { canceled: false, filePaths: ['/private/media/interview.mp4'] }
    })

    await expect(electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-media-picker-navigation-race',
        method: 'media.pickFiles',
        params: {}
      }
    )).rejects.toMatchObject({ code: 'MEDIA_SCOPE_DENIED' })
    expect(state.runtimeRequest).not.toHaveBeenCalled()
  })

  it('releases picker handles when the frame navigates during runtime registration', async () => {
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
    electronMock.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/private/media/interview.mp4']
    })
    state.runtimeRequest.mockImplementationOnce(async () => {
      guest.mainFrame = { processId: 301, routingId: 401 }
      return {
        ok: true,
        status: 201,
        body: JSON.stringify({
          selections: [{
            handleId: 'media_handle_0000000001',
            mode: 'read',
            kind: 'video',
            displayName: 'interview.mp4',
            mimeType: 'video/mp4',
            revoked: false
          }]
        })
      }
    })
    state.runtimeRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: JSON.stringify({ schemaVersion: 1, result: { released: true } })
    })

    await expect(electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-media-picker-registration-race',
        method: 'media.pickFiles',
        params: {}
      }
    )).rejects.toMatchObject({ code: 'MEDIA_SCOPE_DENIED' })
    expect(state.runtimeRequest).toHaveBeenCalledTimes(2)
    const [cleanupPath, cleanupMethod, cleanupBody, cleanupHeaders] =
      state.runtimeRequest.mock.calls[1]!
    expect({ cleanupPath, cleanupMethod }).toEqual({
      cleanupPath: `/v1/extensions/view-sessions/${record.runtimeSessionId}/requests`,
      cleanupMethod: 'POST'
    })
    expect(JSON.parse(cleanupBody as string)).toMatchObject({
      method: 'media.release',
      params: { resource: 'handle', handleId: 'media_handle_0000000001' }
    })
    expect(cleanupHeaders).toEqual({
      'x-kun-extension-session-id': record.runtimeSessionId,
      'x-kun-extension-session-nonce': record.nonce
    })

    guest.mainFrame = mainFrame
    state.runtimeRequest.mockClear()
    electronMock.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/private/media/interview.mp4']
    })
    state.runtimeRequest.mockImplementationOnce(async () => {
      guest.mainFrame = { processId: 302, routingId: 402 }
      return {
        ok: true,
        status: 201,
        body: JSON.stringify({
          selections: [{
            handleId: 'media_handle_0000000002',
            mode: 'read',
            kind: 'video',
            displayName: 'interview.mp4',
            mimeType: 'video/mp4',
            revoked: false
          }]
        })
      }
    })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      state.runtimeRequest.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: JSON.stringify({ schemaVersion: 1, result: { released: false } })
      })
    }
    await expect(electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-media-picker-cleanup-failure',
        method: 'media.pickFiles',
        params: {}
      }
    )).rejects.toMatchObject({ code: 'MEDIA_REGISTRATION_FAILED' })
    expect(state.runtimeRequest).toHaveBeenCalledTimes(4)
  })

  it('rejects picker path forgery and non-main-frame senders before opening a dialog', async () => {
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

    await expect(electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-media-forged-path',
        method: 'media.pickFiles',
        params: { absolutePath: '/tmp/forged.mp4' }
      }
    )).rejects.toThrow()
    await expect(electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: { processId: 301, routingId: 401 } },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-media-subframe',
        method: 'media.pickFiles',
        params: {}
      }
    )).rejects.toMatchObject({ code: 'MEDIA_SCOPE_DENIED' })
    await expect(electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-media-forged-save-name',
        method: 'media.pickSaveTarget',
        params: { suggestedName: '../escape.mp4' }
      }
    )).rejects.toMatchObject({ code: 'MEDIA_INVALID_ARGUMENT' })
    expect(electronMock.showOpenDialog).not.toHaveBeenCalled()
    expect(electronMock.showSaveDialog).not.toHaveBeenCalled()
    expect(state.runtimeRequest).not.toHaveBeenCalled()
  })

  it('registers a save target without returning or creating the selected path', async () => {
    const state = fixture()
    const workspaceRoot = '/tmp/workspace'
    const record = state.viewSessions.create({
      sessionId: 'view_12345678-1234-1234-1234-123456789abc',
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
    electronMock.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: '/private/exports/final.mp4'
    })
    state.runtimeRequest.mockResolvedValue({
      ok: true,
      status: 201,
      body: JSON.stringify({
        selections: [{
          handleId: 'media_export_000000001',
          mode: 'export',
          kind: 'video',
          displayName: 'final.mp4',
          mimeType: 'video/mp4',
          revoked: false
        }]
      })
    })

    const response = await electronMock.handlers.get('extension:view:request')!(
      { sender: guest, senderFrame: mainFrame },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-media-save',
        method: 'media.pickSaveTarget',
        params: {
          suggestedName: 'final.mp4',
          filters: [{ name: 'MP4', extensions: ['mp4'], mimeTypes: [] }]
        }
      }
    )

    expect(response).toMatchObject({
      outcome: 'selected',
      target: { handleId: 'media_export_000000001', mode: 'export' }
    })
    expect(JSON.stringify(response)).not.toContain('/private/exports')
    expect(electronMock.showSaveDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: 'Choose export destination for acme.example',
        defaultPath: join(workspaceRoot, 'final.mp4'),
        filters: [{ name: 'MP4', extensions: ['mp4'] }]
      })
    )
    const registration = JSON.parse(state.runtimeRequest.mock.calls[0]![2] as string)
    expect(registration).toMatchObject({
      mode: 'export',
      selections: [{ absolutePath: '/private/exports/final.mp4', displayName: 'final.mp4' }]
    })
  })

})
