#!/usr/bin/env node

// End-to-end acceptance for the transitional 0.3.x flat TUI archive layout.
//
// This harness downloads the published v0.3.7 standalone TUI (the frozen updater users
// still have installed), installs it, and runs `kun update --yes` against a
// locally served candidate 0.3.8 flat archive. It proves that the three
// hard-coded v0.3.7 paths — kun/release.json, kun/runtime/node(.exe), and
// kun/app/kun/dist/cli/serve-entry.js — are all satisfied, that the upgrade
// completes, that the PATH entry keeps working, and that user data survives.
//
// The manifest and artifact URLs must be HTTPS (v0.3.7 rejects http), so the
// harness serves both over a local HTTPS server and trusts it through a
// committed test-only CA via NODE_EXTRA_CA_CERTS.

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yauzl from 'yauzl'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const CA_DIR = join(SCRIPT_DIR, 'fixtures', 'tui-self-update-ca')
const CA_CERT = join(CA_DIR, 'cert.pem')
const CA_KEY = join(CA_DIR, 'key.pem')
const V037_TAG = 'v0.3.7'
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
  const parent = resolve(flags.get('work-dir') || tmpdir())
  await mkdir(parent, { recursive: true })
  const workDir = await mkdtemp(join(parent, 'kun-tui-037-update-'))
  const keep = flags.has('keep')
  const caCert = resolve(flags.get('ca-cert') || CA_CERT)
  const caKey = resolve(flags.get('ca-key') || CA_KEY)

  await mkdir(workDir, { recursive: true })
  const installRoot = join(workDir, 'install')
  const homeDir = join(workDir, 'home')
  let server
  let passed = false

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

    const baselineArchive = await downloadV037Baseline(workDir, release.target)

    await installBaseline(baselineArchive, installRoot)
    const baselineMetadataPath = join(installRoot, 'kun', 'release.json')
    const baselineMetadata = JSON.parse(await readFile(baselineMetadataPath, 'utf8'))
    if (baselineMetadata.version !== '0.3.7' || baselineMetadata.target !== release.target) {
      throw new Error('Published baseline metadata does not match 0.3.7 and the host target')
    }
    baselineMetadata.updateManifestUrl = `${baseUrl}/${DEFAULT_PREFIX}/channels/stable/latest/latest-tui.json`
    await writeFile(baselineMetadataPath, JSON.stringify(baselineMetadata))
    await seedUserData(homeDir)

    await runV037Updater({ installRoot, homeDir, caCert })

    const manifestUrl = `https://127.0.0.1:${server.port}/${DEFAULT_PREFIX}/channels/stable/latest/latest-tui.json`
    await assertUpgraded({ installRoot, homeDir, caCert, version: release.version, manifestUrl })
    await assertNextUpdate({ candidate, release, workDir, installRoot, homeDir, caCert, manifestUrl, server })

    process.stdout.write(
      `TUI 0.3.7 -> ${release.version} -> simulated next release acceptance passed (${release.target}).\n`
    )
    passed = true
  } finally {
    await server?.close()
    if (!keep && passed) {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    } else {
      process.stderr.write(`TUI upgrade evidence retained at ${workDir}\n`)
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
  if (release.target !== `${process.platform}-${process.arch}`) {
    throw new Error('Candidate must match the native host target')
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

export async function startHttpsServer(tls, release, hostArtifact) {
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
  return {
    port,
    setRelease(nextRelease, nextArtifact) {
      hostArtifact = nextArtifact
      manifestBody = `${JSON.stringify(buildManifest(nextRelease, { ...nextArtifact, port }))}\n`
    },
    close: () => new Promise((resolvePromise, reject) => {
      httpServer.close((error) => error ? reject(error) : resolvePromise())
      httpServer.closeAllConnections()
    })
  }
}

async function assertNextUpdate({ candidate, release, workDir, installRoot, homeDir, caCert, manifestUrl, server }) {
  // Change only the *download fixture's* identity, never the installed updater.
  // This exercises the real candidate updater's flat -> immutable migration and
  // pointer activation without pretending an unreleased 0.3.9 binary exists.
  const parts = release.version.split('.').map(Number)
  const version = `${parts[0]}.${parts[1]}.${parts[2] + 1}`
  const buildId = createHash('sha256').update(`upgrade-fixture:${release.buildId}:${version}`).digest('hex')
  const futureRoot = join(workDir, 'next-fixture')
  await installBaseline(candidate, futureRoot)
  const nextRelease = { ...release, version, artifactVersion: version, tag: `v${version}`, buildId,
    updateManifestUrl: manifestUrl }
  await writeFile(join(futureRoot, 'kun', 'release.json'), JSON.stringify(nextRelease))
  const runtimeManifestPath = join(futureRoot, 'kun', 'app', 'kun', 'dist', 'runtime-build.json')
  const runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, 'utf8'))
  await writeFile(runtimeManifestPath, JSON.stringify({ ...runtimeManifest, buildId,
    serviceVersion: version, artifactVersion: version }))
  const fileName = tuiFileName(version, release.target)
  const artifact = join(workDir, fileName)
  await runCapture('tar', process.platform === 'win32'
    ? ['-a', '-cf', artifact, 'kun'] : ['-czf', artifact, 'kun'], { cwd: futureRoot })
  server.setRelease(nextRelease, { candidate: artifact, fileName, size: (await stat(artifact)).size,
    sha256: await sha256File(artifact) })
  const base = join(installRoot, 'kun')
  const launcher = join(base, 'bin', process.platform === 'win32' ? 'kun.cmd' : 'kun')
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, NODE_EXTRA_CA_CERTS: caCert }
  const output = await runLauncher(launcher, ['update', '--yes'], env)
  if (!output.includes(`Kun ${version} installed`)) throw new Error(`Next update failed: ${output}`)
  if ((await readFile(join(base, 'current'), 'utf8')).trim() !== `releases/${buildId}`) {
    throw new Error('Next update did not activate the immutable release pointer')
  }
  const previous = JSON.parse(await readFile(join(base, 'releases', release.buildId, 'release.json'), 'utf8'))
  if (previous.version !== release.version) throw new Error('Next update lost the rollback release')
  if ((await runLauncher(launcher, ['--version'], env)).trim() !== `kun ${version}`) {
    throw new Error('The stable PATH launcher did not start the simulated next release')
  }
  if (!(await runLauncher(launcher, ['update'], env)).includes('up to date')) {
    throw new Error('The pointer-layout installation cannot check subsequent updates')
  }
  for (const [file, marker] of [['settings.json', 'settings-kept'], ['threads.json', 'threads-kept']]) {
    if (!(await readFile(join(homeDir, '.kun', file), 'utf8')).includes(marker)) {
      throw new Error(`Next update lost ${file}`)
    }
  }
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

async function downloadV037Baseline(workDir, target) {
  const fileName = tuiFileName('0.3.7', target)
  await runCapture('gh', ['release', 'download', V037_TAG, '--repo', 'KunAgent/Kun',
    '--pattern', fileName, '--pattern', `${fileName}.sha256`, '--dir', workDir])
  const archive = join(workDir, fileName)
  const expected = (await readFile(`${archive}.sha256`, 'utf8')).trim().split(/\s+/)[0]
  if (!/^[a-f0-9]{64}$/.test(expected) || await sha256File(archive) !== expected) {
    throw new Error('Published 0.3.7 TUI archive checksum mismatch')
  }
  return archive
}

async function installBaseline(archive, installRoot) {
  await mkdir(installRoot, { recursive: true })
  if (archive.endsWith('.zip')) {
    const extractZip = (await import('extract-zip')).default
    await extractZip(archive, { dir: installRoot })
    return
  }
  await runCapture('tar', ['-xzf', archive, '-C', installRoot])
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
    const result = await runLauncher(launcher, ['update', '--yes'], env)
    if (!result.includes('staged and will activate')) {
      throw new Error(`v0.3.7 Windows updater did not stage: ${result}`)
    }
    await waitForWindowsActivation(installRoot)
    return
  }
  const output = await runLauncher(launcher, ['update', '--yes'], env)
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

  const runKun = (args) => runLauncher(launcher, args, env)

  const versionOutput = (await runKun(['--version'])).trim()
  if (versionOutput !== `kun ${version}`) {
    throw new Error(`kun --version returned ${JSON.stringify(versionOutput)}`)
  }
  const helpOutput = await runKun(['--help'])
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
  const updateOutput = await runKun(['update'])
  if (!updateOutput.includes('up to date')) {
    throw new Error(`kun update did not report up to date: ${updateOutput}`)
  }
}

function runLauncher(launcher, args, env) {
  return process.platform === 'win32'
    ? runCapture('cmd.exe', ['/d', '/s', '/c', `""${launcher}" ${args.join(' ')}"`], {
      env, windowsVerbatimArguments: true
    })
    : runCapture(launcher, args, { env })
}

export async function runCapture(command, args, options = {}) {
  const result = await promisify(execFile)(command, args, {
    timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024, ...options, encoding: 'utf8'
  })
  return result.stdout
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
