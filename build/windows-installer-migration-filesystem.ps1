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
    $processes = @(Get-VerifiedAppProcesses $Roots $currentPid)
    if ($processes.Count -eq 0) {
      return @{ Outcome = 'stopped'; ProcessIds = @() }
    }

    foreach ($process in $processes) {
      & "$env:SystemRoot\System32\taskkill.exe" /PID $process.ProcessId /T /F | Out-Null
    }
    Start-Sleep -Milliseconds 500
  }

  $remaining = @(Get-VerifiedAppProcesses $Roots $currentPid)
  if ($remaining.Count -gt 0) {
    return @{
      Outcome = 'running'
      ProcessIds = @($remaining | ForEach-Object { [int]($_.ProcessId) })
    }
  }
  return @{ Outcome = 'stopped'; ProcessIds = @() }
}

function Get-VerifiedAppProcesses([string[]]$Roots, [int]$CurrentPid) {
  try {
    $candidates = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  } catch {
    throw 'The installer could not inspect Windows processes.'
  }

  $owned = @()
  foreach ($candidate in $candidates) {
    if ($candidate.ProcessId -eq $CurrentPid) {
      continue
    }
    try {
      if (Test-AppOwnedProcessPath $candidate.ExecutablePath $Roots) {
        $owned += $candidate
      }
    } catch {
      throw 'The installer could not validate application process ownership.'
    }
  }
  return @($owned)
}

function Stop-InstallRootProcesses {
  $root = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_APP_ROOT')
  if ([string]::IsNullOrWhiteSpace($root)) {
    return @{ Outcome = 'stopped'; ProcessIds = @() }
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

function Test-InPlaceUpdateRequested {
  return [string]::Equals(
    (Get-EnvironmentValue 'KUN_INSTALLER_IN_PLACE_UPDATE').Trim(),
    '1',
    [StringComparison]::Ordinal
  )
}

function Get-CurrentProductUninstallerFile {
  $configured = (Get-EnvironmentValue 'KUN_INSTALLER_PRODUCT_NAME').Trim()
  if (-not [string]::IsNullOrWhiteSpace($configured)) {
    return 'Uninstall ' + $configured + '.exe'
  }
  return 'Uninstall ' + (Get-CanonicalLeaf) + '.exe'
}

function Test-RetainedInPlaceKnownEntry([IO.FileSystemInfo]$Entry) {
  if ($Entry.PSIsContainer) {
    # Keep packaged directories that the new payload still uses.
    return @('resources', 'locales', 'bin') -contains $Entry.Name.ToLowerInvariant()
  }

  $expectedExecutable = Get-ExpectedApplicationExecutable
  if ([string]::Equals($Entry.Name, $expectedExecutable, [StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }

  $currentUninstaller = Get-CurrentProductUninstallerFile
  if ([string]::Equals($Entry.Name, $currentUninstaller, [StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }

  # Electron runtime files from the newly extracted package stay in place.
  $runtimeFiles = @(
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
  return $runtimeFiles -contains $Entry.Name.ToLowerInvariant()
}

function Invoke-CleanupInPlaceLeftovers {
  if (-not (Test-InPlaceUpdateRequested)) {
    return
  }

  $target = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_TARGET')
  $source = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_SOURCE')
  if ([string]::IsNullOrWhiteSpace($target)) {
    throw 'KUN_INSTALLER_TARGET is required for in-place leftover cleanup.'
  }
  if (-not [string]::IsNullOrWhiteSpace($source) -and -not (Test-PathEqual $source $target)) {
    throw "In-place leftover cleanup requires the source and target to match: $source -> $target"
  }

  Assert-PackagedInstallPayload

  $legacyEntries = @(Get-ChildItem -LiteralPath $target -Force | Where-Object {
    (Test-KnownApplicationEntry $_) -and -not (Test-RetainedInPlaceKnownEntry $_)
  })
  foreach ($entry in $legacyEntries) {
    if ($entry.PSIsContainer) {
      Assert-NoReparsePointsInTree $entry 'Obsolete in-place application directory'
    } elseif (Test-ReparsePoint $entry.FullName) {
      throw "Obsolete in-place application file is a reparse point: $($entry.FullName)"
    }
  }
  foreach ($entry in $legacyEntries) {
    Remove-KnownApplicationEntry $entry
  }
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
