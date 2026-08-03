import { execFile } from 'node:child_process'
import { lstat, mkdir, readdir, realpath, statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, parse, resolve, win32 } from 'node:path'
import { promisify } from 'node:util'
import type {
  StorageRelocationRoot,
  StorageRelocationRootName
} from '../../shared/storage-relocation'

const execFileAsync = promisify(execFile)
const WINDOWS_STORAGE_RELOCATION_VOLUME_ROOT_ENV = 'KUN_STORAGE_RELOCATION_VOLUME_ROOT'
const WINDOWS_STORAGE_RELOCATION_DESTINATION_PATH_ENV = 'KUN_STORAGE_RELOCATION_DESTINATION_PATH'
const WINDOWS_STORAGE_RELOCATION_ACL_SOURCE_PATH_ENV = 'KUN_STORAGE_RELOCATION_ACL_SOURCE_PATH'
const WINDOWS_STORAGE_RELOCATION_ACL_TARGET_PATH_ENV = 'KUN_STORAGE_RELOCATION_ACL_TARGET_PATH'

export const STORAGE_RELOCATION_ROOT_NAMES = ['.kun', '.deepseekgui'] as const
export const STORAGE_RELOCATION_CONTROL_DIR = 'storage-relocation'
export const STORAGE_RELOCATION_OWNERSHIP_MARKER = '.kun-storage-root.json'

export type StorageRelocationVolumeInfo = {
  root: string
  driveType: 'Fixed' | 'Removable' | 'Network' | 'Unknown'
  fileSystem: string
  availableBytes: number
}

export type StorageTreeInventory = {
  files: number
  directories: number
  links: number
  bytes: number
}

export function storageRelocationControlRoot(userDataPath: string): string {
  return join(userDataPath, STORAGE_RELOCATION_CONTROL_DIR)
}

export function storageLogicalRoot(
  name: StorageRelocationRootName,
  homeDir = homedir()
): string {
  return join(homeDir, name)
}

export function normalizeComparableWindowsPath(value: string): string {
  const normalized = win32.resolve(value.trim()).replace(/[\\/]+$/u, '')
  return normalized.toLocaleLowerCase('en-US')
}

export function windowsPathsOverlap(left: string, right: string): boolean {
  const a = normalizeComparableWindowsPath(left)
  const b = normalizeComparableWindowsPath(right)
  return a === b || a.startsWith(`${b}\\`) || b.startsWith(`${a}\\`)
}

export function isWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value.trim()) && !value.trim().startsWith('\\\\')
}

export function validateDestinationPath(input: {
  destinationRoot: string
  homeDir: string
  userDataPath: string
  installPath: string
  restoreDefault?: boolean
}): string {
  const raw = input.destinationRoot.trim()
  if (!raw || raw.includes('\0') || !win32.isAbsolute(raw) || !isWindowsDrivePath(raw)) {
    throw new Error('invalid_destination: Choose an absolute local drive folder.')
  }
  const destination = win32.resolve(raw)
  const parsed = win32.parse(destination)
  if (input.restoreDefault && destination !== win32.resolve(input.homeDir)) {
    throw new Error('invalid_destination: Restore must target the default user-profile location.')
  }
  if (destination === parsed.root || destination === win32.resolve(input.homeDir)) {
    if (!input.restoreDefault || destination !== win32.resolve(input.homeDir)) {
      throw new Error('invalid_destination: A drive or user-profile root cannot own Kun data directly.')
    }
  }
  if (!input.restoreDefault) {
    const protectedPaths = [
      input.userDataPath,
      input.installPath,
      storageLogicalRoot('.kun', input.homeDir),
      storageLogicalRoot('.deepseekgui', input.homeDir)
    ]
    if (protectedPaths.some((candidate) => windowsPathsOverlap(destination, candidate))) {
      throw new Error('invalid_destination: The selected folder overlaps protected Kun data.')
    }
  }
  return destination
}

export async function inspectWindowsVolume(path: string): Promise<StorageRelocationVolumeInfo> {
  const driveRoot = win32.parse(win32.resolve(path)).root
  if (process.platform === 'win32') {
    const script = [
      '$d = [System.IO.DriveInfo]::new($env:KUN_STORAGE_RELOCATION_VOLUME_ROOT)',
      '$o = @{ root=$d.RootDirectory.FullName; driveType=$d.DriveType.ToString(); fileSystem=$d.DriveFormat; availableBytes=$d.AvailableFreeSpace }',
      '$o | ConvertTo-Json -Compress'
    ].join('; ')
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        env: { ...process.env, [WINDOWS_STORAGE_RELOCATION_VOLUME_ROOT_ENV]: driveRoot }
      }
    )
    const parsed = JSON.parse(stdout.trim()) as Partial<StorageRelocationVolumeInfo>
    return {
      root: String(parsed.root ?? driveRoot),
      driveType: parsed.driveType === 'Fixed' || parsed.driveType === 'Removable' || parsed.driveType === 'Network'
        ? parsed.driveType
        : 'Unknown',
      fileSystem: String(parsed.fileSystem ?? ''),
      availableBytes: Number(parsed.availableBytes ?? 0)
    }
  }
  // Non-Windows tests inject win32 paths but use a real temporary filesystem.
  const candidate = await nearestExistingPath(path)
  const stats = await statfs(candidate, { bigint: true })
  const available = stats.bavail * stats.bsize
  return {
    root: parse(candidate).root,
    driveType: 'Fixed',
    fileSystem: 'NTFS',
    availableBytes: available > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(available)
  }
}

async function nearestExistingPath(path: string): Promise<string> {
  let current = path
  for (;;) {
    try {
      await lstat(current)
      return current
    } catch (error) {
      if (String((error as NodeJS.ErrnoException).code) !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

export async function ensureDestinationIsEmpty(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const entries = await readdir(path)
  if (entries.length > 0) {
    throw new Error('destination_not_empty: Choose an empty folder reserved for Kun data.')
  }
}

export async function hardenStorageDestinationAcl(path: string): Promise<void> {
  if (process.platform !== 'win32') return
  const script = [
    '$path = $env:KUN_STORAGE_RELOCATION_DESTINATION_PATH',
    '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()',
    '$acl = New-Object System.Security.AccessControl.DirectorySecurity',
    '$acl.SetOwner($identity.User)',
    '$acl.SetAccessRuleProtection($true, $false)',
    '$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit',
    '$prop = [System.Security.AccessControl.PropagationFlags]::None',
    '$allow = [System.Security.AccessControl.AccessControlType]::Allow',
    '$full = [System.Security.AccessControl.FileSystemRights]::FullControl',
    '$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity.User, $full, $inherit, $prop, $allow))',
    '$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new("S-1-5-18", $full, $inherit, $prop, $allow))',
    'Set-Acl -LiteralPath $path -AclObject $acl',
    '$check = Get-Acl -LiteralPath $path',
    'if (-not $check.AreAccessRulesProtected) { throw "destination ACL inheritance is still enabled" }',
    'if (-not ($check.Access | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $identity.User.Value -and $_.AccessControlType -eq "Allow" })) { throw "current user ACL is missing" }'
  ].join('; ')
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      env: { ...process.env, [WINDOWS_STORAGE_RELOCATION_DESTINATION_PATH_ENV]: path }
    }
  )
}

export async function copyWindowsAcls(sourceRoot: string, targetRoot: string): Promise<void> {
  if (process.platform !== 'win32') return
  const script = [
    `$source = (Get-Item -LiteralPath $env:${WINDOWS_STORAGE_RELOCATION_ACL_SOURCE_PATH_ENV} -Force).FullName`,
    `$target = (Get-Item -LiteralPath $env:${WINDOWS_STORAGE_RELOCATION_ACL_TARGET_PATH_ENV} -Force).FullName`,
    'Set-Acl -LiteralPath $target -AclObject (Get-Acl -LiteralPath $source)',
    '$sourceRootItem = Get-Item -LiteralPath $source -Force',
    '$targetRootItem = Get-Item -LiteralPath $target -Force',
    '$targetRootItem.CreationTimeUtc = $sourceRootItem.CreationTimeUtc',
    'Get-ChildItem -LiteralPath $source -Force -Recurse | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } | ForEach-Object {',
    '  $relative = $_.FullName.Substring($source.Length).TrimStart("\\")',
    '  $copy = Join-Path $target $relative',
    '  if (Test-Path -LiteralPath $copy) {',
    '    Set-Acl -LiteralPath $copy -AclObject (Get-Acl -LiteralPath $_.FullName)',
    '    $copyItem = Get-Item -LiteralPath $copy -Force',
    '    $copyItem.CreationTimeUtc = $_.CreationTimeUtc',
    '  }',
    '}'
  ].join('; ')
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      windowsHide: true,
      timeout: 15 * 60_000,
      maxBuffer: 256 * 1024,
      env: {
        ...process.env,
        [WINDOWS_STORAGE_RELOCATION_ACL_SOURCE_PATH_ENV]: sourceRoot,
        [WINDOWS_STORAGE_RELOCATION_ACL_TARGET_PATH_ENV]: targetRoot
      }
    }
  )
}

export async function inspectStorageRoot(input: {
  name: StorageRelocationRootName
  homeDir: string
  appOwnedPhysicalPath?: string
}): Promise<StorageRelocationRoot> {
  const logicalPath = storageLogicalRoot(input.name, input.homeDir)
  try {
    const metadata = await lstat(logicalPath)
    const junction = metadata.isSymbolicLink()
    const physicalPath = junction ? await realpath(logicalPath) : logicalPath
    const appOwnedPhysicalPath = input.appOwnedPhysicalPath
      ? await realpath(input.appOwnedPhysicalPath).catch(() => input.appOwnedPhysicalPath!)
      : undefined
    const inventory = await inventoryTree(physicalPath)
    return {
      name: input.name,
      logicalPath,
      physicalPath,
      exists: true,
      junction,
      appOwned: Boolean(
        appOwnedPhysicalPath &&
        comparableNativePath(physicalPath) === comparableNativePath(appOwnedPhysicalPath)
      ),
      ...inventory
    }
  } catch (error) {
    if (String((error as NodeJS.ErrnoException).code) !== 'ENOENT') throw error
    return {
      name: input.name,
      logicalPath,
      physicalPath: logicalPath,
      exists: false,
      junction: false,
      appOwned: false,
      files: 0,
      directories: 0,
      links: 0,
      bytes: 0
    }
  }
}

export async function inventoryTree(rootPath: string): Promise<StorageTreeInventory> {
  const inventory: StorageTreeInventory = { files: 0, directories: 0, links: 0, bytes: 0 }
  const seenFiles = new Set<string>()
  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      inventory.links += 1
      inventory.bytes += metadata.size
      return
    }
    if (metadata.isDirectory()) {
      inventory.directories += 1
      for (const name of (await readdir(path)).sort()) await visit(join(path, name))
      return
    }
    if (!metadata.isFile()) throw new Error(`unsupported storage entry: ${path}`)
    const identity = `${metadata.dev}:${metadata.ino}`
    inventory.files += 1
    if (!seenFiles.has(identity)) {
      seenFiles.add(identity)
      inventory.bytes += metadata.size
    }
  }
  await visit(rootPath)
  return inventory
}

export function uniqueSourceBytes(roots: readonly StorageRelocationRoot[]): number {
  const seen = new Set<string>()
  let total = 0
  for (const root of roots) {
    if (!root.exists) continue
    const comparable = comparableNativePath(root.physicalPath)
    if (seen.has(comparable)) continue
    seen.add(comparable)
    total += root.bytes
  }
  return total
}

export function targetRootPath(destinationRoot: string, name: StorageRelocationRootName): string {
  return join(destinationRoot, name)
}

export function stagingRootPath(
  destinationRoot: string,
  name: StorageRelocationRootName,
  operationId: string
): string {
  return join(destinationRoot, `${name}.storage-staging-${operationId}`)
}

export function backupRootPath(logicalPath: string, operationId: string): string {
  return join(dirname(logicalPath), `${basename(logicalPath)}.storage-backup-${operationId}`)
}

function comparableNativePath(path: string): string {
  const resolved = resolve(path).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}
