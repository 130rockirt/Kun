import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const helperPath = join(process.cwd(), 'build/windows-installer-migration.ps1')
const helperModulePaths = [
  'windows-installer-migration-paths.ps1',
  'windows-installer-migration-journal.ps1',
  'windows-installer-migration-filesystem.ps1',
  'windows-installer-migration-actions.ps1'
].map((fileName) => join(process.cwd(), 'build', fileName))
const smokePath = join(process.cwd(), 'scripts/smoke-windows-installer-migration.ps1')
const windowsOnly = process.platform === 'win32' ? describe : describe.skip
const tempRoots: string[] = []

function readHelperSources(): string {
  return [helperPath, ...helperModulePaths]
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')
}

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kun-installer-migration-'))
  tempRoots.push(root)
  return root
}

function runHelper(input: {
  action: 'ResolvePath' | 'ResolveSource' | 'ResolveUpdateScope' | 'ResolveUninstaller' | 'Recover' | 'Prepare' | 'FallbackCleanup' | 'Restore' | 'ValidatePayload' | 'CleanupInPlaceLeftovers'
  source?: string
  secondary?: string
  currentUserSource?: string
  currentUserUninstallCommand?: string
  allUsersSource?: string
  allUsersUninstallCommand?: string
  updateSource?: string
  candidate?: string
  candidateExplicit?: boolean
  target?: string
  journal?: string
  resultPath?: string
  uninstallCommand?: string
  scriptPath?: string
  userProfile?: string
  primarySourceStale?: boolean
  secondarySourceStale?: boolean
  inPlaceUpdate?: boolean
  installMode?: 'CurrentUser' | 'all'
  appGuid?: string
  canonicalLeaf?: string
  appExecutable?: string
  productName?: string
}) {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const resultPath = input.resultPath ??
    (input.scriptPath ? undefined : join(makeTempRoot(), 'resolver-result.txt'))
  return spawnSync(
    powershell,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      input.scriptPath ?? helperPath,
      '-Action',
      input.action,
      ...(resultPath ? ['-ResultPath', resultPath] : [])
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...(input.userProfile ? { USERPROFILE: input.userProfile } : {}),
        KUN_INSTALLER_SOURCE: input.source ?? '',
        KUN_INSTALLER_SECONDARY_SOURCE: input.secondary ?? '',
        KUN_INSTALLER_CURRENT_USER_SOURCE: input.currentUserSource ?? '',
        KUN_INSTALLER_CURRENT_USER_UNINSTALL_STRING: input.currentUserUninstallCommand ?? '',
        KUN_INSTALLER_ALL_USERS_SOURCE: input.allUsersSource ?? '',
        KUN_INSTALLER_ALL_USERS_UNINSTALL_STRING: input.allUsersUninstallCommand ?? '',
        KUN_INSTALLER_UPDATE_SOURCE: input.updateSource ?? '',
        KUN_INSTALLER_CANDIDATE: input.candidate ?? '',
        KUN_INSTALLER_CANDIDATE_EXPLICIT: input.candidateExplicit ? '1' : '0',
        KUN_INSTALLER_TARGET: input.target ?? '',
        KUN_INSTALLER_JOURNAL: input.journal ?? join(makeTempRoot(), 'journal.json'),
        KUN_INSTALLER_UNINSTALL_STRING: input.uninstallCommand ?? '',
        KUN_INSTALLER_PRIMARY_SOURCE_STALE: input.primarySourceStale ? '1' : '0',
        KUN_INSTALLER_SECONDARY_SOURCE_STALE: input.secondarySourceStale ? '1' : '0',
        KUN_INSTALLER_IN_PLACE_UPDATE: input.inPlaceUpdate ? '1' : '0',
        KUN_INSTALLER_INSTALL_MODE: input.installMode ?? 'CurrentUser',
        KUN_INSTALLER_APP_GUID: input.appGuid ?? 'test-kun-app-guid',
        KUN_INSTALLER_CANONICAL_LEAF: input.canonicalLeaf ?? 'Kun',
        KUN_INSTALLER_APP_EXECUTABLE: input.appExecutable ?? 'Kun.exe',
        KUN_INSTALLER_PRODUCT_NAME: input.productName ?? 'Kun',
        KUN_INSTALLER_SELF_PID: String(process.pid)
      }
    }
  )
}

function processError(result: ReturnType<typeof runHelper>): string {
  return String(result.stderr ?? '')
}

function unavailableDriveTarget(): string {
  for (let code = 'Z'.charCodeAt(0); code >= 'P'.charCodeAt(0); code -= 1) {
    const root = `${String.fromCharCode(code)}:\\`
    if (!existsSync(root)) return `${root}Kun`
  }
  throw new Error('No unavailable drive letter was available for the installer helper test.')
}

function readJournal(path: string): { Records: Array<{ Stash: string }> } {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as {
    Records: Array<{ Stash: string }>
  }
}

function writePackagedInstallPayload(root: string, executable = 'Kun.exe') {
  writeFileSync(join(root, executable), 'application executable')
  const resources = join(root, 'resources')
  mkdirSync(join(resources, 'app.asar.unpacked', 'kun', 'dist', 'cli'), { recursive: true })
  writeFileSync(join(resources, 'app.asar'), 'packaged application')
  writeFileSync(
    join(resources, 'app.asar.unpacked', 'kun', 'dist', 'cli', 'serve-entry.js'),
    'runtime entry'
  )
  mkdirSync(join(resources, 'app.asar.unpacked', 'kun', 'dist', 'manager'), { recursive: true })
  writeFileSync(
    join(resources, 'app.asar.unpacked', 'kun', 'dist', 'manager', 'manager-entry.js'),
    'service manager entry'
  )
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('Windows installer migration ACL contract', () => {
  it('uses the Windows filesystem ACL API without the optional PowerShell security module', () => {
    const script = readHelperSources()

    expect(script).not.toMatch(/\b(?:Get|Set)-Acl\b/u)
    expect(script).toContain('[IO.Directory]::GetAccessControl')
    expect(script).toContain('[IO.Directory]::SetAccessControl')
    expect(script).toContain('[IO.File]::SetAccessControl')
  })

  it('reads only the owner and DACL, so normal users do not need SACL privileges', () => {
    const script = readHelperSources()

    expect(script).toContain(
      '$sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access'
    )
    expect(script).not.toContain('[Security.AccessControl.AccessControlSections]::All')
    expect(script).not.toContain('[Security.AccessControl.AccessControlSections]::Audit')
  })

  it('waits for the real NSIS uninstall lifecycle before starting another installer', () => {
    const script = readFileSync(smokePath, 'utf8')

    expect(script).toContain("$arguments = @('/S', $Mode, ('_?={0}' -f $InstallLocation))")
    expect(script).toContain('Start-Process -FilePath $copy -ArgumentList $arguments -Wait -PassThru')
    expect(script).not.toMatch(/Start-Process -FilePath \$(?:unicode|machine)Uninstaller/u)
  })

  it('retries only a Windows access violation and never more than once', () => {
    const script = readFileSync(smokePath, 'utf8')

    expect(script).toContain('$accessViolationExitCode = -1073741819')
    expect(script).toContain('$maximumAttempts = 2')
    expect(script).toContain('$process.ExitCode -ne $accessViolationExitCode')
    expect(script).toContain('retrying once after 2 seconds')
  })

  it('keeps same-directory automatic updates from pre-deleting the application payload', () => {
    const installerScript = readFileSync(join(process.cwd(), 'build/installer.nsh'), 'utf8')
    const migrationScript = readHelperSources()

    expect(installerScript).toContain('Function KunMarkInPlaceAutomaticUpdate')
    expect(installerScript).toContain('${if} $KunInstallerInPlaceUpdate == 1')
    expect(installerScript).toContain('skipping pre-install removal of $KunInstallerPrimarySourceDir')
    expect(installerScript).toContain(
      'suppressed the selected-scope uninstaller until the new payload is installed'
    )
    expect(installerScript.indexOf('!insertmacro kunRunMigrationHelper ValidatePayload')).toBeLessThan(
      installerScript.indexOf('!insertmacro kunRunMigrationHelper CleanupInPlaceLeftovers')
    )
    expect(migrationScript).toContain('function Invoke-CleanupInPlaceLeftovers')
    expect(migrationScript).toContain('function Test-RetainedInPlaceKnownEntry')
    expect(smokePath.length).toBeGreaterThan(0)
    expect(readFileSync(smokePath, 'utf8')).toContain('in-app all-users automatic update scope')
  })
})

windowsOnly('Windows installer migration helper', () => {
  it('validates the installed application payload before PATH is updated', () => {
    const target = join(makeTempRoot(), 'Kun')
    mkdirSync(target, { recursive: true })
    writePackagedInstallPayload(target)

    const result = runHelper({ action: 'ValidatePayload', target })

    expect(result.status, processError(result)).toBe(0)
  })

  it('removes only obsolete known identity files after a validated in-place update', () => {
    const target = join(makeTempRoot(), 'Kun')
    mkdirSync(target, { recursive: true })
    writePackagedInstallPayload(target)
    writeFileSync(join(target, 'DeepSeek GUI.exe'), 'legacy identity')
    writeFileSync(join(target, 'Uninstall DeepSeek GUI.exe'), 'legacy uninstaller')
    writeFileSync(join(target, 'Uninstall Kun.exe'), 'current uninstaller')
    writeFileSync(join(target, 'ffmpeg.dll'), 'runtime')
    writeFileSync(join(target, 'notes.txt'), 'user file')

    const result = runHelper({
      action: 'CleanupInPlaceLeftovers',
      source: target,
      target,
      inPlaceUpdate: true
    })

    expect(result.status, processError(result)).toBe(0)
    expect(existsSync(join(target, 'Kun.exe'))).toBe(true)
    expect(existsSync(join(target, 'Uninstall Kun.exe'))).toBe(true)
    expect(existsSync(join(target, 'ffmpeg.dll'))).toBe(true)
    expect(existsSync(join(target, 'resources', 'app.asar'))).toBe(true)
    expect(existsSync(join(target, 'DeepSeek GUI.exe'))).toBe(false)
    expect(existsSync(join(target, 'Uninstall DeepSeek GUI.exe'))).toBe(false)
    expect(readFileSync(join(target, 'notes.txt'), 'utf8')).toBe('user file')
  })

  it('does not clean in-place leftovers unless the in-place update marker is set', () => {
    const target = join(makeTempRoot(), 'Kun')
    mkdirSync(target, { recursive: true })
    writePackagedInstallPayload(target)
    writeFileSync(join(target, 'DeepSeek GUI.exe'), 'legacy identity')

    const result = runHelper({
      action: 'CleanupInPlaceLeftovers',
      source: target,
      target,
      inPlaceUpdate: false
    })

    expect(result.status, processError(result)).toBe(0)
    expect(existsSync(join(target, 'DeepSeek GUI.exe'))).toBe(true)
  })

  it('refuses in-place leftover cleanup when the validated payload is incomplete', () => {
    const target = join(makeTempRoot(), 'Kun')
    mkdirSync(target, { recursive: true })
    writePackagedInstallPayload(target)
    rmSync(join(target, 'Kun.exe'))
    writeFileSync(join(target, 'DeepSeek GUI.exe'), 'legacy identity')

    const result = runHelper({
      action: 'CleanupInPlaceLeftovers',
      source: target,
      target,
      inPlaceUpdate: true
    })

    expect(result.status).not.toBe(0)
    expect(processError(result)).toContain('payload is missing')
    expect(existsSync(join(target, 'DeepSeek GUI.exe'))).toBe(true)
  })

  it('keeps known application files after prepare for same-directory updates', () => {
    const root = makeTempRoot()
    const source = join(root, 'Kun')
    const journal = join(root, 'recovery', 'journal.json')
    mkdirSync(join(source, 'resources'), { recursive: true })
    writeFileSync(join(source, 'Kun.exe'), 'app')
    writeFileSync(join(source, 'notes.txt'), 'keep me')

    const prepared = runHelper({ action: 'Prepare', source, target: source, journal })
    expect(prepared.status, processError(prepared)).toBe(0)
    expect(existsSync(join(source, 'Kun.exe'))).toBe(true)
    expect(existsSync(join(source, 'notes.txt'))).toBe(false)
  })

  it.each([
    ['application executable', (target: string) => join(target, 'Kun.exe')],
    ['resources\\app.asar', (target: string) => join(target, 'resources', 'app.asar')],
    [
      'unpacked Kun runtime entry',
      (target: string) => join(target, 'resources', 'app.asar.unpacked', 'kun', 'dist', 'cli', 'serve-entry.js')
    ],
    [
      'unpacked Kun service manager entry',
      (target: string) => join(target, 'resources', 'app.asar.unpacked', 'kun', 'dist', 'manager', 'manager-entry.js')
    ]
  ])('rejects an incomplete installed payload missing %s', (label, missingPath) => {
    const target = join(makeTempRoot(), 'Kun')
    mkdirSync(target, { recursive: true })
    writePackagedInstallPayload(target)
    rmSync(missingPath(target))

    const result = runHelper({ action: 'ValidatePayload', target })

    expect(result.status).not.toBe(0)
    expect(processError(result)).toContain('payload is missing')
    expect(processError(result)).toContain(label)
  })

  it('rejects an empty installed payload file', () => {
    const target = join(makeTempRoot(), 'Kun')
    mkdirSync(target, { recursive: true })
    writePackagedInstallPayload(target)
    writeFileSync(join(target, 'resources', 'app.asar'), '')

    const result = runHelper({ action: 'ValidatePayload', target })

    expect(result.status).not.toBe(0)
    expect(processError(result)).toContain('payload is empty for resources\\app.asar')
  })

  it.each([
    ['C:\\Users\\me\\AppData\\Local\\Programs\\DeepSeek GUI', '', 'C:\\Users\\me\\AppData\\Local\\Programs\\Kun'],
    ['D:\\Apps\\deepseek-gui', '', 'D:\\Apps\\Kun'],
    ['D:\\Apps\\DeepSeek GUI\\Kun', '', 'D:\\Apps\\Kun'],
    ['D:\\Legacy\\DeepSeek GUI', 'C:\\Users\\me\\AppData\\Local\\Programs\\Kun', 'D:\\Legacy\\Kun'],
    ['D:\\Apps\\Custom AI', 'D:\\Apps\\Custom AI', 'D:\\Apps\\Custom AI'],
    ['', 'D:\\Apps', 'D:\\Apps\\Kun'],
    ['', 'D:\\KunTools', 'D:\\KunTools\\Kun'],
    ['', 'D:\\Unicode 测试\\', 'D:\\Unicode 测试\\Kun']
  ])('resolves source %s and candidate %s to %s', (source, candidateOverride, expected) => {
    const candidate = candidateOverride || source
    const resultPath = join(makeTempRoot(), 'resolved-path.txt')
    const result = runHelper({ action: 'ResolvePath', source, candidate, resultPath })

    expect(result.status, processError(result)).toBe(0)
    expect(readFileSync(resultPath, 'utf16le')).toBe(expected)
  })
})
