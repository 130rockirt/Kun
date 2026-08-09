#!/usr/bin/env node

'use strict'

const { spawn } = require('node:child_process')
const { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const {
  installSmokeExtensionFixture,
  makeTreeWritable,
  resolvePackagedRuntimeExecutable,
  validatePackagedResources
} = require('./smoke-packaged-extensions.cjs')
const {
  CONTRIBUTION_ID,
  DEFAULT_CDP_COMMAND_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  EXTENSION_ID,
  MAX_CLEANUP_TIMEOUT_MS,
  MAX_REMOVE_RETRIES,
  PROCESS_OUTPUT_LIMIT,
  REMOVE_RETRY_DELAY_MS,
  WEBVIEW_MARKER
} = require('./smoke-packaged-extension-desktop-constants.cjs')
const {
  stopIsolatedSharedRuntime,
  stopIsolatedServiceManager,
  readDiscoveryOwner,
  terminateVerifiedIsolatedProcess,
  isVerifiedIsolatedKunCommand,
  processCommandLine,
  processIsAlive,
  waitForPidExit,
  releaseChildProcessHandles,
  withTimeout,
  desktopSmokeWorkspaceParent,
  desktopSmokeSettings,
  grantSmokeWorkspaceTrust,
  seedDesktopMediaPlaybackFixture,
  buildDesktopPlaybackWav,
  buildDesktopPlaybackPng,
  desktopApplicationEntry,
  resolveDesktopLaunchSelection,
  desktopResourceCandidates,
  resolvedDesktopResourceCandidates,
  desktopUserDataCandidates,
  resolveDesktopResources,
  createIsolatedEnvironment,
  scrubDesktopEnvironment,
  createDesktopLaunchPlan,
  platformDesktopArguments,
  runPackagedKun
} = require('./smoke-packaged-extension-desktop-runtime.cjs')
const {
  CdpConnection,
  WORKBENCH_DISCOVERY_RETRY_DELAYS_MS,
  waitForCdpEndpoint,
  waitForTarget,
  isWorkbenchTarget,
  isExtensionGuestTarget,
  attachToTarget,
  isRecoverableCdpSessionError,
  isCdpCommandTimeout,
  runGuestAsyncInspection,
  sendToRecoverableTargetSession,
  sendToWorkbenchSession,
  sendToGuestSession,
  hasWorkbenchContribution,
  synchronizeWorkbenchContributionDiscovery,
  notifyWorkbenchContributionListener,
  waitForContributionAndClick,
  waitForContributionTabCloseAndClick
} = require('./smoke-packaged-extension-desktop-cdp.cjs')
const {
  inspectGuestImagePlayback,
  inspectGuestMediaPlayback,
  waitForGuestReady,
  inspectMediaUrlFetch,
  releaseGuestMediaLease,
  createGuestMediaLease,
  assertStaleViewSessionMediaBlocked
} = require('./smoke-packaged-extension-desktop-media.cjs')
const {
  inspectGuestSecurity,
  waitForSuccessfulGuestInspection,
  findUnexpectedPopupTargets,
  assertGuestSecurityResult,
  assertTheme,
  isExactExtensionGuestUrl
} = require('./smoke-packaged-extension-desktop-guest.cjs')
const {
  startNetworkCanary,
  evaluationValue,
  pollUntil,
  processState,
  assertDesktopProcessRunning,
  terminateProcessTree,
  signalLiveProcess,
  isProcessRunning,
  remainingMilliseconds,
  waitForProcessExit,
  waitForPortsClosed,
  isLoopbackPortOpen,
  availablePort,
  argumentValue,
  positiveIntegerArgument,
  delay
} = require('./smoke-packaged-extension-desktop-process.cjs')

async function main() {
  const timeoutMs = positiveIntegerArgument('--timeout-ms', DEFAULT_TIMEOUT_MS)
  const resourcesDir = resolveDesktopResources(argumentValue('--resources'))
  const packagedRuntimeExecutable = resolvePackagedRuntimeExecutable(resourcesDir)
  const runtimeExecutable = resolvePackagedRuntimeExecutable(
    resourcesDir,
    argumentValue('--runtime-executable')
  )
  if (!runtimeExecutable) {
    throw new Error(`The packaged application at ${resourcesDir} is not host-native for ${process.arch}`)
  }
  const desktopLaunchSelection = resolveDesktopLaunchSelection({
    resourcesDir,
    runtimeExecutable,
    packagedRuntimeExecutable,
    desktopExecutable: argumentValue('--desktop-executable')
  })

  const unpackedRoot = join(resourcesDir, 'app.asar.unpacked')
  const runtimeEntry = join(unpackedRoot, 'kun', 'dist', 'cli', 'serve-entry.js')
  validatePackagedResources(resourcesDir, unpackedRoot)

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kun-packaged-extension-desktop-smoke-'))
  const home = join(temporaryRoot, 'home')
  const profile = join(home, '.kun', 'data')
  const workspaceParent = desktopSmokeWorkspaceParent()
  await mkdir(workspaceParent, { recursive: true })
  const workspaceRoot = await mkdtemp(join(workspaceParent, 'workspace-'))
  const userData = join(temporaryRoot, 'electron-user-data')
  const appData = join(temporaryRoot, 'app-data')
  const localAppData = join(temporaryRoot, 'local-app-data')
  const temporaryDirectory = join(temporaryRoot, 'tmp')
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(profile, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(userData, { recursive: true }),
    mkdir(appData, { recursive: true }),
    mkdir(localAppData, { recursive: true }),
    mkdir(temporaryDirectory, { recursive: true })
  ])
  const runtimePort = await availablePort()
  const desktopSettings = `${JSON.stringify(
    desktopSmokeSettings(runtimePort, workspaceRoot, profile),
    null,
    2
  )}\n`
  await Promise.all(desktopUserDataCandidates({
    platform: process.platform,
    home,
    appData,
    explicitUserData: userData
  }).map(async (directory) => {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'kun-settings.json'), desktopSettings)
  }))

  const isolatedEnvironment = createIsolatedEnvironment(process.env, {
    home,
    appData,
    localAppData,
    temporaryDirectory
  })
  let desktopProcess
  let cdp
  let networkCanary
  let debuggingPort
  let output = ''
  let primaryError
  let successMessage
  const cleanupErrors = []

  try {
    networkCanary = await startNetworkCanary()
    await installSmokeExtensionFixture({
      temporaryRoot,
      profile,
      webviewConnectUrls: [networkCanary.url],
      runCli: (args) => runPackagedKun(
        desktopLaunchSelection.cliExecutable,
        runtimeEntry,
        args,
        isolatedEnvironment,
        timeoutMs
      )
    })
    await grantSmokeWorkspaceTrust(unpackedRoot, profile, workspaceRoot)
    await seedDesktopMediaPlaybackFixture(profile, workspaceRoot)

    const installedWebview = join(
      profile,
      'extensions',
      EXTENSION_ID,
      '1.0.0',
      'dist',
      'webview',
      'index.html'
    )
    const installedWebviewBody = await readFile(installedWebview, 'utf8')
    if (!installedWebviewBody.includes('data-kun-packaged-webview-smoke="ready"')) {
      throw new Error('Installed desktop smoke fixture is missing its Webview body marker')
    }
    if (!installedWebviewBody.includes(`connect-src ${networkCanary.origin}`)) {
      throw new Error('Installed desktop smoke fixture does not explicitly allow its loopback canary')
    }

    debuggingPort = await availablePort()
    while (debuggingPort === runtimePort) debuggingPort = await availablePort()
    const applicationEntry = desktopLaunchSelection.applicationEntry
    const applicationArguments = [
      ...(applicationEntry ? [applicationEntry] : []),
      `--remote-debugging-port=${debuggingPort}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-allow-origins=*',
      `--user-data-dir=${userData}`,
      '--no-first-run',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps'
    ]
    applicationArguments.push(...platformDesktopArguments(process.platform))
    const launch = createDesktopLaunchPlan({
      executable: desktopLaunchSelection.desktopExecutable,
      applicationArguments,
      environment: isolatedEnvironment,
      platform: process.platform,
      hasDisplay: Boolean(isolatedEnvironment.DISPLAY),
      xvfbExecutable: argumentValue('--xvfb-run') ?? 'xvfb-run'
    })
    desktopProcess = spawn(launch.command, launch.args, {
      cwd: home,
      env: launch.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const appendOutput = (chunk) => {
      output = `${output}${String(chunk)}`.slice(-PROCESS_OUTPUT_LIMIT)
    }
    desktopProcess.stdout?.on('data', appendOutput)
    desktopProcess.stderr?.on('data', appendOutput)
    desktopProcess.once('error', (error) => appendOutput(`\nlaunch error: ${String(error)}\n`))

    const endpoint = await waitForCdpEndpoint({
      port: debuggingPort,
      timeoutMs,
      processState: () => processState(desktopProcess)
    })
    cdp = await CdpConnection.connect(
      endpoint.webSocketDebuggerUrl,
      globalThis.WebSocket,
      Math.min(timeoutMs, DEFAULT_CDP_COMMAND_TIMEOUT_MS)
    )
    await cdp.send('Target.setDiscoverTargets', { discover: true })

    const workbenchTarget = await waitForTarget(
      cdp,
      isWorkbenchTarget,
      'packaged Kun workbench',
      timeoutMs,
      () => processState(desktopProcess)
    )
    const workbenchSession = {
      targetId: workbenchTarget.targetId,
      sessionId: undefined
    }
    await synchronizeWorkbenchContributionDiscovery({
      cdp,
      session: workbenchSession,
      workspaceRoot,
      contributionId: CONTRIBUTION_ID,
      timeoutMs,
      processState: () => processState(desktopProcess)
    })
    await waitForContributionAndClick({
      cdp,
      session: workbenchSession,
      contributionId: CONTRIBUTION_ID,
      timeoutMs,
      processState: () => processState(desktopProcess)
    })

    const guestTarget = await waitForTarget(
      cdp,
      isExtensionGuestTarget,
      `kun-extension guest target for ${EXTENSION_ID}`,
      timeoutMs,
      () => processState(desktopProcess)
    )
    const guestSession = {
      targetId: guestTarget.targetId,
      sessionId: undefined
    }
    const guestResult = await inspectGuestSecurity({
      cdp,
      session: guestSession,
      targetId: guestTarget.targetId,
      workbenchSession,
      localFileUrl: pathToFileURL(join(workspaceRoot, 'packaged-playback.wav')).href,
      fetchUrl: networkCanary.url,
      popupUrl: networkCanary.popupUrl,
      timeoutMs,
      processState: () => processState(desktopProcess)
    })
    assertGuestSecurityResult(guestResult, networkCanary.requestCount())

    await assertStaleViewSessionMediaBlocked({
      cdp,
      guestSession,
      guestTargetId: guestTarget.targetId,
      workbenchSession,
      timeoutMs,
      processState: () => processState(desktopProcess)
    })

    successMessage =
      `Packaged Extension desktop Chromium smoke OK (${process.platform}/${process.arch}): ` +
      `${desktopLaunchSelection.selfContained
        ? 'explicit self-contained packaged desktop executable'
        : applicationEntry
          ? 'explicit host Electron with packaged app.asar'
          : 'normal packaged Electron launch'}, ` +
      `CDP contribution click, ${guestTarget.type} guest, body marker, ` +
      'narrow kunExtension bridge, Theme and View-state round-trips, sender-bound kun-media playback/seek and image load, ' +
      'copied URL, arbitrary file URL, post-release, and stale View Session denial, ' +
      'hidden kunGui/require/process, ' +
      'Host-blocked loopback fetch, and user-gesture popup denial without a new target.\n'
  } catch (error) {
    primaryError = error
  } finally {
    if (cdp) {
      await cdp.send('Browser.close').catch(() => undefined)
      cdp.close()
    }
    if (desktopProcess) {
      await terminateProcessTree(desktopProcess, process.platform, {
        timeoutMs: Math.min(MAX_CLEANUP_TIMEOUT_MS, Math.max(5_000, timeoutMs)),
        ports: [runtimePort, debuggingPort].filter(Number.isSafeInteger)
      }).catch((error) => cleanupErrors.push(error))
    }
    await withTimeout(
      stopIsolatedSharedRuntime(unpackedRoot, profile),
      MAX_CLEANUP_TIMEOUT_MS + 5_000,
      'stopping the isolated packaged Extension Kun runtime'
    ).catch((error) => cleanupErrors.push(error))
    await withTimeout(
      stopIsolatedServiceManager(home, profile),
      MAX_CLEANUP_TIMEOUT_MS + 5_000,
      'stopping the isolated packaged Extension Kun Service Manager'
    ).catch((error) => cleanupErrors.push(error))
    releaseChildProcessHandles(desktopProcess)
    if (networkCanary) {
      await withTimeout(
        networkCanary.close(),
        2_000,
        'closing the packaged Extension network canary'
      ).catch((error) => cleanupErrors.push(error))
      await waitForPortsClosed([networkCanary.port], 2_000)
        .catch((error) => cleanupErrors.push(error))
    }
    if (process.env.KUN_KEEP_PACKAGED_EXTENSION_DESKTOP_SMOKE === '1') {
      process.stderr.write(`Preserved packaged desktop smoke profile: ${temporaryRoot}\n`)
      process.stderr.write(`Preserved packaged desktop smoke workspace: ${workspaceRoot}\n`)
    } else {
      await Promise.all([temporaryRoot, workspaceRoot].map(async (path) => {
        await withTimeout(
          makeTreeWritable(path),
          MAX_CLEANUP_TIMEOUT_MS,
          `making packaged Extension smoke directory writable: ${path}`
        ).catch((error) => cleanupErrors.push(error))
        await withTimeout(
          rm(path, {
            recursive: true,
            force: true,
            maxRetries: MAX_REMOVE_RETRIES,
            retryDelay: REMOVE_RETRY_DELAY_MS
          }),
          MAX_CLEANUP_TIMEOUT_MS,
          `removing packaged Extension smoke directory: ${path}`
        )
          .catch((error) => cleanupErrors.push(error))
      }))
    }
  }

  if (primaryError || cleanupErrors.length > 0) {
    const message = primaryError instanceof Error
      ? primaryError.stack ?? primaryError.message
      : primaryError === undefined
        ? 'Packaged Extension desktop smoke cleanup failed'
        : String(primaryError)
    const cleanupDiagnostics = cleanupErrors.length > 0
      ? `\nCleanup failures:\n${cleanupErrors.map((error) => `- ${error instanceof Error ? error.message : String(error)}`).join('\n')}`
      : ''
    const diagnostics = output.trim() ? `\nPackaged Electron output (tail):\n${output.trim()}` : ''
    throw new Error(`${message}${cleanupDiagnostics}${diagnostics}`)
  }
  process.stdout.write(successMessage)
}


module.exports = {
  CONTRIBUTION_ID,
  WEBVIEW_MARKER,
  CdpConnection,
  assertGuestSecurityResult,
  createDesktopLaunchPlan,
  createIsolatedEnvironment,
  desktopApplicationEntry,
  desktopResourceCandidates,
  desktopSmokeSettings,
  desktopSmokeWorkspaceParent,
  resolvedDesktopResourceCandidates,
  desktopUserDataCandidates,
  findUnexpectedPopupTargets,
  hasWorkbenchContribution,
  WORKBENCH_DISCOVERY_RETRY_DELAYS_MS,
  runGuestAsyncInspection,
  sendToGuestSession,
  synchronizeWorkbenchContributionDiscovery,
  waitForSuccessfulGuestInspection,
  isExtensionGuestTarget,
  isWorkbenchTarget,
  isVerifiedIsolatedKunCommand,
  platformDesktopArguments,
  resolveDesktopLaunchSelection,
  runPackagedKun,
  stopIsolatedServiceManager,
  stopIsolatedSharedRuntime,
  terminateProcessTree,
  waitForPortsClosed
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
