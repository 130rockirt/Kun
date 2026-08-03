param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('ResolvePath', 'ResolveSource', 'ResolveUpdateScope', 'ResolveUninstaller', 'StopProcesses', 'Recover', 'Prepare', 'FallbackCleanup', 'Restore', 'ValidatePayload', 'UpdatePath')]
  [string]$Action,
  [string]$ResultPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Get-EnvironmentValue([string]$Name) {
  return [Environment]::GetEnvironmentVariable($Name, 'Process')
}

function Get-CanonicalLeaf {
  $value = (Get-EnvironmentValue 'KUN_INSTALLER_CANONICAL_LEAF').Trim()
  if ([string]::IsNullOrWhiteSpace($value)) {
    return 'Kun'
  }
  if ($value.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
      $value.Contains('\') -or $value.Contains('/')) {
    throw "The canonical application directory leaf is invalid: $value"
  }
  return $value
}

function Test-ProductionInstallerIdentity {
  return [string]::Equals((Get-CanonicalLeaf), 'Kun', [StringComparison]::OrdinalIgnoreCase)
}

function Get-ApplicationIdentityFiles {
  $configured = (Get-EnvironmentValue 'KUN_INSTALLER_APP_EXECUTABLE').Trim()
  $values = @()
  if (-not [string]::IsNullOrWhiteSpace($configured)) {
    $values += $configured
  } else {
    $values += ((Get-CanonicalLeaf) + '.exe')
  }
  if (Test-ProductionInstallerIdentity) {
    $values += @('Kun.exe', 'DeepSeek GUI.exe')
  }
  return @($values | Select-Object -Unique)
}

function Get-AppSpecificUninstallerFiles {
  $configured = (Get-EnvironmentValue 'KUN_INSTALLER_PRODUCT_NAME').Trim()
  $values = @()
  if (-not [string]::IsNullOrWhiteSpace($configured)) {
    $values += ('Uninstall ' + $configured + '.exe')
  } else {
    $values += ('Uninstall ' + (Get-CanonicalLeaf) + '.exe')
  }
  if (Test-ProductionInstallerIdentity) {
    $values += @('Uninstall Kun.exe', 'Uninstall DeepSeek GUI.exe')
  }
  return @($values | Select-Object -Unique)
}

function Write-InstallerDiagnostic([string]$Message) {
  $diagnosticPath = Get-EnvironmentValue 'KUN_INSTALLER_DIAGNOSTIC_PATH'
  if ([string]::IsNullOrWhiteSpace($diagnosticPath)) {
    return
  }

  try {
    $fullPath = [IO.Path]::GetFullPath($diagnosticPath)
    [IO.Directory]::CreateDirectory((Split-Path -Parent $fullPath)) | Out-Null
    [IO.File]::AppendAllText(
      $fullPath,
      ([DateTime]::UtcNow.ToString('o') + ' ' + $Message + [Environment]::NewLine),
      [Text.Encoding]::UTF8
    )
  } catch {
    # Diagnostics are opt-in test evidence and must never change installer behavior.
  }
}

function Normalize-FullPath([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return ''
  }

  $trimmedPath = $PathValue.Trim()
  if (-not [IO.Path]::IsPathRooted($trimmedPath)) {
    throw "Installer paths must be absolute: $trimmedPath"
  }
  $fullPath = [IO.Path]::GetFullPath($trimmedPath)
  $root = [IO.Path]::GetPathRoot($fullPath)
  while ($fullPath.Length -gt $root.Length -and ($fullPath.EndsWith('\') -or $fullPath.EndsWith('/'))) {
    $fullPath = $fullPath.Substring(0, $fullPath.Length - 1)
  }
  return $fullPath
}

function Test-PathEqual([string]$Left, [string]$Right) {
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) {
    return $false
  }
  return [string]::Equals(
    (Normalize-FullPath $Left),
    (Normalize-FullPath $Right),
    [StringComparison]::OrdinalIgnoreCase
  )
}

function Test-PathWithin([string]$PathValue, [string]$RootValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue) -or [string]::IsNullOrWhiteSpace($RootValue)) {
    return $false
  }
  $path = Normalize-FullPath $PathValue
  $root = Normalize-FullPath $RootValue
  return (Test-PathEqual $path $root) -or
    $path.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Test-LegacyLeaf([string]$Leaf) {
  if (-not (Test-ProductionInstallerIdentity)) {
    return $false
  }
  return [string]::Equals($Leaf, 'DeepSeek GUI', [StringComparison]::OrdinalIgnoreCase) -or
    [string]::Equals($Leaf, 'deepseek-gui', [StringComparison]::OrdinalIgnoreCase)
}

function Resolve-LegacySourceTarget([string]$Source) {
  if ([string]::IsNullOrWhiteSpace($Source)) {
    return ''
  }
  $sourceLeaf = Split-Path -Leaf $Source
  $sourceParent = Split-Path -Parent $Source
  $canonicalLeaf = Get-CanonicalLeaf
  if (Test-LegacyLeaf $sourceLeaf) {
    return Join-Path $sourceParent $canonicalLeaf
  }
  if ([string]::Equals($sourceLeaf, $canonicalLeaf, [StringComparison]::OrdinalIgnoreCase) -and
      (Test-LegacyLeaf (Split-Path -Leaf $sourceParent))) {
    return Join-Path (Split-Path -Parent $sourceParent) $canonicalLeaf
  }
  return ''
}

function Resolve-InstallTarget {
  $source = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_SOURCE')
  $candidate = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_CANDIDATE')
  if ([string]::IsNullOrWhiteSpace($candidate)) {
    throw 'The candidate installation path is empty.'
  }

  $candidateIsExplicit = [string]::Equals(
    (Get-EnvironmentValue 'KUN_INSTALLER_CANDIDATE_EXPLICIT'),
    '1',
    [StringComparison]::Ordinal
  )
  if (-not $candidateIsExplicit) {
    $legacySourceTarget = Resolve-LegacySourceTarget $source
    if (-not [string]::IsNullOrWhiteSpace($legacySourceTarget)) {
      return $legacySourceTarget
    }
  }

  $canonicalLeaf = Get-CanonicalLeaf
  $leaf = Split-Path -Leaf $candidate
  $parent = Split-Path -Parent $candidate

  if ([string]::Equals($leaf, $canonicalLeaf, [StringComparison]::OrdinalIgnoreCase)) {
    $parentLeaf = Split-Path -Leaf $parent
    if (Test-LegacyLeaf $parentLeaf) {
      return Join-Path (Split-Path -Parent $parent) $canonicalLeaf
    }
    return $candidate
  }

  if (Test-LegacyLeaf $leaf) {
    return Join-Path $parent $canonicalLeaf
  }

  if (-not [string]::IsNullOrWhiteSpace($source) -and (Test-PathEqual $source $candidate)) {
    return $candidate
  }

  return Join-Path $candidate $canonicalLeaf
}

function Try-NormalizeRegisteredPath([string]$PathValue, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return ''
  }
  try {
    return Normalize-FullPath $PathValue
  } catch {
    Write-InstallerDiagnostic "Ignoring malformed $Label metadata: $($_.Exception.Message)"
    return ''
  }
}

function Get-UninstallCommandSource([string]$UninstallCommand, [string]$Label) {
  $uninstallSource = ''
  if (-not [string]::IsNullOrWhiteSpace($uninstallCommand)) {
    $match = [Text.RegularExpressions.Regex]::Match(
      $uninstallCommand.Trim(),
      '^(?:"(?<path>[^"]+)"|(?<path>.*?\.exe))(?:\s|$)',
      [Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    if ($match.Success) {
      $uninstaller = Try-NormalizeRegisteredPath $match.Groups['path'].Value "$Label uninstall command"
      $leaf = if ([string]::IsNullOrWhiteSpace($uninstaller)) { '' } else { Split-Path -Leaf $uninstaller }
      if (Get-AppSpecificUninstallerFiles | Where-Object {
        [string]::Equals($_, $leaf, [StringComparison]::OrdinalIgnoreCase)
      }) {
        $uninstallSource = Split-Path -Parent $uninstaller
      }
    }
  }
  return $uninstallSource
}

function Resolve-RegisteredInstallSourceValues(
  [string]$SourceValue,
  [string]$UninstallCommand,
  [string]$Label
) {
  $source = Try-NormalizeRegisteredPath $SourceValue "$Label install location"
  $uninstallSource = Get-UninstallCommandSource $UninstallCommand $Label

  $candidates = @()
  if (-not [string]::IsNullOrWhiteSpace($source)) {
    $candidates += $source
    $sourceParent = Split-Path -Parent $source
    if ([string]::Equals((Split-Path -Leaf $source), (Get-CanonicalLeaf), [StringComparison]::OrdinalIgnoreCase) -and
        (Test-LegacyLeaf (Split-Path -Leaf $sourceParent))) {
      $candidates += $sourceParent
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($uninstallSource)) {
    $candidates += $uninstallSource
  }

  foreach ($candidate in @($candidates | Select-Object -Unique)) {
    if (Test-RecoverableApplicationSource $candidate) {
      return $candidate
    }
  }

  # Keep an unverified registered path so Prepare can distinguish an empty or
  # missing stale registration from a non-empty directory that must fail closed.
  if (-not [string]::IsNullOrWhiteSpace($source)) {
    return $source
  }
  if (-not [string]::IsNullOrWhiteSpace($uninstallSource)) {
    return $uninstallSource
  }
  if (-not [string]::IsNullOrWhiteSpace($SourceValue) -or
      -not [string]::IsNullOrWhiteSpace($UninstallCommand)) {
    throw "The $Label registration contains no valid absolute Kun program directory."
  }
  return ''
}

function Resolve-RegisteredInstallSource {
  return Resolve-RegisteredInstallSourceValues `
    (Get-EnvironmentValue 'KUN_INSTALLER_SOURCE') `
    (Get-EnvironmentValue 'KUN_INSTALLER_UNINSTALL_STRING') `
    'selected-scope'
}

function Resolve-AutomaticUpdateScope {
  $runningSource = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_UPDATE_SOURCE')
  if ([string]::IsNullOrWhiteSpace($runningSource)) {
    throw 'The automatic update did not provide its running application directory.'
  }
  Assert-SafeInstallRoot $runningSource 'Running application'
  Assert-RecoverableApplicationSource $runningSource

  $matches = @()
  foreach ($candidate in @(
    @{
      Scope = 'current'
      Source = Get-EnvironmentValue 'KUN_INSTALLER_CURRENT_USER_SOURCE'
      Uninstall = Get-EnvironmentValue 'KUN_INSTALLER_CURRENT_USER_UNINSTALL_STRING'
    },
    @{
      Scope = 'all'
      Source = Get-EnvironmentValue 'KUN_INSTALLER_ALL_USERS_SOURCE'
      Uninstall = Get-EnvironmentValue 'KUN_INSTALLER_ALL_USERS_UNINSTALL_STRING'
    }
  )) {
    try {
      $registeredSource = Resolve-RegisteredInstallSourceValues `
        ([string]$candidate.Source) ([string]$candidate.Uninstall) ($candidate.Scope + '-user')
      if (-not [string]::IsNullOrWhiteSpace($registeredSource) -and
          (Test-PathEqual $registeredSource $runningSource) -and
          (Test-RecoverableApplicationSource $registeredSource)) {
        $matches += $candidate.Scope
      }
    } catch {
      Write-InstallerDiagnostic "Automatic update ignored invalid $($candidate.Scope) registration: $($_.Exception.Message)"
    }
  }

  if ($matches.Count -ne 1) {
    throw "The automatic update source did not match exactly one verified Kun registration: $runningSource"
  }
  return $matches[0]
}

function Resolve-TrustedAppUninstaller {
  $source = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_SOURCE')
  if ([string]::IsNullOrWhiteSpace($source)) {
    return ''
  }
  Assert-SafeInstallRoot $source 'Uninstaller source'
  Assert-RecoverableApplicationSource $source
  foreach ($name in (Get-AppSpecificUninstallerFiles)) {
    $candidate = Join-Path $source $name
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      if (Test-ReparsePoint $candidate) {
        throw "The app-specific uninstaller is a reparse point: $candidate"
      }
      return Normalize-FullPath $candidate
    }
  }
  return ''
}

function Write-InstallerResult([string]$Value) {
  $resultPath = Normalize-FullPath $ResultPath
  if ([string]::IsNullOrWhiteSpace($resultPath)) {
    $resultPath = Join-Path $PSScriptRoot 'kun-windows-installer-result.txt'
  }
  [IO.File]::WriteAllBytes($resultPath, [Text.Encoding]::Unicode.GetBytes($Value))
  Write-InstallerDiagnostic "RESULT path=$resultPath length=$($Value.Length)"
  [Console]::Out.Write($Value)
}

function Write-ResolvedInstallTarget([string]$Target) {
  Write-InstallerResult $Target
}

function Get-JournalPath {
  $journalPath = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_JOURNAL')
  if ([string]::IsNullOrWhiteSpace($journalPath)) {
    throw 'KUN_INSTALLER_JOURNAL is required for migration actions.'
  }
  return $journalPath
}

function Get-NormalizedInstallMode {
  $mode = (Get-EnvironmentValue 'KUN_INSTALLER_INSTALL_MODE').Trim()
  if ([string]::Equals($mode, 'all', [StringComparison]::OrdinalIgnoreCase)) {
    return 'all'
  }
  if ([string]::Equals($mode, 'CurrentUser', [StringComparison]::OrdinalIgnoreCase) -or
      [string]::Equals($mode, 'current', [StringComparison]::OrdinalIgnoreCase)) {
    return 'current'
  }
  throw "KUN_INSTALLER_INSTALL_MODE is invalid: $mode"
}

function Get-JournalAppGuid {
  $appGuid = (Get-EnvironmentValue 'KUN_INSTALLER_APP_GUID').Trim()
  if ([string]::IsNullOrWhiteSpace($appGuid)) {
    throw 'KUN_INSTALLER_APP_GUID is required for recovery journal actions.'
  }
  return $appGuid
}

function Get-JournalTarget {
  $target = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_TARGET')
  if ([string]::IsNullOrWhiteSpace($target)) {
    throw 'KUN_INSTALLER_TARGET is required for recovery journal actions.'
  }
  return $target
}

function Get-JournalAclOwnerSid([string]$Mode) {
  if ($Mode -eq 'all') {
    return [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  }
  return [Security.Principal.WindowsIdentity]::GetCurrent().User
}

function Convert-IdentityToSid([string]$Identity) {
  if ($Identity -match '^S-\d(?:-\d+)+$') {
    return [Security.Principal.SecurityIdentifier]::new($Identity)
  }
  return [Security.Principal.NTAccount]::new($Identity).Translate(
    [Security.Principal.SecurityIdentifier]
  )
}

function Get-FileSystemSecurity([string]$PathValue) {
  $sections = [Security.AccessControl.AccessControlSections]::All
  if ([IO.Directory]::Exists($PathValue)) {
    return [IO.Directory]::GetAccessControl($PathValue, $sections)
  }
  if ([IO.File]::Exists($PathValue)) {
    return [IO.File]::GetAccessControl($PathValue, $sections)
  }
  throw "The ACL target does not exist: $PathValue"
}

function Test-JournalAclSecure([string]$PathValue, [string]$Mode) {
  try {
    if (Test-ReparsePoint $PathValue) {
      return $false
    }
    $security = Get-FileSystemSecurity $PathValue
    $owner = Convert-IdentityToSid $security.Owner
    $expectedOwner = Get-JournalAclOwnerSid $Mode
    $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    if (-not $owner.Equals($expectedOwner) -and -not $owner.Equals($systemSid)) {
      return $false
    }

    $dangerousSids = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')
    $writeRights = [Security.AccessControl.FileSystemRights]::Write -bor
      [Security.AccessControl.FileSystemRights]::Modify -bor
      [Security.AccessControl.FileSystemRights]::FullControl -bor
      [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
      [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $security.GetAccessRules(
      $true,
      $true,
      [Security.Principal.SecurityIdentifier]
    )) {
      if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
          $dangerousSids -contains $rule.IdentityReference.Value -and
          (($rule.FileSystemRights -band $writeRights) -ne 0)) {
        return $false
      }
    }
    return $true
  } catch {
    Write-InstallerDiagnostic "Recovery journal ACL validation failed for ${PathValue}: $($_.Exception.Message)"
    return $false
  }
}

function Set-SecureJournalDirectoryAcl([string]$Directory, [string]$Mode) {
  $ownerSid = Get-JournalAclOwnerSid $Mode
  $administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $security = [Security.AccessControl.DirectorySecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner($ownerSid)
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagation = [Security.AccessControl.PropagationFlags]::None
  foreach ($sid in @($ownerSid, $administratorsSid, $systemSid) | Select-Object -Unique) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      $propagation,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
  }
  [IO.Directory]::SetAccessControl($Directory, $security)
}

function Set-SecureJournalFileAcl([string]$PathValue, [string]$Mode) {
  $ownerSid = Get-JournalAclOwnerSid $Mode
  $administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $security = [Security.AccessControl.FileSecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner($ownerSid)
  foreach ($sid in @($ownerSid, $administratorsSid, $systemSid) | Select-Object -Unique) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
  }
  [IO.File]::SetAccessControl($PathValue, $security)
}

function Assert-JournalStorageTrusted {
  $journalPath = Get-JournalPath
  $journalParent = Split-Path -Parent $journalPath
  $mode = Get-NormalizedInstallMode
  $journalExists = Test-Path -LiteralPath $journalPath -PathType Leaf

  if (Test-Path -LiteralPath $journalParent) {
    if (-not (Test-Path -LiteralPath $journalParent -PathType Container) -or
        (Test-ReparsePoint $journalParent)) {
      throw "The recovery journal directory is not a trusted directory: $journalParent"
    }
    if ($journalExists -and -not (Test-JournalAclSecure $journalParent $mode)) {
      throw "The existing recovery journal directory has an untrusted ACL: $journalParent"
    }
  } else {
    [IO.Directory]::CreateDirectory($journalParent) | Out-Null
  }

  if (-not (Test-JournalAclSecure $journalParent $mode)) {
    Set-SecureJournalDirectoryAcl $journalParent $mode
  }
  if (-not (Test-JournalAclSecure $journalParent $mode)) {
    throw "The recovery journal directory ACL could not be secured: $journalParent"
  }

  if ($journalExists) {
    if (Test-ReparsePoint $journalPath) {
      throw "The recovery journal is a reparse point: $journalPath"
    }
    if (-not (Test-JournalAclSecure $journalPath $mode)) {
      throw "The recovery journal file has an untrusted ACL: $journalPath"
    }
  }
}

function Assert-JournalContext($Journal) {
  $expectedGuid = Get-JournalAppGuid
  $expectedMode = Get-NormalizedInstallMode
  $expectedTarget = Get-JournalTarget
  if ($null -eq $Journal.PSObject.Properties['AppGuid'] -or
      -not [string]::Equals([string]$Journal.AppGuid, $expectedGuid, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The recovery journal application identity does not match this installer.'
  }
  if ($null -eq $Journal.PSObject.Properties['InstallMode'] -or
      -not [string]::Equals([string]$Journal.InstallMode, $expectedMode, [StringComparison]::Ordinal)) {
    throw 'The recovery journal installation mode does not match this installer transaction.'
  }
  if ($null -eq $Journal.PSObject.Properties['Target'] -or
      -not (Test-PathEqual ([string]$Journal.Target) $expectedTarget)) {
    throw 'The recovery journal target does not match this installer transaction.'
  }
}

function Write-Journal([hashtable]$Journal) {
  Assert-JournalStorageTrusted
  $journalPath = Get-JournalPath
  $temporaryPath = "$journalPath.tmp"
  if (Test-Path -LiteralPath $temporaryPath) {
    Remove-Item -LiteralPath $temporaryPath -Force
  }
  $Journal.SchemaVersion = 3
  $Journal.AppGuid = Get-JournalAppGuid
  $Journal.InstallMode = Get-NormalizedInstallMode
  $Journal.Target = Get-JournalTarget
  $Journal.UpdatedAt = [DateTime]::UtcNow.ToString('o')
  $Journal | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
  Move-Item -LiteralPath $temporaryPath -Destination $journalPath -Force
  Set-SecureJournalFileAcl $journalPath (Get-NormalizedInstallMode)
}

function Read-Journal {
  $journalPath = Get-JournalPath
  if (-not (Test-Path -LiteralPath $journalPath -PathType Leaf)) {
    return $null
  }
  Assert-JournalStorageTrusted
  $journal = Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
  Assert-JournalContext $journal
  return $journal
}

function Remove-Journal {
  $journalPath = Get-JournalPath
  if (Test-Path -LiteralPath $journalPath) {
    Assert-JournalStorageTrusted
    Remove-Item -LiteralPath $journalPath -Force
  }
  $parent = Split-Path -Parent $journalPath
  if (Test-Path -LiteralPath $parent -PathType Container) {
    $remaining = @(Get-ChildItem -LiteralPath $parent -Force)
    if ($remaining.Count -eq 0) {
      Remove-Item -LiteralPath $parent -Force
    }
  }
}

function Get-PathHash([string]$PathValue) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes((Normalize-FullPath $PathValue).ToLowerInvariant())
    $hash = $sha.ComputeHash($bytes)
    return ([BitConverter]::ToString($hash).Replace('-', '').Substring(0, 16)).ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-PreservationRoot([string]$Source) {
  $parent = Split-Path -Parent $Source
  return Join-Path $parent ('.kun-installer-preserved-' + (Get-PathHash $Source))
}

function Test-ReparsePoint([string]$PathValue) {
  if (-not (Test-Path -LiteralPath $PathValue)) {
    return $false
  }
  $item = Get-Item -LiteralPath $PathValue -Force
  return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Get-UnsafeRoots {
  $userPrograms = $null
  if ($env:LOCALAPPDATA) {
    $userPrograms = Join-Path $env:LOCALAPPDATA 'Programs'
  }
  $candidates = @(
    $env:USERPROFILE,
    $env:LOCALAPPDATA,
    $env:APPDATA,
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)},
    $env:ProgramW6432,
    $env:WINDIR,
    $env:SystemRoot,
    $env:TEMP,
    $userPrograms
  )

  return @($candidates | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object {
    Normalize-FullPath $_
  } | Select-Object -Unique)
}

function Assert-NoReparsePathComponents([string]$PathValue, [string]$Label) {
  $current = Normalize-FullPath $PathValue
  while (-not [string]::IsNullOrWhiteSpace($current)) {
    if ((Test-Path -LiteralPath $current) -and (Test-ReparsePoint $current)) {
      throw "$Label path contains a reparse point: $current"
    }
    $parent = Split-Path -Parent $current
    if ([string]::IsNullOrWhiteSpace($parent) -or (Test-PathEqual $parent $current)) {
      break
    }
    $current = $parent
  }
}

function Assert-NoReparsePointsInTree([IO.FileSystemInfo]$Entry, [string]$Label) {
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($Entry.FullName)
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    if (Test-ReparsePoint $current) {
      throw "$Label contains a reparse point: $current"
    }
    if (-not (Test-Path -LiteralPath $current -PathType Container)) {
      continue
    }
    foreach ($child in @(Get-ChildItem -LiteralPath $current -Force)) {
      if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label contains a reparse point: $($child.FullName)"
      }
      if ($child.PSIsContainer) {
        $pending.Push($child.FullName)
      }
    }
  }
}

function Assert-SafeInstallRoot([string]$PathValue, [string]$Label) {
  $normalized = Normalize-FullPath $PathValue
  if ([string]::IsNullOrWhiteSpace($normalized)) {
    return
  }

  if (Test-PathEqual $normalized ([IO.Path]::GetPathRoot($normalized))) {
    throw "$Label path is a shared or protected root: $normalized"
  }

  foreach ($unsafe in (Get-UnsafeRoots)) {
    if (Test-PathEqual $normalized $unsafe) {
      throw "$Label path is a shared or protected root: $normalized"
    }
  }

  foreach ($systemRoot in @($env:WINDIR, $env:SystemRoot)) {
    if (-not [string]::IsNullOrWhiteSpace($systemRoot) -and (Test-PathWithin $normalized $systemRoot)) {
      throw "$Label path is inside a Windows system directory: $normalized"
    }
  }

  Assert-NoReparsePathComponents $normalized $Label
}

function Assert-TargetVolumeReadyAndWritable([string]$Target) {
  $targetPath = Normalize-FullPath $Target
  $root = [IO.Path]::GetPathRoot($targetPath)
  if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root -PathType Container)) {
    throw "The target volume is unavailable: $root"
  }

  if ($root -match '^[A-Za-z]:\\$') {
    try {
      $drive = [IO.DriveInfo]::new($root)
      if (-not $drive.IsReady) {
        throw "The target volume is not ready: $root"
      }
    } catch {
      throw "The target volume is not ready: $root. $($_.Exception.Message)"
    }
  }

  $probeDirectory = $targetPath
  while (-not (Test-Path -LiteralPath $probeDirectory)) {
    $parent = Split-Path -Parent $probeDirectory
    if ([string]::IsNullOrWhiteSpace($parent) -or (Test-PathEqual $parent $probeDirectory)) {
      throw "No existing target directory is available for a write probe: $targetPath"
    }
    $probeDirectory = $parent
  }
  if (-not (Test-Path -LiteralPath $probeDirectory -PathType Container)) {
    throw "The nearest existing target ancestor is not a directory: $probeDirectory"
  }

  $probePath = Join-Path $probeDirectory ('.kun-installer-write-probe-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  try {
    $stream = [IO.File]::Open(
      $probePath,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None
    )
    $stream.Dispose()
    Remove-Item -LiteralPath $probePath -Force
  } catch {
    if (Test-Path -LiteralPath $probePath) {
      Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
    }
    throw "The target directory is not writable: $probeDirectory. $($_.Exception.Message)"
  }
}

function Test-KnownApplicationEntry([IO.FileSystemInfo]$Entry) {
  if ($Entry.PSIsContainer) {
    return @('resources', 'locales', 'bin') -contains $Entry.Name.ToLowerInvariant()
  }

  $knownFiles = @(@(
    Get-ApplicationIdentityFiles
    Get-AppSpecificUninstallerFiles
  ) | ForEach-Object { $_.ToLowerInvariant() }) + @(
    'uninstallericon.ico',
    'chrome_100_percent.pak',
    'chrome_200_percent.pak',
    'd3dcompiler_47.dll',
    'dxcompiler.dll',
    'dxil.dll',
    'ffmpeg.dll',
    'icudtl.dat',
    'libegl.dll',
    'libglesv2.dll',
    'license.electron.txt',
    'licenses.chromium.html',
    'resources.pak',
    'snapshot_blob.bin',
    'v8_context_snapshot.bin',
    'vk_swiftshader.dll',
    'vk_swiftshader_icd.json',
    'vulkan-1.dll'
  )
  return $knownFiles -contains $Entry.Name.ToLowerInvariant()
}

function Get-ExtendedLengthPath([string]$PathValue) {
  $normalized = Normalize-FullPath $PathValue
  if ($normalized.StartsWith('\\')) {
    return '\\?\UNC\' + $normalized.Substring(2)
  }
  return '\\?\' + $normalized
}

function Remove-KnownApplicationEntry([IO.FileSystemInfo]$Entry) {
  if ($Entry.PSIsContainer -and (Test-ReparsePoint $Entry.FullName)) {
    throw "Recognized application directory is a reparse point: $($Entry.FullName)"
  }

  try {
    Remove-Item -LiteralPath $Entry.FullName -Recurse -Force
    return
  } catch {
    if (-not (Test-Path -LiteralPath $Entry.FullName)) {
      return
    }
  }

  $extendedPath = Get-ExtendedLengthPath $Entry.FullName
  if ($Entry.PSIsContainer) {
    [IO.Directory]::Delete($extendedPath, $true)
  } else {
    [IO.File]::SetAttributes($extendedPath, [IO.FileAttributes]::Normal)
    [IO.File]::Delete($extendedPath)
  }
}

function Test-AppOwnedProcessPath([string]$ExecutablePath, [string[]]$Roots) {
  if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
    return $false
  }

  $fullExecutable = Normalize-FullPath $ExecutablePath
  foreach ($rootValue in $Roots) {
    if ([string]::IsNullOrWhiteSpace($rootValue)) {
      continue
    }
    $root = Normalize-FullPath $rootValue
    $relative = $fullExecutable.Substring([Math]::Min($root.Length, $fullExecutable.Length)).TrimStart('\', '/')
    $isUnderRoot = $fullExecutable.Length -gt $root.Length -and
      $fullExecutable.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)
    if (-not $isUnderRoot) {
      continue
    }

    $relativeLower = $relative.ToLowerInvariant()
    $identityMatch = Get-ApplicationIdentityFiles | Where-Object {
      [string]::Equals($_, $relative, [StringComparison]::OrdinalIgnoreCase)
    }
    if ($identityMatch -or
        $relativeLower.StartsWith('resources\') -or $relativeLower.StartsWith('bin\')) {
      return $true
    }
  }
  return $false
}

function Stop-AppProcesses([string[]]$Roots) {
  $currentPidValue = Get-EnvironmentValue 'KUN_INSTALLER_SELF_PID'
  $currentPid = 0
  [void][int]::TryParse($currentPidValue, [ref]$currentPid)

  for ($attempt = 0; $attempt -lt 6; $attempt += 1) {
    $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.ProcessId -ne $currentPid -and (Test-AppOwnedProcessPath $_.ExecutablePath $Roots)
    })
    if ($processes.Count -eq 0) {
      return
    }

    foreach ($process in $processes) {
      & "$env:SystemRoot\System32\taskkill.exe" /PID $process.ProcessId /T /F | Out-Null
    }
    Start-Sleep -Milliseconds 500
  }

  $remaining = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $currentPid -and (Test-AppOwnedProcessPath $_.ExecutablePath $Roots)
  })
  if ($remaining.Count -gt 0) {
    throw ('Unable to stop application processes: ' + (($remaining | ForEach-Object { $_.ProcessId }) -join ', '))
  }
}

function Stop-InstallRootProcesses {
  $root = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_APP_ROOT')
  if ([string]::IsNullOrWhiteSpace($root)) {
    return
  }
  Assert-SafeInstallRoot $root 'Application root'
  Stop-AppProcesses @($root)
}

function Test-ApplicationSourceIdentity([string]$Source) {
  if ([string]::IsNullOrWhiteSpace($Source) -or
      -not (Test-Path -LiteralPath $Source -PathType Container)) {
    return $false
  }
  $identityFiles = Get-ApplicationIdentityFiles
  return [bool]($identityFiles | Where-Object {
    Test-Path -LiteralPath (Join-Path $Source $_) -PathType Leaf
  })
}

function Assert-ApplicationSourceIdentity([string]$Source) {
  if (-not (Test-ApplicationSourceIdentity $Source)) {
    throw "The registered source has no application identity executable: $Source"
  }
}

function Test-PackagedApplicationPayload([string]$Source) {
  if ([string]::IsNullOrWhiteSpace($Source)) {
    return $false
  }
  $packagedPayload = Join-Path (Join-Path $Source 'resources') 'app.asar'
  return (Test-Path -LiteralPath $packagedPayload -PathType Leaf)
}

function Assert-PackagedApplicationPayload([string]$Source) {
  if (-not (Test-PackagedApplicationPayload $Source)) {
    throw "The external current-user installation source is not a recognized packaged Kun installation: $Source"
  }
}

function Get-ExpectedApplicationExecutable {
  $configured = (Get-EnvironmentValue 'KUN_INSTALLER_APP_EXECUTABLE').Trim()
  $executable = if ([string]::IsNullOrWhiteSpace($configured)) {
    (Get-CanonicalLeaf) + '.exe'
  } else {
    $configured
  }
  if ([string]::IsNullOrWhiteSpace($executable) -or
      -not [string]::Equals([IO.Path]::GetFileName($executable), $executable, [StringComparison]::Ordinal) -or
      $executable.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) {
    throw "The configured application executable is invalid: $executable"
  }
  return $executable
}

function Assert-NonEmptyPayloadFile([string]$PathValue, [string]$Label) {
  if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) {
    throw "The installed Kun payload is missing ${Label}: $PathValue"
  }

  $item = Get-Item -LiteralPath $PathValue -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "The installed Kun payload must not use a reparse point for ${Label}: $PathValue"
  }
  if ($item.Length -le 0) {
    throw "The installed Kun payload is empty for ${Label}: $PathValue"
  }
}

function Assert-PackagedInstallPayload {
  $target = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_TARGET')
  if ([string]::IsNullOrWhiteSpace($target)) {
    throw 'The installed Kun payload target is not configured.'
  }
  Assert-SafeInstallRoot $target 'Installed application root'
  if (-not (Test-Path -LiteralPath $target -PathType Container)) {
    throw "The installed Kun payload directory is missing: $target"
  }

  Assert-NonEmptyPayloadFile (Join-Path $target (Get-ExpectedApplicationExecutable)) 'the application executable'
  Assert-NonEmptyPayloadFile (Join-Path $target 'resources\app.asar') 'resources\app.asar'
  Assert-NonEmptyPayloadFile (
    Join-Path $target 'resources\app.asar.unpacked\kun\dist\cli\serve-entry.js'
  ) 'the unpacked Kun runtime entry'
  Assert-NonEmptyPayloadFile (
    Join-Path $target 'resources\app.asar.unpacked\kun\dist\manager\manager-entry.js'
  ) 'the unpacked Kun service manager entry'
}

function Test-AppSpecificUninstaller([string]$Source) {
  if ([string]::IsNullOrWhiteSpace($Source)) {
    return $false
  }
  return [bool](Get-AppSpecificUninstallerFiles | Where-Object {
    Test-Path -LiteralPath (Join-Path $Source $_) -PathType Leaf
  })
}

function Test-RecoverableApplicationSource([string]$Source) {
  if (Test-ApplicationSourceIdentity $Source) {
    return $true
  }
  return (Test-AppSpecificUninstaller $Source) -and (Test-PackagedApplicationPayload $Source)
}

function Assert-RecoverableApplicationSource([string]$Source) {
  if (-not (Test-RecoverableApplicationSource $Source)) {
    throw (
      "The registered source contains files but is not a verifiable Kun installation: $Source. " +
      'No files or registration were changed.'
    )
  }
}

function Assert-TrustedSecondarySource([string]$Source) {
  $profile = Normalize-FullPath $env:USERPROFILE
  if (-not [string]::IsNullOrWhiteSpace($profile) -and (Test-PathWithin $Source $profile) -and
      -not (Test-PathEqual $Source $profile)) {
    return
  }

  Assert-SafeInstallRoot $Source 'External current-user installation source'
  if (@(Get-ChildItem -LiteralPath $Source -Force).Count -eq 0) {
    return
  }
  Assert-RecoverableApplicationSource $Source
  Assert-PackagedApplicationPayload $Source
}

function Get-InstallSources(
  [bool]$ValidateSecondary = $true,
  [bool]$IncludeMissingSecondary = $false
) {
  $primary = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_SOURCE')
  $secondary = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_SECONDARY_SOURCE')
  if (-not [string]::IsNullOrWhiteSpace($secondary)) {
    if (-not (Test-Path -LiteralPath $secondary)) {
      Write-InstallerDiagnostic "Ignoring missing current-user installation source: $secondary"
      if (-not $IncludeMissingSecondary) {
        $secondary = ''
      }
    } elseif (-not (Test-Path -LiteralPath $secondary -PathType Container)) {
      throw "The current-user installation source exists but is not a directory: $secondary"
    } elseif ($ValidateSecondary) {
      Assert-TrustedSecondarySource $secondary
    }
  }
  $sources = @($primary, $secondary)
  $normalizedSources = @()
  foreach ($sourceValue in $sources) {
    $source = Normalize-FullPath $sourceValue
    if ([string]::IsNullOrWhiteSpace($source)) {
      continue
    }
    if (-not ($normalizedSources | Where-Object { Test-PathEqual $_ $source })) {
      $normalizedSources += $source
    }
  }
  return $normalizedSources
}

function Get-JournalRecords($Journal) {
  if ($null -ne $Journal.PSObject.Properties['Records']) {
    return @($Journal.Records)
  }
  if ($null -ne $Journal.PSObject.Properties['Stash']) {
    return @($Journal)
  }
  throw 'The preservation journal contains no recovery records.'
}

function Get-ValidatedJournalRecord($Record) {
  $source = Normalize-FullPath ([string]$Record.Source)
  $target = Normalize-FullPath ([string]$Record.Target)
  $stash = Normalize-FullPath ([string]$Record.Stash)
  $destination = Normalize-FullPath ([string]$Record.RestoreDestination)
  if ([string]::IsNullOrWhiteSpace($source) -or [string]::IsNullOrWhiteSpace($target) -or
      [string]::IsNullOrWhiteSpace($stash) -or [string]::IsNullOrWhiteSpace($destination)) {
    throw 'The preservation journal contains an empty path.'
  }

  Assert-SafeInstallRoot $source 'Journal source'
  Assert-SafeInstallRoot $target 'Journal target'
  if (-not (Test-PathEqual $target (Get-JournalTarget))) {
    throw "The preservation journal record target does not match the current transaction: $target"
  }
  if (-not (Test-PathEqual $stash (Get-PreservationRoot $source))) {
    throw "The preservation journal references an unexpected recovery directory: $stash"
  }
  if (-not (Test-PathEqual $destination $source) -and -not (Test-PathEqual $destination $target)) {
    throw "The preservation journal references an unexpected restore destination: $destination"
  }
  if (Test-ReparsePoint $stash) {
    throw "The preservation directory is a reparse point: $stash"
  }
  $content = Join-Path $stash 'content'
  if (Test-ReparsePoint $content) {
    throw "The preservation content directory is a reparse point: $content"
  }

  return @{
    Source = $source
    Target = $target
    RestoreDestination = $destination
    Stash = $stash
    Content = $content
  }
}

function Invoke-RestoreJournal {
  $journal = Read-Journal
  if ($null -eq $journal) {
    return
  }

  $remainingRecords = @()
  foreach ($recordValue in (Get-JournalRecords $journal)) {
    $record = Get-ValidatedJournalRecord $recordValue
    if (-not (Test-Path -LiteralPath $record.Content -PathType Container)) {
      if (Test-Path -LiteralPath $record.Stash) {
        Remove-Item -LiteralPath $record.Stash -Recurse -Force
      }
      continue
    }

    Assert-SafeInstallRoot $record.RestoreDestination 'Restore destination'
    [IO.Directory]::CreateDirectory($record.RestoreDestination) | Out-Null
    $collisions = @()
    foreach ($entry in @(Get-ChildItem -LiteralPath $record.Content -Force)) {
      $destinationEntry = Join-Path $record.RestoreDestination $entry.Name
      if (Test-Path -LiteralPath $destinationEntry) {
        $collisions += $entry.Name
        continue
      }
      Move-Item -LiteralPath $entry.FullName -Destination $destinationEntry
    }

    if ($collisions.Count -gt 0) {
      $remainingRecords += @{
        Source = $record.Source
        Target = $record.Target
        RestoreDestination = $record.RestoreDestination
        Stash = $record.Stash
        Entries = $collisions
      }
    } else {
      Remove-Item -LiteralPath $record.Stash -Recurse -Force
    }
  }

  if ($remainingRecords.Count -gt 0) {
    $updated = @{
      SchemaVersion = 3
      Phase = 'restore-conflict'
      Records = $remainingRecords
    }
    Write-Journal $updated
    $collisionNames = @($remainingRecords | ForEach-Object { $_['Entries'] })
    throw ('Preserved install content conflicts with existing paths: ' + ($collisionNames -join ', '))
  }

  Remove-Journal
}

function Invoke-Prepare {
  Invoke-RestoreJournal

  $primarySource = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_SOURCE')
  $secondarySource = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_SECONDARY_SOURCE')
  $registeredSources = @(Get-InstallSources $true $true)
  $sources = @()
  [int]$staleSourceMask = 0
  $target = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_TARGET')
  if ([string]::IsNullOrWhiteSpace($target)) {
    throw 'KUN_INSTALLER_TARGET is required.'
  }

  Assert-SafeInstallRoot $target 'Target'
  if ((Test-Path -LiteralPath $target) -and -not (Test-Path -LiteralPath $target -PathType Container)) {
    throw "The target exists but is not a directory: $target"
  }
  Assert-TargetVolumeReadyAndWritable $target
  foreach ($source in $registeredSources) {
    Assert-SafeInstallRoot $source 'Source'
    if (-not (Test-Path -LiteralPath $source)) {
      if (Test-PathEqual $source $primarySource) {
        $staleSourceMask = $staleSourceMask -bor 1
      }
      if (Test-PathEqual $source $secondarySource) {
        $staleSourceMask = $staleSourceMask -bor 2
      }
      continue
    }
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
      throw "The registered source exists but is not a directory: $source"
    }

    $entries = @(Get-ChildItem -LiteralPath $source -Force)
    if ($entries.Count -eq 0) {
      if (Test-PathEqual $source $primarySource) {
        $staleSourceMask = $staleSourceMask -bor 1
      }
      if (Test-PathEqual $source $secondarySource) {
        $staleSourceMask = $staleSourceMask -bor 2
      }
      continue
    }

    Assert-RecoverableApplicationSource $source
    $sources += $source
  }

  $targetIsSource = $sources | Where-Object { Test-PathEqual $_ $target }
  if (-not $targetIsSource -and (Test-Path -LiteralPath $target -PathType Container)) {
    $targetEntries = @(Get-ChildItem -LiteralPath $target -Force)
    if ($targetEntries.Count -gt 0) {
      throw "The canonical target already contains files and cannot be merged safely: $target"
    }
  }

  $preparedSources = @()
  foreach ($source in $sources) {
    $entries = @(Get-ChildItem -LiteralPath $source -Force)
    if (-not ($entries | Where-Object { Test-KnownApplicationEntry $_ })) {
      throw "The registered source has no recognized application payload: $source"
    }
    $knownDirectories = @($entries | Where-Object {
      $_.PSIsContainer -and (Test-KnownApplicationEntry $_)
    })
    foreach ($directory in $knownDirectories) {
      Assert-NoReparsePointsInTree $directory 'Recognized application directory'
    }
    $unknown = @($entries | Where-Object { -not (Test-KnownApplicationEntry $_) })
    $stash = Get-PreservationRoot $source
    if ($unknown.Count -gt 0) {
      if (Test-Path -LiteralPath $stash) {
        throw "A preservation directory already exists without a recoverable journal: $stash"
      }
    }
    $preparedSources += @{
      Source = $source
      Stash = $stash
      Unknown = $unknown
    }
  }

  Stop-AppProcesses @($sources + $target)

  $journal = @{
    SchemaVersion = 3
    Phase = 'preserving'
    Records = @()
  }
  foreach ($set in $preparedSources) {
    $record = @{
      Source = $set.Source
      Target = $target
      RestoreDestination = if (Test-PathEqual $set.Source $target) { $target } else { $set.Source }
      Stash = $set.Stash
      Entries = @($set.Unknown | ForEach-Object { $_.Name })
    }
    $journal.Records += $record
    Write-Journal $journal
    if ($set.Unknown.Count -eq 0) {
      continue
    }
    $content = Join-Path $set.Stash 'content'
    [IO.Directory]::CreateDirectory($content) | Out-Null
    $stashItem = Get-Item -LiteralPath $set.Stash -Force
    $stashItem.Attributes = $stashItem.Attributes -bor [IO.FileAttributes]::Hidden
    foreach ($entry in $set.Unknown) {
      Move-Item -LiteralPath $entry.FullName -Destination (Join-Path $content $entry.Name)
    }
  }

  $journal.Phase = 'preserved'
  if ($journal.Records.Count -gt 0) {
    Write-Journal $journal
  }
  Write-InstallerResult ([string]$staleSourceMask)
}

function Assert-FallbackCleanupSource([string]$Source) {
  $journal = Read-Journal
  if ($null -ne $journal) {
    $matchesJournal = Get-JournalRecords $journal | Where-Object {
      Test-PathEqual ([string]$_.Source) $Source
    }
    if ($matchesJournal) {
      return
    }
    throw "The cleanup source does not match the preservation journal: $Source"
  }

  $target = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_TARGET')
  if (-not (Test-PathEqual $Source $target)) {
    throw "The cleanup source has no preservation journal and does not match the install target: $Source"
  }
  Assert-ApplicationSourceIdentity $Source
}

function Invoke-FallbackCleanup {
  $source = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_SOURCE')
  if ([string]::IsNullOrWhiteSpace($source) -or -not (Test-Path -LiteralPath $source -PathType Container)) {
    return
  }
  Assert-SafeInstallRoot $source 'Source'
  Assert-FallbackCleanupSource $source

  $knownEntries = @(Get-ChildItem -LiteralPath $source -Force | Where-Object {
    Test-KnownApplicationEntry $_
  })
  foreach ($entry in $knownEntries) {
    if ($entry.PSIsContainer) {
      Assert-NoReparsePointsInTree $entry 'Recognized application directory'
    }
  }
  foreach ($entry in $knownEntries) {
    Remove-KnownApplicationEntry $entry
  }

  if (@(Get-ChildItem -LiteralPath $source -Force).Count -eq 0) {
    Remove-Item -LiteralPath $source -Force
  }
}

function Remove-EmptyLegacyContainers {
  $candidates = @()
  $primary = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_SOURCE')
  $secondary = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_SECONDARY_SOURCE')
  $primaryIsStale = [string]::Equals(
    (Get-EnvironmentValue 'KUN_INSTALLER_PRIMARY_SOURCE_STALE'),
    '1',
    [StringComparison]::Ordinal
  )
  $secondaryIsStale = [string]::Equals(
    (Get-EnvironmentValue 'KUN_INSTALLER_SECONDARY_SOURCE_STALE'),
    '1',
    [StringComparison]::Ordinal
  )
  # Prepare performs the positive secondary-source validation before cleanup.
  # Restore can run after the packaged payload has already been removed.
  foreach ($source in @(Get-InstallSources $false)) {
    if (($primaryIsStale -and (Test-PathEqual $source $primary)) -or
        ($secondaryIsStale -and (Test-PathEqual $source $secondary))) {
      continue
    }
    $candidates += $source
    $parent = Split-Path -Parent $source
    if (Test-LegacyLeaf (Split-Path -Leaf $parent)) {
      $candidates += $parent
    }
  }

  foreach ($candidate in @($candidates | Select-Object -Unique)) {
    if ((Test-Path -LiteralPath $candidate -PathType Container) -and
        @(Get-ChildItem -LiteralPath $candidate -Force).Count -eq 0) {
      Assert-SafeInstallRoot $candidate 'Empty legacy container'
      Remove-Item -LiteralPath $candidate -Force
    }
  }
}

function Update-UserPath {
  # Missing secondary sources do not participate in filesystem migration, but
  # their stale bin entries should still be removed from the user PATH.
  $sources = @(Get-InstallSources $false $true)
  $target = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_TARGET')
  if ([string]::IsNullOrWhiteSpace($target)) {
    throw 'KUN_INSTALLER_TARGET is required for PATH reconciliation.'
  }

  $pathSources = @()
  foreach ($source in $sources) {
    $pathSources += $source
    if (Test-LegacyLeaf (Split-Path -Leaf $source)) {
      # Older assisted installers could register or add PATH for the falsely
      # nested child even though the application payload lived in the parent.
      $pathSources += Join-Path $source (Get-CanonicalLeaf)
    }
  }
  $sourceBins = @($pathSources | Select-Object -Unique | ForEach-Object { Join-Path $_ 'bin' })
  $targetBin = Join-Path $target 'bin'
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($current -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  $kept = @($parts | Where-Object {
    $candidatePart = $_.TrimEnd('\')
    $isSourceBin = $sourceBins | Where-Object {
      [string]::Equals($candidatePart, $_.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
    }
    -not $isSourceBin -and
      -not [string]::Equals($candidatePart, $targetBin.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
  })
  [Environment]::SetEnvironmentVariable('Path', (($kept + $targetBin) -join ';'), 'User')
}

try {
  Write-InstallerDiagnostic (
    "START action=$Action source=$(Get-EnvironmentValue 'KUN_INSTALLER_SOURCE') " +
    "target=$(Get-EnvironmentValue 'KUN_INSTALLER_TARGET') " +
    "journal=$(Get-EnvironmentValue 'KUN_INSTALLER_JOURNAL')"
  )
  switch ($Action) {
    'ResolvePath' {
      Write-ResolvedInstallTarget (Resolve-InstallTarget)
    }
    'ResolveSource' {
      Write-ResolvedInstallTarget (Resolve-RegisteredInstallSource)
    }
    'ResolveUpdateScope' {
      Write-InstallerResult (Resolve-AutomaticUpdateScope)
    }
    'ResolveUninstaller' {
      Write-InstallerResult (Resolve-TrustedAppUninstaller)
    }
    'StopProcesses' {
      Stop-InstallRootProcesses
    }
    'Recover' {
      Invoke-RestoreJournal
    }
    'Prepare' {
      Invoke-Prepare
    }
    'FallbackCleanup' {
      Invoke-FallbackCleanup
    }
    'Restore' {
      Invoke-RestoreJournal
      Remove-EmptyLegacyContainers
    }
    'ValidatePayload' {
      Assert-PackagedInstallPayload
    }
    'UpdatePath' {
      Update-UserPath
    }
  }
  Write-InstallerDiagnostic "SUCCESS action=$Action"
} catch {
  Write-InstallerDiagnostic "FAIL action=$Action error=$($_.Exception.Message)"
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
