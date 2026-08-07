import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertSafeUninstallPath,
  collectUninstallPaths,
  findMacBundleRoot,
  resolveAppRemovalTarget
} from './paths'

const HOME = '/Users/Alice'
const USER_DATA = '/Users/Alice/Library/Application Support/Kun'

describe('uninstall path collection', () => {
  it('collects userData, canonical Kun data, and legacy directories', () => {
    const items = collectUninstallPaths({
      userDataPath: USER_DATA,
      settings: null,
      homeDir: HOME,
      platform: 'darwin'
    })
    const kinds = items.map((item) => item.kind)
    expect(kinds).toContain('userData')
    expect(kinds).toContain('legacyUserData')
    expect(kinds).toContain('kunData')
    expect(kinds).toContain('legacyKunData')
    expect(items.find((item) => item.kind === 'kunData')?.path).toBe('/Users/Alice/.kun/data')
    expect(items.find((item) => item.kind === 'legacyKunData')?.path).toBe('/Users/Alice/.deepseekgui/kun')
    expect(items.find((item) => item.kind === 'legacyUserData')?.path)
      .toBe('/Users/Alice/Library/Application Support/deepseek-gui')
  })

  it('includes a custom configured dataDir instead of the canonical current dir', () => {
    const items = collectUninstallPaths({
      userDataPath: USER_DATA,
      settings: { agents: { kun: { dataDir: '~/custom/kun-data' } } } as never,
      homeDir: HOME,
      platform: 'darwin'
    })
    const custom = items.find((item) => item.kind === 'customData')
    expect(custom?.path).toBe('/Users/Alice/custom/kun-data')
    expect(items.find((item) => item.kind === 'kunData')).toBeUndefined()
  })

  it('deduplicates paths that appear more than once', () => {
    const items = collectUninstallPaths({
      userDataPath: '/Users/Alice/.kun/data',
      settings: { agents: { kun: { dataDir: '/Users/Alice/.kun/data' } } } as never,
      homeDir: HOME,
      platform: 'darwin'
    })
    const paths = items.map((item) => item.path)
    expect(new Set(paths).size).toBe(paths.length)
  })
})

describe('uninstall path safety guard', () => {
  it('accepts paths inside the user home and custom absolute directories', () => {
    expect(assertSafeUninstallPath('/Users/Alice/.kun/data', { homeDir: HOME, platform: 'darwin' }))
      .toBe('/Users/Alice/.kun/data')
    expect(assertSafeUninstallPath('/Volumes/Data/Kun', { homeDir: HOME, platform: 'darwin' }))
      .toBe('/Volumes/Data/Kun')
  })

  it('rejects roots, the home directory, ancestors of home, and relative paths', () => {
    for (const path of ['/', '/Users', HOME, '~/', 'relative/path']) {
      expect(() => assertSafeUninstallPath(path, { homeDir: HOME, platform: 'darwin' }), path).toThrow()
    }
  })

  it('enforces the same rules on Windows with case-insensitive comparisons', () => {
    expect(assertSafeUninstallPath('C:\\Users\\Alice\\.kun\\data', {
      homeDir: 'C:\\Users\\Alice',
      platform: 'win32'
    })).toBe('C:\\Users\\Alice\\.kun\\data')
    for (const path of ['C:\\', 'C:\\Users', 'c:\\users\\alice', 'C:\\Users\\Alice\\']) {
      expect(() => assertSafeUninstallPath(path, {
        homeDir: 'C:\\Users\\Alice',
        platform: 'win32'
      }), path).toThrow()
    }
  })
})

describe('app removal target resolution', () => {
  it('never removes the app from an unpackaged development checkout', async () => {
    const result = await resolveAppRemovalTarget({
      execPath: '/Users/Alice/dev/DeepSeek-GUI/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      isPackaged: false,
      platform: 'darwin'
    })
    expect(result.mode).toBe('none')
  })

  it('finds the .app bundle root from the executable path', async () => {
    const result = await resolveAppRemovalTarget({
      execPath: '/Applications/Kun.app/Contents/MacOS/Kun',
      isPackaged: true,
      platform: 'darwin'
    })
    expect(result).toEqual({
      mode: 'bundle',
      target: '/Applications/Kun.app',
      installPath: '/Applications/Kun.app'
    })
  })

  it('targets the AppImage on Linux and gives a hint for deb installs', async () => {
    const appImage = await resolveAppRemovalTarget({
      execPath: '/tmp/mount/Kun',
      isPackaged: true,
      platform: 'linux',
      appImageEnv: '/home/Alice/Downloads/Kun-0.1.0.AppImage'
    })
    expect(appImage).toEqual({
      mode: 'appimage',
      target: '/home/Alice/Downloads/Kun-0.1.0.AppImage',
      installPath: '/home/Alice/Downloads/Kun-0.1.0.AppImage'
    })
    const deb = await resolveAppRemovalTarget({
      execPath: '/opt/Kun/kun',
      isPackaged: true,
      platform: 'linux'
    })
    expect(deb.mode).toBe('none')
    expect(deb.hint).toContain('sudo')
  })

  it('locates the NSIS uninstaller in the Windows install directory', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'kun-uninstall-install-'))
    await writeFile(join(installDir, 'Uninstall Kun.exe'), '', 'utf8')
    const result = await resolveAppRemovalTarget({
      execPath: join(installDir, 'Kun.exe'),
      isPackaged: true,
      platform: 'win32'
    })
    expect(result).toEqual({
      mode: 'uninstaller',
      target: join(installDir, 'Uninstall Kun.exe'),
      installPath: installDir
    })
    const emptyDir = await mkdtemp(join(tmpdir(), 'kun-uninstall-empty-'))
    const withoutUninstaller = await resolveAppRemovalTarget({
      execPath: join(emptyDir, 'Kun.exe'),
      isPackaged: true,
      platform: 'win32'
    })
    expect(withoutUninstaller.mode).toBe('none')
    expect(withoutUninstaller.hint).toContain('uninstaller')
  })
})

describe('macOS bundle root discovery', () => {
  it('walks up from the binary to the .app directory', () => {
    expect(findMacBundleRoot('/Applications/Kun.app/Contents/MacOS/Kun')).toBe('/Applications/Kun.app')
    expect(findMacBundleRoot('/Applications/Kun.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper'))
      .toBe('/Applications/Kun.app/Contents/Frameworks/Helper.app')
    expect(findMacBundleRoot('/usr/local/bin/kun')).toBeNull()
  })
})
