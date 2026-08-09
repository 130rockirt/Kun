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
  # Journal trust only depends on the owner and DACL. Requesting All would
  # also read the SACL/Audit section, which ordinary user accounts cannot
  # inspect without SeSecurityPrivilege.
  $sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
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
