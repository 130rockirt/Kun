import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const builderConfig = require('../../electron-builder.config.cjs')
const rootPackage = require('../../package.json')
const afterPack = require('../../scripts/after-pack.cjs')
const nativeBuildEnv = require('../../scripts/electron-native-build-env.cjs')
const macNotarize = require('../../scripts/mac-notarize.cjs')
const officeCliPrepare = require('../../scripts/prepare-officecli.cjs')

const tempRoots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ds-gui-packaging-'))
  tempRoots.push(root)
  return root
}

function touch(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '{}\n', 'utf8')
}

function preloadSourceFiles(dir = join(process.cwd(), 'src/preload')): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) return preloadSourceFiles(path)
    if (
      path.endsWith('.d.ts') ||
      path.endsWith('.test.ts') ||
      path.endsWith('.spec.ts')
    ) {
      return []
    }
    return path.endsWith('.ts') ? [path] : []
  })
}

function forbiddenPreloadImports(source: string): string[] {
  const builtins = new Set(builtinModules.map((moduleName) => moduleName.replace(/^node:/, '')))
  const imports = source.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)
  return [...imports]
    .map((match) => match[1])
    .filter((specifier) => {
      const moduleName = specifier.replace(/^node:/, '')
      return specifier.startsWith('node:') ||
        builtins.has(moduleName) ||
        builtins.has(moduleName.split('/')[0] ?? moduleName)
    })
}

async function visiblePixelBounds(path: string): Promise<{
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
} | undefined> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let left = info.width
  let top = info.height
  let right = -1
  let bottom = -1

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const alpha = data[(y * info.width + x) * info.channels + 3] ?? 0
      if (alpha === 0) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }

  if (right < left || bottom < top) return undefined
  return {
    left,
    top,
    right,
    bottom,
    width: right - left + 1,
    height: bottom - top + 1
  }
}

function loadBuilderConfigWithEnv(env: Record<string, string | undefined>): typeof builderConfig {
  const configPath = require.resolve('../../electron-builder.config.cjs')
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  delete require.cache[configPath]
  try {
    return require(configPath)
  } finally {
    delete require.cache[configPath]
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    require(configPath)
  }
}

function createMacPackContext(root: string): {
  appOutDir: string
  electronPlatformName: string
  arch: string
  packager: { appInfo: { productFilename: string } }
} {
  return {
    appOutDir: join(root, 'mac-arm64'),
    electronPlatformName: 'darwin',
    arch: 'arm64',
    packager: {
      appInfo: {
        productFilename: 'Kun'
      }
    }
  }
}

function createWindowsPackContext(root: string, signIf: (path: string) => Promise<boolean>) {
  return {
    appOutDir: join(root, 'win-unpacked'),
    electronPlatformName: 'win32',
    arch: 'x64',
    packager: {
      appInfo: {
        productFilename: 'Kun'
      },
      signIf
    }
  }
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('electron-builder Kun packaging', () => {
  it('ships only Chromium locales exposed by the application locale picker', () => {
    expect(builderConfig.mac.electronLanguages).toEqual([
      'en',
      'en_GB',
      'zh_CN',
      'zh_TW',
      'ru',
      'hi',
      'th',
      'ja',
      'ko'
    ])
    const chromiumPakLanguages = [
      'en-US',
      'en-GB',
      'zh-CN',
      'zh-TW',
      'ru',
      'hi',
      'th',
      'ja',
      'ko'
    ]
    expect(builderConfig.win.electronLanguages).toEqual(chromiumPakLanguages)
    expect(builderConfig.linux.electronLanguages).toEqual(chromiumPakLanguages)
  })

  it('provides the maintainer identity required by Debian packages', () => {
    expect(builderConfig.linux.maintainer)
      .toMatch(/^Kun Contributors <[^<>@\s]+@[^<>@\s]+>$/)
  })

  it('keeps renderer and release-only packages out of the production dependency graph', () => {
    const developmentOnly = [
      '@aws-sdk/client-s3',
      '@codemirror/view',
      '@streamdown/math',
      '@tiptap/core',
      '@xterm/xterm',
      '@xyflow/react',
      'i18next',
      'jimp',
      'lucide-react',
      'qrcode.react',
      'react-i18next',
      'rehype-harden',
      'rehype-raw',
      'shiki',
      'streamdown',
      'zustand'
    ]
    for (const packageName of developmentOnly) {
      expect(rootPackage.dependencies?.[packageName]).toBeUndefined()
      expect(rootPackage.devDependencies?.[packageName]).toEqual(expect.any(String))
    }
  })

  it('keeps Linux Electron native-addon rebuilds on the external V8 header path', () => {
    const linuxEnv: Record<string, string> = { CXXFLAGS: '-O2' }

    expect(nativeBuildEnv.configureElectronNativeBuildEnvironment('linux', linuxEnv)).toBe(linuxEnv)
    expect(linuxEnv.CXXFLAGS).toBe('-O2 -UV8_DEPRECATION_WARNINGS')

    nativeBuildEnv.configureElectronNativeBuildEnvironment('linux', linuxEnv)
    expect(linuxEnv.CXXFLAGS).toBe('-O2 -UV8_DEPRECATION_WARNINGS')

    const macEnv: Record<string, string> = {}
    nativeBuildEnv.configureElectronNativeBuildEnvironment('darwin', macEnv)
    expect(macEnv.CXXFLAGS).toBeUndefined()

    const configSource = readFileSync(join(process.cwd(), 'electron-builder.config.cjs'), 'utf8')
    expect(configSource).toContain(
      'configureElectronNativeBuildEnvironment(process.platform, process.env)'
    )
  })

  it('includes Kun runtime dependencies in the packaged app', () => {
    expect(builderConfig.files).toEqual(expect.arrayContaining([
      'kun/dist/**/*',
      'kun/package.json',
      'kun/package-lock.json',
      'kun/node_modules/**/*'
    ]))
    expect(builderConfig.asarUnpack).toEqual(expect.arrayContaining([
      '**/kun/dist/**/*',
      '**/kun/package*.json',
      '**/kun/node_modules/**/*',
      '**/node_modules/sharp/**/*',
      '**/node_modules/@img/**/*'
    ]))
    expect(builderConfig.asarUnpack).not.toEqual(expect.arrayContaining([
      '**/node_modules/node-bin-darwin-*/*',
      '**/node_modules/node-bin-linux-*/*',
      '**/node_modules/node-bin-win-*/*',
      '**/node_modules/openclaw/**/*',
      '**/node_modules/@tencent-weixin/openclaw-weixin/**/*'
    ]))
    // The openclaw shim (vendor/openclaw-shim) must ship: the WeChat bridge
    // imports the bundled plugin's dist at runtime to send media, and that
    // import chain resolves openclaw/plugin-sdk/*.
    expect(builderConfig.files).not.toEqual(expect.arrayContaining([
      '!**/node_modules/openclaw/**/*'
    ]))
  })

  it('ships third-party notices with packaged applications', () => {
    expect(builderConfig.extraResources).toEqual(expect.arrayContaining([{
      from: 'THIRD_PARTY_NOTICES.md',
      to: 'THIRD_PARTY_NOTICES.md'
    }]))
    expect(readFileSync(join(process.cwd(), 'THIRD_PARTY_NOTICES.md'), 'utf8'))
      .toContain('Copyright (c) 2025 Addy Osmani')
  })

  it('bundles one pinned OfficeCLI target with its manifests and legal notices', () => {
    expect(builderConfig.extraResources).toEqual(expect.arrayContaining([
      {
        from: 'resources/officecli/current',
        to: 'officecli',
        filter: ['officecli', 'officecli.exe', 'selected.json']
      },
      {
        from: 'resources/officecli/manifest.json',
        to: 'officecli/manifest.json'
      },
      {
        from: 'resources/officecli/legal',
        to: 'officecli/legal',
        filter: ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt']
      }
    ]))
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'resources/officecli/manifest.json'), 'utf8')
    )
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      version: '1.0.141',
      releaseTag: 'v1.0.141',
      schemaCrc: '2da9da05'
    })
    expect(Object.keys(manifest.assets).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'win32-x64'
    ])
    for (const asset of Object.values(manifest.assets) as Array<Record<string, unknown>>) {
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(asset.size).toEqual(expect.any(Number))
      expect(asset.url).toMatch(/^https:\/\/github\.com\/iOfficeAI\/OfficeCLI\/releases\/download\/v1\.0\.141\//)
    }
    expect(officeCliPrepare._internals.parseArgs(['--platform', 'mac', '--arch', 'x64']))
      .toEqual({ platform: 'darwin', arch: 'x64' })
  })

  it('verifies the packaged OfficeCLI architecture selection, digest, mode, and notices', () => {
    const root = tempRoot()
    const context = createMacPackContext(root)
    const officeRoot = join(afterPack._internals.packedResourcesDir(context), 'officecli')
    const binary = Buffer.from('pinned officecli fixture')
    const digest = createHash('sha256').update(binary).digest('hex')
    const manifest = {
      schemaVersion: 1,
      version: '1.0.141',
      releaseTag: 'v1.0.141',
      schemaCrc: '2da9da05',
      assets: {
        'darwin-arm64': {
          name: 'officecli-mac-arm64',
          size: binary.length,
          sha256: digest,
          url: 'https://example.invalid/officecli'
        }
      }
    }
    const selected = {
      schemaVersion: 1,
      version: '1.0.141',
      releaseTag: 'v1.0.141',
      schemaCrc: '2da9da05',
      platform: 'darwin',
      arch: 'arm64',
      asset: 'officecli-mac-arm64',
      size: binary.length,
      sha256: digest
    }
    mkdirSync(join(officeRoot, 'legal'), { recursive: true })
    writeFileSync(join(officeRoot, 'manifest.json'), JSON.stringify(manifest))
    writeFileSync(join(officeRoot, 'selected.json'), JSON.stringify(selected))
    writeFileSync(join(officeRoot, 'officecli'), binary)
    chmodSync(join(officeRoot, 'officecli'), 0o644)
    for (const name of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt']) {
      writeFileSync(join(officeRoot, 'legal', name), name)
    }

    expect(() => afterPack._internals.validateBundledOfficeCli(context)).not.toThrow()
    expect(statSync(join(officeRoot, 'officecli')).mode & 0o111).not.toBe(0)

    writeFileSync(join(officeRoot, 'officecli.exe'), 'wrong architecture')
    expect(() => afterPack._internals.validateBundledOfficeCli(context)).toThrow(
      /exactly one darwin-arm64/
    )
  })

  it('passes the nested OfficeCLI executable through the Windows signing manager', async () => {
    const root = tempRoot()
    const signedPaths: string[] = []
    const context = createWindowsPackContext(root, async (path) => {
      signedPaths.push(path)
      return true
    })

    await expect(afterPack._internals.maybeSignBundledOfficeCli(context)).resolves.toBe(true)
    expect(signedPaths).toEqual([
      join(context.appOutDir, 'resources', 'officecli', 'officecli.exe')
    ])
  })

  it('validates the unpacked Kun runtime before release artifacts are created', () => {
    const root = tempRoot()
    const context = createMacPackContext(root)
    const unpackedRoot = afterPack._internals.unpackedAppRoot(context)

    expect(afterPack.KUN_RUNTIME_REQUIRED_PATHS).toEqual(expect.arrayContaining([
      'kun/node_modules/typescript/package.json',
      'kun/node_modules/typescript/lib/typescript.js',
      'kun/node_modules/typescript-language-server/package.json',
      'kun/node_modules/typescript-language-server/lib/cli.mjs'
    ]))

    for (const relativePath of afterPack.KUN_RUNTIME_REQUIRED_PATHS) {
      touch(join(unpackedRoot, relativePath))
    }
    touch(join(unpackedRoot, 'kun/node_modules/@cursor/sdk-darwin-arm64/package.json'))
    touch(join(unpackedRoot, 'node_modules/better-sqlite3/package.json'))

    expect(() => afterPack._internals.validateBundledKunRuntime(context)).not.toThrow()

    rmSync(join(unpackedRoot, 'kun/node_modules/zod'), { recursive: true, force: true })

    expect(() => afterPack._internals.validateBundledKunRuntime(context)).toThrow(
      /kun\/node_modules\/zod\/package\.json/
    )
  })

  it('runs npm through cmd.exe during Windows afterPack hooks', () => {
    expect(afterPack._internals.npmCommand(['prune'], 'win32')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm', 'prune']
    })
    expect(afterPack._internals.npmCommand(['prune'], 'darwin')).toEqual({
      command: 'npm',
      args: ['prune']
    })
  })

  it('uses the rounded Kun icon for Windows installers and shortcuts', () => {
    // Windows ships a multi-size .ico (16/24/32/48/64/72/96/128/256) generated
    // from the rounded kun_mac.png so Explorer/desktop render crisp small icons
    // instead of downscaling a single 1024px PNG (#222). The .ico still carries
    // the rounded Kun artwork — it is derived from kun_mac.png.
    expect(builderConfig.win.icon).toBe('./build/icon.ico')
  })

  it('keeps the macOS Dock icon inside the platform artwork safe area', async () => {
    const iconPath = join(process.cwd(), 'src/asset/img/kun_mac.png')

    expect(builderConfig.mac.icon).toBe('./src/asset/img/kun_mac.png')
    await expect(sharp(iconPath).metadata()).resolves.toMatchObject({
      width: 1024,
      height: 1024,
      hasAlpha: true
    })
    await expect(visiblePixelBounds(iconPath)).resolves.toEqual({
      left: 100,
      top: 100,
      right: 923,
      bottom: 923,
      width: 824,
      height: 824
    })
  })

  it('ships compact 1x and 2x macOS menu-bar artwork', async () => {
    const icon1xPath = join(process.cwd(), 'src/asset/img/kun_tray_mac.png')
    const icon2xPath = join(process.cwd(), 'src/asset/img/kun_tray_mac@2x.png')

    await expect(sharp(icon1xPath).metadata()).resolves.toMatchObject({
      width: 16,
      height: 16,
      hasAlpha: true
    })
    await expect(sharp(icon2xPath).metadata()).resolves.toMatchObject({
      width: 32,
      height: 32,
      hasAlpha: true
    })
  })

  it('migrates Windows install roots without changing identity or touching user data', () => {
    const installerScript = readFileSync(join(process.cwd(), 'build/installer.nsh'), 'utf8')
    const migrationScript = readFileSync(
      join(process.cwd(), 'build/windows-installer-migration.ps1'),
      'utf8'
    )

    expect(builderConfig.appId).toBe('com.xingyuzhong.deepseekgui')
    expect(builderConfig.productName).toBe('Kun')
    expect(builderConfig.nsis.include).toBe('build/installer.nsh')
    expect(builderConfig.nsis.allowToChangeInstallationDirectory).toBe(false)
    expect(builderConfig.nsis.deleteAppDataOnUninstall).toBe(false)
    expect(installerScript).toContain('!macro customInit')
    expect(installerScript).toContain('${if} ${isUpdated}')
    expect(installerScript).toContain('SetSilent silent')
    expect(installerScript).toContain('customPageAfterChangeDir')
    expect(installerScript).toContain('MUI_PAGE_CUSTOMFUNCTION_PRE KunInstallDirectoryPagePre')
    expect(installerScript).toContain('MUI_PAGE_CUSTOMFUNCTION_LEAVE KunInstallDirectoryPageLeave')
    expect(installerScript).toContain('MUI_PAGE_CUSTOMFUNCTION_PRE KunInstallFilesPagePre')
    expect(installerScript).toContain('Var /GLOBAL KunInstallerSourceDir')
    expect(installerScript).toContain('Var /GLOBAL KunInstallerPrimarySourceDir')
    expect(installerScript).toContain('Var /GLOBAL KunInstallerSecondarySourceDir')
    expect(installerScript).toContain('Var /GLOBAL KunInstallerTargetDir')
    expect(installerScript).toContain('Call KunRefreshInstallPaths')
    expect(installerScript).toContain('Function KunInstallDirectoryPagePre')
    expect(installerScript).toContain('Function KunInstallDirectoryPageLeave')
    expect(installerScript).toContain('Function KunInstallFilesPagePre')
    expect(installerScript).toContain('FileReadUTF16LE $KunInstallerResultHandle')
    expect(installerScript).toContain('${andIf} ${Silent}\n    Call KunPrepareInstallMigration')
    expect(installerScript).toContain('StrCpy $appExe "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"')
    expect(installerScript).toContain('customCheckAppRunning')
    expect(installerScript).toContain('customUnInstallCheck')
    expect(installerScript).toContain('customUnInstallCheckCurrentUser')
    expect(installerScript).toContain('KunHandleOldUninstallerResult')
    expect(installerScript).toContain('FallbackCleanup')
    expect(installerScript).toContain('Restore')
    expect(installerScript).toContain('UpdatePath')
    expect(installerScript).toContain('old-uninstaller.exe')
    expect(installerScript).toContain('$$_.ExecutablePath')
    expect(installerScript).toContain("$$r=[IO.Path]::GetFullPath")
    expect(installerScript).toContain('taskkill.exe /PID $$_.ProcessId /T /F')
    expect(installerScript).toContain('!ifdef BUILD_UNINSTALLER')
    expect(installerScript).toContain('${ifNot} ${isUpdated}')
    expect(installerScript).toContain('MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)"')
    expect(installerScript).not.toContain('RMDir /r "$INSTDIR"')
    expect(installerScript).not.toContain('DeleteRegKey SHELL_CONTEXT')
    expect(installerScript).not.toContain('Stop-Process -Id')

    expect(migrationScript).toContain("ValidateSet('ResolvePath', 'ResolveSource', 'Recover', 'Prepare'")
    expect(migrationScript).toContain('Test-LegacyLeaf')
    expect(migrationScript).toContain('Test-ReparsePoint')
    expect(migrationScript).toContain('Test-KnownApplicationEntry')
    expect(migrationScript).toContain('Get-ValidatedJournalRecord')
    expect(migrationScript).toContain("Get-EnvironmentValue 'KUN_INSTALLER_SECONDARY_SOURCE'")
    expect(migrationScript).toContain('Invoke-RestoreJournal')
    expect(migrationScript).toContain("[Environment]::GetEnvironmentVariable('Path', 'User')")
    expect(migrationScript).not.toMatch(/Remove-Item[^\n]*(?:APPDATA|USERPROFILE|\.kun|\.deepseekgui)/i)
  })

  it('builds kun-dv with an isolated application identity and no production updater feed', () => {
    const developmentConfig = loadBuilderConfigWithEnv({ KUN_APP_FLAVOR: 'development' })

    expect(developmentConfig.appId).toBe('com.xingyuzhong.deepseekgui.dv')
    expect(developmentConfig.productName).toBe('kun-dv')
    expect(developmentConfig.artifactName).toContain('kun-dv-')
    expect(developmentConfig.nsis.shortcutName).toBe('kun-dv')
    expect(developmentConfig.extraMetadata.kunAppFlavor).toBe('development')
    expect(developmentConfig.publish).toEqual([])
  })

  it('keeps sandboxed preload free of Node builtin imports', () => {
    for (const sourcePath of preloadSourceFiles()) {
      expect(forbiddenPreloadImports(readFileSync(sourcePath, 'utf8'))).toEqual([])
    }
  })

  it('requires Apple secure timestamps when Developer ID signing is enabled', () => {
    const signedConfig = loadBuilderConfigWithEnv({
      MAC_SIGN: '1'
    })

    expect(signedConfig.mac.identity).toBeUndefined()
    expect(signedConfig.mac.hardenedRuntime).toBe(true)
    expect(signedConfig.mac.forceCodeSigning).toBe(true)
    expect(signedConfig.mac.timestamp).toBe('http://timestamp.apple.com/ts01')
  })

  it('checks timestamp candidates across nested macOS signed code', () => {
    const root = tempRoot()
    const appBundle = join(root, 'Kun.app')
    const mainExecutable = join(appBundle, 'Contents/MacOS/Kun')
    const framework = join(appBundle, 'Contents/Frameworks/Electron Framework.framework')
    const nativeAddon = join(
      appBundle,
      'Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
    )
    const resourceScript = join(appBundle, 'Contents/Resources/postinstall.sh')

    touch(mainExecutable)
    touch(join(framework, 'Versions/A/Electron Framework'))
    touch(nativeAddon)
    touch(resourceScript)
    chmodSync(mainExecutable, 0o755)
    chmodSync(resourceScript, 0o755)

    expect(macNotarize._internals.collectSignedCodeCandidates(appBundle)).toEqual([
      appBundle,
      framework,
      mainExecutable,
      nativeAddon
    ])
  })
})
