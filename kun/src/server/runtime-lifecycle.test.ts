import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startKunServe, type KunServeHandle } from './runtime-factory.js'

const roots: string[] = []
const servers: KunServeHandle[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('runtime lifecycle API', () => {
  it('reports instance identity and only shuts down the current instance', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-runtime-lifecycle-'))
    roots.push(dataDir)
    const server = await startKunServe({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      runtimeToken: 'secret',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:9',
      model: 'test-model',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      tokenEconomyMode: false,
      insecure: false,
      launchMode: 'shared'
    })
    servers.push(server)
    const baseUrl = `http://${server.host}:${server.port}`
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' }
    const info = await fetch(`${baseUrl}/v1/runtime/info`, { headers }).then((response) => response.json())
    expect(info).toMatchObject({
      instanceId: server.instanceId,
      serviceVersion: '0.1.0',
      launchMode: 'shared'
    })

    const initialConnections = await fetch(`${baseUrl}/v1/model-connections`, { headers })
      .then((response) => response.json()) as { revision: number }
    const eventAbort = new AbortController()
    const eventResponsePromise = fetch(
      `${baseUrl}/v1/model-connections/events?since_revision=${initialConnections.revision}`,
      { headers: { ...headers, accept: 'text/event-stream' }, signal: eventAbort.signal }
    )
    const connectedResponse = await fetch(`${baseUrl}/v1/model-connections/connect`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        expectedRevision: initialConnections.revision,
        name: 'Test custom',
        baseUrl: 'https://example.com/v1',
        credential: 'must-never-be-returned',
        models: ['model-a'],
        selectedModel: 'model-a',
        probe: false
      })
    })
    const connectedText = await connectedResponse.text()
    expect(connectedResponse.status, connectedText).toBe(201)
    expect(connectedText).not.toContain('must-never-be-returned')
    const eventResponse = await eventResponsePromise
    expect(eventResponse.headers.get('content-type')).toContain('text/event-stream')
    const eventReader = eventResponse.body!.getReader()
    const eventChunk = await eventReader.read()
    expect(new TextDecoder().decode(eventChunk.value)).toContain('event: model_connections')
    eventAbort.abort()
    await eventReader.cancel().catch(() => undefined)
    const conflict = await fetch(`${baseUrl}/v1/model-connections/select`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        expectedRevision: initialConnections.revision,
        providerId: 'test-custom',
        model: 'model-a'
      })
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ code: 'revision_conflict' })

    const stale = await fetch(`${baseUrl}/v1/runtime/shutdown`, {
      method: 'POST', headers, body: JSON.stringify({ instanceId: 'stale' })
    })
    expect(stale.status).toBe(409)
    const accepted = await fetch(`${baseUrl}/v1/runtime/shutdown`, {
      method: 'POST', headers, body: JSON.stringify({ instanceId: server.instanceId })
    })
    expect(accepted.status).toBe(200)
    await server.shutdownRequested
  })
})
