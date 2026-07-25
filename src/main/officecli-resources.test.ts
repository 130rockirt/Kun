import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveOfficeCliBinary } from './officecli-resources'

const roots: string[] = []
const sha256 = 'a'.repeat(64)

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kun-officecli-resources-'))
  roots.push(root)
  return root
}

function touch(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('OfficeCLI resource resolution', () => {
  it('prefers an explicit existing binary', () => {
    const root = tempRoot()
    const explicitPath = join(root, 'custom-officecli')
    touch(explicitPath)

    expect(resolveOfficeCliBinary({
      isPackaged: false,
      resourcesPath: join(root, 'packaged-resources'),
      appRoot: root,
      platform: 'linux',
      arch: 'x64',
      explicitPath
    })).toBe(resolve(explicitPath))
  })

  it('uses the prepared development binary only for its selected target', () => {
    const root = tempRoot()
    const currentRoot = join(root, 'resources', 'officecli', 'current')
    const binaryPath = join(currentRoot, 'officecli')
    touch(binaryPath)
    writeFileSync(join(currentRoot, 'selected.json'), JSON.stringify({
      version: '1.0.141',
      platform: 'linux',
      arch: 'x64',
      sha256
    }))

    const input = {
      isPackaged: false,
      resourcesPath: join(root, 'packaged-resources'),
      appRoot: root,
      platform: 'linux' as const
    }
    expect(resolveOfficeCliBinary({ ...input, arch: 'x64' })).toBe(binaryPath)
    expect(resolveOfficeCliBinary({ ...input, arch: 'arm64' })).toBeUndefined()
  })

  it('resolves the packaged platform executable without development metadata', () => {
    const root = tempRoot()
    const resourcesPath = join(root, 'resources')
    const binaryPath = join(resourcesPath, 'officecli', 'officecli.exe')
    touch(binaryPath)

    expect(resolveOfficeCliBinary({
      isPackaged: true,
      resourcesPath,
      appRoot: root,
      platform: 'win32',
      arch: 'x64'
    })).toBe(binaryPath)
  })
})
