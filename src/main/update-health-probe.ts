import { app } from 'electron'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectPackagedInstallHealth } from './packaged-install-health'

export type UpdateHealthProbeDeps = {
  isPackaged: () => boolean
  executablePath: () => string
  resourcesPath: () => string
  inspectInstall: typeof inspectPackagedInstallHealth
  loadRuntimeAdapter: () => Promise<unknown>
  /** Probe the renderer surface: preload, renderer entry, and an IPC ping. */
  probeRendererWindow: () => Promise<void>
  /**
   * Exercise the runtime against an isolated temporary data directory:
   * start the gateway, create a throwaway thread, read it back, delete it.
   */
  probeRuntimeServices: (dataDir: string) => Promise<void>
  createTempDir: () => Promise<string>
  removeTempDir: (dir: string) => Promise<void>
}

async function defaultCreateTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kun-update-health-'))
}

async function defaultRemoveTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

const defaultDeps: UpdateHealthProbeDeps = {
  isPackaged: () => app.isPackaged,
  executablePath: () => process.execPath,
  resourcesPath: () => process.resourcesPath,
  inspectInstall: inspectPackagedInstallHealth,
  loadRuntimeAdapter: () => import('./runtime/kun-adapter'),
  probeRendererWindow: defaultProbeRendererWindow,
  probeRuntimeServices: defaultProbeRuntimeServices,
  createTempDir: defaultCreateTempDir,
  removeTempDir: defaultRemoveTempDir
}

let rendererProbeRegistered = false

/**
 * Renderer-surface probe: load the production preload and renderer entry in a
 * hidden window and complete one renderer -> main IPC round trip. This catches
 * missing preload builds, broken renderer chunks, and dead IPC channels before
 * the installer commits the payload switch.
 */
async function defaultProbeRendererWindow(): Promise<void> {
  const { BrowserWindow, ipcMain } = await import('electron')
  if (!rendererProbeRegistered) {
    ipcMain.handle('kun-update-health-probe:ping', () => ({ ok: true, at: Date.now() }))
    rendererProbeRegistered = true
  }
  const preloadPath = (await import('./main-paths')).resolveNamedPreloadPath(
    join(__dirname), 'index'
  )
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true
    }
  })
  try {
    await window.loadFile(join(__dirname, '../renderer/index.html'))
    const pong = await window.webContents.executeJavaScript(
      'window.kunGui ? window.kunGui.startup.getState() : Promise.reject(new Error("preload bridge missing"))',
      true
    )
    if (!pong || typeof pong !== 'object') {
      throw new Error('The renderer IPC ping returned an invalid payload.')
    }
  } finally {
    window.destroy()
  }
}

/**
 * Runtime-service probe against an isolated data directory: no user data is
 * touched. A throwaway thread is created, read back, and deleted through the
 * local gateway to prove the adapter, HTTP surface, and storage all work in
 * the candidate payload.
 */
async function defaultProbeRuntimeServices(dataDir: string): Promise<void> {
  const { spawn } = await import('node:child_process')
  const { resolveKunExecutableForCurrentApp } = await import('./kun-process')
  const { resolveKunRuntimeBuildId } = await import('./resolve-kun-binary')
  const resolution = resolveKunExecutableForCurrentApp()
  const buildId = await resolveKunRuntimeBuildId(resolution)
  if (!buildId) throw new Error('The candidate Kun Runtime build identity is missing.')

  const port = 18991
  const token = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const child = spawn(resolution.command, [
    ...resolution.args,
    'serve',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--data-dir', dataDir,
    '--approval-policy', 'never',
    '--sandbox-mode', 'read-only',
    '--approval-reviewer', 'user',
    '--token-economy-mode', 'false',
    '--runtime-token', token
  ], { stdio: 'ignore', windowsHide: true })
  try {
    const base = `http://127.0.0.1:${port}`
    const headers = { Authorization: `Bearer ${token}` }
    let ready = false
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const response = await fetch(`${base}/health`, { headers, signal: AbortSignal.timeout(2_000) })
        if (response.ok) { ready = true; break }
      } catch {
        // keep polling until the gateway listens or the budget is exhausted
      }
      await new Promise((resolveTimeout) => { setTimeout(resolveTimeout, 500).unref?.() })
    }
    if (!ready) throw new Error('The candidate runtime gateway did not become healthy.')

    const createResponse = await fetch(`${base}/v1/threads`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'update-health-probe',
        workspace: dataDir,
        model: 'probe-model'
      }),
      signal: AbortSignal.timeout(15_000)
    })
    if (createResponse.status !== 201) {
      throw new Error(`The candidate runtime could not create a thread (${createResponse.status}).`)
    }
    const created = await createResponse.json() as { id?: string }
    if (!created?.id) throw new Error('The candidate runtime returned a thread without an id.')

    const readResponse = await fetch(`${base}/v1/threads/${created.id}`, {
      headers, signal: AbortSignal.timeout(15_000)
    })
    if (!readResponse.ok) {
      throw new Error(`The candidate runtime could not read the probe thread (${readResponse.status}).`)
    }

    const deleteResponse = await fetch(`${base}/v1/threads/${created.id}`, {
      method: 'DELETE', headers, signal: AbortSignal.timeout(15_000)
    })
    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      throw new Error(`The candidate runtime could not delete the probe thread (${deleteResponse.status}).`)
    }
  } finally {
    child.kill()
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => resolveExit(), 5_000)
      timer.unref?.()
      child.once('exit', () => { clearTimeout(timer); resolveExit() })
    })
  }
}

/**
 * Check the candidate payload before its installation transaction commits.
 * The probe now also exercises the renderer surface (preload, entry chunk,
 * IPC) and the runtime services (gateway, thread read/write) against an
 * isolated temporary data directory, because a successful probe triggers the
 * irreversible CommitUpdateTransaction. Persistent user-data migrations still
 * intentionally begin on the first normal launch after the commit succeeds.
 */
export async function runMinimalUpdateProbe(
  deps: UpdateHealthProbeDeps = defaultDeps
): Promise<void> {
  await app.whenReady()
  // Calling getVersion confirms Electron's main-process binding is available.
  app.getVersion()

  const installHealth = deps.inspectInstall({
    isPackaged: deps.isPackaged(),
    executablePath: deps.executablePath(),
    resourcesPath: deps.resourcesPath()
  })
  if (!installHealth.ok) {
    throw new Error(`Kun installation is incomplete (${installHealth.missing.join(', ')}).`)
  }

  // This verifies the packaged runtime module graph without resolving settings,
  // starting a Manager/Runtime, or touching user data.
  await deps.loadRuntimeAdapter()

  // Renderer surface: preload bridge, renderer entry, and one IPC round trip.
  await deps.probeRendererWindow()

  // Runtime services against an isolated data directory; never user data.
  const dataDir = await deps.createTempDir()
  try {
    await deps.probeRuntimeServices(dataDir)
  } finally {
    await deps.removeTempDir(dataDir).catch(() => undefined)
  }
}
