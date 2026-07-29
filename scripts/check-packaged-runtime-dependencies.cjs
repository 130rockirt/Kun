'use strict'

const { builtinModules } = require('node:module')
const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs')
const { join, relative, resolve } = require('node:path')

const BUILTIN_MODULES = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/u, '')])
)
const ELECTRON_PROVIDED_PACKAGES = new Set(['electron'])
const KNOWN_DYNAMIC_RUNTIME_SPECIFIERS = [
  '@computer-use/node-mac-permissions',
  '@tesseract.js-data/eng',
  'html-to-docx'
]

function packageNameFromSpecifier(specifier) {
  if (
    typeof specifier !== 'string' ||
    !specifier ||
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:')
  ) {
    return undefined
  }
  const first = specifier.split('/')[0]
  if (BUILTIN_MODULES.has(specifier) || BUILTIN_MODULES.has(first)) return undefined
  if (!specifier.startsWith('@')) return first
  const [scope, name] = specifier.split('/')
  return scope && name ? `${scope}/${name}` : undefined
}

function sourceSpecifiers(source) {
  const specifiers = []
  const pattern = /(?:\b(?:import|export)\s+(?:[^'"\n;]*?\s+from\s+)?|\bimport\s*\(\s*|\brequire(?:\.resolve)?\s*\(\s*)['"]([^'"]+)['"]/gu
  for (const match of source.matchAll(pattern)) specifiers.push(match[1])
  return specifiers
}

function sourceFiles(root) {
  const files = []
  if (!existsSync(root)) return files
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    const details = statSync(path)
    if (details.isDirectory()) {
      files.push(...sourceFiles(path))
    } else if (/\.(?:c?js|mjs)$/u.test(entry)) {
      files.push(path)
    }
  }
  return files
}

function compiledRuntimePackages(outputRoots) {
  const packages = new Set(
    KNOWN_DYNAMIC_RUNTIME_SPECIFIERS.map(packageNameFromSpecifier).filter(Boolean)
  )
  let compiledFileCount = 0
  for (const root of outputRoots) {
    for (const file of sourceFiles(root)) {
      compiledFileCount += 1
      for (const specifier of sourceSpecifiers(readFileSync(file, 'utf8'))) {
        const packageName = packageNameFromSpecifier(specifier)
        if (packageName && !ELECTRON_PROVIDED_PACKAGES.has(packageName)) {
          packages.add(packageName)
        }
      }
    }
  }
  if (compiledFileCount === 0) {
    throw new Error('No compiled main/preload JavaScript was found. Run the application build first.')
  }
  return [...packages].sort()
}

function packageLockPath(packageName) {
  return `node_modules/${packageName}`
}

function isProductionPackage(lockfile, packageName) {
  const entry = lockfile?.packages?.[packageLockPath(packageName)]
  return Boolean(entry && entry.dev !== true)
}

function checkPackagedRuntimeDependencies(options = {}) {
  const root = resolve(options.root ?? join(__dirname, '..'))
  const lockfilePath = join(root, 'package-lock.json')
  const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'))
  const packages = compiledRuntimePackages([
    join(root, 'out', 'main'),
    join(root, 'out', 'preload')
  ])
  const missing = packages.filter((name) => !isProductionPackage(lockfile, name))
  if (missing.length > 0) {
    throw new Error(
      `Compiled runtime imports are absent from the production dependency graph:\n` +
      missing.map((name) => `- ${name}`).join('\n')
    )
  }
  return { packages, lockfilePath: relative(root, lockfilePath) }
}

if (require.main === module) {
  const result = checkPackagedRuntimeDependencies()
  console.log(
    `[packaged-runtime-deps] ${result.packages.length} external packages are present in the production dependency graph.`
  )
}

module.exports = {
  ELECTRON_PROVIDED_PACKAGES,
  KNOWN_DYNAMIC_RUNTIME_SPECIFIERS,
  packageNameFromSpecifier,
  sourceSpecifiers,
  compiledRuntimePackages,
  isProductionPackage,
  checkPackagedRuntimeDependencies
}
