#!/usr/bin/env node

// End-to-end acceptance for the transitional 0.3.x flat TUI archive layout.
//
// This harness builds the real v0.3.7 standalone TUI (the frozen updater users
// still have installed), installs it, and runs `kun update --yes` against a
// locally served candidate 0.3.8 flat archive. It proves that the three
// hard-coded v0.3.7 paths — kun/release.json, kun/runtime/node(.exe), and
// kun/app/kun/dist/cli/serve-entry.js — are all satisfied, that the upgrade
// completes, that the PATH entry keeps working, and that user data survives.
//
// The manifest and artifact URLs must be HTTPS (v0.3.7 rejects http), so the
// harness serves both over a local HTTPS server and trusts it through a
// committed test-only CA via NODE_EXTRA_CA_CERTS.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yauzl from 'yauzl'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..')
const CA_DIR = join(SCRIPT_DIR, 'fixtures', 'tui-self-update-ca')
const CA_CERT = join(CA_DIR, 'cert.pem')
const CA_KEY = join(CA_DIR, 'key.pem')
const V037_TAG = 'v0.3.7'
const V037_COMMIT = 'f466d2e242930f238da54d60e5effb8f78ebdd8f'
const DEFAULT_PREFIX = 'deepseek-gui'

const TARGETS = {
  'darwin-arm64': { os: 'mac', arch: 'arm64', format: 'tar.gz' },
  'darwin-x64': { os: 'mac', arch: 'x64', format: 'tar.gz' },
  'linux-arm64': { os: 'linux', arch: 'arm64', format: 'tar.gz' },
  'linux-x64': { os: 'linux', arch: 'x64', format: 'tar.gz' },
  'win32-x64': { os: 'win', arch: 'x64', format: 'zip' }
}

async function main() {
  const flags = readFlags(process.argv.slice(2))
  const candidate = resolve(required(flags, 'candidate'))
  const workDir = resolve(flags.get('work-dir') || (await mkdtemp(join(tmpdir(), 'kun-tui-037-update-'))))
  const repoRoot = resolve(flags.get('repo-root') || REPO_ROOT)
  const keep = flags.has('keep')
  const caCert = resolve(flags.get('ca-cert') || CA_CERT)
  const caKey = resolve(flags.get('ca-key') || CA_KEY)

  await mkdir(workDir, { recursive: true })
  const installRoot = join(workDir, 'install')
  const homeDir = join(workDir, 'home')
  let server

  try {
    const release = await readEmbeddedRelease(candidate)
    validateCandidate(candidate, release)
    const fileName = tuiFileName(release.version, release.target)
    if (basename(candidate) !== fileName) {
      throw new Error(`candidate must be named ${fileName}, got ${basename(candidate)}`)
    }
    const size = (await stat(candidate)).size
    const sha256 = await sha256File(candidate)

    server = await startHttpsServer(
      { cert: caCert, key: caKey },
      release,
      { candidate, fileName, size, sha256 }
    )
    const baseUrl = `https://127.0.0.1:${server.port}`

    const baselineArchive = await buildV037Baseline({
      repoRoot,
      workDir,
      target: release.target,
      publicBaseUrl: baseUrl
    })

    await installBaseline(baselineArchive, installRoot)
    await seedUserData(homeDir)

    await runV037Updater({ installRoot, homeDir, caCert })

    const manifestUrl = `https://127.0.0.1:${server.port}/${DEFAULT_PREFIX}/channels/stable/latest/latest-tui.json`
    await assertUpgraded({ installRoot, homeDir, caCert, version: release.version, manifestUrl })

    process.stdout.write(
      `TUI 0.3.7 -> ${release.version} self-update acceptance passed (${release.target}).\n`
    )
  } finally {
    server?.close?.()
    if (!keep) {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

function validateCandidate(artifactPath, release) {
  if (!release || typeof release.version !== 'string' || !/^[a-f0-9]{64}$/.test(release.buildId)) {
    throw new Error(`candidate ${basename(artifactPath)} has invalid embedded release metadata`)
  }
  if (!TARGETS[release.target]) {
    throw new Error(`candidate ${basename(artifactPath)} has unsupported target ${release.target}`)
  }
}

function tuiFileName(version, target) {
  const { os, arch, format } = TARGETS[target]
  return `Kun-TUI-${version}-${os}-${arch}.${format}`
}

function readFlags(argv) {
  const flags = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (!name.startsWith('--')) throw new Error(`Unexpected argument: ${name}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      flags.set(name.slice(2), 'true')
    } else {
      flags.set(name.slice(2), value)
      index += 1
    }
  }
  return flags
}

function required(flags, name) {
  const value = flags.get(name)
  if (!value) throw new Error(`Missing --${name}`)
  return value
}

async function readEmbeddedRelease(artifactPath) {
  const member = artifactPath.endsWith('.zip')
    ? await readZipMember(artifactPath, 'kun/release.json')
    : readTarMember(artifactPath, 'kun/release.json')
  if (member === null) return null
  return JSON.parse(member)
}

function readTarMember(artifactPath, member) {
  try {
    return execFileSync('tar', ['-xOf', artifactPath, member], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    })
  } catch {
    return null
  }
}

function readZipMember(artifactPath, member) {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(artifactPath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error(`Cannot open ${basename(artifactPath)}`))
        return
      }
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        zip.close()
        reject(error)
      }
      zip.on('error', fail)
      zip.on('end', () => {
        if (!settled) {
          settled = true
          zip.close()
          resolvePromise(null)
        }
      })
      zip.on('entry', (entry) => {
        if (entry.fileName !== member) {
          zip.readEntry()
          return
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error(`Cannot read ${member}`))
            return
          }
          const chunks = []
          let length = 0
          stream.on('data', (chunk) => {
            length += chunk.length
            if (length > 1024 * 1024) {
              stream.destroy(new Error(`${member} exceeds 1 MiB`))
              return
            }
            chunks.push(chunk)
          })
          stream.on('error', fail)
          stream.on('end', () => {
            if (settled) return
            settled = true
            zip.close()
            resolvePromise(Buffer.concat(chunks).toString('utf8'))
          })
        })
      })
      zip.readEntry()
    })
  })
}

async function startHttpsServer(tls, release, hostArtifact) {
  const [key, cert] = await Promise.all([readFile(tls.key), readFile(tls.cert)])
  let manifestBody = ''

  const httpServer = createHttpsServer({ key, cert }, (request, response) => {
    const url = new URL(request.url, 'https://127.0.0.1')
    if (url.pathname.endsWith('/latest-tui.json')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(manifestBody)
      return
    }
    if (url.pathname === `/artifact/${hostArtifact.fileName}`) {
      const stream = createReadStream(hostArtifact.candidate)
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': hostArtifact.size
      })
      stream.pipe(response)
      return
    }
    response.writeHead(404)
    response.end('not found')
  })

  await new Promise((resolvePromise, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => resolvePromise())
  })
  const port = httpServer.address().port
  manifestBody = `${JSON.stringify(buildManifest(release, { ...hostArtifact, port }))}\n`
  return { server: httpServer, port }
}

function buildManifest(release, hostArtifact) {
  const artifacts = Object.entries(TARGETS).map(([target, { os, arch, format }]) => {
    const isHost = target === release.target
    const fileName = isHost ? hostArtifact.fileName : tuiFileName(release.version, target)
    return {
      target,
      platform: target.split('-')[0],
      os,
      arch,
      format,
      fileName,
      size: isHost ? hostArtifact.size : 1,
      sha256: isHost ? hostArtifact.sha256 : 'a'.repeat(64),
      nodeVersion: '22.23.1',
      url: `https://127.0.0.1:${hostArtifact.port}/artifact/${fileName}`
    }
  })
  return {
    schemaVersion: 1,
    productName: 'Kun',
    component: 'tui',
    version: release.version,
    artifactVersion: release.version,
    tag: `v${release.version}`,
    channel: 'stable',
    buildId: release.buildId,
    artifacts
  }
}

async function buildV037Baseline({ repoRoot, workDir, target, publicBaseUrl }) {
  const v037Dir = join(workDir, 'v037')
  const outputDir = join(workDir, 'v037-out')
  run('git', ['-C', repoRoot, 'worktree', 'add', '--detach', v037Dir, V037_TAG])
  try {
    const env = {
      ...process.env,
      KUN_APP_VERSION: '0.3.7',
      KUN_ARTIFACT_VERSION: '0.3.7',
      RELEASE_CHANNEL: 'stable'
    }
    run('npm', ['ci'], { cwd: v037Dir, env })
    run('npm', ['--prefix', 'kun', 'ci'], { cwd: v037Dir, env })
    run('npm', ['run', 'build:kun'], { cwd: v037Dir, env })
    run('npm', ['run', 'package:tui', '--',
      '--version', '0.3.7',
      '--artifact-version', '0.3.7',
      '--tag', V037_TAG,
      '--channel', 'stable',
      '--commit', V037_COMMIT,
      '--target', target,
      '--output', outputDir,
      '--public-base-url', publicBaseUrl
    ], { cwd: v037Dir, env })
  } finally {
    try {
      run('git', ['-C', repoRoot, 'worktree', 'remove', '--force', v037Dir])
    } catch {
      // Best-effort cleanup; the caller removes the scratch directory.
    }
  }
  return join(outputDir, tuiFileName('0.3.7', target))
}

async function installBaseline(archive, installRoot) {
  await mkdir(installRoot, { recursive: true })
  if (archive.endsWith('.zip')) {
    const extractZip = (await import('extract-zip')).default
    await extractZip(archive, { dir: installRoot })
    return
  }
  run('tar', ['-xzf', archive, '-C', installRoot])
}

async function seedUserData(homeDir) {
  const settingsDir = join(homeDir, '.kun')
  await mkdir(settingsDir, { recursive: true })
  await writeFile(join(settingsDir, 'settings.json'), '{"marker":"settings-kept"}\n', 'utf8')
  await writeFile(join(settingsDir, 'threads.json'), '{"marker":"threads-kept"}\n', 'utf8')
}

async function runV037Updater({ installRoot, homeDir, caCert }) {
  const launcher = join(installRoot, 'kun', 'bin', process.platform === 'win32' ? 'kun.cmd' : 'kun')
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    NODE_EXTRA_CA_CERTS: caCert
  }
  if (process.platform === 'win32') {
    // The v0.3.7 Windows updater stages the rename in a detached PowerShell
    // process that activates only after this process exits; poll until it runs.
    const result = runCapture('cmd.exe', ['/c', launcher, 'update', '--yes'], { env })
    if (!result.includes('staged and will activate')) {
      throw new Error(`v0.3.7 Windows updater did not stage: ${result}`)
    }
    await waitForWindowsActivation(installRoot)
    return
  }
  const output = runCapture(launcher, ['update', '--yes'], { env })
  if (!output.includes('installed')) {
    throw new Error(`v0.3.7 updater did not report installation: ${output}`)
  }
}

async function waitForWindowsActivation(installRoot) {
  const updatedFrom = join(installRoot, 'kun', '.updated-from')
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      await readFile(updatedFrom, 'utf8')
      return
    } catch {
      // Not activated yet.
    }
    await delay(1_000)
  }
  throw new Error('timed out waiting for the v0.3.7 Windows replacement to activate')
}

async function assertUpgraded({ installRoot, homeDir, caCert, version, manifestUrl }) {
  const kunRoot = join(installRoot, 'kun')
  const releasePath = join(kunRoot, 'release.json')
  const launcher = join(kunRoot, 'bin', process.platform === 'win32' ? 'kun.cmd' : 'kun')
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    NODE_EXTRA_CA_CERTS: caCert
  }

  const installedRelease = JSON.parse(await readFile(releasePath, 'utf8'))
  if (installedRelease.version !== version) {
    throw new Error(`installed release.json is ${installedRelease.version}, expected ${version}`)
  }
  await stat(`${kunRoot}.previous`)

  const runKun = (args) => process.platform === 'win32'
    ? runCapture('cmd.exe', ['/c', launcher, ...args], { env })
    : runCapture(launcher, args, { env })

  const versionOutput = runKun(['--version']).trim()
  if (versionOutput !== `kun ${version}`) {
    throw new Error(`kun --version returned ${JSON.stringify(versionOutput)}`)
  }
  const helpOutput = runKun(['--help'])
  if (!helpOutput.includes('kun <command> [options]')) {
    throw new Error('kun --help did not report the expected usage')
  }

  const settings = await readFile(join(homeDir, '.kun', 'settings.json'), 'utf8')
  const threads = await readFile(join(homeDir, '.kun', 'threads.json'), 'utf8')
  if (!settings.includes('settings-kept') || !threads.includes('threads-kept')) {
    throw new Error('user data markers were not preserved')
  }

  // Point the installed updater's manifest check at the local server so the
  // up-to-date assertion is deterministic regardless of production state.
  installedRelease.updateManifestUrl = manifestUrl
  await writeFile(releasePath, `${JSON.stringify(installedRelease, null, 2)}\n`, 'utf8')

  // The installed updater (now 0.3.8) must parse its own flat layout and report
  // up to date against the same manifest.
  const updateOutput = runKun(['update'])
  if (!updateOutput.includes('up to date')) {
    throw new Error(`kun update did not report up to date: ${updateOutput}`)
  }
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    ...options,
    shell: process.platform === 'win32',
    stdio: 'inherit'
  })
}

function runCapture(command, args, options = {}) {
  return execFileSync(command, args, { ...options, encoding: 'utf8' }).toString()
}

async function sha256File(path) {
  const hash = createHash('sha256')
  await new Promise((resolvePromise, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolvePromise)
  })
  return hash.digest('hex')
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[test-tui-self-update-from-0.3.7] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
