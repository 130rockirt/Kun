import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const KUN_PPT_TOOLCHAIN_DIR_ENV = 'KUN_PPT_TOOLCHAIN_DIR'

export interface PptToolchainPaths {
  rootDir: string
  scriptsDir: string
  referenceDir: string
}

/** Resolve the vendored PPT scripts and reference documents for the runtime. */
export function resolvePptToolchainDir(): PptToolchainPaths {
  const configuredDir = process.env[KUN_PPT_TOOLCHAIN_DIR_ENV]?.trim()
  if (configuredDir) return buildToolchainPaths(resolve(configuredDir), 'KUN_PPT_TOOLCHAIN_DIR')

  let currentDir = resolve(process.cwd())
  while (true) {
    const candidate = join(currentDir, 'resources', 'ppt-toolchain')
    if (existsSync(candidate)) return buildToolchainPaths(candidate, 'repository')

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) break
    currentDir = parentDir
  }

  throw new Error(
    'PPT toolchain not found. Set KUN_PPT_TOOLCHAIN_DIR to the toolchain directory, or restore the repository resources/ppt-toolchain directory.'
  )
}

export function pptScriptsDir(): string {
  return resolvePptToolchainDir().scriptsDir
}

export function pptReferenceDir(): string {
  return resolvePptToolchainDir().referenceDir
}

function buildToolchainPaths(rootDir: string, source: string): PptToolchainPaths {
  const scriptsDir = join(rootDir, 'scripts')
  const referenceDir = join(rootDir, 'reference')
  if (!existsSync(scriptsDir) || !existsSync(referenceDir)) {
    throw new Error(
      `PPT toolchain at ${rootDir} is incomplete (${source}): expected scripts and reference directories. Set KUN_PPT_TOOLCHAIN_DIR to a complete toolchain or restore the repository resources/ppt-toolchain directory.`
    )
  }
  return { rootDir, scriptsDir, referenceDir }
}
