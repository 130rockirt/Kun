'use strict'

const { spawnSync } = require('node:child_process')
const { existsSync, statSync } = require('node:fs')
const { readFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const {
  desktopSmokeSettings,
  platformDesktopArguments
} = require('./smoke-packaged-extension-desktop.cjs')
const { deterministicFixtureArguments } = require('./lib/extension-native-media-smoke.cjs')
const {
  CONTRIBUTION_ID,
  EXTENSION_ID,
  MODEL_NAME
} = require('./smoke-packaged-video-editor-desktop-constants.cjs')
const {
  assertLocalizedFirstLaunchPermissionPrompt,
  hasVideoEditorGuest,
  pollUntil
} = require('./smoke-packaged-video-editor-desktop-guest.cjs')

function assertRegularFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Missing ${label}: ${path}`)
}

function desktopVideoEditorSettings({ runtimePort, workspaceRoot, dataDir, modelBaseUrl }) {
  const base = desktopSmokeSettings(runtimePort, workspaceRoot, dataDir)
  return {
    ...base,
    locale: 'zh',
    theme: 'light',
    agents: {
      kun: {
        ...base.agents.kun,
        apiKey: 'desktop-e2e-local-placeholder',
        baseUrl: modelBaseUrl,
        providerId: 'deepseek',
        model: MODEL_NAME,
        endpointFormat: 'openai-chat-completions',
        approvalPolicy: 'auto',
        sandboxMode: 'danger-full-access'
      }
    }
  }
}

async function resolveVideoEditorArchive(resourcesDir, explicit) {
  if (explicit) {
    const archive = resolve(explicit)
    assertRegularFile(archive, 'explicit Kun Video Editor .kunx')
    if (!archive.endsWith('.kunx')) throw new Error(`Video editor archive must end with .kunx: ${archive}`)
    return archive
  }
  const bundledRoot = join(resourcesDir, 'bundled-extensions')
  const catalogPath = join(bundledRoot, 'catalog.json')
  assertRegularFile(catalogPath, 'packaged bundled-extension catalog')
  let catalog
  try {
    catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot parse packaged bundled-extension catalog: ${error instanceof Error ? error.message : String(error)}`)
  }
  const matches = Array.isArray(catalog?.extensions)
    ? catalog.extensions.filter((entry) => entry?.id === EXTENSION_ID)
    : []
  if (matches.length !== 1 || typeof matches[0]?.archive !== 'string') {
    throw new Error(`Packaged bundled-extension catalog must contain exactly one ${EXTENSION_ID}`)
  }
  const archive = join(bundledRoot, matches[0].archive)
  assertRegularFile(archive, 'packaged bundled Kun Video Editor .kunx')
  return archive
}

function createVideoFixture(ffmpegPath, output, cwd, timeoutMs) {
  const result = spawnSync(ffmpegPath, deterministicFixtureArguments(output, 2), {
    cwd,
    env: process.env,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`.trim().slice(-8_000)
    throw new Error(
      `Cannot create the real MP4 desktop fixture with ${ffmpegPath}. ` +
      'Install an FFmpeg build with libx264 and AAC, or set KUN_FFMPEG_PATH. ' +
      `Exit: ${result.signal ?? result.status ?? 'unknown'}${detail ? `\n${detail}` : ''}`
    )
  }
}

async function launchPackagedDesktop({
  desktopLaunchSelection,
  userData,
  home,
  environment,
  timeoutMs
}) {
  if (process.platform === 'linux' && !environment.DISPLAY && !environment.WAYLAND_DISPLAY) {
    throw new Error(
      'The Playwright Electron desktop E2E needs a display on Linux. ' +
      'Run it under `xvfb-run -a npm run smoke:packaged-video-editor-desktop -- ...`.'
    )
  }
  const { _electron } = require('playwright-core')
  const args = [
    ...(desktopLaunchSelection.applicationEntry
      ? [desktopLaunchSelection.applicationEntry]
      : []),
    `--user-data-dir=${userData}`,
    '--no-first-run',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    ...platformDesktopArguments(process.platform)
  ]
  return _electron.launch({
    executablePath: desktopLaunchSelection.desktopExecutable,
    args,
    cwd: home,
    env: environment,
    // Match the production desktop security posture. Playwright otherwise
    // injects --no-sandbox on Linux; CI must provide working user namespaces.
    chromiumSandbox: true,
    timeout: timeoutMs
  })
}

async function installNativeDialogStubs(electronApplication, {
  openSelections = [],
  saveSelections = []
}) {
  await electronApplication.evaluate(({ dialog }, queues) => {
    const state = {
      openSelections: queues.openSelections.map((selection) => [...selection]),
      saveSelections: [...queues.saveSelections],
      messageBoxes: [],
      calls: []
    }
    globalThis.__kunVideoEditorDesktopE2eDialogs = state
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1) ?? {}
      const selected = state.openSelections.shift()
      state.calls.push({ kind: 'open', title: options.title ?? '', selected: selected ?? null })
      return selected
        ? { canceled: false, filePaths: selected }
        : { canceled: true, filePaths: [] }
    }
    dialog.showSaveDialog = async (...args) => {
      const options = args.at(-1) ?? {}
      const selected = state.saveSelections.shift()
      state.calls.push({ kind: 'save', title: options.title ?? '', selected: selected ?? null })
      return selected
        ? { canceled: false, filePath: selected }
        : { canceled: true, filePath: undefined }
    }
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1) ?? {}
      const buttons = Array.isArray(options.buttons)
        ? options.buttons.map((button) => String(button))
        : []
      const detail = typeof options.detail === 'string' ? options.detail : ''
      const response = Number.isInteger(options.cancelId)
        ? options.cancelId
        : Math.max(buttons.length - 1, 0)
      const record = {
        kind: 'message',
        type: typeof options.type === 'string' ? options.type : '',
        title: typeof options.title === 'string' ? options.title : '',
        message: typeof options.message === 'string' ? options.message : '',
        detail: detail.slice(0, 32_000),
        buttons,
        defaultId: Number.isInteger(options.defaultId) ? options.defaultId : null,
        cancelId: Number.isInteger(options.cancelId) ? options.cancelId : null,
        noLink: options.noLink === true,
        normalizeAccessKeys: options.normalizeAccessKeys === true,
        response
      }
      state.messageBoxes.push(record)
      state.calls.push(record)
      return { response, checkboxChecked: false }
    }
  }, { openSelections, saveSelections })
}

async function findWorkbenchWindow(electronApplication, timeoutMs) {
  return pollUntil(async () => {
    for (const window of electronApplication.windows()) {
      try {
        if (await window.evaluate(() => typeof globalThis.kunGui === 'object')) return window
      } catch {
        // Window may still be navigating.
      }
    }
    return undefined
  }, { timeoutMs, description: 'packaged Kun workbench window' })
}

async function findProtectedConsentWindow(electronApplication, workbench, timeoutMs) {
  return pollUntil(async () => {
    for (const window of electronApplication.windows()) {
      if (window === workbench || window.isClosed()) continue
      try {
        if (
          await window.locator('#consent-approve').count() === 1 &&
          await window.locator('#consent-cancel').count() === 1
        ) return window
      } catch {
        // The protected BrowserWindow may still be loading or closing.
      }
    }
    return undefined
  }, {
    timeoutMs,
    description: `localized protected workspace permission review for ${EXTENSION_ID}`
  })
}

async function readProtectedConsentPrompt(window) {
  return window.evaluate(() => {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? ''
    const meta = Object.fromEntries(
      [...document.querySelectorAll('.meta-row')].map((row) => [
        row.querySelector('dt')?.textContent?.trim() ?? '',
        row.querySelector('dd')?.textContent?.trim() ?? ''
      ])
    )
    const scrollRegion = document.querySelector('.scroll-region')
    const footer = document.querySelector('.footer')
    const approve = document.querySelector('#consent-approve')
    const cancel = document.querySelector('#consent-cancel')
    const visibleWithinViewport = (element) => {
      if (!(element instanceof HTMLElement)) return false
      const style = getComputedStyle(element)
      const bounds = element.getBoundingClientRect()
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0 &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        bounds.top >= -1 &&
        bounds.left >= -1 &&
        bounds.bottom <= innerHeight + 1 &&
        bounds.right <= innerWidth + 1
    }
    const scrollBounds = scrollRegion?.getBoundingClientRect()
    const footerBounds = footer?.getBoundingClientRect()
    return {
      title: document.title,
      heading: text('.header h1'),
      message: text('.header p'),
      detail: text('.review-text'),
      meta,
      approveLabel: text('#consent-approve'),
      cancelLabel: text('#consent-cancel'),
      approveVisible: visibleWithinViewport(approve),
      cancelVisible: visibleWithinViewport(cancel),
      scrollOverflowY: scrollRegion ? getComputedStyle(scrollRegion).overflowY : '',
      scrollClientHeight: scrollRegion?.clientHeight ?? 0,
      scrollHeight: scrollRegion?.scrollHeight ?? 0,
      scrollTop: scrollBounds?.top ?? -1,
      scrollBottom: scrollBounds?.bottom ?? -1,
      footerTop: footerBounds?.top ?? -1,
      footerBottom: footerBounds?.bottom ?? -1,
      viewportHeight: innerHeight
    }
  })
}

async function openUntrustedVideoEditor(
  workbench,
  electronApplication,
  workspaceRoot,
  timeoutMs
) {
  if (await hasVideoEditorGuest(electronApplication)) {
    throw new Error('Kun Video Editor opened before the first-launch workspace trust review')
  }
  await assertVideoEditorHiddenFromRightRail(workbench, workspaceRoot, timeoutMs)
  const card = await openVideoEditorManagementCard(workbench, timeoutMs)
  const authorize = card.getByRole('button', { name: /^(?:授权后打开 Kun 视频编辑器|Authorize to open Kun Video Editor)$/ })
  await authorize.waitFor({ state: 'visible', timeout: timeoutMs })
  await authorize.click()
  const review = card.getByRole('button', { name: /^(?:在受保护窗口审核并应用|Review and apply in protected window)$/ })
  await review.waitFor({ state: 'visible', timeout: timeoutMs })
  await review.click()
  const permissionPromptWindow = await findProtectedConsentWindow(
    electronApplication,
    workbench,
    timeoutMs
  )
  const permissionPrompt = await readProtectedConsentPrompt(permissionPromptWindow)
  assertLocalizedFirstLaunchPermissionPrompt(permissionPrompt, { workspaceRoot })
  await permissionPromptWindow.locator('#consent-approve').click()
  const open = card.getByRole('button', { name: /^(?:打开 Kun 视频编辑器|Open Kun Video Editor)$/ })
  await open.waitFor({ state: 'visible', timeout: timeoutMs })
  await open.click()
  await waitForVideoEditorGuest(
    workbench,
    electronApplication,
    timeoutMs,
    `authorized Extension management View ${CONTRIBUTION_ID}`
  )
}

async function openVideoEditor(workbench, electronApplication, timeoutMs) {
  if (await hasVideoEditorGuest(electronApplication)) return
  const card = await openVideoEditorManagementCard(workbench, timeoutMs)
  const open = card.getByRole('button', { name: /^(?:打开 Kun 视频编辑器|Open Kun Video Editor)$/ })
  await open.waitFor({ state: 'visible', timeout: timeoutMs })
  await open.click()
  try {
    await waitForVideoEditorGuest(
      workbench,
      electronApplication,
      timeoutMs,
      `Extension management View ${CONTRIBUTION_ID}`
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${message}\nExtension management open failed for ${CONTRIBUTION_ID}`
    )
  }
}

async function assertVideoEditorHiddenFromRightRail(workbench, workspaceRoot, timeoutMs) {
  const discovery = await pollUntil(async () => workbench.evaluate(
    async ({ extensionId, workspaceRoot: currentWorkspaceRoot }) => {
      const result = await globalThis.kunGui.extensionGetWorkbench({
        workspaceRoot: currentWorkspaceRoot,
        locale: 'zh-CN'
      })
      if (!result.ok) throw new Error(`Workbench contribution query failed: ${result.status}`)
      const snapshot = JSON.parse(result.body)
      const extension = snapshot.extensions?.find((entry) => entry?.id === extensionId)
      if (!extension) return undefined
      const view = extension.workspaceTrusted
        ? extension.contributes?.['views.rightSidebar']?.find((entry) => entry?.id === 'editor')
        : extension.rightRailDiscovery?.views?.find((entry) => entry?.id === 'editor')
      return view?.showInRightRail === false ? view : undefined
    }, { extensionId: EXTENSION_ID, workspaceRoot }), {
    timeoutMs,
    description: `default-hidden video editor contribution ${CONTRIBUTION_ID}`
  })
  if (!discovery || await workbench.locator(`button[data-contribution-id="${CONTRIBUTION_ID}"]`).count() !== 0) {
    throw new Error('Kun Video Editor must not be displayed in the Code right rail by default')
  }
}

async function openVideoEditorManagementCard(workbench, timeoutMs) {
  const extensions = workbench.getByRole('button', { name: /^(?:扩展|Extensions)$/ })
  await extensions.waitFor({ state: 'visible', timeout: timeoutMs })
  await extensions.click()
  const card = workbench.locator(`[data-extension-id="${EXTENSION_ID}"]`)
  await card.waitFor({ state: 'visible', timeout: timeoutMs })
  return card
}

async function waitForVideoEditorGuest(
  workbench,
  electronApplication,
  timeoutMs,
  description
) {
  try {
    await pollUntil(() => hasVideoEditorGuest(electronApplication), {
      timeoutMs,
      description
    })
  } catch (error) {
    const diagnostic = await readVideoEditorOpenDiagnostic(workbench, electronApplication)
      .catch((diagnosticError) => ({
        diagnosticError: diagnosticError instanceof Error
          ? diagnosticError.message
          : String(diagnosticError)
      }))
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}\nVideo editor open diagnostic: ${JSON.stringify(diagnostic)}`)
  }
}

async function readVideoEditorOpenDiagnostic(workbench, electronApplication) {
  const [renderer, contents] = await Promise.all([
    workbench.evaluate((contributionId) => {
      const button = document.querySelector(`button[data-contribution-id="${contributionId}"]`)
      return {
        button: button ? {
          trusted: button.getAttribute('data-extension-trusted'),
          label: button.getAttribute('aria-label'),
          pressed: button.getAttribute('aria-pressed')
        } : null,
        views: [...document.querySelectorAll('.ds-extension-view')].slice(0, 8).map((view) => ({
          contributionId: view.getAttribute('data-contribution-id'),
          text: (view.textContent ?? '').trim().slice(0, 2_000)
        })),
        statuses: [...document.querySelectorAll('[role="status"], [role="alert"]')]
          .slice(0, 16)
          .map((node) => (node.textContent ?? '').trim().slice(0, 2_000))
      }
    }, CONTRIBUTION_ID),
    electronApplication.evaluate(({ webContents }) =>
      webContents.getAllWebContents().slice(0, 32).map((contents) => ({
        id: contents.id,
        type: contents.getType(),
        url: contents.getURL().slice(0, 4_096),
        destroyed: contents.isDestroyed()
      })))
  ])
  return { renderer, contents }
}


module.exports = {
  desktopVideoEditorSettings,
  resolveVideoEditorArchive,
  createVideoFixture,
  launchPackagedDesktop,
  installNativeDialogStubs,
  findWorkbenchWindow,
  findProtectedConsentWindow,
  readProtectedConsentPrompt,
  openUntrustedVideoEditor,
  openVideoEditor,
  assertVideoEditorHiddenFromRightRail,
  openVideoEditorManagementCard,
  waitForVideoEditorGuest,
  readVideoEditorOpenDiagnostic
}
