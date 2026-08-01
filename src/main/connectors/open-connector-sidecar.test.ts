import { createServer } from 'node:net'
import { createHmac } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OpenConnectorSidecar,
  PINNED_OPEN_CONNECTOR_VERSION,
  resolveOpenConnectorRuntime,
  verifyOpenConnectorInstanceProof
} from './open-connector-sidecar'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ))
})

describe('OpenConnector sidecar', () => {
  it('resolves only a compatible runtime whose entrypoint remains inside its root', async () => {
    const fixture = await createRuntimeFixture()
    await expect(resolveOpenConnectorRuntime({
      isPackaged: false,
      resourcesPath: fixture.root,
      appRoot: fixture.root,
      environment: { KUN_OPENCONNECTOR_RUNTIME_DIR: fixture.runtimeRoot }
    })).resolves.toMatchObject({
      root: fixture.runtimeRoot,
      entrypoint: fixture.entrypoint,
      metadata: { version: PINNED_OPEN_CONNECTOR_VERSION, protocolVersion: '1' }
    })

    await writeRuntimeMetadata(fixture.runtimeRoot, { protocolVersion: '2' })
    await expect(resolveOpenConnectorRuntime({
      isPackaged: false,
      resourcesPath: fixture.root,
      appRoot: fixture.root,
      environment: { KUN_OPENCONNECTOR_RUNTIME_DIR: fixture.runtimeRoot }
    })).rejects.toThrow('does not match required protocol')

    await writeRuntimeMetadata(fixture.runtimeRoot, { entrypoint: '../escape.mjs' })
    await expect(resolveOpenConnectorRuntime({
      isPackaged: false,
      resourcesPath: fixture.root,
      appRoot: fixture.root,
      environment: { KUN_OPENCONNECTOR_RUNTIME_DIR: fixture.runtimeRoot }
    })).rejects.toThrow('escapes its runtime root')
  })

  it('reports a port conflict without stopping the process that owns the port', async () => {
    const fixture = await createRuntimeFixture()
    const occupied = createServer()
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen({ host: '127.0.0.1', port: 0 }, resolve)
    })
    const address = occupied.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP address')
    const sidecar = createSidecar(fixture, [])
    try {
      const health = await sidecar.start(address.port)
      expect(health).toMatchObject({ state: 'port_conflict', managed: false, port: address.port })
      expect(occupied.listening).toBe(true)
    } finally {
      await sidecar.stop()
      await new Promise<void>((resolve) => occupied.close(() => resolve()))
    }
  })

  it('does not disclose authorization while proving sidecar ownership', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      return Response.json({
        ok: true,
        runtime: 'open-connector',
        runtimeVersion: PINNED_OPEN_CONNECTOR_VERSION,
        protocolVersion: '1',
        instanceProof: '00'.repeat(32)
      })
    })

    await expect(verifyOpenConnectorInstanceProof(
      fetchImpl,
      'http://127.0.0.1:18898',
      'ab'.repeat(32)
    )).resolves.toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('accepts a matching unauthenticated instance proof', async () => {
    const proofKey = 'ab'.repeat(32)
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      const challenge = new URL(String(input)).searchParams.get('challenge') ?? ''
      return Response.json({
        ok: true,
        runtime: 'open-connector',
        runtimeVersion: PINNED_OPEN_CONNECTOR_VERSION,
        protocolVersion: '1',
        instanceProof: createHmac('sha256', Buffer.from(proofKey, 'hex'))
          .update(challenge)
          .digest('hex')
      })
    })

    await expect(verifyOpenConnectorInstanceProof(
      fetchImpl,
      'http://127.0.0.1:18898',
      proofKey
    )).resolves.toBe(true)
  })

  it('ignores development runtime overrides in packaged applications', async () => {
    const fixture = await createRuntimeFixture()
    const resourcesPath = join(fixture.root, 'packaged-resources')
    const packagedRoot = join(resourcesPath, 'open-connector', 'current')
    const packagedEntrypoint = await writeRuntimeTree(packagedRoot)
    await writeRuntimeMetadata(fixture.runtimeRoot, { protocolVersion: '2' })

    await expect(resolveOpenConnectorRuntime({
      isPackaged: true,
      resourcesPath,
      appRoot: fixture.root,
      environment: { KUN_OPENCONNECTOR_RUNTIME_DIR: fixture.runtimeRoot }
    })).resolves.toMatchObject({
      root: packagedRoot,
      entrypoint: packagedEntrypoint,
      metadata: { protocolVersion: '1' }
    })
  })

  it('coalesces concurrent starts, redacts child output, restarts after a crash, and stops cleanly', async () => {
    const fixture = await createRuntimeFixture()
    const logs: string[] = []
    const sidecar = createSidecar(fixture, logs)
    const port = await freePort()
    try {
      const starts = await Promise.all([
        sidecar.start(port),
        sidecar.start(port),
        sidecar.start(port)
      ])
      expect(starts.every((health) => health.state === 'running')).toBe(true)
      expect(new Set(starts.map((health) => health.pid)).size).toBe(1)
      expect(logs.join('\n')).toContain('[REDACTED]')
      expect(logs.join('\n')).not.toContain(sidecar.runtimeToken)
      expect(sidecar.instanceProofKey).toMatch(/^[a-f0-9]{64}$/)
      expect(logs.join('\n')).not.toContain(sidecar.instanceProofKey!)
      expect(logs.join('\n')).not.toContain('must-not-leak-to-sidecar')
      const firstPid = starts[0]!.pid

      await fetch(`http://127.0.0.1:${port}/crash`).catch(() => undefined)
      const restarted = await waitFor(async () => {
        const health = await sidecar.health()
        return health.state === 'running' && health.pid !== firstPid ? health : null
      }, 6_000)
      expect(restarted.pid).not.toBe(firstPid)

      const stopped = await sidecar.stop()
      expect(stopped).toMatchObject({ state: 'stopped', managed: false, enabled: false })
      expect(await canBind(port)).toBe(true)
    } finally {
      await sidecar.stop()
    }
  }, 15_000)

  it('reuses the encrypted instance proof across desktop host restarts', async () => {
    const fixture = await createRuntimeFixture()
    const port = await freePort()
    const first = createSidecar(fixture, [])
    const second = createSidecar(fixture, [])
    try {
      await expect(first.start(port)).resolves.toMatchObject({ state: 'running' })
      const persistedProof = first.instanceProofKey
      await first.stop()

      await expect(second.start(port)).resolves.toMatchObject({ state: 'running' })
      expect(second.instanceProofKey).toBe(persistedProof)
    } finally {
      await first.stop()
      await second.stop()
    }
  }, 15_000)
})

function createSidecar(
  fixture: Awaited<ReturnType<typeof createRuntimeFixture>>,
  logs: string[]
): OpenConnectorSidecar {
  return new OpenConnectorSidecar({
    userDataDir: join(fixture.root, 'user-data'),
    isPackaged: false,
    resourcesPath: fixture.root,
    appRoot: fixture.root,
    execPath: process.execPath,
    environment: {
      ...process.env,
      DEEPSEEK_API_KEY: 'must-not-leak-to-sidecar',
      KUN_OPENCONNECTOR_RUNTIME_DIR: fixture.runtimeRoot
    },
    log: (_level, message, details) => {
      logs.push(`${message} ${JSON.stringify(details ?? {})}`)
    }
  })
}

async function createRuntimeFixture(): Promise<{
  root: string
  runtimeRoot: string
  entrypoint: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'kun-openconnector-sidecar-'))
  temporaryRoots.push(root)
  const runtimeRoot = join(root, 'runtime')
  const entrypoint = await writeRuntimeTree(runtimeRoot)
  return { root, runtimeRoot, entrypoint }
}

async function writeRuntimeTree(runtimeRoot: string): Promise<string> {
  const entrypoint = join(runtimeRoot, 'dist', 'server', 'index.mjs')
  await mkdir(join(runtimeRoot, 'dist', 'server'), { recursive: true })
  await writeFile(entrypoint, `
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
const token = process.env.OOMOL_CONNECT_RUNTIME_TOKEN ?? ''
const proofKey = process.env.OOMOL_CONNECT_INSTANCE_PROOF_KEY ?? ''
console.error('bootstrap', process.env.OOMOL_CONNECT_ADMIN_TOKEN, token, proofKey, process.env.OOMOL_CONNECT_ENCRYPTION_KEY, process.env.DEEPSEEK_API_KEY)
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/crash') process.exit(7)
  if (url.pathname === '/health') {
    const challenge = url.searchParams.get('challenge') ?? ''
    const instanceProof = createHmac('sha256', Buffer.from(proofKey, 'hex')).update(challenge).digest('hex')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      ok: true,
      runtime: 'open-connector',
      runtimeVersion: '${PINNED_OPEN_CONNECTOR_VERSION}',
      protocolVersion: '1',
      instanceProof
    }))
    return
  }
  if (url.pathname !== '/v1/health' || request.headers.authorization !== 'Bearer ' + token) {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'unauthorized', message: 'Unauthorized.' } }))
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({
    success: true,
    message: 'OK',
    data: { ok: true, runtime: 'open-connector', runtimeVersion: '${PINNED_OPEN_CONNECTOR_VERSION}', protocolVersion: '1' },
    meta: {}
  }))
})
server.listen(Number(process.env.PORT), '127.0.0.1')
process.once('SIGTERM', () => server.close(() => process.exit(0)))
`)
  await writeRuntimeMetadata(runtimeRoot)
  return entrypoint
}

async function writeRuntimeMetadata(
  runtimeRoot: string,
  patch: { protocolVersion?: string; entrypoint?: string } = {}
): Promise<void> {
  await writeFile(join(runtimeRoot, 'runtime.json'), `${JSON.stringify({
    schemaVersion: 1,
    name: 'open-connector',
    version: PINNED_OPEN_CONNECTOR_VERSION,
    protocolVersion: patch.protocolVersion ?? '1',
    nodeRange: '>=22',
    entrypoint: patch.entrypoint ?? 'dist/server/index.mjs'
  }, null, 2)}\n`)
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

async function canBind(port: number): Promise<boolean> {
  const server = createServer()
  return await new Promise((resolve) => {
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close(() => resolve(true))
    })
  })
}

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== null) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`)
}
