import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseExtensionManifest } from '@kun/extension-api'
import {
  ExtensionPaths,
  ExtensionRegistry,
  manifestCompatibilityReport,
  type DevelopmentExtensionRecord
} from '../../src/extensions/index.js'
import { ExtensionViewSessionService } from '../../src/services/extension-view-session-service.js'
import { extensionProviderId } from '../../src/services/extension-provider-account-store.js'
import type { ExtensionAgentEvent } from '../../src/services/extension-agent-service.js'
import type { ServerRuntime } from '../../src/server/routes/server-runtime.js'
import {
  buildExtensionPublicRouter,
  EXTENSION_SESSION_ID_HEADER,
  EXTENSION_SESSION_NONCE_HEADER
} from '../../src/server/routes/extension-public.js'
import {
  WORKSPACE_ROOT,
  createFixture,
  createSession,
  dispatchJson,
  dispatchRaw,
  runtimeHeaders,
  sessionHeaders
} from './extension-public-fixture.js'

describe('extension public routes', () => {
  it('polls and streams cursor events with bounded replay and no secret projection', async () => {
    const fixture = await createFixture({ maxEvents: 3 })
    const router = buildExtensionPublicRouter(fixture.runtime)
    const created = await createSession(router)
    const headers = sessionHeaders(created.body.sessionId, created.body.nonce)

    await fixture.viewSessions.onUiRequest({
      principal: fixture.viewSessions.principal(created.body.sessionId),
      method: 'ui.postMessage',
      params: { channel: 'result', payload: { value: 1 } }
    })
    const poll = await dispatchJson(
      router,
      'GET',
      `/v1/extensions/view-sessions/${created.body.sessionId}/events?cursor=0&limit=2`,
      undefined,
      headers
    )
    expect(poll.status).toBe(200)
    expect(poll.body.events.map((event: { type: string }) => event.type)).toEqual(['session', 'message'])
    expect(JSON.stringify(poll.body)).not.toContain('route-runtime-token')
    expect(poll.body.nextCursor).toBe(2)

    const sse = await dispatchRaw(
      router,
      'GET',
      `/v1/extensions/view-sessions/${created.body.sessionId}/events?cursor=1&limit=2`,
      undefined,
      { ...headers, accept: 'text/event-stream' }
    )
    expect(sse).toBeInstanceOf(Response)
    expect((sse as Response).headers.get('content-type')).toContain('text/event-stream')
    const reader = (sse as Response).body!.getReader()
    const chunk = await reader.read()
    expect(new TextDecoder().decode(chunk.value)).toContain('event: message')
    await reader.cancel()

    await fixture.viewSessions.onUiRequest({
      principal: fixture.viewSessions.principal(created.body.sessionId),
      method: 'ui.postMessage',
      params: { channel: 'result', payload: { value: 2 } }
    })
    await fixture.viewSessions.onUiRequest({
      principal: fixture.viewSessions.principal(created.body.sessionId),
      method: 'ui.postMessage',
      params: { channel: 'result', payload: { value: 3 } }
    })
    const expired = await dispatchJson(
      router,
      'GET',
      `/v1/extensions/view-sessions/${created.body.sessionId}/events?cursor=0&limit=3`,
      undefined,
      headers
    )
    expect(expired).toMatchObject({ status: 409, body: { code: 'cursor_expired' } })
  })

  it('dispatches allowlisted Webview SDK requests through the session-bound broker', async () => {
    const fixture = await createFixture()
    fixture.broker.handlePrincipal.mockResolvedValue({
      kind: 'dark', tokens: {}, zoomFactor: 1, reducedMotion: false
    })
    const router = buildExtensionPublicRouter(fixture.runtime)
    const created = await createSession(router)
    const headers = sessionHeaders(created.body.sessionId, created.body.nonce)

    const response = await dispatchJson(
      router,
      'POST',
      `/v1/extensions/view-sessions/${created.body.sessionId}/requests`,
      { requestId: 'request-theme-1', method: 'ui.getTheme', params: {} },
      headers
    )
    expect(response).toMatchObject({
      status: 200,
      body: { result: { kind: 'dark', reducedMotion: false } }
    })
    expect(fixture.broker.handlePrincipal).toHaveBeenCalledWith(expect.objectContaining({
      principal: expect.objectContaining({
        extensionId: 'acme.dashboard',
        viewSessionId: created.body.sessionId,
        viewContributionId: 'extension:acme.dashboard/panel'
      }),
      method: 'ui.getTheme',
      requestId: 'request-theme-1'
    }))

    const protectedOperation = await dispatchJson(
      router,
      'POST',
      `/v1/extensions/view-sessions/${created.body.sessionId}/requests`,
      {
        requestId: 'request-delete-1',
        method: 'authentication.deleteAccount',
        params: { accountId: 'account-1' }
      },
      headers
    )
    expect(protectedOperation.status).toBe(403)
    expect(fixture.broker.handlePrincipal).toHaveBeenCalledTimes(1)
  })

  it('forwards guest-safe jobs and media methods without exposing credentials or registration', async () => {
    const fixture = await createFixture()
    fixture.broker.handlePrincipal
      .mockResolvedValueOnce({ items: [], page: { hasMore: false } })
      .mockResolvedValueOnce({ handleId: 'media_123456789012', streams: [] })
    const router = buildExtensionPublicRouter(fixture.runtime)
    const created = await dispatchJson(router, 'POST', '/v1/extensions/view-sessions', {
      contributionId: 'extension:acme.dashboard/panel',
      workspaceRoot: '/workspace'
    }, runtimeHeaders())
    const headers = sessionHeaders(created.body.sessionId, created.body.nonce)
    const requestPath = `/v1/extensions/view-sessions/${created.body.sessionId}/requests`

    const jobs = await dispatchJson(router, 'POST', requestPath, {
      requestId: 'request-jobs-list-1',
      method: 'jobs.list',
      params: {}
    }, headers)
    expect(jobs).toMatchObject({
      status: 200,
      body: { result: { items: [], page: { hasMore: false } } }
    })

    const media = await dispatchJson(router, 'POST', requestPath, {
      requestId: 'request-media-probe-1',
      method: 'media.probe',
      params: { handleId: 'media_123456789012' }
    }, headers)
    expect(media).toMatchObject({
      status: 200,
      body: { result: { handleId: 'media_123456789012' } }
    })

    for (const request of [
      {
        requestId: 'request-secret-reveal-1',
        method: 'authentication.revealSecret',
        params: { accountId: 'account-1', operation: 'sign request' }
      },
      {
        requestId: 'request-tool-register-1',
        method: 'tools.register',
        params: { id: 'unsafe-registration' }
      }
    ]) {
      const denied = await dispatchJson(router, 'POST', requestPath, request, headers)
      expect(denied.status).toBe(403)
    }
    expect(fixture.broker.handlePrincipal).toHaveBeenCalledTimes(2)
    expect(fixture.broker.handlePrincipal).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: 'jobs.list' })
    )
    expect(fixture.broker.handlePrincipal).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ method: 'media.probe' })
    )
  })

  it('accepts the real workbench environment only from trusted Main', async () => {
    const fixture = await createFixture()
    const router = buildExtensionPublicRouter(fixture.runtime)
    const environment = {
      theme: {
        kind: 'light',
        tokens: { foreground: '#233659' },
        zoomFactor: 1.25,
        reducedMotion: true
      },
      locale: { language: 'zh', direction: 'ltr', messages: {} }
    }
    const accepted = await dispatchJson(
      router,
      'PUT',
      '/v1/extensions/workbench/environment',
      environment,
      runtimeHeaders()
    )
    expect(accepted).toMatchObject({ status: 200, body: { accepted: true } })
    expect(fixture.viewSessions.workbenchEnvironment()).toEqual(environment)
    expect(fixture.manager.notify).toHaveBeenCalledWith(
      'acme.dashboard',
      'ui.themeChanged',
      environment.theme
    )
    expect(fixture.manager.notify).toHaveBeenCalledWith(
      'acme.dashboard',
      'ui.localeChanged',
      environment.locale
    )

    const created = await createSession(router)
    const rejected = await dispatchJson(
      router,
      'PUT',
      '/v1/extensions/workbench/environment',
      environment,
      sessionHeaders(created.body.sessionId, created.body.nonce)
    )
    expect(rejected.status).toBe(401)
  })

  it('registers Main-confirmed media selections once and returns only opaque metadata', async () => {
    const fixture = await createFixture()
    const router = buildExtensionPublicRouter(fixture.runtime)
    const created = await dispatchJson(router, 'POST', '/v1/extensions/view-sessions', {
      contributionId: 'extension:acme.dashboard/panel',
      workspaceRoot: '/workspace'
    }, runtimeHeaders())
    const body = {
      operationToken: 't'.repeat(43),
      binding: {
        sessionId: created.body.sessionId,
        runtimeSessionId: created.body.sessionId,
        sessionNonce: created.body.nonce,
        extensionId: 'acme.dashboard',
        extensionVersion: '1.0.0',
        contributionId: 'extension:acme.dashboard/panel',
        workspaceRoot: WORKSPACE_ROOT,
        senderWebContentsId: 42,
        senderMainFrameProcessId: 7,
        senderMainFrameRoutingId: 11
      },
      mode: 'read',
      selections: [{
        absolutePath: '/private/media/interview.mp4',
        displayName: 'interview.mp4'
      }]
    }

    const unauthorized = await dispatchJson(
      router,
      'POST',
      '/v1/extensions/media/selections',
      body
    )
    expect(unauthorized.status).toBe(401)
    expect(fixture.mediaHandles.register).not.toHaveBeenCalled()

    const registered = await dispatchJson(
      router,
      'POST',
      '/v1/extensions/media/selections',
      body,
      runtimeHeaders()
    )
    expect(registered).toMatchObject({
      status: 201,
      body: {
        selections: [{
          handleId: 'media_handle_0000000001',
          mode: 'read',
          kind: 'video',
          displayName: 'interview.mp4',
          mimeType: 'video/mp4',
          revoked: false
        }]
      }
    })
    expect(JSON.stringify(registered.body)).not.toContain('/private/media')
    expect(JSON.stringify(registered.body)).not.toContain('operationToken')
    expect(JSON.stringify(registered.body)).not.toContain(created.body.nonce)
    expect(fixture.mediaHandles.register).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionId: 'acme.dashboard',
        extensionVersion: '1.0.0',
        viewSessionId: created.body.sessionId,
        viewContributionId: 'extension:acme.dashboard/panel',
        workspaceRoots: [WORKSPACE_ROOT]
      }),
      {
        workspaceRoot: WORKSPACE_ROOT,
        path: '/private/media/interview.mp4',
        mode: 'read',
        source: 'picker',
        displayName: 'interview.mp4'
      }
    )

    const replayed = await dispatchJson(
      router,
      'POST',
      '/v1/extensions/media/selections',
      body,
      runtimeHeaders()
    )
    expect(replayed).toMatchObject({
      status: 409,
      body: { code: 'conflict' }
    })
    expect(fixture.mediaHandles.register).toHaveBeenCalledTimes(1)
  })

  it('burns a protected media token when its View binding is forged', async () => {
    const fixture = await createFixture()
    const router = buildExtensionPublicRouter(fixture.runtime)
    const created = await dispatchJson(router, 'POST', '/v1/extensions/view-sessions', {
      contributionId: 'extension:acme.dashboard/panel',
      workspaceRoot: WORKSPACE_ROOT
    }, runtimeHeaders())
    const binding = {
      sessionId: created.body.sessionId,
      runtimeSessionId: created.body.sessionId,
      sessionNonce: created.body.nonce,
      extensionId: 'acme.dashboard',
      extensionVersion: '1.0.0',
      contributionId: 'extension:acme.dashboard/panel',
      workspaceRoot: WORKSPACE_ROOT,
      senderWebContentsId: 42,
      senderMainFrameProcessId: 7,
      senderMainFrameRoutingId: 11
    }
    const selection = {
      operationToken: 'f'.repeat(43),
      binding: { ...binding, extensionId: 'other.extension' },
      mode: 'export',
      selections: [{ absolutePath: '/private/exports/final.mp4', displayName: 'final.mp4' }]
    }
    const forged = await dispatchJson(
      router,
      'POST',
      '/v1/extensions/media/selections',
      selection,
      runtimeHeaders()
    )
    expect(forged.status).toBe(401)
    expect(fixture.mediaHandles.register).not.toHaveBeenCalled()

    const retried = await dispatchJson(
      router,
      'POST',
      '/v1/extensions/media/selections',
      { ...selection, binding },
      runtimeHeaders()
    )
    expect(retried).toMatchObject({ status: 409, body: { code: 'conflict' } })
    expect(fixture.mediaHandles.register).not.toHaveBeenCalled()
  })

  it('resolves a readable handle for Main lease creation without exposing it to a View route', async () => {
    const fixture = await createFixture()
    const router = buildExtensionPublicRouter(fixture.runtime)
    const created = await dispatchJson(router, 'POST', '/v1/extensions/view-sessions', {
      contributionId: 'extension:acme.dashboard/panel',
      workspaceRoot: WORKSPACE_ROOT
    }, runtimeHeaders())
    const binding = {
      sessionId: created.body.sessionId,
      runtimeSessionId: created.body.sessionId,
      sessionNonce: created.body.nonce,
      extensionId: 'acme.dashboard',
      extensionVersion: '1.0.0',
      contributionId: 'extension:acme.dashboard/panel',
      workspaceRoot: WORKSPACE_ROOT,
      senderWebContentsId: 42,
      senderMainFrameProcessId: 7,
      senderMainFrameRoutingId: 11
    }
    const unauthorized = await dispatchJson(router, 'POST', '/v1/extensions/media/leases/resolve', {
      binding,
      handleId: 'media_handle_0000000001'
    })
    expect(unauthorized.status).toBe(401)
    const resolved = await dispatchJson(router, 'POST', '/v1/extensions/media/leases/resolve', {
      binding,
      handleId: 'media_handle_0000000001',
      requestedTtlMs: 60_000
    }, runtimeHeaders())
    expect(resolved).toMatchObject({
      status: 200,
      body: {
        handleId: 'media_handle_0000000001',
        absolutePath: '/private/media/interview.mp4',
        mimeType: 'video/mp4',
        fileIdentity: { byteSize: 1234, modifiedAtMs: 1000, device: 2, inode: 3 }
      }
    })
    expect(fixture.mediaHandles.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionId: 'acme.dashboard',
        viewSessionId: created.body.sessionId,
        workspaceRoots: [WORKSPACE_ROOT]
      }),
      'media_handle_0000000001',
      'read'
    )

    const artifact = await dispatchJson(router, 'POST', '/v1/extensions/media/artifacts/resolve', {
      artifactId: 'artifact_1234567890',
      ownerExtensionId: 'acme.dashboard',
      ownerExtensionVersion: '1.0.0',
      workspaceId: fixture.paths.workspaceKey(WORKSPACE_ROOT),
      workspaceRoot: WORKSPACE_ROOT
    }, runtimeHeaders())
    expect(artifact).toMatchObject({
      status: 200,
      body: {
        artifactId: 'artifact_1234567890',
        absolutePath: '/private/media/interview.mp4',
        displayName: 'interview.mp4',
        mimeType: 'video/mp4'
      }
    })
    const forgedWorkspace = await dispatchJson(router, 'POST', '/v1/extensions/media/artifacts/resolve', {
      artifactId: 'artifact_1234567890',
      ownerExtensionId: 'acme.dashboard',
      ownerExtensionVersion: '1.0.0',
      workspaceId: fixture.paths.workspaceKey(WORKSPACE_ROOT),
      workspaceRoot: '/other-workspace'
    }, runtimeHeaders())
    expect(forgedWorkspace.status).toBe(404)
  })

  it('delivers host-owned notifications without a View Session and resolves declared actions', async () => {
    const fixture = await createFixture()
    const router = buildExtensionPublicRouter(fixture.runtime)

    const unauthorized = await dispatchJson(
      router,
      'GET',
      '/v1/extensions/workbench/notifications'
    )
    expect(unauthorized.status).toBe(401)

    await expect(fixture.viewSessions.publishNotification({
      extensionId: 'acme.dashboard',
      extensionVersion: '1.0.0'
    }, {
      id: 'headless-notice',
      title: 'No workbench',
      message: 'An unauthorized poll must not establish workbench presence.',
      actions: []
    })).resolves.toBeUndefined()

    const connected = await dispatchJson(
      router,
      'GET',
      '/v1/extensions/workbench/notifications',
      undefined,
      runtimeHeaders()
    )
    expect(connected).toMatchObject({
      status: 200,
      body: { schemaVersion: 1, notifications: [] }
    })

    const selection = fixture.viewSessions.publishNotification({
      extensionId: 'acme.dashboard',
      extensionVersion: '1.0.0'
    }, {
      id: 'retry-notice',
      title: 'Provider unavailable',
      message: 'Reconnect the account and retry.',
      severity: 'warning',
      actions: [{ id: 'retry', title: 'Retry' }]
    })
    const listed = await dispatchJson(
      router,
      'GET',
      '/v1/extensions/workbench/notifications',
      undefined,
      runtimeHeaders()
    )
    expect(listed).toMatchObject({
      status: 200,
      body: {
        schemaVersion: 1,
        notifications: [{
          extensionId: 'acme.dashboard',
          sourceId: 'retry-notice',
          actions: [{ id: 'retry', title: 'Retry' }]
        }]
      }
    })
    const notificationId = listed.body.notifications[0].notificationId as string
    const spoofed = await dispatchJson(
      router,
      'POST',
      `/v1/extensions/workbench/notifications/${notificationId}/respond`,
      { actionId: 'undeclared' },
      runtimeHeaders()
    )
    expect(spoofed.status).toBe(401)

    const responded = await dispatchJson(
      router,
      'POST',
      `/v1/extensions/workbench/notifications/${notificationId}/respond`,
      { actionId: 'retry' },
      runtimeHeaders()
    )
    expect(responded).toMatchObject({ status: 200, body: { responded: true } })
    await expect(selection).resolves.toBe('retry')
    expect(fixture.viewSessions.listWorkbenchNotifications()).toEqual([])

    const disconnectedSelection = fixture.viewSessions.publishNotification({
      extensionId: 'acme.dashboard',
      extensionVersion: '1.0.0'
    }, {
      id: 'disconnect-notice',
      title: 'Disconnecting',
      message: 'The workbench is closing.',
      actions: []
    })
    const disconnected = await dispatchJson(
      router,
      'DELETE',
      '/v1/extensions/workbench/presence',
      undefined,
      runtimeHeaders()
    )
    expect(disconnected).toMatchObject({ status: 200, body: { disconnected: true } })
    await expect(disconnectedSelection).resolves.toBeUndefined()
  })
})
