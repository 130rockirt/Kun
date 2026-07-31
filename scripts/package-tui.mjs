#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const TUI_NODE_VERSION = '22.23.1'
export const TUI_RELEASE_SCHEMA_VERSION = 1

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..')
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const ARTIFACT_VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]*$/
const TAG = /^(?:v\d+\.\d+\.\d+|dev-\d{8}\.\d{4})$/
const TARGETS = {
  'darwin-arm64': { os: 'mac', arch: 'arm64', format: 'tar.gz' },
  'darwin-x64': { os: 'mac', arch: 'x64', format: 'tar.gz' },
  'linux-x64': { os: 'linux', arch: 'x64', format: 'tar.gz' },
  'win32-x64': { os: 'win', arch: 'x64', format: 'zip' }
}

export function resolveTuiTarget(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`
  const target = TARGETS[key]
  if (!target) throw new Error(`Unsupported standalone TUI target: ${key}`)
  return { key, platform, ...target }
}

export function tuiArtifactName(artifactVersion, target) {
  if (!ARTIFACT_VERSION.test(artifactVersion)) {
    throw new Error(`Invalid TUI artifact version: ${artifactVersion}`)
  }
  return `Kun-TUI-${artifactVersion}-${target.os}-${target.arch}.${target.format}`
}

export function resolveNpmCliInvocation({
  execPath = process.execPath,
  npmExecPath = process.env.npm_execpath
} = {}) {
  if (typeof npmExecPath !== 'string' || npmExecPath.length === 0) {
    throw new Error('npm_execpath is required to install standalone TUI dependencies')
  }
  return {
    command: execPath,
    args: [npmExecPath]
  }
}

export function createTuiReleaseMetadata(input) {
  if (!SEMVER.test(input.version)) throw new Error(`Invalid TUI version: ${input.version}`)
  if (!ARTIFACT_VERSION.test(input.artifactVersion)) {
    throw new Error(`Invalid TUI artifact version: ${input.artifactVersion}`)
  }
  if (!TAG.test(input.tag)) throw new Error(`Invalid TUI release tag: ${input.tag}`)
  if (input.channel !== 'stable' && input.channel !== 'frontier') {
    throw new Error(`Invalid TUI release channel: ${input.channel}`)
  }
  const expectedTag = input.channel === 'stable'
    ? `v${input.version}`
    : `dev-${input.artifactVersion}`
  const expectedVersion = input.channel === 'stable'
    ? input.artifactVersion
    : `0.0.0-dev-${input.artifactVersion.replace('.', '-')}`
  if (input.tag !== expectedTag || input.version !== expectedVersion) {
    throw new Error(
      `TUI version, artifact version, tag, and channel must identify one joint release: ` +
      `${input.version}/${input.artifactVersion}/${input.tag}/${input.channel}`
    )
  }
  if (!/^[a-f0-9]{64}$/.test(input.buildId)) {
    throw new Error('TUI runtime build id must be a SHA-256 hex digest')
  }
  if (!/^[a-f0-9]{40}$/.test(input.commit)) {
    throw new Error('TUI release commit must be a full Git SHA')
  }
  return {
    schemaVersion: TUI_RELEASE_SCHEMA_VERSION,
    productName: 'Kun',
    component: 'tui',
    version: input.version,
    artifactVersion: input.artifactVersion,
    tag: input.tag,
    channel: input.channel,
    target: input.target.key,
    platform: input.target.platform,
    os: input.target.os,
    arch: input.target.arch,
    format: input.target.format,
    buildId: input.buildId,
    commit: input.commit,
    nodeVersion: TUI_NODE_VERSION,
    updateEnabled: input.channel === 'stable',
    updateManifestUrl: input.updateManifestUrl
  }
}

async function packageTui(options) {
  const target = resolveTuiTarget()
  if (options.target && options.target !== target.key) {
    throw new Error(`TUI packages must be built host-native: requested ${options.target}, host is ${target.key}`)
  }
  const currentNodeVersion = process.versions.node
  if (currentNodeVersion !== TUI_NODE_VERSION) {
    throw new Error(
      `Standalone TUI packaging requires Node ${TUI_NODE_VERSION}; current Node is ${currentNodeVersion}`
    )
  }
  const runtimeManifest = JSON.parse(
    await readFile(join(ROOT, 'kun', 'dist', 'runtime-build.json'), 'utf8')
  )
  if (runtimeManifest.serviceVersion !== options.version) {
    throw new Error(
      `Kun build version ${runtimeManifest.serviceVersion ?? '(missing)'} does not match ${options.version}`
    )
  }
  if (runtimeManifest.channel !== options.channel) {
    throw new Error(
      `Kun build channel ${runtimeManifest.channel ?? '(missing)'} does not match ${options.channel}`
    )
  }
  if (runtimeManifest.artifactVersion !== options.artifactVersion) {
    throw new Error(
      `Kun build artifact version ${runtimeManifest.artifactVersion ?? '(missing)'} does not match ${options.artifactVersion}`
    )
  }
  const releaseMetadata = createTuiReleaseMetadata({
    ...options,
    target,
    buildId: runtimeManifest.buildId
  })
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kun-tui-package-'))
  const archiveRoot = join(temporaryRoot, 'archive')
  const productRoot = join(archiveRoot, 'kun')
  const appRoot = join(productRoot, 'app')
  const packagedKun = join(appRoot, 'kun')
  const outputDirectory = resolve(options.output)
  try {
    await Promise.all([
      mkdir(join(productRoot, 'bin'), { recursive: true }),
      mkdir(join(productRoot, 'runtime'), { recursive: true }),
      mkdir(packagedKun, { recursive: true }),
      mkdir(join(appRoot, 'packages'), { recursive: true }),
      mkdir(outputDirectory, { recursive: true })
    ])
    await Promise.all([
      cp(join(ROOT, 'kun', 'dist'), join(packagedKun, 'dist'), { recursive: true }),
      copyFile(join(ROOT, 'kun', 'package.json'), join(packagedKun, 'package.json')),
      copyFile(join(ROOT, 'kun', 'package-lock.json'), join(packagedKun, 'package-lock.json')),
      cp(join(ROOT, 'packages', 'extension-api'), join(appRoot, 'packages', 'extension-api'), {
        recursive: true,
        filter: releasePackageFilter
      }),
      cp(join(ROOT, 'packages', 'provider-catalog'), join(appRoot, 'packages', 'provider-catalog'), {
        recursive: true,
        filter: releasePackageFilter
      }),
      cp(join(ROOT, 'packages', 'create-kun-extension'), join(appRoot, 'packages', 'create-kun-extension'), {
        recursive: true,
        filter: releasePackageFilter
      }),
      copyFile(await realpath(process.execPath), join(productRoot, 'runtime', target.platform === 'win32' ? 'node.exe' : 'node')),
      copyOptionalFile(join(ROOT, 'THIRD_PARTY_NOTICES.md'), join(productRoot, 'THIRD_PARTY_NOTICES.md')),
      copyOptionalFile(join(ROOT, 'kun', 'README.md'), join(productRoot, 'README.md'))
    ])
    if (target.platform !== 'win32') {
      await chmod(join(productRoot, 'runtime', 'node'), 0o755)
    }
    runNpmInstall(packagedKun)
    await materializeWorkspaceDependencies(appRoot, packagedKun)
    await removeDownloadedClaudeBinary(packagedKun)
    await patchPackagedKunManifest(packagedKun, options.version)
    await writeLaunchers(productRoot, target.platform)
    await writeFile(
      join(productRoot, 'release.json'),
      `${JSON.stringify(releaseMetadata, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o644 }
    )
    const artifactName = tuiArtifactName(options.artifactVersion, target)
    const artifactPath = join(outputDirectory, artifactName)
    await rm(artifactPath, { force: true })
    createArchive(archiveRoot, artifactPath, target.format)
    const details = await stat(artifactPath)
    const sha256 = await hashFile(artifactPath)
    await writeFile(
      `${artifactPath}.sha256`,
      `${sha256}  ${artifactName}\n`,
      'utf8'
    )
    const result = {
      ...releaseMetadata,
      fileName: artifactName,
      path: artifactPath,
      size: details.size,
      sha256
    }
    await writeFile(
      join(outputDirectory, `${artifactName}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8'
    )
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return result
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function releasePackageFilter(path) {
  const name = basename(path)
  return name !== 'node_modules' &&
    name !== '.DS_Store' &&
    !name.endsWith('.test.ts') &&
    !name.endsWith('.test.tsx')
}

async function copyOptionalFile(source, destination) {
  try {
    await copyFile(source, destination)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function runNpmInstall(packagedKun) {
  const npm = resolveNpmCliInvocation()
  execFileSync(npm.command, [...npm.args, 'ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: packagedKun,
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false'
    },
    stdio: 'inherit'
  })
}

async function materializeWorkspaceDependencies(appRoot, packagedKun) {
  for (const [sourceRelative, targetRelative] of [
    ['packages/extension-api', 'node_modules/@kun/extension-api'],
    ['packages/provider-catalog', 'node_modules/@kun/provider-catalog'],
    ['packages/create-kun-extension', 'node_modules/create-kun-extension']
  ]) {
    const source = join(appRoot, sourceRelative)
    const target = join(packagedKun, targetRelative)
    await rm(target, { recursive: true, force: true })
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, { recursive: true })
  }
}

async function removeDownloadedClaudeBinary(packagedKun) {
  const scope = join(packagedKun, 'node_modules', '@anthropic-ai')
  let entries = []
  try {
    entries = await readdir(scope)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  await Promise.all(entries
    .filter((name) => name.startsWith('claude-agent-sdk-'))
    .map((name) => rm(join(scope, name), { recursive: true, force: true })))
}

async function patchPackagedKunManifest(packagedKun, version) {
  const path = join(packagedKun, 'package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.version = version
  manifest.private = true
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

async function writeLaunchers(productRoot, platform) {
  if (platform === 'win32') {
    await writeFile(
      join(productRoot, 'bin', 'kun.cmd'),
      '@echo off\r\n' +
      'setlocal\r\n' +
      'set "KUN_STANDALONE_ROOT=%~dp0.."\r\n' +
      '"%~dp0..\\runtime\\node.exe" "%~dp0..\\app\\kun\\dist\\cli\\serve-entry.js" %*\r\n',
      'utf8'
    )
    return
  }
  const launcher = join(productRoot, 'bin', 'kun')
  await writeFile(
    launcher,
    '#!/bin/sh\n' +
    'set -eu\n' +
    'self_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd -P)\n' +
    'root=$(CDPATH= cd -P "$self_dir/.." && pwd -P)\n' +
    'export KUN_STANDALONE_ROOT="$root"\n' +
    'exec "$root/runtime/node" "$root/app/kun/dist/cli/serve-entry.js" "$@"\n',
    { encoding: 'utf8', mode: 0o755 }
  )
  await chmod(launcher, 0o755)
}

function createArchive(archiveRoot, artifactPath, format) {
  const args = format === 'zip'
    ? ['-a', '-cf', artifactPath, 'kun']
    : ['-czf', artifactPath, 'kun']
  execFileSync('tar', args, {
    cwd: archiveRoot,
    stdio: 'inherit'
  })
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function parseArgs(argv) {
  const flags = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
    flags.set(key.slice(2), value)
    index += 1
  }
  const required = (name, fallback = '') => {
    const value = flags.get(name) || fallback
    if (!value) throw new Error(`Missing --${name}`)
    return value
  }
  const publicBaseUrl = required(
    'public-base-url',
    process.env.R2_PUBLIC_BASE_URL || 'https://www.kun-agent.com/api/r2'
  ).replace(/\/+$/, '')
  const prefix = required(
    'release-prefix',
    process.env.R2_RELEASE_PREFIX || 'deepseek-gui'
  ).replace(/^\/+|\/+$/g, '')
  const channel = required('channel', process.env.RELEASE_CHANNEL || 'stable')
  return {
    version: required('version', process.env.KUN_APP_VERSION),
    artifactVersion: required(
      'artifact-version',
      process.env.KUN_ARTIFACT_VERSION || process.env.KUN_APP_VERSION
    ),
    tag: required('tag', process.env.TAG_NAME),
    channel,
    commit: required('commit', process.env.GITHUB_SHA),
    target: flags.get('target'),
    output: required('output', 'dist'),
    updateManifestUrl:
      `${publicBaseUrl}/${prefix}/channels/stable/latest/latest-tui.json`
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  packageTui(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`[package-tui] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
