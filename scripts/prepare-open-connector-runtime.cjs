'use strict'

const { execFileSync } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')

const PROJECT_ROOT = join(__dirname, '..')
const RESOURCE_ROOT = join(PROJECT_ROOT, 'resources', 'open-connector')
const CURRENT_ROOT = join(RESOURCE_ROOT, 'current')
const LOCK_PATH = join(RESOURCE_ROOT, 'open-connector.lock.json')
const PREPARED_MARKER = '.kun-openconnector-runtime.json'
const RUNTIME_ARCHIVE_URL_ENV = 'KUN_OPENCONNECTOR_RUNTIME_ARCHIVE_URL'
const RUNTIME_MANIFEST_URL_ENV = 'KUN_OPENCONNECTOR_RUNTIME_MANIFEST_URL'
const MAX_RUNTIME_MANIFEST_BYTES = 1024 * 1024

function readJson(path, label) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`[open-connector] Cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`[open-connector] ${label} must contain an object`)
  }
  return parsed
}

function readLock() {
  const lock = readJson(LOCK_PATH, 'OpenConnector lock')
  const archive = lock.archive
  if (
    lock.schemaVersion !== 1 ||
    lock.name !== 'open-connector' ||
    lock.version !== '1.4.0' ||
    lock.protocolVersion !== '1' ||
    lock.nodeRange !== '>=22' ||
    lock.entrypoint !== 'dist/server/index.js' ||
    !archive ||
    archive.file !== 'open-connector-runtime-1.4.0.tar.gz' ||
    archive.sha256 !== '1275d22c83cabb16161f01cb7acfbe1a2ebb0c7696f3a3b5129d8bc7dbd6454f' ||
    archive.sizeBytes !== 12441728
  ) {
    throw new Error('[open-connector] OpenConnector lock has an unsupported contract')
  }
  return lock
}

function parseArgs(argv) {
  const output = { archive: process.env.KUN_OPENCONNECTOR_RUNTIME_ARCHIVE || '', manifest: process.env.KUN_OPENCONNECTOR_RUNTIME_MANIFEST || '', force: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--archive') output.archive = argv[++index] || ''
    else if (value === '--manifest') output.manifest = argv[++index] || ''
    else if (value === '--force') output.force = true
    else throw new Error(`[open-connector] Unknown argument: ${value}`)
  }
  return output
}

function explicitPath(value, label) {
  if (!value) return ''
  const path = isAbsolute(value) ? value : resolve(PROJECT_ROOT, value)
  if (!existsSync(path)) throw new Error(`[open-connector] ${label} does not exist: ${path}`)
  const details = lstatSync(path)
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`[open-connector] ${label} must be a regular non-symlink file: ${path}`)
  }
  return path
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function assertManifestMatchesLock(manifest, lock) {
  const archive = manifest.archive
  if (
    manifest.schemaVersion !== lock.schemaVersion ||
    manifest.name !== lock.name ||
    manifest.version !== lock.version ||
    manifest.protocolVersion !== lock.protocolVersion ||
    manifest.nodeRange !== lock.nodeRange ||
    manifest.entrypoint !== lock.entrypoint ||
    !archive ||
    archive.file !== lock.archive.file ||
    archive.sha256 !== lock.archive.sha256 ||
    archive.sizeBytes !== lock.archive.sizeBytes
  ) {
    throw new Error('[open-connector] Artifact manifest does not match the pinned OpenConnector lock')
  }
}

function assertArchiveMatchesLock(archivePath, lock) {
  const details = statSync(archivePath)
  if (details.size !== lock.archive.sizeBytes) {
    throw new Error(`[open-connector] Archive size mismatch: expected ${lock.archive.sizeBytes}, got ${details.size}`)
  }
  const digest = sha256(archivePath)
  if (digest !== lock.archive.sha256) {
    throw new Error(`[open-connector] Archive SHA-256 mismatch: expected ${lock.archive.sha256}, got ${digest}`)
  }
}

function normalizedArchivePath(value) {
  const normalized = value.replace(/^\.\//, '')
  if (!normalized || normalized === '.') return ''
  if (normalized.includes('\\') || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`[open-connector] Archive contains unsafe path: ${value}`)
  }
  return normalized
}

function archiveEntries(archivePath) {
  // node_modules produces a large but bounded listing. Keep the listing local
  // so it can be checked before extraction rather than relying on tar paths.
  const output = execFileSync('tar', ['-tzf', archivePath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  const entries = output.split(/\r?\n/).filter(Boolean).map(normalizedArchivePath).filter(Boolean)
  if (entries.length === 0) throw new Error('[open-connector] Runtime archive is empty')
  return entries
}

function assertContained(root, target, label) {
  const relativePath = relative(root, target)
  if (relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))) return
  throw new Error(`[open-connector] ${label} escapes the runtime root`)
}

function assertSafeExtractedTree(root, runtimeRoot = root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    assertContained(runtimeRoot, path, 'Extracted archive entry')
    const details = lstatSync(path)
    if (details.isSymbolicLink()) {
      const target = readlinkSync(path)
      if (isAbsolute(target)) {
        throw new Error(`[open-connector] Runtime archive contains an absolute symlink: ${path}`)
      }
      const resolvedTarget = resolve(dirname(path), target)
      assertContained(runtimeRoot, resolvedTarget, 'Runtime symlink')
      continue
    }
    if (details.isDirectory()) assertSafeExtractedTree(path, runtimeRoot)
    else if (!details.isFile()) throw new Error(`[open-connector] Runtime archive contains a non-file entry: ${path}`)
  }
}

function assertRuntime(root, lock, expectedArchive) {
  const metadataPath = join(root, 'runtime.json')
  const entrypointPath = join(root, ...lock.entrypoint.split('/'))
  const licensePath = join(root, 'LICENSE.txt')
  const noticePath = join(root, 'NOTICE.md')
  for (const [path, label] of [[metadataPath, 'runtime metadata'], [entrypointPath, 'runtime entrypoint'], [licensePath, 'runtime license'], [noticePath, 'runtime notice']]) {
    if (!existsSync(path)) throw new Error(`[open-connector] Missing ${label}: ${path}`)
    const details = lstatSync(path)
    if (details.isSymbolicLink() || !details.isFile() || details.size <= 0) {
      throw new Error(`[open-connector] ${label} must be a non-empty regular file: ${path}`)
    }
  }
  const metadata = readJson(metadataPath, 'runtime metadata')
  assertManifestMatchesLock({ ...metadata, archive: lock.archive }, lock)
  if (expectedArchive) {
    const marker = readJson(join(root, PREPARED_MARKER), 'prepared runtime marker')
    if (marker.schemaVersion !== 1 || marker.archiveSha256 !== expectedArchive.sha256 || marker.archiveSizeBytes !== expectedArchive.sizeBytes) {
      throw new Error('[open-connector] Prepared runtime marker does not match the pinned archive')
    }
  }
}

function prepareOpenConnectorRuntime({ archive: archiveValue, manifest: manifestValue, force = false } = {}) {
  const lock = readLock()
  const archivePath = explicitPath(archiveValue, 'Runtime archive')
  const manifestPath = explicitPath(manifestValue || (archivePath ? join(dirname(archivePath), 'manifest.json') : ''), 'Runtime manifest')

  if (!archivePath) {
    if (force) throw new Error('[open-connector] --force requires an explicit --archive')
    try {
      assertRuntime(CURRENT_ROOT, lock, lock.archive)
      console.log(`[open-connector] using verified prepared runtime ${lock.version}`)
      return { prepared: false, runtimeRoot: CURRENT_ROOT, lock }
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}. Supply KUN_OPENCONNECTOR_RUNTIME_ARCHIVE and KUN_OPENCONNECTOR_RUNTIME_MANIFEST for packaging.`)
    }
  }

  if (!manifestPath) throw new Error('[open-connector] An explicit runtime archive requires its manifest')
  const manifest = readJson(manifestPath, 'artifact manifest')
  assertManifestMatchesLock(manifest, lock)
  assertArchiveMatchesLock(archivePath, lock)
  const entries = archiveEntries(archivePath)
  const expectedEntrypoint = lock.entrypoint
  if (!entries.includes(expectedEntrypoint)) {
    throw new Error(`[open-connector] Runtime archive is missing ${expectedEntrypoint}`)
  }

  mkdirSync(RESOURCE_ROOT, { recursive: true, mode: 0o755 })
  const stagingRoot = join(RESOURCE_ROOT, `.open-connector-stage-${randomUUID()}`)
  const stagingRuntime = join(stagingRoot, 'current')
  const backupRoot = join(RESOURCE_ROOT, `.open-connector-previous-${randomUUID()}`)
  mkdirSync(stagingRuntime, { recursive: true, mode: 0o755 })
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', stagingRuntime], { stdio: 'inherit' })
    assertSafeExtractedTree(stagingRuntime)
    writeFileSync(join(stagingRuntime, PREPARED_MARKER), `${JSON.stringify({
      schemaVersion: 1,
      archiveFile: lock.archive.file,
      archiveSha256: lock.archive.sha256,
      archiveSizeBytes: lock.archive.sizeBytes
    }, null, 2)}\n`, { mode: 0o644 })
    assertRuntime(stagingRuntime, lock, lock.archive)

    if (existsSync(CURRENT_ROOT)) renameSync(CURRENT_ROOT, backupRoot)
    try {
      renameSync(stagingRuntime, CURRENT_ROOT)
    } catch (error) {
      if (existsSync(backupRoot)) renameSync(backupRoot, CURRENT_ROOT)
      throw error
    }
    rmSync(backupRoot, { recursive: true, force: true })
    console.log(`[open-connector] prepared ${lock.name} ${lock.version} (${lock.archive.sizeBytes} bytes)`)
    return { prepared: true, runtimeRoot: CURRENT_ROOT, lock }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
    if (existsSync(backupRoot)) {
      // Never discard the last verified runtime if the atomic swap or its
      // first rollback attempt failed. A second rename is safe when current is
      // absent; otherwise the successful replacement makes the backup stale.
      if (!existsSync(CURRENT_ROOT)) renameSync(backupRoot, CURRENT_ROOT)
      else rmSync(backupRoot, { recursive: true, force: true })
    }
  }
}

function assertRemoteRuntimeUrl(value, label) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`[open-connector] ${label} must be a valid HTTPS URL`)
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(`[open-connector] ${label} must be an HTTPS URL without embedded credentials`)
  }
  return parsed.href
}

async function downloadRuntimeInput({ url, label, maxBytes, expectedBytes, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new Error('[open-connector] This Node runtime does not provide fetch')
  const safeUrl = assertRemoteRuntimeUrl(url, label)
  const response = await fetchImpl(safeUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000)
  })
  if (!response.ok) {
    throw new Error(`[open-connector] ${label} download failed with HTTP ${response.status}`)
  }
  if (response.url) assertRemoteRuntimeUrl(response.url, `${label} redirect target`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`[open-connector] ${label} declares ${declared} bytes, above the ${maxBytes} byte limit`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > maxBytes) {
    throw new Error(`[open-connector] ${label} returned an invalid ${bytes.length} byte payload`)
  }
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
    throw new Error(`[open-connector] ${label} size mismatch: expected ${expectedBytes}, got ${bytes.length}`)
  }
  return bytes
}

async function prepareOpenConnectorRuntimeForCli(
  options,
  { environment = process.env, fetchImpl = globalThis.fetch } = {}
) {
  if (options.archive || options.manifest) return prepareOpenConnectorRuntime(options)

  let localError
  if (!options.force) {
    try {
      return prepareOpenConnectorRuntime(options)
    } catch (error) {
      localError = error
    }
  }

  const archiveUrl = environment[RUNTIME_ARCHIVE_URL_ENV]?.trim() || ''
  const manifestUrl = environment[RUNTIME_MANIFEST_URL_ENV]?.trim() || ''
  if (!archiveUrl && !manifestUrl) {
    if (localError) throw localError
    return prepareOpenConnectorRuntime(options)
  }
  if (!archiveUrl || !manifestUrl) {
    throw new Error(
      `[open-connector] ${RUNTIME_ARCHIVE_URL_ENV} and ${RUNTIME_MANIFEST_URL_ENV} must be configured together`
    )
  }

  const lock = readLock()
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'kun-openconnector-runtime-'))
  const archivePath = join(temporaryRoot, lock.archive.file)
  const manifestPath = join(temporaryRoot, 'manifest.json')
  try {
    const [archiveBytes, manifestBytes] = await Promise.all([
      downloadRuntimeInput({
        url: archiveUrl,
        label: 'Runtime archive',
        maxBytes: lock.archive.sizeBytes,
        expectedBytes: lock.archive.sizeBytes,
        fetchImpl
      }),
      downloadRuntimeInput({
        url: manifestUrl,
        label: 'Runtime manifest',
        maxBytes: MAX_RUNTIME_MANIFEST_BYTES,
        fetchImpl
      })
    ])
    writeFileSync(archivePath, archiveBytes, { mode: 0o600 })
    writeFileSync(manifestPath, manifestBytes, { mode: 0o600 })
    return prepareOpenConnectorRuntime({ archive: archivePath, manifest: manifestPath, force: true })
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

if (require.main === module) {
  prepareOpenConnectorRuntimeForCli(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(`[open-connector] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

exports._internals = {
  PROJECT_ROOT,
  RESOURCE_ROOT,
  CURRENT_ROOT,
  LOCK_PATH,
  PREPARED_MARKER,
  parseArgs,
  readLock,
  assertManifestMatchesLock,
  assertArchiveMatchesLock,
  normalizedArchivePath,
  archiveEntries,
  assertRuntime,
  prepareOpenConnectorRuntime,
  assertRemoteRuntimeUrl,
  downloadRuntimeInput,
  prepareOpenConnectorRuntimeForCli,
  RUNTIME_ARCHIVE_URL_ENV,
  RUNTIME_MANIFEST_URL_ENV
}
