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

function Get-JournalTransactionPaths {
  $paths = @()
  foreach ($name in @(
    'KUN_INSTALLER_SOURCE',
    'KUN_INSTALLER_SECONDARY_SOURCE',
    'KUN_INSTALLER_TARGET'
  )) {
    $value = Get-EnvironmentValue $name
    if ([string]::IsNullOrWhiteSpace($value)) {
      continue
    }
    $normalized = Normalize-FullPath $value
    if (-not ($paths | Where-Object { Test-PathEqual $_ $normalized })) {
      $paths += $normalized
    }
  }
  return $paths
}

function Test-JournalPreservationRootBlocksRecovery([string]$Root) {
  if (-not (Test-Path -LiteralPath $Root)) {
    return $false
  }
  if (-not (Test-Path -LiteralPath $Root -PathType Container) -or
      (Test-ReparsePoint $Root)) {
    return $true
  }

  $entries = @(Get-ChildItem -LiteralPath $Root -Force)
  if ($entries | Where-Object {
    -not [string]::Equals($_.Name, 'content', [StringComparison]::OrdinalIgnoreCase)
  }) {
    return $true
  }
  $content = Join-Path $Root 'content'
  if (-not (Test-Path -LiteralPath $content)) {
    return $false
  }
  if (-not (Test-Path -LiteralPath $content -PathType Container) -or
      (Test-ReparsePoint $content)) {
    return $true
  }
  return (@(Get-ChildItem -LiteralPath $content -Force).Count -gt 0)
}

function Get-ExistingJournalPreservationRoots {
  $blockingRoots = @()
  foreach ($source in @(Get-JournalTransactionPaths)) {
    $root = Get-PreservationRoot $source
    if ((Test-JournalPreservationRootBlocksRecovery $root) -and
        -not ($blockingRoots | Where-Object { Test-PathEqual $_ $root })) {
      $blockingRoots += $root
    }
  }
  return $blockingRoots
}

function Remove-EmptyJournalPreservationRoots {
  foreach ($source in @(Get-JournalTransactionPaths)) {
    $root = Get-PreservationRoot $source
    if ((Test-Path -LiteralPath $root) -and
        -not (Test-JournalPreservationRootBlocksRecovery $root)) {
      Assert-SafeInstallRoot $root 'Empty preservation directory'
      Remove-Item -LiteralPath $root -Recurse -Force
      Write-InstallerDiagnostic "Removed an empty preservation directory at: $root"
    }
  }
}

function Move-UntrustedJournalToQuarantine([string]$PathValue, [string]$Mode) {
  $preservationRoots = @(Get-ExistingJournalPreservationRoots)
  if ($preservationRoots.Count -gt 0) {
    throw (
      'The recovery journal has untrusted permissions while preserved installation files still exist at: ' +
      ($preservationRoots -join ', ') + '. The journal and preserved files were left unchanged.'
    )
  }
  Remove-EmptyJournalPreservationRoots
  if (Test-ReparsePoint $PathValue) {
    throw "The recovery journal is a reparse point and cannot be quarantined: $PathValue"
  }

  $quarantinePath = "$PathValue.untrusted-$([Guid]::NewGuid().ToString('N'))"
  [IO.File]::Move($PathValue, $quarantinePath)
  Write-InstallerDiagnostic "Quarantined an untrusted recovery journal at: $quarantinePath"

  $parent = Split-Path -Parent $PathValue
  if (-not (Test-JournalAclSecure $parent $Mode)) {
    Set-SecureJournalDirectoryAcl $parent $Mode
  }
  if (-not (Test-JournalAclSecure $parent $Mode)) {
    throw "The recovery journal directory ACL could not be secured after quarantine: $parent"
  }
  # Never read or mutate the quarantined file again. It could be a hard link
  # supplied through the previously writable directory, so changing its ACL
  # could affect a different file on the same volume.
}

function Assert-JournalStorageTrusted {
  $journalPath = Get-JournalPath
  $journalParent = Split-Path -Parent $journalPath
  $mode = Get-NormalizedInstallMode
  $journalExists = Test-Path -LiteralPath $journalPath -PathType Leaf

  if ((Test-Path -LiteralPath $journalPath) -and -not $journalExists) {
    throw "The recovery journal path is not a regular file: $journalPath"
  }

  if (Test-Path -LiteralPath $journalParent) {
    if (-not (Test-Path -LiteralPath $journalParent -PathType Container) -or
        (Test-ReparsePoint $journalParent)) {
      throw "The recovery journal directory is not a trusted directory: $journalParent"
    }
    if ($journalExists -and -not (Test-JournalAclSecure $journalParent $mode)) {
      Move-UntrustedJournalToQuarantine $journalPath $mode
      $journalExists = $false
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

  # Re-evaluate the fixed journal path only after the parent DACL is secured.
  # An untrusted writer could have recreated it between quarantine and lockdown.
  $journalExists = Test-Path -LiteralPath $journalPath -PathType Leaf
  if ((Test-Path -LiteralPath $journalPath) -and -not $journalExists) {
    throw "The recovery journal path is not a regular file: $journalPath"
  }
  if ($journalExists) {
    if (Test-ReparsePoint $journalPath) {
      throw "The recovery journal is a reparse point: $journalPath"
    }
    if (-not (Test-JournalAclSecure $journalPath $mode)) {
      Move-UntrustedJournalToQuarantine $journalPath $mode
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

function Convert-LegacyJournal($Journal) {
  $schemaVersion = if ($null -eq $Journal.PSObject.Properties['SchemaVersion']) {
    0
  } else {
    [int]$Journal.SchemaVersion
  }
  if ($schemaVersion -ne 2) {
    throw "The recovery journal schema is unsupported: $schemaVersion"
  }

  $transactionPaths = @(Get-JournalTransactionPaths)
  $records = @(Get-JournalRecords $Journal)
  if ($records.Count -eq 0) {
    throw 'The legacy recovery journal contains no recovery records.'
  }
  foreach ($record in $records) {
    $validated = Get-ValidatedJournalRecord $record
    if (-not ($transactionPaths | Where-Object { Test-PathEqual $_ $validated.Source })) {
      throw "The legacy recovery journal source is outside this installer transaction: $($validated.Source)"
    }
  }

  $upgraded = @{
    SchemaVersion = 3
    Phase = if ($null -eq $Journal.PSObject.Properties['Phase']) { 'preserved' } else { [string]$Journal.Phase }
    Records = $records
  }
  Write-Journal $upgraded
  Write-InstallerDiagnostic 'Upgraded a trusted legacy recovery journal from schema 2 to schema 3.'
  return [pscustomobject]$upgraded
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
  if (-not (Test-Path -LiteralPath $journalPath -PathType Leaf)) {
    return $null
  }
  $journal = Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
  $schemaVersion = if ($null -eq $journal.PSObject.Properties['SchemaVersion']) {
    0
  } else {
    [int]$journal.SchemaVersion
  }
  if ($schemaVersion -eq 3) {
    Assert-JournalContext $journal
    return $journal
  }
  return (Convert-LegacyJournal $journal)
}

function Remove-Journal {
  $journalPath = Get-JournalPath
  if (Test-Path -LiteralPath $journalPath) {
    Assert-JournalStorageTrusted
    if (Test-Path -LiteralPath $journalPath -PathType Leaf) {
      Remove-Item -LiteralPath $journalPath -Force
    }
  }
  $parent = Split-Path -Parent $journalPath
  if (Test-Path -LiteralPath $parent -PathType Container) {
    $remaining = @(Get-ChildItem -LiteralPath $parent -Force)
    if ($remaining.Count -eq 0) {
      Remove-Item -LiteralPath $parent -Force
    }
  }
}

function Invoke-CleanupJournal {
  $journalPath = Get-JournalPath
  if (-not (Test-Path -LiteralPath $journalPath)) {
    return
  }
  $preservationRoots = @(Get-ExistingJournalPreservationRoots)
  if ($preservationRoots.Count -gt 0) {
    Write-InstallerDiagnostic (
      'Keeping the recovery journal because preserved installation files still exist at: ' +
      ($preservationRoots -join ', ')
    )
    return
  }
  Remove-EmptyJournalPreservationRoots
  Assert-JournalStorageTrusted
  if (Test-Path -LiteralPath $journalPath -PathType Leaf) {
    Remove-Journal
  }
}
