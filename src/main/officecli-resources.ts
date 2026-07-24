import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const OFFICECLI_RESOURCE_DIRECTORY = 'officecli'

export function officeCliExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'officecli.exe' : 'officecli'
}

export function resolveOfficeCliBinary(input: {
  isPackaged: boolean
  resourcesPath: string
  appRoot: string
  platform?: NodeJS.Platform
  arch?: string
  explicitPath?: string
}): string | undefined {
  const explicit = input.explicitPath?.trim()
  if (explicit && existsSync(explicit)) return resolve(explicit)

  const platform = input.platform ?? process.platform
  const arch = input.arch ?? process.arch
  const executable = officeCliExecutableName(platform)
  const currentRoot = join(
    input.appRoot,
    'resources',
    OFFICECLI_RESOURCE_DIRECTORY,
    'current'
  )
  const candidates = input.isPackaged
    ? [join(input.resourcesPath, OFFICECLI_RESOURCE_DIRECTORY, executable)]
    : [
        ...(selectedOfficeCliTargetMatches(currentRoot, platform, arch)
          ? [join(currentRoot, executable)]
          : []),
        join(input.appRoot, 'resources', OFFICECLI_RESOURCE_DIRECTORY, executable)
      ]
  return candidates.find((candidate) => existsSync(candidate))
}

function selectedOfficeCliTargetMatches(
  currentRoot: string,
  platform: NodeJS.Platform,
  arch: string
): boolean {
  try {
    const selected = JSON.parse(
      readFileSync(join(currentRoot, 'selected.json'), 'utf8')
    ) as { version?: unknown; platform?: unknown; arch?: unknown; sha256?: unknown }
    return selected.version === '1.0.141' &&
      selected.platform === platform &&
      selected.arch === arch &&
      typeof selected.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(selected.sha256)
  } catch {
    return false
  }
}
