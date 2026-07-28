import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertPathOutsideSourceTree,
  assertPublishableManifest,
  runRequiredCommand,
  runRequiredNpm
} from './lib/extension-release-execution.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'scripts/fixtures/external-extension-project')
const expectedApiMajor = readExpectedApiMajor(process.argv.slice(2))
const temporaryRoot = await mkdtemp(join(tmpdir(), 'kun-extension-external-release-'))
const artifactsDirectory = join(temporaryRoot, 'artifacts')
const projectDirectory = join(temporaryRoot, 'project')
const profileDirectory = join(temporaryRoot, 'profile')
const archivePath = join(temporaryRoot, 'kun-release-fixtures.external-release-1.0.0.kunx')

assertPathOutsideSourceTree(root, temporaryRoot)

try {
  await Promise.all([
    mkdir(artifactsDirectory, { recursive: true }),
    cp(fixture, projectDirectory, { recursive: true })
  ])

  const artifacts = new Map()
  for (const packagePath of [
    'packages/provider-catalog',
    'packages/extension-api',
    'packages/extension-test',
    'packages/extension-react',
    'packages/create-kun-extension'
  ]) {
    const manifest = JSON.parse(await readFile(join(root, packagePath, 'package.json'), 'utf8'))
    assertPublishableManifest(manifest, manifest.name)
    artifacts.set(manifest.name, await packPackage(join(root, packagePath), artifactsDirectory, manifest.name))
  }

  const kunArtifact = await packPublishableKunCli(artifactsDirectory)
  artifacts.set('kun', kunArtifact)

  const template = JSON.parse(await readFile(join(projectDirectory, 'package.template.json'), 'utf8'))
  const rootLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  const typescriptVersion = requiredLockedVersion(rootLock, 'typescript')
  const reactVersion = requiredLockedVersion(rootLock, 'react')
  const dependencies = Object.fromEntries(
    [...artifacts].map(([name, path]) => [name, localTarballSpecifier(projectDirectory, path)])
  )
  await writeFile(
    join(projectDirectory, 'package.json'),
    `${JSON.stringify({
      ...template,
      dependencies: {
        ...dependencies,
        react: reactVersion,
        typescript: typescriptVersion
      }
    }, null, 2)}\n`
  )

  runRequiredNpm({
    label: 'install packaged Extension SDK and CLI tarballs in the external project',
    args: ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
    cwd: projectDirectory,
    env: {
      npm_config_audit: 'false',
      npm_config_fund: 'false'
    }
  })

  await assertInstalledArtifacts(projectDirectory, artifacts)
  await assertExternalLockfile(projectDirectory)

  runRequiredCommand({
    label: 'typecheck the external packaged-SDK extension',
    command: process.execPath,
    args: [join(projectDirectory, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    cwd: projectDirectory
  })
  runRequiredCommand({
    label: 'execute the external SDK behavioral harness',
    command: process.execPath,
    args: ['acceptance.mjs'],
    cwd: projectDirectory
  })

  const cliEntry = join(projectDirectory, 'node_modules/kun/dist/cli/serve-entry.js')
  const validateSource = runKunCli(cliEntry, ['validate', '.', '--json'])
  assertJsonValue(validateSource.stdout, ['result', 'id'], 'kun-release-fixtures.external-release')
  const packed = runKunCli(cliEntry, ['pack', '.', '--output', archivePath, '--json'])
  assertJsonValue(packed.stdout, ['result', 'id'], 'kun-release-fixtures.external-release')
  const validateArchive = runKunCli(cliEntry, ['validate', archivePath, '--json'])
  assertJsonValue(validateArchive.stdout, ['result', 'id'], 'kun-release-fixtures.external-release')
  const installed = runKunCli(cliEntry, [
    'install',
    archivePath,
    '--data-dir',
    profileDirectory,
    '--accept-permissions',
    '--json'
  ])
  assertJsonValue(installed.stdout, ['result', 'id'], 'kun-release-fixtures.external-release')
  const listed = runKunCli(cliEntry, ['list', '--data-dir', profileDirectory, '--json'])
  const listResult = JSON.parse(listed.stdout)
  if (listResult.extensions?.length !== 1) {
    throw new Error(`External CLI list expected one extension, got ${String(listResult.extensions?.length)}`)
  }
  const doctor = runKunCli(cliEntry, [
    'doctor',
    'kun-release-fixtures.external-release',
    '--data-dir',
    profileDirectory,
    '--json'
  ])
  assertJsonValue(doctor.stdout, ['healthy'], true)
  const uninstalled = runKunCli(cliEntry, [
    'uninstall',
    'kun-release-fixtures.external-release',
    '--data-dir',
    profileDirectory,
    '--json'
  ])
  assertJsonValue(
    uninstalled.stdout,
    ['result', 'extensionId'],
    'kun-release-fixtures.external-release'
  )

  const installedApi = JSON.parse(
    await readFile(join(projectDirectory, 'node_modules/@kun/extension-api/package.json'), 'utf8')
  )
  const installedApiMajor = Number(String(installedApi.version).split('.')[0])
  if (installedApiMajor !== expectedApiMajor) {
    throw new Error(
      `External conformance executed API major ${installedApiMajor}, expected ${expectedApiMajor}`
    )
  }

  process.stdout.write(
    `External Extension acceptance OK: API v${expectedApiMajor}, packaged SDK/React/test/CLI tarballs, ` +
    'clean typecheck, Agent/tool/provider behavior, validate/pack/install/list/doctor/uninstall.\n'
  )
} finally {
  if (process.env.KUN_KEEP_EXTERNAL_RELEASE_PROJECT === '1') {
    process.stdout.write(`Retained external release project: ${temporaryRoot}\n`)
  } else {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function readExpectedApiMajor(argv) {
  const index = argv.indexOf('--expected-api-major')
  const value = index < 0 ? undefined : argv[index + 1]
  if (!value || !/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error('Usage: check-extension-external-project.mjs --expected-api-major <positive integer>')
  }
  return Number(value)
}

async function packPackage(packageDirectory, destination, label) {
  const result = runRequiredNpm({
    label: `pack ${label}`,
    args: ['pack', packageDirectory, '--pack-destination', destination, '--silent'],
    cwd: root,
    capture: true,
    env: {
      npm_config_audit: 'false',
      npm_config_fund: 'false'
    }
  })
  const filename = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
  if (!filename?.endsWith('.tgz')) {
    throw new Error(`npm pack ${label} did not report a tarball:\n${result.stdout}`)
  }
  return join(destination, filename)
}

async function packPublishableKunCli(destination) {
  const sourceManifest = JSON.parse(await readFile(join(root, 'kun/package.json'), 'utf8'))
  const providerCatalogManifest = JSON.parse(
    await readFile(join(root, 'packages/provider-catalog/package.json'), 'utf8')
  )
  const apiManifest = JSON.parse(await readFile(join(root, 'packages/extension-api/package.json'), 'utf8'))
  const scaffoldManifest = JSON.parse(
    await readFile(join(root, 'packages/create-kun-extension/package.json'), 'utf8')
  )
  const stage = join(temporaryRoot, 'kun-cli-package')
  await mkdir(stage, { recursive: true })
  await Promise.all([
    cp(join(root, 'kun/dist'), join(stage, 'dist'), { recursive: true }),
    cp(join(root, 'kun/README.md'), join(stage, 'README.md'))
  ])
  const manifest = {
    ...sourceManifest,
    private: false,
    files: ['dist', 'README.md'],
    dependencies: {
      ...sourceManifest.dependencies,
      '@kun/provider-catalog': providerCatalogManifest.version,
      '@kun/extension-api': apiManifest.version,
      'create-kun-extension': scaffoldManifest.version
    }
  }
  assertPublishableManifest(manifest, 'kun packaged CLI')
  await writeFile(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return packPackage(stage, destination, 'kun packaged CLI')
}

function localTarballSpecifier(project, tarball) {
  const path = relative(project, tarball).split(sep).join('/')
  if (!path.endsWith('.tgz')) throw new Error(`Kun dependency is not a tarball: ${tarball}`)
  return `file:${path.startsWith('.') ? path : `./${path}`}`
}

function requiredLockedVersion(lock, name) {
  const version = lock.packages?.[`node_modules/${name}`]?.version
  if (typeof version !== 'string') throw new Error(`Root lockfile has no installed version for ${name}`)
  return version
}

async function assertInstalledArtifacts(project, artifacts) {
  for (const [name] of artifacts) {
    const packagePath = join(project, 'node_modules', ...name.split('/'))
    const [details, installedPath, manifest] = await Promise.all([
      lstat(packagePath),
      realpath(packagePath),
      readFile(join(packagePath, 'package.json'), 'utf8').then(JSON.parse)
    ])
    if (details.isSymbolicLink()) throw new Error(`${name} was linked instead of installed from its tarball`)
    assertPathOutsideSourceTree(root, installedPath, `${name} installed package`)
    assertPublishableManifest(manifest, `${name} installed tarball`)
  }
}

async function assertExternalLockfile(project) {
  const lockPath = join(project, 'package-lock.json')
  const lockText = await readFile(lockPath, 'utf8')
  const normalizedRoot = (await realpath(root)).split(sep).join('/')
  if (lockText.split('\\').join('/').includes(normalizedRoot)) {
    throw new Error('External project lockfile references the Kun source tree')
  }
  const lock = JSON.parse(lockText)
  for (const name of [
    '@kun/provider-catalog',
    '@kun/extension-api',
    '@kun/extension-test',
    '@kun/extension-react',
    'create-kun-extension',
    'kun'
  ]) {
    const entry = lock.packages?.[`node_modules/${name}`]
    if (typeof entry?.resolved !== 'string' || !entry.resolved.endsWith('.tgz')) {
      throw new Error(`${name} did not resolve from a packaged tarball in the external lockfile`)
    }
  }
}

function runKunCli(cliEntry, args) {
  return runRequiredCommand({
    label: `packaged CLI: kun extension ${args[0]}`,
    command: process.execPath,
    args: [cliEntry, 'extension', ...args],
    cwd: projectDirectory,
    capture: true,
    env: { KUN_DATA_DIR: profileDirectory }
  })
}

function assertJsonValue(output, path, expected) {
  const document = JSON.parse(output)
  let value = document
  for (const segment of path) value = value?.[segment]
  if (value !== expected) {
    throw new Error(`Expected CLI JSON ${path.join('.')}=${JSON.stringify(expected)}, got ${JSON.stringify(value)}`)
  }
}
