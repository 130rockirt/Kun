#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yauzl from 'yauzl'

const TARGETS = new Map([
  ['darwin-arm64', { os: 'mac', arch: 'arm64', format: 'tar.gz' }],
  ['darwin-x64', { os: 'mac', arch: 'x64', format: 'tar.gz' }],
  ['linux-arm64', { os: 'linux', arch: 'arm64', format: 'tar.gz' }],
  ['linux-x64', { os: 'linux', arch: 'x64', format: 'tar.gz' }],
  ['win32-x64', { os: 'win', arch: 'x64', format: 'zip' }]
])

export async function assembleTuiRelease(input) {
  const directory = resolve(input.directory)
  const entries = await readdir(directory)
  const records = []
  const buildIds = new Set()
  for (const [target, expected] of TARGETS) {
    const expectedName =
      `Kun-TUI-${input.artifactVersion}-${expected.os}-${expected.arch}.${expected.format}`
    if (!entries.includes(expectedName)) throw new Error(`Missing standalone TUI artifact: ${expectedName}`)
    const path = join(directory, expectedName)
    const embedded = await readEmbeddedRelease(path)
    validateEmbeddedRelease(embedded, {
      ...input,
      target,
      ...expected
    })
    buildIds.add(embedded.buildId)
    const sidecarPath = `${path}.json`
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'))
    if (sidecar.fileName !== expectedName || sidecar.sha256 !== await sha256File(path)) {
      throw new Error(`TUI sidecar does not match artifact bytes: ${expectedName}`)
    }
    const details = await stat(path)
    if (sidecar.size !== details.size) throw new Error(`TUI sidecar size mismatch: ${expectedName}`)
    records.push({
      target,
      platform: embedded.platform,
      os: expected.os,
      arch: expected.arch,
      format: expected.format,
      fileName: expectedName,
      size: details.size,
      sha256: sidecar.sha256,
      nodeVersion: embedded.nodeVersion,
      url: joinUrl(
        input.publicBaseUrl,
        input.releasePrefix,
        'channels',
        input.channel,
        'releases',
        input.tag,
        expectedName
      )
    })
  }
  if (buildIds.size !== 1) throw new Error('Standalone TUI targets do not share one runtime build id')
  const buildId = [...buildIds][0]
  if (input.expectedBuildId && buildId !== input.expectedBuildId) {
    throw new Error(
      `Standalone TUI build id ${buildId} does not match the shared GUI runtime ${input.expectedBuildId}`
    )
  }
  if (input.previousRelease) {
    const previous = JSON.parse(await readFile(resolve(input.previousRelease), 'utf8'))
    if (
      typeof previous.version !== 'string' ||
      typeof previous.buildId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(previous.buildId)
    ) {
      throw new Error('Previous release-tui.json has an invalid version or build id')
    }
    if (previous.version !== input.version && previous.buildId === buildId) {
      throw new Error(
        `Standalone TUI version changed from ${previous.version} to ${input.version} ` +
        `but reused build id ${buildId}`
      )
    }
  }
  const release = {
    schemaVersion: 1,
    productName: 'Kun',
    component: 'tui',
    version: input.version,
    artifactVersion: input.artifactVersion,
    tag: input.tag,
    channel: input.channel,
    commit: input.commit,
    buildId,
    releaseDate: input.releaseDate,
    generatedAt: new Date().toISOString(),
    githubReleaseUrl: input.githubReleaseUrl,
    artifacts: records
  }
  await writeFile(
    join(directory, 'release-tui.json'),
    `${JSON.stringify(release, null, 2)}\n`,
    'utf8'
  )
  await writeFile(
    join(directory, 'SHA256SUMS-tui.txt'),
    `${records.map((record) => `${record.sha256}  ${record.fileName}`).join('\n')}\n`,
    'utf8'
  )
  return release
}

const POINTER_MEMBER = 'kun/current'
const LEGACY_METADATA_MEMBER = 'kun/release.json'
const POINTER_PATTERN = /^releases\/([a-f0-9]{64})$/

// Standalone TUI archives since the atomic-pointer change store metadata at
// kun/releases/<buildId>/release.json with kun/current pointing at the build.
// Archives built before that layout keep the flat kun/release.json member.
// A present pointer is authoritative: never fall back to the legacy member.
export async function readEmbeddedRelease(path) {
  const pointer = await readArchiveMember(path, POINTER_MEMBER)
  if (pointer !== null) {
    const releasePointer = pointer.trim()
    const match = releasePointer.match(POINTER_PATTERN)
    if (!match) {
      throw new Error(
        `Invalid standalone TUI current pointer in ${basename(path)}: ${JSON.stringify(releasePointer)}`
      )
    }
    const buildId = match[1]
    const metadataMember = `kun/releases/${buildId}/release.json`
    const metadata = await readArchiveMember(path, metadataMember)
    if (metadata === null) {
      throw new Error(`Cannot read ${metadataMember} from ${basename(path)}`)
    }
    const embedded = JSON.parse(metadata)
    if (embedded?.buildId !== buildId) {
      throw new Error(
        `Embedded TUI build id does not match current pointer in ${basename(path)}: ` +
        `${String(embedded?.buildId)} != ${buildId}`
      )
    }
    return embedded
  }
  const legacy = await readArchiveMember(path, LEGACY_METADATA_MEMBER)
  if (legacy !== null) return JSON.parse(legacy)
  throw new Error(`Cannot read ${LEGACY_METADATA_MEMBER} from ${basename(path)}`)
}

async function readArchiveMember(path, member) {
  if (path.endsWith('.zip')) {
    return readZipEntry(path, member)
  }
  try {
    return execFileSync('tar', ['-xOf', path, member], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    })
  } catch {
    // A non-zero tar exit means the member is absent. The caller tries the
    // next candidate layout member before reporting a read failure.
    return null
  }
}

function readZipEntry(path, expectedName) {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error(`Cannot open ${basename(path)}`))
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
          // A missing entry is not an error; the caller falls back to other
          // layout members before failing.
          resolvePromise(null)
        }
      })
      zip.on('entry', (entry) => {
        if (normalizeArchiveMemberName(entry.fileName) !== expectedName) {
          zip.readEntry()
          return
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error(`Cannot read ${expectedName}`))
            return
          }
          const chunks = []
          let length = 0
          stream.on('data', (chunk) => {
            length += chunk.length
            if (length > 1024 * 1024) {
              stream.destroy(new Error(`${expectedName} exceeds 1 MiB`))
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

function normalizeArchiveMemberName(name) {
  return String(name).replaceAll('\\', '/').replace(/^\.\//, '')
}

function validateEmbeddedRelease(value, expected) {
  const exact = {
    schemaVersion: 1,
    component: 'tui',
    version: expected.version,
    artifactVersion: expected.artifactVersion,
    tag: expected.tag,
    channel: expected.channel,
    target: expected.target,
    platform: expected.target.split('-')[0],
    os: expected.os,
    arch: expected.arch,
    format: expected.format,
    commit: expected.commit
  }
  for (const [key, expectedValue] of Object.entries(exact)) {
    if (value?.[key] !== expectedValue) {
      throw new Error(
        `Embedded TUI metadata ${key} mismatch for ${expected.target}: ` +
        `${String(value?.[key])} != ${String(expectedValue)}`
      )
    }
  }
  if (!/^[a-f0-9]{64}$/.test(value.buildId)) {
    throw new Error(`Embedded TUI build id is invalid for ${expected.target}`)
  }
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

function joinUrl(base, ...parts) {
  return [
    base.replace(/\/+$/, ''),
    ...parts.map((part) => String(part).replace(/^\/+|\/+$/g, '')).filter(Boolean)
  ].join('/')
}

function parseArgs(argv) {
  const flags = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid argument near ${name}`)
    }
    flags.set(name.slice(2), value)
    index += 1
  }
  const required = (name, fallback = '') => {
    const value = flags.get(name) || fallback
    if (!value) throw new Error(`Missing --${name}`)
    return value
  }
  const version = required('version', process.env.KUN_APP_VERSION)
  const artifactVersion = required(
    'artifact-version',
    process.env.KUN_ARTIFACT_VERSION || version
  )
  const tag = required('tag', process.env.TAG_NAME)
  return {
    directory: required('directory', 'release-artifacts'),
    version,
    artifactVersion,
    tag,
    channel: required('channel', process.env.RELEASE_CHANNEL || 'stable'),
    commit: required('commit', process.env.GITHUB_SHA),
    expectedBuildId: required(
      'expected-build-id',
      process.env.KUN_RUNTIME_BUILD_ID
    ),
    previousRelease: flags.get('previous-release') || process.env.PREVIOUS_TUI_RELEASE || '',
    releaseDate: required('release-date', new Date().toISOString()),
    publicBaseUrl: required(
      'public-base-url',
      process.env.R2_PUBLIC_BASE_URL || 'https://www.kun-agent.com/api/r2'
    ),
    releasePrefix: required(
      'release-prefix',
      process.env.R2_RELEASE_PREFIX || 'deepseek-gui'
    ),
    githubReleaseUrl: required(
      'github-release-url',
      `https://github.com/KunAgent/Kun/releases/tag/${tag}`
    )
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ''
if (invoked === fileURLToPath(import.meta.url)) {
  assembleTuiRelease(parseArgs(process.argv.slice(2)))
    .then((release) => {
      process.stdout.write(
        `Standalone TUI release ${release.version}: ${release.artifacts.length} targets, build ${release.buildId}\n`
      )
    })
    .catch((error) => {
      process.stderr.write(`[assemble-tui-release] ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
