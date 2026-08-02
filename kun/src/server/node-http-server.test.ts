import { describe, expect, it } from 'vitest'
import { startNodeHttpServer } from './node-http-server.js'
import { jsonResponse } from './response.js'
import { Router } from './router.js'

describe('startNodeHttpServer', () => {
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
