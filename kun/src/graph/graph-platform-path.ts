import { posix, win32 } from 'node:path'
import {
  graphRelativePathCovers,
  graphRelativePathsOverlap
} from '../contracts/graph-path.js'

type SupportedGraphPlatform = 'darwin' | 'linux' | 'win32'

function pathApi(platform: SupportedGraphPlatform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

function supportedPlatform(platform: NodeJS.Platform): SupportedGraphPlatform {
  return platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux'
}

export function graphPhysicalPathIdentity(
  input: string,
  platform: NodeJS.Platform = process.platform
): string {
  const host = supportedPlatform(platform)
  const normalized = pathApi(host).normalize(input)
  return host === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

export function graphPhysicalPathsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return graphPhysicalPathIdentity(left, platform) ===
    graphPhysicalPathIdentity(right, platform)
}

export function isGraphPhysicalPathContained(
  parent: string,
  child: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const host = supportedPlatform(platform)
  const api = pathApi(host)
  const parentKey = graphPhysicalPathIdentity(parent, platform)
  const childKey = graphPhysicalPathIdentity(child, platform)
  const relative = api.relative(parentKey, childKey)
  return Boolean(
    relative &&
    relative !== '..' &&
    !relative.startsWith(`..${api.sep}`) &&
    !api.isAbsolute(relative)
  )
}

export function graphHostRelativePathCovers(parent: string, child: string): boolean {
  return graphRelativePathCovers(parent, child, process.platform === 'win32')
}

export function graphHostRelativePathsOverlap(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return graphRelativePathsOverlap(left, right, process.platform === 'win32')
}
