#!/usr/bin/env node

'use strict'

const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } = require('node:fs/promises')
const { createConnection, createServer } = require('node:net')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { _electron } = require('playwright-core')
const sharp = require('sharp')
const { makeTreeWritable } = require('./smoke-packaged-extensions.cjs')
const {
  createIsolatedEnvironment,
  desktopSmokeSettings,
  desktopSmokeWorkspaceParent,
  desktopUserDataCandidates,
  platformDesktopArguments,
  terminateProcessTree,
  waitForPortsClosed
} = require('./smoke-packaged-extension-desktop.cjs')
const {
  developmentRendererEnvironment
} = require('./development-renderer-environment.cjs')
const {
  findWorkbenchWindow
} = require('./smoke-packaged-video-editor-desktop.cjs')

const {
  readLayoutSnapshot,
  assertWidePresentation,
  assertNarrowPresentation,
  assertSceneContentClearance,
  assertThemeIdentity,
  assertNoHorizontalOverflow,
  hasArea,
  numericZIndex,
  rectanglesOverlap,
  captureWorkbench,
  writeReport,
  writeOverview,
  formatThemeResult,
  formatRect,
  formatPercent
} = require('./smoke-development-ui-plugin-layout-evidence.cjs')

const DEFAULT_TIMEOUT_MS = 120_000
const PROCESS_OUTPUT_LIMIT = 128 * 1024
const WIDE_BOUNDS = Object.freeze({ width: 1_800, height: 1_100 })
const NARROW_BOUNDS = Object.freeze({ width: 960, height: 900 })
const UI_PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/
const OVERFLOW_TOLERANCE_PX = 1
const CONTENT_COLUMN_CLEARANCE_PX = 32
const SCENE_CONTENT_CLEARANCE_PX = 16

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(
      'Usage: node scripts/smoke-development-ui-plugin-layout.cjs ' +
      '--plugins-root <directory> --evidence-dir <directory> ' +
      '[--ids id-one,id-two] [--capture-modes] [--timeout-ms 120000] ' +
      '[--repository-root <directory>]\n'
    )
    return
  }

  const timeoutMs = positiveIntegerArgument('--timeout-ms', DEFAULT_TIMEOUT_MS)
  const repositoryRoot = resolve(argumentValue('--repository-root') ?? join(__dirname, '..'))
  const pluginsRoot = resolve(requiredArgumentValue('--plugins-root'))
  const evidenceRoot = resolve(requiredArgumentValue('--evidence-dir'))
  const requestedIds = commaSeparatedIdsArgument('--ids')
  const captureModes = process.argv.includes('--capture-modes')
  const plugins = await discoverPlugins(pluginsRoot, requestedIds)
  assertPresentationPluginsReady(plugins)

  const electronExecutable = require('electron')
  const viteCli = join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js')
  const rendererConfig = join(repositoryRoot, 'scripts', 'vite-development-renderer.config.mjs')
  const mainEntry = join(repositoryRoot, 'out', 'main', 'index.js')
  for (const [label, path] of [
    ['Electron executable', electronExecutable],
    ['Vite CLI', viteCli],
    ['development renderer config', rendererConfig],
    ['built development Main entry', mainEntry]
  ]) {
    if (!existsSync(path)) throw new Error(`${label} is missing: ${path}. Run npm run build first.`)
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kun-development-ui-plugin-layout-'))
  const home = join(temporaryRoot, 'home')
  const profile = join(home, '.kun', 'data')
  const installedPluginsRoot = join(home, '.kun', 'ui-plugins')
  const userData = join(temporaryRoot, 'electron-user-data')
  const appData = join(temporaryRoot, 'app-data')
  const localAppData = join(temporaryRoot, 'local-app-data')
  const temporaryDirectory = join(temporaryRoot, 'tmp')
  const workspaceParent = desktopSmokeWorkspaceParent(repositoryRoot)
  await mkdir(workspaceParent, { recursive: true })
  const workspaceRoot = await mkdtemp(join(workspaceParent, 'ui-plugin-development-layout-'))
  const runtimePort = await availablePort()
  let rendererPort = await availablePort()
  while (rendererPort === runtimePort) rendererPort = await availablePort()

  let electronApplication
  let electronProcess
  let rendererProcess
  let rendererOutput = ''
  let electronOutput = ''
  let primaryError
  const cleanupErrors = []
  const report = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    pluginsRoot,
    evidenceRoot,
    wideWindow: WIDE_BOUNDS,
    narrowWindow: NARROW_BOUNDS,
    captureModes,
    themes: []
  }

  try {
    await Promise.all([
      mkdir(profile, { recursive: true }),
      mkdir(installedPluginsRoot, { recursive: true }),
      mkdir(userData, { recursive: true }),
      mkdir(appData, { recursive: true }),
      mkdir(localAppData, { recursive: true }),
      mkdir(temporaryDirectory, { recursive: true }),
      mkdir(evidenceRoot, { recursive: true })
    ])
    await Promise.all(plugins.map(async (plugin) => {
      await cp(plugin.sourceDir, join(installedPluginsRoot, plugin.id), {
        recursive: true,
        force: true
      })
    }))

    const settings = {
      ...desktopSmokeSettings(runtimePort, workspaceRoot, profile),
      locale: 'zh',
      theme: 'light',
      design: {
        defaultWorkspaceRoot: workspaceRoot
      }
    }
    const serializedSettings = `${JSON.stringify(settings, null, 2)}\n`
    await Promise.all(desktopUserDataCandidates({
      platform: process.platform,
      home,
      appData,
      explicitUserData: userData
    }).map(async (directory) => {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'kun-settings.json'), serializedSettings)
    }))

    const isolatedEnvironment = developmentRendererEnvironment(
      createIsolatedEnvironment(process.env, {
        home,
        appData,
        localAppData,
        temporaryDirectory
      }),
      { rendererPort, temporaryRoot }
    )
    isolatedEnvironment.NODE_ENV = 'development'

    rendererProcess = spawn(
      process.execPath,
      [viteCli, '--config', rendererConfig, '--logLevel', 'warn'],
      {
        cwd: repositoryRoot,
        env: isolatedEnvironment,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    const appendRendererOutput = (chunk) => {
      rendererOutput = `${rendererOutput}${String(chunk)}`.slice(-PROCESS_OUTPUT_LIMIT)
    }
    rendererProcess.stdout?.on('data', appendRendererOutput)
    rendererProcess.stderr?.on('data', appendRendererOutput)
    rendererProcess.once('error', (error) => {
      appendRendererOutput(`\nrenderer launch error: ${String(error)}\n`)
    })
    await waitForPortOpen(rendererPort, timeoutMs, () => processState(rendererProcess))

    electronApplication = await _electron.launch({
      executablePath: electronExecutable,
      args: [
        `--user-data-dir=${userData}`,
        '--no-first-run',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        ...platformDesktopArguments(process.platform),
        repositoryRoot
      ],
      cwd: repositoryRoot,
      env: isolatedEnvironment,
      chromiumSandbox: true,
      timeout: timeoutMs
    })
    electronProcess = electronApplication.process()
    const appendElectronOutput = (chunk) => {
      electronOutput = `${electronOutput}${String(chunk)}`.slice(-PROCESS_OUTPUT_LIMIT)
    }
    electronProcess.stdout?.on('data', appendElectronOutput)
    electronProcess.stderr?.on('data', appendElectronOutput)

    let workbench = await findWorkbenchWindow(electronApplication, timeoutMs)
    await workbench.evaluate(() => {
      localStorage.setItem('kun.layout.leftSidebarCollapsed', '0')
      localStorage.setItem('kun.focusMode', '0')
    })
    // On macOS the OS may clamp an initial 1800px BrowserWindow to the work
    // area while Electron still accepts later renderer surface resizes. Prime
    // the minimum-size layout first so every theme, including the first one,
    // receives the same requested wide renderer surface and capture size.
    await setWorkbenchBounds(electronApplication, NARROW_BOUNDS)

    for (const plugin of plugins) {
      const wideWindowState = await setWorkbenchBounds(electronApplication, WIDE_BOUNDS, {
        emulateRequestedWidth: true
      })
      await workbench.evaluate((id) => {
        localStorage.setItem('kun.uiMode', id)
        localStorage.setItem('kun.ikunMode', id === 'ikun' ? '1' : '0')
        localStorage.setItem('kun.layout.leftSidebarCollapsed', '0')
        localStorage.setItem('kun.focusMode', '0')
      }, plugin.id)
      await workbench.reload({ waitUntil: 'domcontentloaded' })
      workbench = await findWorkbenchWindow(electronApplication, timeoutMs)
      await waitForActivePresentation(workbench, plugin.id, timeoutMs)
      await workbench.waitForTimeout(250)

      const wide = await readLayoutSnapshot(workbench)
      assertWidePresentation(plugin.id, wide)
      const screenshotPath = join(evidenceRoot, `${plugin.id}-kun-ui-plugin.png`)
      await captureWorkbench(electronApplication, screenshotPath)

      const modeEvidence = captureModes
        ? await captureModeEvidence({
            electronApplication,
            workbench,
            plugin,
            evidenceRoot,
            timeoutMs
          })
        : undefined

      const narrowWindowState = await setWorkbenchBounds(electronApplication, NARROW_BOUNDS)
      await waitForNarrowPresentationHidden(workbench, plugin.id, timeoutMs)
      await workbench.waitForTimeout(150)
      const narrow = await readLayoutSnapshot(workbench)
      assertNarrowPresentation(plugin.id, narrow)

      report.themes.push({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        screenshotPath,
        wideWindowState,
        narrowWindowState,
        wide,
        narrow,
        ...(modeEvidence ? { modes: modeEvidence } : {})
      })
      await writeReport(evidenceRoot, report)
      process.stdout.write(formatThemeResult(plugin.id, wide, narrow, screenshotPath))
    }

    report.overviewPath = await writeOverview(evidenceRoot, plugins)
    const reportPath = await writeReport(evidenceRoot, report)
    process.stdout.write(
      `Development Kun UI Plugin layout smoke OK (${process.platform}/${process.arch}): ` +
      `${plugins.length} theme(s); evidence=${evidenceRoot}; report=${reportPath}\n`
    )
  } catch (error) {
    primaryError = error
    if (existsSync(evidenceRoot)) {
      await writeReport(evidenceRoot, {
        ...report,
        failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      }).catch((reportError) => cleanupErrors.push(reportError))
    }
  } finally {
    if (electronApplication) {
      await electronApplication.close().catch((error) => cleanupErrors.push(error))
    }
    if (electronProcess && !electronProcess.killed) {
      await terminateProcessTree(electronProcess, process.platform, {
        timeoutMs: 15_000,
        ports: [runtimePort]
      }).catch((error) => cleanupErrors.push(error))
    }
    if (rendererProcess) {
      await terminateProcessTree(rendererProcess, process.platform, {
        timeoutMs: 15_000,
        ports: [rendererPort]
      }).catch((error) => cleanupErrors.push(error))
    }
    await waitForPortsClosed([runtimePort, rendererPort], 2_000)
      .catch((error) => cleanupErrors.push(error))

    if (process.env.KUN_KEEP_DEVELOPMENT_UI_PLUGIN_LAYOUT_SMOKE === '1') {
      process.stderr.write(`Preserved development UI Plugin profile: ${temporaryRoot}\n`)
      process.stderr.write(`Preserved development UI Plugin workspace: ${workspaceRoot}\n`)
    } else {
      await Promise.all([temporaryRoot, workspaceRoot].map(async (path) => {
        await makeTreeWritable(path).catch(() => undefined)
        await rm(path, { recursive: true, force: true }).catch((error) => cleanupErrors.push(error))
      }))
    }
  }

  if (primaryError || cleanupErrors.length > 0) {
    const message = primaryError instanceof Error
      ? primaryError.stack ?? primaryError.message
      : primaryError === undefined
        ? 'Development UI Plugin layout smoke cleanup failed'
        : String(primaryError)
    const cleanup = cleanupErrors.length > 0
      ? `\nCleanup failures:\n${cleanupErrors.map(String).join('\n')}`
      : ''
    const renderer = rendererOutput.trim()
      ? `\nRenderer development server output (tail):\n${rendererOutput.trim()}`
      : ''
    const electron = electronOutput.trim()
      ? `\nElectron output (tail):\n${electronOutput.trim()}`
      : ''
    throw new Error(`${message}${cleanup}${renderer}${electron}`)
  }
}

async function discoverPlugins(pluginsRoot, requestedIds) {
  const details = await stat(pluginsRoot).catch(() => null)
  if (!details?.isDirectory()) throw new Error(`--plugins-root must be a directory: ${pluginsRoot}`)

  const rootManifest = join(pluginsRoot, 'manifest.json')
  const candidates = existsSync(rootManifest)
    ? [pluginsRoot]
    : (await readdir(pluginsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => join(pluginsRoot, entry.name))
        .filter((directory) => existsSync(join(directory, 'manifest.json')))

  const plugins = []
  const ids = new Set()
  for (const sourceDir of candidates) {
    const manifestPath = join(sourceDir, 'manifest.json')
    let manifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
      throw new Error(
        `Cannot parse UI Plugin manifest ${manifestPath}: ` +
        `${error instanceof Error ? error.message : String(error)}`
      )
    }
    const id = typeof manifest?.id === 'string' ? manifest.id.trim().toLowerCase() : ''
    if (!UI_PLUGIN_ID_PATTERN.test(id)) {
      throw new Error(`Invalid UI Plugin id in ${manifestPath}: ${JSON.stringify(manifest?.id)}`)
    }
    if (ids.has(id)) throw new Error(`Duplicate UI Plugin id ${id} under ${pluginsRoot}`)
    ids.add(id)
    plugins.push({
      id,
      name: typeof manifest.name === 'string' ? manifest.name : id,
      version: typeof manifest.version === 'string' ? manifest.version : '',
      sourceDir,
      manifest
    })
  }

  if (plugins.length === 0) {
    throw new Error(`No direct child UI Plugin manifests found under ${pluginsRoot}`)
  }
  plugins.sort((left, right) => left.id.localeCompare(right.id))

  if (requestedIds.length === 0) return plugins
  const requested = new Set(requestedIds)
  const missing = requestedIds.filter((id) => !ids.has(id))
  if (missing.length > 0) {
    throw new Error(
      `--ids requested unknown UI Plugin(s): ${missing.join(', ')}; ` +
      `available: ${plugins.map((plugin) => plugin.id).join(', ')}`
    )
  }
  return plugins.filter((plugin) => requested.has(plugin.id))
}

function assertPresentationPluginsReady(plugins) {
  const unready = plugins.flatMap((plugin) => {
    const missing = []
    if (!plugin.manifest?.figures?.portrait) missing.push('figures.portrait')
    if (!plugin.manifest?.presentation) missing.push('presentation')
    return missing.length > 0 ? [`${plugin.id} (${missing.join(' + ')})`] : []
  })
  if (unready.length > 0) {
    throw new Error(
      'The UI Plugin layout smoke requires presentation-ready character themes. ' +
      `Missing fields: ${unready.join(', ')}`
    )
  }
}

async function captureModeEvidence({
  electronApplication,
  workbench,
  plugin,
  evidenceRoot,
  timeoutMs
}) {
  const definitions = [
    {
      mode: 'write',
      selector: '.write-workspace-view',
      manifestSlot: 'write'
    },
    {
      mode: 'design',
      selector: '.design-workspace-view .ds-stage-design-canvas',
      manifestSlot: 'design'
    }
  ]
  const evidence = {}

  for (const definition of definitions) {
    if (!plugin.manifest?.backgrounds?.light?.[definition.manifestSlot]) continue
    await workbench.locator(`[data-workspace-mode="${definition.mode}"]`).click()
    await workbench.waitForFunction(({ id, selector, mode }) => {
      const root = document.documentElement
      const target = document.querySelector(selector)
      const selected = document.querySelector(
        `[data-workspace-mode="${mode}"][aria-selected="true"]`
      )
      if (!(target instanceof HTMLElement) || !(selected instanceof HTMLElement)) return false
      const pseudo = getComputedStyle(target, '::after')
      return (
        root.getAttribute('data-ui-plugin') === id &&
        root.getAttribute('data-ui-plugin-cdp') === id &&
        pseudo.backgroundImage !== 'none' &&
        Number.parseFloat(pseudo.opacity) > 0
      )
    }, { id: plugin.id, selector: definition.selector, mode: definition.mode }, {
      timeout: timeoutMs
    })
    await workbench.waitForTimeout(300)

    const snapshot = await workbench.evaluate(({ selector, mode }) => {
      const target = document.querySelector(selector)
      if (!(target instanceof HTMLElement)) throw new Error(`Missing mode surface: ${selector}`)
      const rect = target.getBoundingClientRect()
      const pseudo = getComputedStyle(target, '::after')
      const root = document.documentElement
      return {
        mode,
        selector,
        selected: Boolean(document.querySelector(
          `[data-workspace-mode="${mode}"][aria-selected="true"]`
        )),
        rect: {
          x: Math.round(rect.x * 100) / 100,
          y: Math.round(rect.y * 100) / 100,
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100
        },
        pseudo: {
          backgroundImage: pseudo.backgroundImage.startsWith('url(') ? 'url(data-image)' : pseudo.backgroundImage,
          backgroundSize: pseudo.backgroundSize,
          backgroundPosition: pseudo.backgroundPosition,
          opacity: pseudo.opacity,
          pointerEvents: pseudo.pointerEvents
        },
        overflow: {
          documentExcess: Math.max(0, root.scrollWidth - root.clientWidth),
          surfaceExcess: Math.max(0, target.scrollWidth - target.clientWidth)
        }
      }
    }, { selector: definition.selector, mode: definition.mode })

    if (!snapshot.selected) throw new Error(`${plugin.id} ${definition.mode}: mode tab is not selected`)
    if (snapshot.pseudo.backgroundImage !== 'url(data-image)') {
      throw new Error(`${plugin.id} ${definition.mode}: dedicated background image is not active`)
    }
    if (snapshot.pseudo.pointerEvents !== 'none') {
      throw new Error(`${plugin.id} ${definition.mode}: artwork must remain pointer-events:none`)
    }
    if (snapshot.overflow.documentExcess > OVERFLOW_TOLERANCE_PX) {
      throw new Error(
        `${plugin.id} ${definition.mode}: document horizontal overflow ` +
        `${snapshot.overflow.documentExcess}px`
      )
    }

    const screenshotPath = join(
      evidenceRoot,
      `${plugin.id}-${definition.mode}-kun-ui-plugin.png`
    )
    await captureWorkbench(electronApplication, screenshotPath)
    evidence[definition.mode] = { screenshotPath, ...snapshot }
  }

  await workbench.locator('[data-workspace-mode="chat"]').click()
  await waitForActivePresentation(workbench, plugin.id, timeoutMs)
  await workbench.waitForTimeout(150)
  return evidence
}

async function setWorkbenchBounds(electronApplication, bounds, options = {}) {
  return electronApplication.evaluate(async ({ BrowserWindow }, request) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
    if (!window) throw new Error('Kun development workbench BrowserWindow is unavailable')
    window.webContents.setZoomFactor(1)
    const current = window.getBounds()
    window.setBounds({ ...current, width: request.bounds.width, height: request.bounds.height }, false)
    window.show()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    const nativeBounds = window.getBounds()
    const nativeViewport = await window.webContents.executeJavaScript(
      '({ width: window.innerWidth, height: window.innerHeight })',
      true
    )
    const zoomFactor = request.emulateRequestedWidth && nativeViewport.width < request.bounds.width
      ? Math.max(0.5, nativeViewport.width / request.bounds.width)
      : 1
    if (zoomFactor !== 1) {
      window.webContents.setZoomFactor(zoomFactor)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
    const effectiveViewport = await window.webContents.executeJavaScript(
      '({ width: window.innerWidth, height: window.innerHeight })',
      true
    )
    return {
      requestedBounds: request.bounds,
      nativeBounds,
      nativeViewport,
      zoomFactor,
      effectiveViewport
    }
  }, { bounds, emulateRequestedWidth: options.emulateRequestedWidth === true })
}

async function waitForActivePresentation(workbench, id, timeoutMs) {
  await workbench.waitForFunction((expectedId) => {
    const root = document.documentElement
    const image = document.querySelector('.ds-ui-plugin-character')
    const sceneArtwork = [...document.querySelectorAll('.ds-ui-plugin-scene-artwork')]
    const timeline = document.querySelector('.ds-message-timeline-content')
    const style = document.querySelector('#kun-ui-plugin-theme-cdp')
    const sceneReady = root.getAttribute('data-ui-plugin-scene') !== 'on' || (
      Boolean(root.getAttribute('data-ui-plugin-scene-layout')) &&
      sceneArtwork.length > 0 &&
      sceneArtwork.every((candidate) => (
        candidate instanceof HTMLImageElement &&
        candidate.complete &&
        candidate.naturalWidth > 0 &&
        candidate.naturalHeight > 0
      ))
    )
    return (
      root.getAttribute('data-ui-plugin') === expectedId &&
      root.getAttribute('data-ui-plugin-cdp') === expectedId &&
      root.getAttribute('data-ui-plugin-presentation') === 'on' &&
      style instanceof HTMLStyleElement &&
      style.getAttribute('data-ui-plugin-id') === expectedId &&
      timeline instanceof HTMLElement &&
      image instanceof HTMLImageElement &&
      image.complete &&
      image.naturalWidth > 0 &&
      image.naturalHeight > 0 &&
      sceneReady
    )
  }, id, { timeout: timeoutMs })
}

async function waitForNarrowPresentationHidden(workbench, id, timeoutMs) {
  await workbench.waitForFunction((expectedId) => {
    const root = document.documentElement
    const layers = [...document.querySelectorAll(
      '.ds-ui-plugin-decor-layer, .ds-ui-plugin-character-layer, ' +
      '.ds-ui-plugin-readability-scrim, .ds-ui-plugin-scene-stage-layer, ' +
      '.ds-ui-plugin-scene-visual-zone'
    )]
    if (layers.length === 0) return false
    return (
      root.getAttribute('data-ui-plugin') === expectedId &&
      root.getAttribute('data-ui-plugin-cdp') === expectedId &&
      layers.every((layer) => (
        layer instanceof HTMLElement &&
        getComputedStyle(layer).display === 'none' &&
        layer.getBoundingClientRect().width === 0
      ))
    )
  }, id, { timeout: timeoutMs })
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise())
  })
  if (!port) throw new Error('Could not allocate a development UI Plugin layout smoke port')
  return port
}

async function waitForPortOpen(port, timeoutMs, state) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (state().exited) throw new Error(`Renderer development server exited before port ${port} opened`)
    if (await isPortOpen(port)) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error(`Timed out waiting for renderer development server on port ${port}`)
}

function isPortOpen(port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (open) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise(open)
    }
    socket.setTimeout(250, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.unref()
  })
}

function processState(child) {
  return {
    exited: child.exitCode !== null || child.signalCode !== null || child.killed,
    exitCode: child.exitCode,
    signalCode: child.signalCode
  }
}

function commaSeparatedIdsArgument(name) {
  const raw = argumentValue(name)
  if (raw === undefined) return []
  const ids = raw.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
  if (ids.length === 0) throw new Error(`${name} requires at least one UI Plugin id`)
  for (const id of ids) {
    if (!UI_PLUGIN_ID_PATTERN.test(id)) throw new Error(`${name} contains an invalid UI Plugin id: ${id}`)
  }
  return [...new Set(ids)]
}

function requiredArgumentValue(name) {
  const value = argumentValue(name)
  if (value === undefined) throw new Error(`${name} is required`)
  return value
}

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function positiveIntegerArgument(name, fallback) {
  const raw = argumentValue(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
