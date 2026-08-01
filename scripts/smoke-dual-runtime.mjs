import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  ensureSharedRuntime,
  resolveSharedRuntime,
  stopSharedRuntime
} from '../kun/dist/cli/shared-runtime.js'
import {
  ManagerThreadExecutionLeaseClient,
  ensureServiceManager,
  readManagerRuntime,
  resolveServiceManager
} from '../kun/dist/manager/manager-client.js'
import { readManagerDiscovery } from '../kun/dist/manager/manager-discovery.js'
import { ThreadExecutionBusyError } from '../kun/dist/ports/thread-execution-lease.js'
import { KunTuiClient } from '../kun/dist/tui/client.js'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'kun-dual-runtime-smoke-'))
const dataDir = join(root, 'data')
const controlDir = join(root, 'control')
const settingsPath = join(root, 'settings.json')
let manager

try {
  manager = await ensureServiceManager({
    flavor: 'production',
    controlDir,
    dataDir,
    settingsPath
  })
  const production = await ensureSharedRuntime({
    dataDir,
    controlDir,
    manager,
    runtimeFlavor: 'production'
  })
  const development = await ensureSharedRuntime({
    dataDir,
    controlDir,
    manager,
    runtimeFlavor: 'development'
  })

  assert.notEqual(production.discovery.pid, development.discovery.pid)
  assert.notEqual(production.discovery.port, development.discovery.port)
  assert.notEqual(production.discovery.runtimeToken, development.discovery.runtimeToken)
  assert.notEqual(production.discovery.buildId, development.discovery.buildId)
  assert.notEqual(production.discovery.logPath, development.discovery.logPath)
  assert.equal(production.discovery.flavor ?? 'production', 'production')
  assert.equal(development.discovery.flavor, 'development')

  const [productionCommand, developmentCommand] = await Promise.all([
    processCommand(production.discovery.pid),
    processCommand(development.discovery.pid)
  ])
  if (process.platform !== 'win32') {
    assert.match(productionCommand, /kun-runtime/u)
    assert.match(developmentCommand, /kun-dv-runtime/u)
  }

  const productionClient = new KunTuiClient({
    baseUrl: production.discovery.baseUrl,
    runtimeToken: production.discovery.runtimeToken
  })
  const developmentClient = new KunTuiClient({
    baseUrl: development.discovery.baseUrl,
    runtimeToken: development.discovery.runtimeToken
  })
  const thread = await productionClient.createThread({
    title: 'dual-runtime-smoke',
    workspace: root,
    model: 'gpt-5.6-luna'
  })
  await waitFor(async () => (await developmentClient.listThreads()).some(
    (candidate) => candidate.id === thread.id
  ))

  const productionLease = new ManagerThreadExecutionLeaseClient(
    manager,
    'production',
    production.discovery.instanceId
  )
  const developmentLease = new ManagerThreadExecutionLeaseClient(
    manager,
    'development',
    development.discovery.instanceId
  )
  await productionLease.acquire(thread.id, 'turn_smoke_production')
  await assert.rejects(
    () => developmentLease.acquire(thread.id, 'turn_smoke_development'),
    ThreadExecutionBusyError
  )
  await productionLease.release(thread.id, 'turn_smoke_production')
  productionLease.shutdown()
  developmentLease.shutdown()

  const originalManagerPid = manager.discovery.pid
  process.kill(originalManagerPid, process.platform === 'win32' ? undefined : 'SIGKILL')
  manager = await waitForValue(async () => {
    const discovery = await readManagerDiscovery(controlDir).catch(() => null)
    if (!discovery || discovery.pid === originalManagerPid) return undefined
    const recovered = await resolveServiceManager(controlDir).catch(() => null)
    if (!recovered) return undefined
    const [productionSlot, developmentSlot] = await Promise.all([
      readManagerRuntime(recovered, 'production'),
      readManagerRuntime(recovered, 'development')
    ])
    return productionSlot?.pid === production.discovery.pid &&
      developmentSlot?.pid === development.discovery.pid
      ? recovered
      : undefined
  }, 30_000)

  const productionPid = production.discovery.pid
  assert.equal(await stopSharedRuntime(dataDir, fetch, {
    runtimeFlavor: 'development',
    controlDir
  }), true)
  const productionAfterDvStop = await resolveSharedRuntime(dataDir, fetch, {
    runtimeFlavor: 'production',
    controlDir
  })
  assert.equal(productionAfterDvStop?.discovery.pid, productionPid)

  process.stdout.write(`${JSON.stringify({
    managerPid: manager.discovery.pid,
    productionPid,
    developmentPid: development.discovery.pid,
    productionPort: production.discovery.port,
    developmentPort: development.discovery.port,
    productionBuildId: production.discovery.buildId,
    developmentBuildId: development.discovery.buildId,
    sharedThreadId: thread.id,
    managerRecovered: manager.discovery.pid !== originalManagerPid,
    productionSurvivedDvStop: productionAfterDvStop?.discovery.pid === productionPid
  }, null, 2)}\n`)
} catch (error) {
  for (const path of [
    join(controlDir, 'manager.log'),
    join(dataDir, 'logs', 'runtime.log'),
    join(dataDir, 'logs', 'runtime.development.log')
  ]) {
    const text = await readFile(path, 'utf8').catch(() => '')
    if (text) process.stderr.write(`\n[${path}]\n${text.slice(-8_000)}\n`)
  }
  throw error
} finally {
  await stopSharedRuntime(dataDir, fetch, {
    runtimeFlavor: 'development',
    controlDir
  }).catch(() => false)
  await stopSharedRuntime(dataDir, fetch, {
    runtimeFlavor: 'production',
    controlDir
  }).catch(() => false)
  const discovery = await readManagerDiscovery(controlDir).catch(() => null)
  if (discovery && discovery.dataDir === dataDir) {
    await fetch(`${discovery.baseUrl}/v1/manager/shutdown`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${discovery.managerToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ instanceId: discovery.instanceId })
    }).catch(() => undefined)
    await waitFor(() => !processAlive(discovery.pid), 5_000).catch(() => undefined)
  }
  await rm(root, { recursive: true, force: true })
}

async function processCommand(pid) {
  if (process.platform === 'win32') return `pid:${pid}`
  const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='])
  return stdout.trim()
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for dual-runtime state')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function waitForValue(read, timeoutMs) {
  let value
  await waitFor(async () => {
    value = await read()
    return value !== undefined
  }, timeoutMs)
  return value
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
