import { link, lstat, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  inventoryTree,
  normalizeComparableWindowsPath,
  uniqueSourceBytes,
  validateDestinationPath,
  windowsPathsOverlap
} from './paths'

const protectedPaths = {
  homeDir: 'C:\\Users\\Alice',
  userDataPath: 'C:\\Users\\Alice\\AppData\\Roaming\\Kun',
  installPath: 'C:\\Program Files\\Kun'
}

describe('Windows storage destination policy', () => {
  it('normalizes drive letters, slash styles, case, and trailing separators', () => {
    expect(normalizeComparableWindowsPath('d:/KunData/')).toBe('d:\\kundata')
    expect(windowsPathsOverlap('D:\\KunData', 'd:/kundata/.kun')).toBe(true)
    expect(windowsPathsOverlap('D:\\KunData', 'E:\\KunData')).toBe(false)
  })

  it('accepts a nested local drive folder and rejects roots, UNC, and protected overlaps', () => {
    expect(validateDestinationPath({ destinationRoot: 'D:\\KunData', ...protectedPaths }))
      .toBe('D:\\KunData')
    for (const destinationRoot of [
      'D:\\',
      '\\\\server\\share\\KunData',
      'C:\\Users\\Alice',
      'C:\\Users\\Alice\\.kun\\nested',
      'C:\\Program Files\\Kun\\data',
      'C:\\Users\\Alice\\AppData\\Roaming\\Kun\\data'
    ]) {
      expect(() => validateDestinationPath({ destinationRoot, ...protectedPaths })).toThrow()
    }
  })

  it('allows the user profile only for a restore-to-default plan', () => {
    expect(validateDestinationPath({
      destinationRoot: protectedPaths.homeDir,
      ...protectedPaths,
      restoreDefault: true
    })).toBe(protectedPaths.homeDir)
    expect(() => validateDestinationPath({
      destinationRoot: 'D:\\Other',
      ...protectedPaths,
      restoreDefault: true
    })).toThrow(/Restore must target/)
  })
})

describe('storage inventory', () => {
  it('does not follow links and counts hard-linked bytes once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-storage-inventory-'))
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'payload.bin'), Buffer.alloc(32))
    await link(join(root, 'nested', 'payload.bin'), join(root, 'payload-hardlink.bin'))
    await symlink(join(root, 'nested'), join(root, 'external-link'), 'dir')
    const inventory = await inventoryTree(root)
    expect(inventory.files).toBe(2)
    expect(inventory.links).toBe(1)
    expect(inventory.bytes).toBe(32 + (await lstat(join(root, 'external-link'))).size)
  })

  it('deduplicates roots that resolve to the same physical entity', () => {
    expect(uniqueSourceBytes([
      { name: '.kun', logicalPath: 'C:\\a', physicalPath: 'D:\\KunData\\.kun', exists: true, junction: true, appOwned: true, files: 1, directories: 1, links: 0, bytes: 10 },
      { name: '.deepseekgui', logicalPath: 'C:\\b', physicalPath: 'D:\\KunData\\.kun', exists: true, junction: true, appOwned: true, files: 1, directories: 1, links: 0, bytes: 10 }
    ])).toBe(10)
  })
})
