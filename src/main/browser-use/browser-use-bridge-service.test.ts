import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { signBrowserUseKunApprovalGrant } from '../../../kun/src/contracts/browser-use'
import { ToolOperationJournal } from '../../../kun/src/reliability/operation-journal'
import { BrowserUseBridgeService } from './browser-use-bridge-service'

const expectedTarget = {
  sessionId: 'session-1234567890',
  tabId: 'tab-1',
  documentGeneration: 3,
  origin: 'https://example.test',
  sanitizedUrl: 'https://example.test/settings/security',
  role: 'button',
  name: 'Delete account'
}

function fakeManager() {
  return {
    execute: vi.fn(async () => ({
      ok: true,
      code: 'snapshot',
      message: 'bounded result'
    })),
    disposeAll: vi.fn(async () => undefined)
  }
}

function approvalGrant(
  action: Record<string, unknown>,
  signingKey: string,
  id = `appr_${'a'.repeat(32)}`
) {
  const issuedAt = new Date()
  return signBrowserUseKunApprovalGrant({
    id,
    source: 'agent' as const,
    toolName: 'browser_use' as const,
    threadId: 'thread-1',
    turnId: 'turn-1',
    callId: 'call-browser-use',
    argumentsHash: ToolOperationJournal.argsHash(action),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 2 * 60 * 1_000).toISOString()
  }, signingKey)
}

async function rawRequest(
  url: string,
  options: {
    method?: string
    host?: string
    token?: string
    contentType?: string
    body?: string
    contentLength?: number
  } = {}
): Promise<{ status: number | undefined; body: unknown }> {
  const parsed = new URL(url)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname,
      method: options.method ?? 'POST',
      headers: {
        host: options.host ?? parsed.host,
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.contentType ? { 'content-type': options.contentType } : {}),
        ...(options.contentLength !== undefined
          ? { 'content-length': String(options.contentLength) }
          : {})
      }
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({
          status: response.statusCode,
          body: text ? JSON.parse(text) : undefined
        })
      })
    })
    request.once('error', reject)
    if (options.body) request.write(options.body)
    request.end()
  })
}

describe('BrowserUseBridgeService', () => {
  it('requires exact Host, launch bearer, method, path, and content type', async () => {
    const manager = fakeManager()
    const service = new BrowserUseBridgeService(manager as never)
    const launch = await service.start()
    try {
      await expect(rawRequest(`${launch.url}/v1/actions`, {
        host: 'evil.example',
        token: launch.token,
        contentType: 'application/json',
        body: '{}'
      })).resolves.toMatchObject({ status: 400, body: { error: 'invalid_host' } })

      await expect(rawRequest(`${launch.url}/v1/actions`, {
        token: 'wrong-token',
        contentType: 'application/json',
        body: '{}'
      })).resolves.toMatchObject({ status: 401, body: { error: 'unauthorized' } })

      await expect(rawRequest(`${launch.url}/v1/actions`, {
        token: launch.token,
        contentType: 'text/plain',
        body: '{}'
      })).resolves.toMatchObject({ status: 415, body: { error: 'content_type_required' } })

      await expect(rawRequest(`${launch.url}/not-an-operation`, {
        token: launch.token,
        contentType: 'application/json',
        body: '{}'
      })).resolves.toMatchObject({ status: 404, body: { error: 'unsupported_operation' } })
      expect(manager.execute).not.toHaveBeenCalled()
    } finally {
      await service.stop()
    }
  })

  it('strictly validates actions and never reflects the launch token', async () => {
    const manager = fakeManager()
    const service = new BrowserUseBridgeService(manager as never)
    const launch = await service.start()
    try {
      const invalid = await rawRequest(`${launch.url}/v1/actions`, {
        token: launch.token,
        contentType: 'application/json',
        body: JSON.stringify({
          contractVersion: 2,
          requestId: randomUUID(),
          threadId: 'thread-1',
          turnId: 'turn-1',
          action: {
            action: 'click',
            ref: 'opaque-reference-1234',
            expectedTarget,
            selector: '#buy'
          }
        })
      })
      expect(invalid).toMatchObject({ status: 400, body: { error: 'invalid_request' } })

      const modeInjection = await rawRequest(`${launch.url}/v1/actions`, {
        token: launch.token,
        contentType: 'application/json',
        body: JSON.stringify({
          contractVersion: 2,
          requestId: randomUUID(),
          threadId: 'thread-1',
          turnId: 'turn-1',
          action: { action: 'snapshot' },
          kunApprovalMode: 'full-access'
        })
      })
      expect(modeInjection).toMatchObject({
        status: 400,
        body: { error: 'invalid_request' }
      })
      expect(manager.execute).not.toHaveBeenCalled()

      const requestId = randomUUID()
      const valid = await rawRequest(`${launch.url}/v1/actions`, {
        token: launch.token,
        contentType: 'application/json',
        body: JSON.stringify({
          contractVersion: 2,
          requestId,
          threadId: 'thread-1',
          turnId: 'turn-1',
          action: { action: 'snapshot' }
        })
      })
      expect(valid).toMatchObject({
        status: 200,
        body: {
          contractVersion: 2,
          requestId,
          result: { ok: true, code: 'snapshot' }
        }
      })
      expect(JSON.stringify(valid.body)).not.toContain(launch.token)
      expect(manager.execute).toHaveBeenCalledWith(
        'thread-1',
        'turn-1',
        { action: 'snapshot' },
        expect.any(AbortSignal)
      )
    } finally {
      await service.stop()
    }
  })

  it('requires, binds, and consumes one Kun approval grant per boundary action', async () => {
    const manager = fakeManager()
    const service = new BrowserUseBridgeService(manager as never)
    const launch = await service.start()
    const action = { action: 'open', url: 'https://example.test/path' }
    const grant = approvalGrant(action, launch.approvalSigningKey)
    const requestBody = (
      requestId: string,
      value = grant,
      overrides: Partial<{
        threadId: string
        turnId: string
        action: Record<string, unknown>
      }> = {}
    ) => JSON.stringify({
      contractVersion: 2,
      requestId,
      threadId: overrides.threadId ?? 'thread-1',
      turnId: overrides.turnId ?? 'turn-1',
      action: overrides.action ?? action,
      kunApprovalMode: 'agent',
      kunApprovalGrant: value
    })
    try {
      await expect(rawRequest(`${launch.url}/v1/actions`, {
        token: launch.token,
        contentType: 'application/json',
        body: JSON.stringify({
          contractVersion: 2,
          requestId: randomUUID(),
          threadId: 'thread-1',
          turnId: 'turn-1',
          action
        })
      })).resolves.toMatchObject({ status: 400, body: { error: 'invalid_request' } })

      await expect(rawRequest(`${launch.url}/v1/actions`, {
        token: launch.token,
        contentType: 'application/json',
        body: requestBody(randomUUID(), {
          ...grant,
          argumentsHash: 'f'.repeat(64)
        })
      })).resolves.toMatchObject({
        status: 400,
        body: { error: 'approval_grant_invalid' }
      })
      expect(manager.execute).not.toHaveBeenCalled()

      await expect(rawRequest(`${launch.url}/v1/actions`, {
        token: launch.token,
        contentType: 'application/json',
        body: requestBody(randomUUID(), {
          ...grant,
          id: `appr_${'f'.repeat(32)}`,
          signature: 'f'.repeat(64)
        })
      })).resolves.toMatchObject({
        status: 400,
        body: { error: 'approval_grant_invalid' }
      })

      await expect(rawRequest(`${launch.url}/v1/actions`, {
        token: launch.token,
        contentType: 'application/json',
        body: requestBody(randomUUID(), grant, { threadId: 'thread-substituted' })
      })).resolves.toMatchObject({
        status: 400,
        body: { error: 'approval_grant_invalid' }
      })

      await expect(rawRequest(`${launch.url}/v1/actions`, {
        token: launch.token,
        contentType: 'application/json',
        body: requestBody(randomUUID(), grant, { turnId: 'turn-substituted' })
      })).resolves.toMatchObject({
        status: 400,
        body: { error: 'approval_grant_invalid' }
      })

      await expect(rawRequest(`${launch.url}/v1/actions`, {
        token: launch.token,
        contentType: 'application/json',
        body: requestBody(randomUUID(), grant, {
          action: { action: 'open', url: 'https://substituted.example/path' }
        })
      })).resolves.toMatchObject({
        status: 400,
        body: { error: 'approval_grant_invalid' }
      })
      expect(manager.execute).not.toHaveBeenCalled()

      await expect(rawRequest(`${launch.url}/v1/actions`, {
        token: launch.token,
        contentType: 'application/json',
        body: requestBody(randomUUID())
      })).resolves.toMatchObject({ status: 200 })
      expect(manager.execute).toHaveBeenCalledWith(
        'thread-1',
        'turn-1',
        action,
        expect.any(AbortSignal),
        grant,
        'agent'
      )

      await expect(rawRequest(`${launch.url}/v1/actions`, {
        token: launch.token,
        contentType: 'application/json',
        body: requestBody(randomUUID())
      })).resolves.toMatchObject({
        status: 409,
        body: { error: 'approval_grant_replayed' }
      })
      expect(manager.execute).toHaveBeenCalledOnce()
    } finally {
      await service.stop()
    }
  })

  it('rejects an interaction when its reviewer-visible expected target is substituted', async () => {
    const manager = fakeManager()
    const service = new BrowserUseBridgeService(manager as never)
    const launch = await service.start()
    const action = {
      action: 'click',
      ref: 'opaque-reference-1234',
      expectedTarget
    }
    const grant = approvalGrant(action, launch.approvalSigningKey)
    try {
      const result = await rawRequest(`${launch.url}/v1/actions`, {
        token: launch.token,
        contentType: 'application/json',
        body: JSON.stringify({
          contractVersion: 2,
          requestId: randomUUID(),
          threadId: 'thread-1',
          turnId: 'turn-1',
          action: {
            ...action,
            expectedTarget: {
              ...expectedTarget,
              name: 'Approve transfer'
            }
          },
          kunApprovalMode: 'agent',
          kunApprovalGrant: grant
        })
      })

      expect(result).toMatchObject({
        status: 400,
        body: { error: 'approval_grant_invalid' }
      })
      expect(manager.execute).not.toHaveBeenCalled()
    } finally {
      await service.stop()
    }
  })

  it('rejects declared oversized bodies and rotates launch authority', async () => {
    const manager = fakeManager()
    const service = new BrowserUseBridgeService(manager as never)
    const first = await service.start()
    await expect(rawRequest(`${first.url}/v1/actions`, {
      token: first.token,
      contentType: 'application/json',
      contentLength: 70_000
    })).resolves.toMatchObject({ status: 413, body: { error: 'request_too_large' } })

    await service.stop()
    const second = await service.start()
    try {
      expect(second.token).not.toBe(first.token)
      expect(second.approvalSigningKey).not.toBe(first.approvalSigningKey)
      expect(second.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    } finally {
      await service.stop()
    }
  })
})
