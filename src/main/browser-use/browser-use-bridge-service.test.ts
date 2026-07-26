import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { BrowserUseBridgeService } from './browser-use-bridge-service'

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
          contractVersion: 1,
          requestId: randomUUID(),
          threadId: 'thread-1',
          turnId: 'turn-1',
          action: { action: 'click', ref: 'opaque-reference-1234', selector: '#buy' }
        })
      })
      expect(invalid).toMatchObject({ status: 400, body: { error: 'invalid_request' } })

      const requestId = randomUUID()
      const valid = await rawRequest(`${launch.url}/v1/actions`, {
        token: launch.token,
        contentType: 'application/json',
        body: JSON.stringify({
          contractVersion: 1,
          requestId,
          threadId: 'thread-1',
          turnId: 'turn-1',
          action: { action: 'snapshot' }
        })
      })
      expect(valid).toMatchObject({
        status: 200,
        body: {
          contractVersion: 1,
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
      expect(second.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    } finally {
      await service.stop()
    }
  })
})
