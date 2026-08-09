'use strict'

const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, lstatSync, statSync } = require('node:fs')
const { readFile } = require('node:fs/promises')
const { basename, join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const { isDeepStrictEqual } = require('node:util')
const { assertRegularNonEmptyFile } = require('./lib/extension-native-media-smoke.cjs')

const EXTENSION_ID = 'kun-examples.kun-video-editor'
const EXTENSION_VERSION = '0.4.4'
const SUCCESS_MARKER = 'Packaged Kun Video Editor native smoke OK ('
const REEXEC_MARKER = 'KUN_PACKAGED_VIDEO_EDITOR_NATIVE_SMOKE_REEXEC'
const DEFAULT_COMMAND_TIMEOUT_MS = 180_000
const DEFAULT_JOB_TIMEOUT_MS = 120_000
const DEFAULT_SMOKE_TIMEOUT_MS = 10 * 60_000
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024
const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const PACKAGED_CAPTION_TEXT = 'A deterministic packaged caption'
const EXPECTED_PACKAGED_SRT =
  `1\n00:00:00,000 --> 00:00:01,500\n${PACKAGED_CAPTION_TEXT}\n`
const EXPECTED_TOOL_IDS = [
  'video-project',
  'video-inspect',
  'video-probe',
  'video-transcribe',
  'video-read-script',
  'video-apply-script',
  'video-update-timeline',
  'video-analyze-visual',
  'video-analyze-audio',
  'video-analysis-status',
  'video-analysis-cancel',
  'video-interchange',
  'video-interchange-status',
  'video-interchange-cancel',
  'video-generation-catalog',
  'video-generation-request',
  'video-generation-status',
  'video-generation-cancel',
  'video-project-package',
  'video-project-package-status',
  'video-project-package-cancel',
  'video-render',
  'video-render-status',
  'video-render-cancel',
  'video-undo'
]


function createPackagedReexecInvocation({
  runtimeExecutable,
  scriptPath,
  argv = [],
  environment = process.env
}) {
  const env = scrubEnvironment(environment)
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: '1',
    KUN_DISABLE_OS_CREDENTIAL_STORE: '1',
    [REEXEC_MARKER]: '1',
    NODE_ENV: 'production'
  })
  return {
    command: resolve(runtimeExecutable),
    args: [resolve(scriptPath), ...argv],
    options: {
      cwd: process.cwd(),
      env,
      shell: false,
      encoding: 'utf8',
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      timeout: DEFAULT_SMOKE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  }
}

function assertPackagedReexecResult(result) {
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `Packaged Kun Video Editor native smoke child failed ` +
      `(${result.signal ?? result.status ?? 'unknown exit'})`
    )
  }
  if (!String(result.stdout ?? '').includes(SUCCESS_MARKER)) {
    throw new Error('Packaged Kun Video Editor native smoke child omitted its completion marker')
  }
}


function assertRegisteredToolIds(registrations) {
  const actual = registrations
    .map((registration) => registration?.declaration?.name)
    .filter((name) => typeof name === 'string')
    .sort()
  const expected = [...EXPECTED_TOOL_IDS].sort()
  if (actual.length === registrations.length && isDeepStrictEqual(actual, expected)) return
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  const missing = expected.filter((name) => !actualSet.has(name))
  const unexpected = actual.filter((name) => !expectedSet.has(name))
  throw new Error(
    `Packaged Kun Video Editor registered an unexpected tool surface ` +
    `(expected ${expected.length}, received ${registrations.length}; ` +
    `missing: ${missing.join(', ') || 'none'}; ` +
    `unexpected: ${unexpected.join(', ') || 'none'})`
  )
}

async function loadPackagedRuntimeModules(unpackedRoot) {
  const [serve, runtimeFactory] = await Promise.all([
    importFresh(join(unpackedRoot, 'kun', 'dist', 'cli', 'serve.js')),
    importFresh(join(unpackedRoot, 'kun', 'dist', 'server', 'runtime-factory.js'))
  ])
  if (typeof serve.parseServeOptions !== 'function' ||
      typeof runtimeFactory.createKunServeRuntime !== 'function') {
    throw new Error('Packaged Kun runtime omitted the required native smoke composition exports')
  }
  return {
    parseServeOptions: serve.parseServeOptions,
    createKunServeRuntime: runtimeFactory.createKunServeRuntime
  }
}

function runNpm(args, { cwd, timeoutMs }) {
  const invocation = createNpmInvocation({
    args,
    cwd,
    runtimeExecutable: process.execPath,
    environment: process.env,
    timeoutMs
  })
  return runInvocation(invocation, `npm ${args.join(' ')}`)
}

function createNpmInvocation({
  args,
  cwd,
  runtimeExecutable = process.execPath,
  environment = process.env,
  platform = process.platform,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS
}) {
  const npmCli = environment.npm_execpath
  if (npmCli && existsSync(npmCli)) {
    return {
      command: runtimeExecutable,
      args: [npmCli, ...args],
      options: commandOptions({ cwd, environment, timeoutMs, shell: false })
    }
  }
  return {
    command: platform === 'win32' ? 'npm.cmd' : 'npm',
    args,
    options: commandOptions({ cwd, environment, timeoutMs, shell: platform === 'win32' })
  }
}

function runPackagedCli(runtimeExecutable, runtimeEntry, args, {
  cwd,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS
}) {
  return runInvocation({
    command: runtimeExecutable,
    args: [runtimeEntry, ...args],
    options: commandOptions({
      cwd,
      timeoutMs,
      environment: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1'
      },
      shell: false
    })
  }, `packaged kun ${args.join(' ')}`)
}

function runRequiredCommand(invocation, {
  cwd,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  environment = process.env
}) {
  return runInvocation({
    command: invocation.command,
    args: invocation.args,
    options: commandOptions({ cwd, timeoutMs, environment, shell: false })
  }, invocation.label)
}

function runInvocation(invocation, label) {
  const result = spawnSync(invocation.command, invocation.args, invocation.options)
  if (result.error) throw result.error
  if (result.status !== 0) {
    const output = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`.trim()
    throw new Error(
      `${label} failed (${result.signal ?? result.status ?? 'unknown exit'})` +
      `${output ? `:\n${output.slice(-32_000)}` : ''}`
    )
  }
  return String(result.stdout ?? '')
}

function commandOptions({ cwd, environment, timeoutMs, shell }) {
  return {
    cwd,
    env: scrubEnvironment(environment),
    shell,
    encoding: 'utf8',
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }
}

function runFfprobe(ffprobePath, mediaPath, timeoutMs) {
  const body = runInvocation({
    command: ffprobePath,
    args: [
      '-v', 'error',
      '-hide_banner',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      mediaPath
    ],
    options: commandOptions({
      cwd: resolve(mediaPath, '..'),
      environment: process.env,
      timeoutMs,
      shell: false
    })
  }, 'post-export host-native ffprobe')
  try {
    return JSON.parse(body)
  } catch {
    throw new Error('Post-export host-native ffprobe returned invalid JSON')
  }
}

function assertH264Probe(probe) {
  if (!isRecord(probe) || !Array.isArray(probe.streams)) {
    throw new Error('Post-export ffprobe omitted streams')
  }
  if (!probe.streams.some((stream) => isRecord(stream) &&
      stream.codec_type === 'video' && stream.codec_name === 'h264')) {
    throw new Error('Post-export ffprobe did not confirm an H.264 video stream')
  }
  const duration = Number(isRecord(probe.format) ? probe.format.duration : undefined)
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Post-export ffprobe did not confirm a positive duration')
  }
}

function assertCompletedArtifact(result, expectedMime, label) {
  return assertCompletedArtifacts(result, [{ mimePrefix: expectedMime }], label)[0]
}

function assertCompletedArtifacts(result, expected, label) {
  assertContent(result, {
    outcome: 'completed',
    state: 'completed',
    technicallyValidated: true
  }, label)
  if (!Array.isArray(result.generatedArtifacts) || result.generatedArtifacts.length !== expected.length) {
    throw new Error(`${label} did not publish exactly ${expected.length} generated artifacts`)
  }
  const artifacts = result.generatedArtifacts
  for (const artifact of artifacts) {
    if (!isRecord(artifact) || typeof artifact.artifactId !== 'string' ||
        artifact.availability !== 'available' || typeof artifact.mimeType !== 'string') {
      throw new Error(`${label} published an invalid generated artifact: ${JSON.stringify(artifact)}`)
    }
  }
  const matched = expected.map((specification) => artifacts.find((artifact) =>
    (specification.mediaKind === undefined || artifact.mediaKind === specification.mediaKind) &&
    (specification.mimeType === undefined || artifact.mimeType === specification.mimeType) &&
    (specification.mimePrefix === undefined || artifact.mimeType.startsWith(specification.mimePrefix))))
  if (matched.some((artifact) => artifact === undefined) ||
      new Set(matched.map((artifact) => artifact.artifactId)).size !== expected.length) {
    throw new Error(
      `${label} did not publish the expected artifact types: ${JSON.stringify(result.generatedArtifacts)}`
    )
  }
  return matched
}

function assertContent(result, expected, label) {
  const content = contentOf(result, label)
  for (const [key, value] of Object.entries(expected)) {
    if (!isDeepStrictEqual(content[key], value)) {
      throw new Error(
        `${label} expected content.${key}=${JSON.stringify(value)}, got ${JSON.stringify(content[key])}`
      )
    }
  }
  return content
}

async function assertSourcePreserved(path, expectedHash, label) {
  await assertRegularNonEmptyFile(path, label)
  if (await sha256File(path) !== expectedHash) {
    throw new Error(`${label} changed during packaged media processing`)
  }
}

async function assertSrtSidecar(path, label) {
  await assertRegularNonEmptyFile(path, label)
  const normalized = (await readFile(path, 'utf8')).replace(/\r\n?/gu, '\n').trimEnd()
  if (normalized !== EXPECTED_PACKAGED_SRT.trimEnd()) {
    throw new Error(
      `${label} did not preserve deterministic cue ordering/content: ${JSON.stringify(normalized)}`
    )
  }
  return normalized
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function contentOf(result, label) {
  if (!isRecord(result) || !isRecord(result.content)) {
    throw new Error(`${label} returned no object content: ${JSON.stringify(result)}`)
  }
  return result.content
}

function jobId(result, label) {
  const content = contentOf(result, label)
  const value = content.jobId
  if (typeof value !== 'string' || value.length < 8) {
    throw new Error(`${label} returned no durable job ID: ${JSON.stringify(content)}`)
  }
  return value
}

async function withMediaEnvironment(executables, operation) {
  const previous = {
    ffmpeg: process.env.KUN_FFMPEG_PATH,
    ffprobe: process.env.KUN_FFPROBE_PATH
  }
  process.env.KUN_FFMPEG_PATH = executables.ffmpeg
  process.env.KUN_FFPROBE_PATH = executables.ffprobe
  try {
    return await operation()
  } finally {
    restoreEnvironment('KUN_FFMPEG_PATH', previous.ffmpeg)
    restoreEnvironment('KUN_FFPROBE_PATH', previous.ffprobe)
  }
}

function mediaEnvironment(environment, executables) {
  return {
    ...environment,
    KUN_FFMPEG_PATH: executables.ffmpeg,
    KUN_FFPROBE_PATH: executables.ffprobe
  }
}

function scrubEnvironment(environment) {
  const result = { ...environment }
  for (const key of [
    'ELECTRON_RENDERER_URL',
    'NODE_OPTIONS',
    'NODE_PATH',
    'VITE_DEV_SERVER_URL',
    'WEBPACK_DEV_SERVER_URL'
  ]) delete result[key]
  return result
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function executableName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name
}

function importFresh(path) {
  return import(`${pathToFileURL(path).href}?packaged-native=${Date.now()}-${Math.random()}`)
}

function assertPath(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Missing ${label}: ${path}`)
}

function assertReleaseArchive(path) {
  const details = lstatSync(path)
  if (!details.isFile() || details.isSymbolicLink() || details.size === 0) {
    throw new Error(`Packaged Kun Video Editor smoke archive must be a non-empty regular file: ${path}`)
  }
  if (basename(path) !== `kun-video-editor-${EXTENSION_VERSION}.kunx`) {
    throw new Error(
      `Packaged Kun Video Editor smoke archive must be named ` +
      `kun-video-editor-${EXTENSION_VERSION}.kunx`
    )
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function positiveIntegerArgument(name, fallback) {
  const value = argumentValue(name)
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function captionModeArgument(name, fallback) {
  return parseCaptionMode(argumentValue(name), fallback, name)
}

function parseCaptionMode(value, fallback = 'both', label = 'caption mode') {
  if (value === undefined) return fallback
  if (value !== 'both' && value !== 'sidecar') {
    throw new Error(`${label} must be both or sidecar`)
  }
  return value
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

module.exports = {
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
}
