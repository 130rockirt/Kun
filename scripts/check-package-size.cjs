#!/usr/bin/env node
'use strict'

const { existsSync, lstatSync, readdirSync, statSync } = require('node:fs')
const { extname, join, resolve } = require('node:path')

const MIB = 1024 * 1024
const MAC_ARM64_BUDGETS = {
  app: 800 * MIB,
  dmg: 270 * MIB,
  zip: 290 * MIB
}

function parseArgs(argv) {
  const options = {
    platform: process.platform,
    arch: process.arch,
    enforce: false,
    distDir: process.env.KUN_DIST_DIR || process.env.DEEPSEEK_GUI_DIST_DIR || 'dist'
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--enforce') {
      options.enforce = true
    } else if (argument === '--platform') {
      options.platform = argv[++index]
    } else if (argument === '--arch') {
      options.arch = argv[++index]
    } else if (argument === '--dist-dir') {
      options.distDir = argv[++index]
    } else {
      throw new Error(`Unknown package-size argument: ${argument}`)
    }
  }
  if (!['darwin', 'win32', 'linux'].includes(options.platform)) {
    throw new Error(`Unsupported package-size platform: ${options.platform}`)
  }
  if (!['arm64', 'x64'].includes(options.arch)) {
    throw new Error(`Unsupported package-size architecture: ${options.arch}`)
  }
  options.distDir = resolve(options.distDir)
  return options
}

function packagedAppPath(distDir, platform, arch) {
  if (platform === 'darwin') {
    return join(distDir, arch === 'arm64' ? 'mac-arm64' : 'mac', 'Kun.app')
  }
  if (platform === 'win32') return join(distDir, 'win-unpacked')
  return join(distDir, 'linux-unpacked')
}

function resourcesPath(appPath, platform) {
  return platform === 'darwin'
    ? join(appPath, 'Contents', 'Resources')
    : join(appPath, 'resources')
}

function logicalBytes(path) {
  if (!existsSync(path)) return 0
  const details = lstatSync(path)
  if (details.isSymbolicLink()) return 0
  if (!details.isDirectory()) return details.size
  let total = 0
  for (const entry of readdirSync(path)) total += logicalBytes(join(path, entry))
  return total
}

function largestFiles(path, limit = 10) {
  const files = []
  function visit(current) {
    if (!existsSync(current)) return
    const details = lstatSync(current)
    if (details.isSymbolicLink()) return
    if (!details.isDirectory()) {
      files.push({ path: current, bytes: details.size })
      return
    }
    for (const entry of readdirSync(current)) visit(join(current, entry))
  }
  visit(path)
  return files.sort((left, right) => right.bytes - left.bytes).slice(0, limit)
}

function artifactPlatformName(platform) {
  if (platform === 'darwin') return 'mac'
  if (platform === 'win32') return 'win'
  return 'linux'
}

function packagedArtifacts(distDir, platform, arch) {
  if (!existsSync(distDir)) return []
  const marker = `-${artifactPlatformName(platform)}-${arch}.`
  return readdirSync(distDir)
    .filter((entry) =>
      entry.startsWith('Kun-') &&
      entry.includes(marker) &&
      !entry.endsWith('.blockmap')
    )
    .map((entry) => {
      const path = join(distDir, entry)
      return { name: entry, path, bytes: statSync(path).size, extension: extname(entry).toLowerCase() }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

function buildReport(options) {
  const appPath = packagedAppPath(options.distDir, options.platform, options.arch)
  if (!existsSync(appPath)) {
    throw new Error(`Packaged application was not found: ${appPath}`)
  }
  const resources = resourcesPath(appPath, options.platform)
  const unpacked = join(resources, 'app.asar.unpacked')
  const extraResourcePaths = [
    join(resources, 'THIRD_PARTY_NOTICES.md'),
    join(resources, 'officecli'),
    join(resources, 'whisper'),
    join(resources, 'bundled-extensions')
  ]
  const components = [
    { name: 'application', path: appPath },
    ...(options.platform === 'darwin'
      ? [{ name: 'electron-frameworks', path: join(appPath, 'Contents', 'Frameworks') }]
      : []),
    { name: 'app.asar', path: join(resources, 'app.asar') },
    { name: 'app.asar.unpacked', path: unpacked },
    { name: 'root-unpacked-node_modules', path: join(unpacked, 'node_modules') },
    { name: 'kun-runtime', path: join(unpacked, 'kun') },
    { name: 'kun-unpacked-node_modules', path: join(unpacked, 'kun', 'node_modules') },
    { name: 'extra-resources', paths: extraResourcePaths },
    { name: 'officecli', path: join(resources, 'officecli') },
    { name: 'whisper', path: join(resources, 'whisper') },
    { name: 'bundled-extensions', path: join(resources, 'bundled-extensions') }
  ].map((component) => ({
    ...component,
    bytes: component.paths
      ? component.paths.reduce((total, path) => total + logicalBytes(path), 0)
      : logicalBytes(component.path)
  }))

  return {
    platform: options.platform,
    arch: options.arch,
    appPath,
    appBytes: components[0].bytes,
    components,
    artifacts: packagedArtifacts(options.distDir, options.platform, options.arch),
    largestFiles: largestFiles(appPath)
  }
}

function budgetFailures(report) {
  if (report.platform !== 'darwin' || report.arch !== 'arm64') return []
  const failures = []
  if (report.appBytes > MAC_ARM64_BUDGETS.app) {
    failures.push(
      `application ${formatBytes(report.appBytes)} exceeds ${formatBytes(MAC_ARM64_BUDGETS.app)}`
    )
  }
  for (const [extension, budget] of [
    ['.dmg', MAC_ARM64_BUDGETS.dmg],
    ['.zip', MAC_ARM64_BUDGETS.zip]
  ]) {
    const artifact = report.artifacts.find((entry) => entry.extension === extension)
    if (!artifact) {
      failures.push(`missing ${extension} artifact`)
    } else if (artifact.bytes > budget) {
      failures.push(`${artifact.name} ${formatBytes(artifact.bytes)} exceeds ${formatBytes(budget)}`)
    }
  }
  return failures
}

function formatBytes(bytes) {
  return `${(bytes / MIB).toFixed(1)} MiB`
}

function printReport(report) {
  console.log(`[package-size] ${report.platform}-${report.arch}`)
  console.log('Components:')
  for (const component of report.components) {
    console.log(`  ${component.name.padEnd(28)} ${formatBytes(component.bytes)}`)
  }
  console.log('Artifacts:')
  for (const artifact of report.artifacts) {
    console.log(`  ${artifact.name.padEnd(44)} ${formatBytes(artifact.bytes)}`)
  }
  console.log('Largest files:')
  for (const file of report.largestFiles) {
    console.log(`  ${formatBytes(file.bytes).padStart(10)}  ${file.path}`)
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const report = buildReport(options)
  printReport(report)
  if (!options.enforce) return
  const failures = budgetFailures(report)
  if (failures.length > 0) {
    throw new Error(`Package size budget failed:\n${failures.map((entry) => `- ${entry}`).join('\n')}`)
  }
  console.log('[package-size] macOS arm64 package is within the release budgets.')
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

module.exports = {
  MIB,
  MAC_ARM64_BUDGETS,
  parseArgs,
  packagedAppPath,
  resourcesPath,
  logicalBytes,
  largestFiles,
  packagedArtifacts,
  buildReport,
  budgetFailures,
  formatBytes
}
