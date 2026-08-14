#!/usr/bin/env node

'use strict'

const { randomUUID } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { existsSync, lstatSync, statSync } = require('node:fs')
const {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm
} = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { basename, join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const { isDeepStrictEqual } = require('node:util')
const {
  makeTreeWritable,
  resolvePackagedRuntimeExecutable,
  resolveResources,
  validatePackagedResources
} = require('./smoke-packaged-extensions.cjs')
const {
  assertRegularNonEmptyFile,
  createDeterministicVideoFixtureInvocations,
  resolveHostMediaExecutables
} = require('./lib/extension-native-media-smoke.cjs')

const {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_SMOKE_TIMEOUT_MS,
  EXPECTED_TOOL_IDS,
  EXTENSION_ID,
  EXTENSION_VERSION,
  MAX_COMMAND_OUTPUT_BYTES,
  PACKAGED_CAPTION_TEXT,
  REEXEC_MARKER,
  SUCCESS_MARKER,
  TERMINAL_JOB_STATES,
  argumentValue,
  assertCompletedArtifact,
  assertCompletedArtifacts,
  assertContent,
  assertH264Probe,
  assertPackagedReexecResult,
  assertPath,
  assertRegisteredToolIds,
  assertReleaseArchive,
  assertSourcePreserved,
  assertSrtSidecar,
  captionModeArgument,
  contentOf,
  createNpmInvocation,
  createPackagedReexecInvocation,
  delay,
  executableName,
  importFresh,
  isRecord,
  jobId,
  loadPackagedRuntimeModules,
  mediaEnvironment,
  parseCaptionMode,
  positiveIntegerArgument,
  runFfprobe,
  runNpm,
  runPackagedCli,
  runRequiredCommand,
  scrubEnvironment,
  sha256File,
  withMediaEnvironment
} = require('./smoke-packaged-video-editor-native-support.cjs')

async function main() {
  const resourcesDir = resolveResources(argumentValue('--resources'))
  const runtimeExecutable = resolvePackagedRuntimeExecutable(
    resourcesDir,
    argumentValue('--runtime-executable')
  )
  if (!runtimeExecutable) {
    throw new Error(
      `Packaged Kun Video Editor native smoke requires a host-native packaged runtime for ` +
      `${process.platform}/${process.arch}`
    )
  }
  if (process.env[REEXEC_MARKER] !== '1') {
    const invocation = createPackagedReexecInvocation({
      runtimeExecutable,
      scriptPath: __filename,
      argv: process.argv.slice(2),
      environment: process.env
    })
    const result = spawnSync(invocation.command, invocation.args, invocation.options)
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    assertPackagedReexecResult(result)
    return
  }

  await runPackagedVideoEditorNativeSmoke({
    resourcesDir,
    runtimeExecutable,
    repositoryRoot: argumentValue('--repository-root') ?? resolve(__dirname, '..'),
    archivePath: argumentValue('--archive'),
    captionMode: captionModeArgument('--caption-mode', 'both'),
    commandTimeoutMs: positiveIntegerArgument('--command-timeout-ms', DEFAULT_COMMAND_TIMEOUT_MS),
    jobTimeoutMs: positiveIntegerArgument('--job-timeout-ms', DEFAULT_JOB_TIMEOUT_MS)
  })
}

async function runPackagedVideoEditorNativeSmoke({
  resourcesDir,
  runtimeExecutable,
  repositoryRoot,
  archivePath,
  captionMode = 'both',
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS
}) {
  const unpackedRoot = join(resourcesDir, 'app.asar.unpacked')
  const runtimeEntry = join(unpackedRoot, 'kun', 'dist', 'cli', 'serve-entry.js')
  validatePackagedResources(resourcesDir, unpackedRoot)

  const root = resolve(repositoryRoot)
  const exampleRoot = join(root, 'examples', 'extensions', 'kun-video-editor')
  assertPath(join(exampleRoot, 'kun-extension.json'), 'Kun Video Editor manifest')
  assertPath(join(exampleRoot, 'package.json'), 'Kun Video Editor package')
  const exampleDist = join(exampleRoot, 'dist')
  const exampleDistExisted = existsSync(exampleDist)
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kun-packaged-video-editor-native-'))
  const profile = join(temporaryRoot, 'profile')
  const workspace = join(temporaryRoot, 'workspace')
  const fixtureDirectory = join(workspace, 'fixtures')
  const exportDirectory = join(workspace, 'exports')
  const archive = archivePath === undefined
    ? join(temporaryRoot, 'kun-video-editor.kunx')
    : resolve(archivePath)
  const shortFixture = join(fixtureDirectory, 'short-source.mp4')
  const cancellationFixture = join(fixtureDirectory, 'cancellation-source.mp4')
  const proofOutput = join(exportDirectory, 'proof.png')
  const videoOutput = join(exportDirectory, 'final.mp4')
  const subtitleOutput = join(exportDirectory, 'final.srt')
  const cancellationOutput = join(exportDirectory, 'cancelled.mp4')
  let primaryError
  const cleanupErrors = []

  try {
    await Promise.all([
      mkdir(profile, { recursive: true }),
      mkdir(fixtureDirectory, { recursive: true }),
      mkdir(exportDirectory, { recursive: true })
    ])
    const executables = resolveHostMediaExecutables()
    if (archivePath === undefined) {
      runNpm(
        ['--prefix', exampleRoot, 'run', 'build'],
        { cwd: root, timeoutMs: commandTimeoutMs }
      )
      runPackagedCli(runtimeExecutable, runtimeEntry, [
        'extension', 'validate', exampleRoot, '--json'
      ], { cwd: root, timeoutMs: commandTimeoutMs })
      runPackagedCli(runtimeExecutable, runtimeEntry, [
        'extension', 'pack', exampleRoot,
        '--output', archive,
        '--include', 'dist',
        '--overwrite',
        '--json'
      ], { cwd: root, timeoutMs: commandTimeoutMs })
    } else {
      assertReleaseArchive(archive)
    }
    runPackagedCli(runtimeExecutable, runtimeEntry, [
      'extension', 'validate', archive, '--json'
    ], { cwd: root, timeoutMs: commandTimeoutMs })
    const archiveHash = await sha256File(archive)
    runPackagedCli(runtimeExecutable, runtimeEntry, [
      'extension', 'install', archive,
      '--data-dir', profile,
      '--accept-permissions',
      '--json'
    ], { cwd: root, timeoutMs: commandTimeoutMs })
    assertPath(join(profile, 'extensions', EXTENSION_ID, EXTENSION_VERSION, 'kun-extension.json'), 'installed video editor manifest')
    assertPath(join(profile, 'extensions', EXTENSION_ID, EXTENSION_VERSION, 'dist', 'host', 'extension.js'), 'installed video editor Host')

    for (const invocation of createDeterministicVideoFixtureInvocations({
      ffmpegPath: executables.ffmpeg,
      shortOutput: shortFixture,
      cancellationOutput: cancellationFixture
    })) {
      runRequiredCommand(invocation, {
        cwd: workspace,
        timeoutMs: commandTimeoutMs,
        environment: mediaEnvironment(process.env, executables)
      })
    }
    await Promise.all([
      assertRegularNonEmptyFile(shortFixture, 'short native media fixture'),
      assertRegularNonEmptyFile(cancellationFixture, 'cancellation native media fixture')
    ])
    const sourceHashes = {
      short: await sha256File(shortFixture),
      cancellation: await sha256File(cancellationFixture)
    }

    const packagedModules = await loadPackagedRuntimeModules(unpackedRoot)
    const success = await withPackagedRuntime({
      ...packagedModules,
      profile,
      workspace,
      executables
    }, async (runtime, smoke) => {
      return await exerciseSuccessfulNativeWorkflow(runtime, smoke, {
        workspace,
        shortFixture,
        cancellationFixture,
        proofOutput,
        videoOutput,
        subtitleOutput,
        cancellationOutput,
        ffprobePath: executables.ffprobe,
        jobTimeoutMs,
        commandTimeoutMs,
        captionMode
      })
    })

    const missingExecutables = {
      ffmpeg: join(temporaryRoot, 'unavailable', executableName('ffmpeg')),
      ffprobe: join(temporaryRoot, 'unavailable', executableName('ffprobe'))
    }
    await withPackagedRuntime({
      ...packagedModules,
      profile,
      workspace,
      executables: missingExecutables
    }, async (runtime, smoke) => {
      await exerciseUnavailableExecutablePath(runtime, smoke, {
        sourceHandleId: success.shortSourceHandleId
      })
    })

    runPackagedCli(runtimeExecutable, runtimeEntry, [
      'extension', 'uninstall', EXTENSION_ID,
      '--data-dir', profile,
      '--json'
    ], { cwd: root, timeoutMs: commandTimeoutMs })
    const listed = JSON.parse(runPackagedCli(runtimeExecutable, runtimeEntry, [
      'extension', 'list',
      '--data-dir', profile,
      '--json'
    ], { cwd: root, timeoutMs: commandTimeoutMs }))
    if (!Array.isArray(listed.extensions) || listed.extensions.some(({ id }) => id === EXTENSION_ID)) {
      throw new Error('Packaged Kun Video Editor uninstall left a registry entry')
    }
    await assertRegularNonEmptyFile(videoOutput, 'export preserved after extension uninstall')
    await assertRegularNonEmptyFile(proofOutput, 'proof preserved after extension uninstall')
    const preservedSubtitle = await assertSrtSidecar(subtitleOutput, 'subtitle preserved after extension uninstall')
    if (preservedSubtitle !== success.subtitleText) {
      throw new Error('Subtitle sidecar changed after extension uninstall')
    }
    await assertSourcePreserved(shortFixture, sourceHashes.short, 'short source')
    await assertSourcePreserved(cancellationFixture, sourceHashes.cancellation, 'cancellation source')
    if (await sha256File(archive) !== archiveHash) {
      throw new Error('Packaged Kun Video Editor smoke archive changed during lifecycle validation')
    }

    process.stdout.write(
      `${SUCCESS_MARKER}${process.platform}/${process.arch}): real packaged Kun runtime, ` +
      `real kun-video-editor .kunx ${archivePath === undefined ? 'build/' : ''}validate/install/activation, ` +
      'host-native ffprobe, proof artifact, ' +
      `${captionMode === 'both' ? 'burned-caption' : 'sidecar-caption fallback'} H.264/SRT export, ` +
      'post-probe/artifact publication, durable cancellation, executable-unavailable path, ' +
      'source preservation, and uninstall.\n'
    )
  } catch (error) {
    primaryError = error
  } finally {
    if (!exampleDistExisted) {
      await rm(exampleDist, { recursive: true, force: true }).catch((error) => cleanupErrors.push(error))
    }
    if (process.env.KUN_KEEP_PACKAGED_VIDEO_EDITOR_NATIVE_SMOKE === '1') {
      process.stderr.write(`Preserved packaged video editor native smoke profile: ${temporaryRoot}\n`)
    } else {
      await makeTreeWritable(temporaryRoot).catch(() => undefined)
      await rm(temporaryRoot, { recursive: true, force: true }).catch((error) => cleanupErrors.push(error))
    }
  }

  if (primaryError || cleanupErrors.length > 0) {
    const primary = primaryError instanceof Error
      ? primaryError.stack ?? primaryError.message
      : primaryError === undefined
        ? 'Packaged Kun Video Editor native smoke cleanup failed'
        : String(primaryError)
    const cleanup = cleanupErrors.length > 0
      ? `\nCleanup failures:\n${cleanupErrors.map((error) => `- ${error instanceof Error ? error.message : String(error)}`).join('\n')}`
      : ''
    throw new Error(`${primary}${cleanup}`)
  }
}

async function exerciseSuccessfulNativeWorkflow(runtime, smoke, paths) {
  const shortSource = await smoke.registerMedia({
    path: 'fixtures/short-source.mp4',
    mode: 'read',
    source: 'workspace',
    mimeType: 'video/mp4'
  })
  const cancellationSource = await smoke.registerMedia({
    path: 'fixtures/cancellation-source.mp4',
    mode: 'read',
    source: 'workspace',
    mimeType: 'video/mp4'
  })
  const proofTarget = await smoke.registerMedia({
    path: 'exports/proof.png',
    mode: 'write',
    source: 'workspace',
    mimeType: 'image/png'
  })
  const videoTarget = await smoke.registerMedia({
    path: 'exports/final.mp4',
    mode: 'write',
    source: 'workspace',
    mimeType: 'video/mp4'
  })
  const subtitleTarget = await smoke.registerMedia({
    path: 'exports/final.srt',
    mode: 'write',
    source: 'workspace',
    mimeType: 'application/x-subrip'
  })
  const cancellationTarget = await smoke.registerMedia({
    path: 'exports/cancelled.mp4',
    mode: 'write',
    source: 'workspace',
    mimeType: 'video/mp4'
  })

  await smoke.invoke('video-project', {
    action: 'create',
    projectId: 'packaged-native-success',
    name: 'Packaged native success'
  })
  const probed = await smoke.invoke('video-probe', {
    projectId: 'packaged-native-success',
    expectedRevision: 0,
    mediaHandleId: shortSource.id,
    assetId: 'short-source',
    addToTimeline: true
  })
  assertContent(probed, { outcome: 'imported', currentRevision: 1 }, 'video-probe')

  const proofStart = await smoke.invoke('video-render', {
    projectId: 'packaged-native-success',
    expectedRevision: 1,
    kind: 'proof-frame',
    outputHandleId: proofTarget.id,
    proofFrame: 0,
    captionMode: 'none',
    idempotencyKey: 'packaged-native-proof'
  })
  const proofStatus = await smoke.waitForJob(jobId(proofStart, 'proof render'), paths.jobTimeoutMs)
  const proofArtifact = assertCompletedArtifact(proofStatus, 'image/', 'proof render')
  await assertRegularNonEmptyFile(paths.proofOutput, 'packaged proof output')

  const timelineUpdate = await smoke.invoke('video-update-timeline', {
    projectId: 'packaged-native-success',
    expectedRevision: 1,
    operations: [{
      type: 'add-caption',
      caption: {
        id: 'packaged-native-caption',
        trackId: 'captions-1',
        startFrame: 0,
        endFrame: 45,
        text: PACKAGED_CAPTION_TEXT,
        placement: 'bottom'
      }
    }],
    summary: 'Add deterministic native smoke caption'
  })
  assertContent(timelineUpdate, {
    outcome: 'updated',
    previousRevision: 1,
    currentRevision: 2
  }, 'video-update-timeline')

  const videoStart = await smoke.invoke('video-render', {
    projectId: 'packaged-native-success',
    expectedRevision: 2,
    kind: 'h264-mp4',
    outputHandleId: videoTarget.id,
    captionMode: paths.captionMode,
    subtitleOutputHandleId: subtitleTarget.id,
    subtitleFormat: 'srt',
    idempotencyKey: 'packaged-native-h264'
  })
  const videoStatus = await smoke.waitForJob(jobId(videoStart, 'H.264 render'), paths.jobTimeoutMs)
  const [videoArtifact, subtitleArtifact] = assertCompletedArtifacts(videoStatus, [
    { mediaKind: 'video', mimeType: 'video/mp4' },
    { mediaKind: 'subtitle', mimeType: 'application/x-subrip' }
  ], `${paths.captionMode === 'both' ? 'burned-caption' : 'sidecar-caption'} H.264/SRT render`)
  await assertRegularNonEmptyFile(paths.videoOutput, 'packaged H.264 output')
  const subtitleText = await assertSrtSidecar(paths.subtitleOutput, 'packaged SRT sidecar')
  assertH264Probe(runFfprobe(paths.ffprobePath, paths.videoOutput, paths.commandTimeoutMs))

  await smoke.invoke('video-project', {
    action: 'create',
    projectId: 'packaged-native-cancel',
    name: 'Packaged native cancellation'
  })
  const cancellationProbe = await smoke.invoke('video-probe', {
    projectId: 'packaged-native-cancel',
    expectedRevision: 0,
    mediaHandleId: cancellationSource.id,
    assetId: 'cancellation-source',
    addToTimeline: true
  })
  assertContent(cancellationProbe, { outcome: 'imported', currentRevision: 1 }, 'cancellation video-probe')
  const cancellationStart = await smoke.invoke('video-render', {
    projectId: 'packaged-native-cancel',
    expectedRevision: 1,
    kind: 'h264-mp4',
    outputHandleId: cancellationTarget.id,
    captionMode: 'none',
    idempotencyKey: 'packaged-native-cancellation'
  })
  const cancellationJobId = jobId(cancellationStart, 'cancellation render')
  const cancelled = await smoke.invoke('video-render-cancel', {
    jobId: cancellationJobId,
    reason: 'Packaged native smoke cancellation'
  })
  assertContent(cancelled, {
    outcome: 'cancelled',
    state: 'cancelled',
    technicallyValidated: false
  }, 'video-render-cancel cancellation')
  if (smoke.approvalCount('video-render-status') !== 0) {
    throw new Error('Read-only video-render-status unexpectedly requested approval')
  }
  if (smoke.approvalCount('video-render-cancel') !== 1) {
    throw new Error('Destructive video-render-cancel did not request exactly one approval')
  }
  if (Array.isArray(cancelled.generatedArtifacts) && cancelled.generatedArtifacts.length > 0) {
    throw new Error('Cancelled packaged render published generated artifacts')
  }
  if (existsSync(paths.cancellationOutput)) {
    throw new Error('Cancelled packaged render promoted a partial output')
  }

  const durableArtifacts = await runtime.extensionPlatform.artifacts.listOwned(
    smoke.principal,
    smoke.workspaceKey
  )
  const expectedArtifactIds = new Set([
    proofArtifact.artifactId,
    videoArtifact.artifactId,
    subtitleArtifact.artifactId
  ])
  for (const artifactId of expectedArtifactIds) {
    if (!durableArtifacts.some((artifact) => artifact.artifactId === artifactId && artifact.availability === 'available')) {
      throw new Error(`Generated artifact ${artifactId} was not durably published`)
    }
  }
  if (durableArtifacts.some((artifact) => artifact.provenance?.jobId === cancellationJobId)) {
    throw new Error('Cancelled packaged render left a durable artifact record')
  }
  if (durableArtifacts.length !== expectedArtifactIds.size) {
    throw new Error(
      `Packaged native workflow published ${durableArtifacts.length} artifacts instead of ` +
      `${expectedArtifactIds.size}`
    )
  }
  return { shortSourceHandleId: shortSource.id, subtitleText }
}

async function exerciseUnavailableExecutablePath(_runtime, smoke, { sourceHandleId }) {
  await smoke.invoke('video-project', {
    action: 'create',
    projectId: 'packaged-native-unavailable',
    name: 'Packaged native unavailable executable'
  })
  const unavailable = await smoke.invoke('video-probe', {
    projectId: 'packaged-native-unavailable',
    expectedRevision: 0,
    mediaHandleId: sourceHandleId,
    assetId: 'unavailable-source',
    addToTimeline: true
  })
  const unavailableContent = assertContent(unavailable, {
    outcome: 'unavailable',
    code: 'FFPROBE_UNAVAILABLE',
    currentRevision: 0,
    changedIds: []
  }, 'unavailable video-probe preflight')
  const diagnostic = JSON.stringify(unavailableContent)
  if (!diagnostic.includes('ffprobe is unavailable')) {
    throw new Error(`Missing ffprobe path returned an unexpected diagnostic: ${diagnostic}`)
  }
  if (diagnostic.includes('unavailable/ffprobe') || diagnostic.includes('unavailable\\\\ffprobe')) {
    throw new Error('Missing executable diagnostic leaked the configured unavailable path')
  }
  const unchanged = await smoke.invoke('video-project', {
    action: 'get',
    projectId: 'packaged-native-unavailable'
  })
  const unchangedContent = assertContent(unchanged, { outcome: 'loaded' }, 'unavailable project rollback')
  if (!isRecord(unchangedContent.project) || unchangedContent.project.currentRevision !== 0) {
    throw new Error('Unavailable ffprobe path advanced the project revision')
  }
}

async function withPackagedRuntime({
  parseServeOptions,
  createKunServeRuntime,
  profile,
  workspace,
  executables
}, operation) {
  return await withMediaEnvironment(executables, async () => {
    const options = parseServeOptions([
      '--data-dir', profile,
      '--api-key', 'packaged-video-editor-smoke-placeholder',
      '--base-url', 'https://invalid.example',
      '--model', 'packaged-video-editor-smoke-model',
      '--approval-policy', 'auto',
      '--sandbox-mode', 'danger-full-access'
    ], {})
    const runtime = await createKunServeRuntime(options)
    try {
      const smoke = await prepareRuntime(runtime, workspace)
      return await operation(runtime, smoke)
    } finally {
      await runtime.shutdown?.()
    }
  })
}

async function prepareRuntime(runtime, workspace) {
  if (!runtime.extensionPlatform || !runtime.toolHost) {
    throw new Error('Packaged Kun runtime omitted the Extension Platform or ToolHost')
  }
  const platform = runtime.extensionPlatform
  const entry = await platform.registry.get(EXTENSION_ID)
  const active = entry?.useDevelopment
    ? entry.development
    : entry?.selectedVersion
      ? entry.versions[entry.selectedVersion]
      : undefined
  if (!active) throw new Error('Installed Kun Video Editor has no selected registry version')
  const canonicalWorkspace = await realpath(workspace)
  const workspaceKey = platform.paths.workspaceKey(canonicalWorkspace)
  await platform.registry.setWorkspaceEnabled(EXTENSION_ID, workspaceKey, true)
  await platform.registry.setWorkspacePermissionGrant(
    EXTENSION_ID,
    workspaceKey,
    [...active.grantedPermissions],
    active.manifest.version
  )
  const host = await platform.manager.activate(EXTENSION_ID, 'onTool:video-project', {
    workspaceRoot: canonicalWorkspace,
    workspaceContext: {
      id: workspaceKey,
      name: basename(canonicalWorkspace) || 'Packaged native workspace',
      root: canonicalWorkspace,
      trusted: true,
      active: true
    }
  })
  if (!host) throw new Error('Packaged Kun Video Editor Host did not activate')
  const registrations = platform.tools.list(EXTENSION_ID)
  assertRegisteredToolIds(registrations)
  const aliases = new Map(registrations.map((registration) => [
    registration.declaration.name,
    registration.modelAlias
  ]))
  const principal = {
    extensionId: EXTENSION_ID,
    extensionVersion: active.manifest.version,
    permissions: [...active.grantedPermissions],
    workspaceRoots: [canonicalWorkspace],
    workspaceTrusted: true
  }
  let callSequence = 0
  const approvalCounts = new Map()
  const invokeRaw = async (localToolId, args) => {
    const toolName = aliases.get(localToolId)
    if (!toolName) throw new Error(`Packaged Kun Video Editor tool is unavailable: ${localToolId}`)
    callSequence += 1
    const controller = new AbortController()
    return await runtime.toolHost.execute({
      callId: `packaged_native_${callSequence}_${randomUUID().slice(0, 8)}`,
      toolName,
      providerId: `extension:${EXTENSION_ID}`,
      arguments: args
    }, {
      threadId: 'packaged_video_editor_native',
      turnId: `packaged_video_editor_native_${callSequence}`,
      workspace: canonicalWorkspace,
      threadMode: 'agent',
      memoryPolicy: { enabled: false },
      delegationPolicy: { enabled: false },
      approvalPolicy: 'auto',
      sandboxMode: 'danger-full-access',
      abortSignal: controller.signal,
      awaitApproval: async () => {
        approvalCounts.set(localToolId, (approvalCounts.get(localToolId) ?? 0) + 1)
        return 'allow'
      }
    })
  }
  const invoke = async (localToolId, args) => {
    const result = await invokeRaw(localToolId, args)
    if (result.item.kind !== 'tool_result') {
      throw new Error(`Packaged tool ${localToolId} returned ${result.item.kind}`)
    }
    if (result.item.isError) {
      throw new Error(`Packaged tool ${localToolId} failed: ${JSON.stringify(result.item.output)}`)
    }
    if (!isRecord(result.item.output)) {
      throw new Error(`Packaged tool ${localToolId} returned a non-object result`)
    }
    return result.item.output
  }
  return {
    principal,
    workspaceKey,
    invoke,
    invokeRaw,
    approvalCount: (localToolId) => approvalCounts.get(localToolId) ?? 0,
    registerMedia: (input) => platform.mediaHandles.register(principal, {
      workspaceRoot: canonicalWorkspace,
      ...input
    }),
    waitForJob: async (jobIdValue, timeoutMs) => {
      const deadline = Date.now() + timeoutMs
      let last
      while (Date.now() < deadline) {
        last = await invoke('video-render-status', { jobId: jobIdValue })
        const state = contentOf(last, 'video-render-status').state
        if (typeof state === 'string' && TERMINAL_JOB_STATES.has(state)) {
          if (state !== 'completed') {
            throw new Error(`Packaged media job ${jobIdValue} ended as ${state}: ${JSON.stringify(last)}`)
          }
          return last
        }
        await delay(100)
      }
      throw new Error(
        `Timed out waiting for packaged media job ${jobIdValue}; last status: ${JSON.stringify(last ?? null)}`
      )
    }
  }
}

module.exports = {
  EXTENSION_ID,
  EXTENSION_VERSION,
  EXPECTED_TOOL_IDS,
  SUCCESS_MARKER,
  assertContent,
  assertCompletedArtifact,
  assertCompletedArtifacts,
  assertH264Probe,
  assertPackagedReexecResult,
  assertRegisteredToolIds,
  assertReleaseArchive,
  assertSrtSidecar,
  captionModeArgument,
  createNpmInvocation,
  createPackagedReexecInvocation,
  parseCaptionMode,
  runPackagedVideoEditorNativeSmoke
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
