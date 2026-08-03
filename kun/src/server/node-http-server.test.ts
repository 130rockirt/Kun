import { describe, expect, it, vi } from 'vitest'
import { startNodeHttpServer } from './node-http-server.js'
import { jsonResponse } from './response.js'
import { Router } from './router.js'

describe('startNodeHttpServer', () => {
  it('logs sanitized context before returning an unexpected internal error', async () => {
    const router = new Router()
    router.add('POST', '/broken', () => {
      const error = new Error('rename metadata.jsonl.compact.tmp failed') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const server = await startNodeHttpServer({
      router,
      host: '127.0.0.1',
      port: 0
    })
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/broken?runtimeToken=do-not-log`,
        {
          method: 'POST',
          headers: { authorization: 'Bearer do-not-log' }
        }
      )
      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({
        code: 'internal_error',
        message: 'Internal server error.'
      })
      expect(log).toHaveBeenCalledWith(
        '[kun-http] unexpected request failure',
        {
          method: 'POST',
          pathname: '/broken',
          error: {
            name: 'Error',
            message: 'rename metadata.jsonl.compact.tmp failed',
            code: 'EPERM'
          }
        }
      )
      expect(JSON.stringify(log.mock.calls)).not.toContain('do-not-log')
    } finally {
      log.mockRestore()
      await server.close()
    }
  })

  it('does not crash when a response stream fails after headers were sent', async () => {
    const router = new Router()
    router.add('GET', '/broken-stream', () => {
      let first = true
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (first) {
            first = false
            controller.enqueue(new TextEncoder().encode('partial'))
            return
          }
          controller.error(new Error('stream failed after headers'))
        }
      }), {
        headers: { 'content-type': 'text/plain' }
      })
    })
    router.add('GET', '/health', () => jsonResponse({ status: 'ok' }))
    const server = await startNodeHttpServer({
      router,
      host: '127.0.0.1',
      port: 0
    })
    try {
      await fetch(`http://127.0.0.1:${server.port}/broken-stream`)
        .then((response) => response.text())
        .catch(() => undefined)
      await expect(fetch(`http://127.0.0.1:${server.port}/health`)
        .then((response) => response.json())).resolves.toEqual({ status: 'ok' })
    } finally {
      await server.close()
    }
  })
})
