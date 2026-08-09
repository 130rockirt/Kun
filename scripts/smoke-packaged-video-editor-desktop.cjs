#!/usr/bin/env node

'use strict'

const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { existsSync, statSync } = require('node:fs')
const {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} = require('node:fs/promises')
const { createServer: createHttpServer } = require('node:http')
const { createServer: createNetServer } = require('node:net')
const { tmpdir } = require('node:os')
const { basename, join, resolve } = require('node:path')
const {
  makeTreeWritable,
  resolvePackagedRuntimeExecutable,
  resolveResources,
  validatePackagedResources
} = require('./smoke-packaged-extensions.cjs')
const {
  createIsolatedEnvironment,
  desktopSmokeSettings,
  desktopSmokeWorkspaceParent,
  desktopUserDataCandidates,
  platformDesktopArguments,
  resolveDesktopLaunchSelection,
  runPackagedKun,
  terminateProcessTree,
  waitForPortsClosed
} = require('./smoke-packaged-extension-desktop.cjs')
const {
  deterministicFixtureArguments,
  resolveHostMediaExecutables
} = require('./lib/extension-native-media-smoke.cjs')

const {
  CONTRIBUTION_ID,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  EXTENSION_ID,
  EXTENSION_VERSION,
  MAX_CLEANUP_TIMEOUT_MS,
  MODEL_NAME,
  SUCCESS_MARKER,
  VIDEO_EDITOR_PERMISSIONS
} = require('./smoke-packaged-video-editor-desktop-constants.cjs')
const {
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
} = require('./smoke-packaged-video-editor-desktop-runtime.cjs')
const {
  assertLocalizedFirstLaunchPermissionPrompt,
  hasVideoEditorGuest,
  evaluateVideoEditorGuest,
  readGuestSnapshot,
  waitForGuestSnapshot,
  setGuestFormValue,
  submitGuestForm,
  clickGuestButton,
  clickGuestSelector,
  applyWorkbenchSettings,
  startAgentToolTurn,
  waitForAgentTurn,
  startOfflineModelFixture,
  openAiToolCallFrames,
  openAiTextFrames,
  sseFrame,
  assertNoGuestErrors,
  guestDiagnostic,
  pollUntil,
  availablePort,
  sha256FileBytes
} = require('./smoke-packaged-video-editor-desktop-guest.cjs')

async function main() {
  const timeoutMs = positiveIntegerArgument('--timeout-ms', DEFAULT_TIMEOUT_MS)
  const jobTimeoutMs = positiveIntegerArgument('--job-timeout-ms', DEFAULT_JOB_TIMEOUT_MS)
  const resourcesDir = resolveResources(argumentValue('--resources'))
  const packagedRuntimeExecutable = resolvePackagedRuntimeExecutable(resourcesDir)
  const runtimeExecutable = resolvePackagedRuntimeExecutable(
    resourcesDir,
    argumentValue('--runtime-executable')
  )
  if (!runtimeExecutable) {
    throw new Error(
      `The packaged Kun application at ${resourcesDir} is not host-native for ${process.arch}`
    )
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

  const repositoryRoot = resolve(argumentValue('--repository-root') ?? join(__dirname, '..'))
  const archive = await resolveVideoEditorArchive(
    resourcesDir,
    argumentValue('--archive')
  )
  const transcriptFixture = join(
    repositoryRoot,
    'examples',
    'extensions',
    'kun-video-editor',
    'fixtures',
    'talking-head.srt'
  )
  assertRegularFile(transcriptFixture, 'committed SRT fixture')

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kun-video-editor-desktop-e2e-'))
  const home = join(temporaryRoot, 'home')
  const profile = join(home, '.kun', 'data')
  const userData = join(temporaryRoot, 'electron-user-data')
  const appData = join(temporaryRoot, 'app-data')
  const localAppData = join(temporaryRoot, 'local-app-data')
  const temporaryDirectory = join(temporaryRoot, 'tmp')
  const workspaceParent = desktopSmokeWorkspaceParent(repositoryRoot)
  await mkdir(workspaceParent, { recursive: true })
  const workspaceRoot = await mkdtemp(join(workspaceParent, 'video-editor-e2e-'))
  const fixtureDirectory = join(workspaceRoot, 'fixtures')
  const exportDirectory = join(workspaceRoot, 'exports')
  const videoFixture = join(fixtureDirectory, 'desktop-e2e-source.mp4')
  const transcript = join(fixtureDirectory, 'desktop-e2e-source.srt')
  const subtitleOutput = join(exportDirectory, 'desktop-e2e-output.srt')
  const runtimePort = await availablePort()
  const cleanupErrors = []
  let primaryError
  let electronApplication
  let electronProcess
  let firstDesktopPid
  let relaunchedDesktopPid
  let modelFixture
  let mediaExecutables

  try {
    await Promise.all([
      mkdir(profile, { recursive: true }),
      mkdir(userData, { recursive: true }),
      mkdir(appData, { recursive: true }),
      mkdir(localAppData, { recursive: true }),
      mkdir(temporaryDirectory, { recursive: true }),
      mkdir(fixtureDirectory, { recursive: true }),
      mkdir(exportDirectory, { recursive: true })
    ])

    mediaExecutables = resolveHostMediaExecutables()
    createVideoFixture(mediaExecutables.ffmpeg, videoFixture, workspaceRoot, timeoutMs)
    await copyFile(transcriptFixture, transcript)
    await Promise.all([
      assertNonEmptyFile(videoFixture, 'desktop MP4 fixture'),
      assertNonEmptyFile(transcript, 'desktop SRT fixture')
    ])

    modelFixture = await startOfflineModelFixture()
    const settings = desktopVideoEditorSettings({
      runtimePort,
      workspaceRoot,
      dataDir: profile,
      modelBaseUrl: modelFixture.baseUrl
    })
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

    const isolatedEnvironment = createIsolatedEnvironment(process.env, {
      home,
      appData,
      localAppData,
      temporaryDirectory
    })
    isolatedEnvironment.KUN_FFMPEG_PATH = mediaExecutables.ffmpeg
    isolatedEnvironment.KUN_FFPROBE_PATH = mediaExecutables.ffprobe

    runPackagedKun(
      desktopLaunchSelection.cliExecutable,
      runtimeEntry,
      [
        'extension', 'install', archive,
        '--data-dir', profile,
        '--accept-permissions',
        '--json'
      ],
      isolatedEnvironment,
      timeoutMs
    )

    const launch = () => launchPackagedDesktop({
      desktopLaunchSelection,
      userData,
      home,
      environment: isolatedEnvironment,
      timeoutMs
    })

    electronApplication = await launch()
    electronProcess = electronApplication.process()
    firstDesktopPid = electronProcess.pid
    if (!Number.isSafeInteger(firstDesktopPid) || firstDesktopPid <= 0) {
      throw new Error(`Packaged Electron did not expose a valid first-launch PID: ${firstDesktopPid}`)
    }
    await installNativeDialogStubs(electronApplication, {
      openSelections: [[videoFixture], [transcript]],
      saveSelections: [subtitleOutput]
    })
    let workbench = await findWorkbenchWindow(electronApplication, timeoutMs)
    await openUntrustedVideoEditor(
      workbench,
      electronApplication,
      workspaceRoot,
      timeoutMs
    )

    let snapshot = await waitForGuestSnapshot(
      electronApplication,
      (value) => value.ready &&
        value.lang.toLowerCase().startsWith('zh') &&
        value.theme === 'light' &&
        value.text.includes('开始你的第一支作品') &&
        value.text.includes('Kun 视频剪辑'),
      'Chinese/light Kun Video Editor View',
      timeoutMs
    )
    assertNoGuestErrors(snapshot, 'initializing the Chinese/light editor')

    await setGuestFormValue(
      electronApplication,
      '.onboarding-project-card input',
      'Desktop E2E Alpha'
    )
    await submitGuestForm(electronApplication, '.onboarding-project-card')
    snapshot = await waitForGuestSnapshot(
      electronApplication,
      (value) => value.projectName === 'Desktop E2E Alpha' && Boolean(value.projectId) && !value.busy,
      'first video project creation',
      timeoutMs
    )
    assertNoGuestErrors(snapshot, 'creating the first project')
    const firstProjectId = snapshot.projectId

    await clickGuestButton(electronApplication, '导入媒体', '.project-actions')
    snapshot = await waitForGuestSnapshot(
      electronApplication,
      (value) => value.assets.includes(basename(videoFixture)) &&
        value.selectedAssetName === basename(videoFixture) && value.revision >= 1 && !value.busy,
      'real MP4 import and ffprobe metadata',
      timeoutMs
    )
    assertNoGuestErrors(snapshot, 'importing MP4 media')

    await clickGuestButton(electronApplication, '导入逐字稿')
    snapshot = await waitForGuestSnapshot(
      electronApplication,
      (value) => value.transcriptCount === 3 &&
        value.text.includes('This range stays editable.') &&
        !value.busy,
      'real SRT import',
      timeoutMs
    )
    assertNoGuestErrors(snapshot, 'importing the SRT transcript')

    const revisionBeforeEdit = snapshot.revision
    await clickGuestSelector(electronApplication, '.transcript-cut', 1)
    snapshot = await waitForGuestSnapshot(
      electronApplication,
      (value) => value.revision > revisionBeforeEdit && !value.busy,
      'manual transcript-range edit',
      timeoutMs
    )
    assertNoGuestErrors(snapshot, 'applying the manual edit')

    await clickGuestButton(electronApplication, '生成字幕')
    snapshot = await waitForGuestSnapshot(
      electronApplication,
      (value) => value.captionCount > 0 && !value.busy,
      'caption generation from imported transcript',
      timeoutMs
    )
    assertNoGuestErrors(snapshot, 'generating captions')

    await clickGuestSelector(electronApplication, '#video-editor-tab-output')
    await clickGuestButton(electronApplication, '导出 SRT', '.output-kind-options')
    await clickGuestButton(electronApplication, '导出 SRT', '.export-primary-row')
    snapshot = await waitForGuestSnapshot(
      electronApplication,
      (value) => value.jobStates.includes('completed') && !value.busy,
      'durable standalone SRT export',
      jobTimeoutMs
    )
    assertNoGuestErrors(snapshot, 'exporting SRT')
    const exportedSubtitle = await readFile(subtitleOutput, 'utf8')
    if (!/\d\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n.+/u.test(exportedSubtitle)) {
      throw new Error('Desktop SRT export did not contain a bounded timed caption cue')
    }

    await clickGuestSelector(electronApplication, '.create-project-toggle')
    await setGuestFormValue(electronApplication, '.new-project-form input', 'Desktop E2E Beta')
    await submitGuestForm(electronApplication, '.new-project-form')
    snapshot = await waitForGuestSnapshot(
      electronApplication,
      (value) => value.projectName === 'Desktop E2E Beta' &&
        value.projectId !== firstProjectId &&
        !value.busy,
      'second project creation',
      timeoutMs
    )
    assertNoGuestErrors(snapshot, 'creating the second project')

    modelFixture.setTargetProjectId(firstProjectId)
    const turn = await startAgentToolTurn(workbench, workspaceRoot)
    const terminalTurn = await waitForAgentTurn(workbench, turn, timeoutMs)
    if (terminalTurn.status !== 'completed') {
      throw new Error(`Main Agent desktop E2E turn ended as ${terminalTurn.status}: ${terminalTurn.error ?? 'no detail'}`)
    }
    const modelState = modelFixture.snapshot()
    if (!modelState.toolCallIssued || !modelState.toolResultObserved) {
      throw new Error(
        'Main Agent did not complete the real extension ToolHost round-trip; ' +
        `offline model state: ${JSON.stringify(modelState)}`
      )
    }
    snapshot = await waitForGuestSnapshot(
      electronApplication,
      (value) => value.projectId === firstProjectId && value.syncText.length > 0,
      'Main Agent video-project selection reflected in the video editor View',
      timeoutMs
    )
    assertNoGuestErrors(snapshot, 'synchronizing the Main Agent tool result')

    await applyWorkbenchSettings(workbench, { locale: 'en', theme: 'dark' })
    snapshot = await waitForGuestSnapshot(
      electronApplication,
      (value) => value.lang.toLowerCase().startsWith('en') && value.theme === 'dark' &&
        value.text.toLowerCase().includes('ready to deliver') && value.text.includes('Output mode'),
      'English/dark View update from Kun settings',
      timeoutMs
    )
    assertNoGuestErrors(snapshot, 'following English/dark Kun settings')

    // Give the debounced View state writer time to commit before exercising a
    // full desktop shutdown/relaunch with the same isolated profile.
    await delay(350)
    const firstRunProcess = electronProcess
    await electronApplication.evaluate(({ app }) => {
      setTimeout(() => app.quit(), 0)
    })
    // macOS keeps the application process alive when its last window closes.
    // Let the explicit quit run before Playwright disconnects, then verify the
    // exact launcher PID and its managed runtime are gone before relaunching.
    await delay(1_000)
    await terminateProcessTree(firstRunProcess, process.platform, {
      timeoutMs: MAX_CLEANUP_TIMEOUT_MS,
      ports: [runtimePort]
    })
    await electronApplication.close().catch(() => undefined)
    electronApplication = undefined
    electronProcess = undefined

    electronApplication = await launch()
    electronProcess = electronApplication.process()
    relaunchedDesktopPid = electronProcess.pid
    if (!Number.isSafeInteger(relaunchedDesktopPid) || relaunchedDesktopPid <= 0) {
      throw new Error(`Packaged Electron did not expose a valid relaunch PID: ${relaunchedDesktopPid}`)
    }
    if (relaunchedDesktopPid === firstDesktopPid) {
      throw new Error(`Packaged Electron relaunch reused the original PID ${firstDesktopPid}`)
    }
    await installNativeDialogStubs(electronApplication, {
      openSelections: [],
      saveSelections: []
    })
    workbench = await findWorkbenchWindow(electronApplication, timeoutMs)
    await openVideoEditor(workbench, electronApplication, timeoutMs)
    snapshot = await waitForGuestSnapshot(
      electronApplication,
      (value) => value.projectId === firstProjectId &&
        value.projectName === 'Desktop E2E Alpha' &&
        value.assets.includes(basename(videoFixture)) &&
        value.transcriptCount === 3 &&
        value.captionCount > 0 &&
        value.jobStates.includes('completed') &&
        value.lang.toLowerCase().startsWith('en') &&
        value.theme === 'dark',
      'project, revision, output job, locale and theme recovery after desktop relaunch',
      timeoutMs
    )
    assertNoGuestErrors(snapshot, 'restoring the editor after relaunch')
    process.stdout.write(
      `${SUCCESS_MARKER}${process.platform}/${process.arch}): real packaged Electron, ` +
      `desktop PID ${firstDesktopPid} -> ${relaunchedDesktopPid}, ` +
      'default-hidden first-launch View opened from Extension management with localized protected permission/risk review, ' +
      'main-process native picker stubs, zh/light -> en/dark, ' +
      'real MP4/SRT import, manual transcript edit, durable SRT export, Main Agent extension-tool sync, ' +
      'and close/reopen recovery.\n'
    )
  } catch (error) {
    primaryError = error
  } finally {
    if (electronApplication) {
      await electronApplication.close().catch((error) => cleanupErrors.push(error))
    }
    if (electronProcess && !electronProcess.killed) {
      await terminateProcessTree(electronProcess, process.platform, {
        timeoutMs: MAX_CLEANUP_TIMEOUT_MS,
        ports: [runtimePort]
      }).catch((error) => cleanupErrors.push(error))
    }
    if (modelFixture) {
      await modelFixture.close().catch((error) => cleanupErrors.push(error))
      await waitForPortsClosed([modelFixture.port], 2_000).catch((error) => cleanupErrors.push(error))
    }
    if (process.env.KUN_KEEP_VIDEO_EDITOR_DESKTOP_E2E === '1') {
      process.stderr.write(`Preserved desktop E2E profile: ${temporaryRoot}\n`)
      process.stderr.write(`Preserved desktop E2E workspace: ${workspaceRoot}\n`)
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
        ? 'Kun Video Editor desktop E2E cleanup failed'
        : String(primaryError)
    const cleanup = cleanupErrors.length > 0
      ? `\nCleanup failures:\n${cleanupErrors.map((error) => `- ${error instanceof Error ? error.message : String(error)}`).join('\n')}`
      : ''
    throw new Error(`${message}${cleanup}`)
  }
}

function assertRegularFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Missing ${label}: ${path}`)
}

async function assertNonEmptyFile(path, label) {
  const details = await stat(path)
  if (!details.isFile() || details.size <= 0) throw new Error(`${label} is missing or empty: ${path}`)
  return { bytes: details.size, sha256: sha256FileBytes(await readFile(path)) }
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

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

module.exports = {
  CONTRIBUTION_ID,
  EXTENSION_ID,
  EXTENSION_VERSION,
  MODEL_NAME,
  SUCCESS_MARKER,
  VIDEO_EDITOR_PERMISSIONS,
  assertLocalizedFirstLaunchPermissionPrompt,
  desktopVideoEditorSettings,
  evaluateVideoEditorGuest,
  findWorkbenchWindow,
  guestDiagnostic,
  launchPackagedDesktop,
  openVideoEditor,
  openAiTextFrames,
  openAiToolCallFrames,
  readGuestSnapshot,
  resolveVideoEditorArchive,
  sseFrame,
  waitForGuestSnapshot
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
