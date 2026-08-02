param(
  [string]$InstallerPath = '',
  [switch]$AllowLocal
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if (-not [Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'This smoke test requires 64-bit Windows.'
}
if (-not $AllowLocal -and $env:CI -ne 'true') {
  throw 'This smoke mutates the current-user Kun uninstall registration and is restricted to clean CI runners. Use -AllowLocal only in a disposable Windows account.'
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('kun-installer-migration-smoke-' + [guid]::NewGuid().ToString('N'))
$markerName = '.kun-installer-migration-smoke-' + [guid]::NewGuid().ToString('N')
$installRegistryPath = $null
$uninstallRegistryPath = $null
$installRegistryPaths = @()
$uninstallRegistryPaths = @()
$sentinels = @()
$currentScenario = 'smoke setup'

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) {
    throw "[$script:currentScenario] $Message"
  }
}

function Normalize-Path([string]$PathValue) {
  return [IO.Path]::GetFullPath($PathValue).TrimEnd('\')
}

function Test-PathEqual([string]$Left, [string]$Right) {
  return [string]::Equals((Normalize-Path $Left), (Normalize-Path $Right), [StringComparison]::OrdinalIgnoreCase)
}

function Invoke-Installer(
  [string]$Scenario,
  [string[]]$Arguments,
  [int]$ExpectedExitCode = 0
) {
  $script:currentScenario = $Scenario
  $argumentText = $Arguments -join ' '
  Write-Host "[$Scenario] Starting installer: $argumentText"
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  $process = Start-Process -FilePath $script:InstallerPath -ArgumentList $Arguments -Wait -PassThru
  $stopwatch.Stop()
  Write-Host "[$Scenario] Installer exited with $($process.ExitCode) after $([math]::Round($stopwatch.Elapsed.TotalSeconds, 1))s."
  Assert-True ($process.ExitCode -eq $ExpectedExitCode) "Installer exited with $($process.ExitCode), expected $ExpectedExitCode. Arguments: $argumentText"
}

function Find-KunRegistration(
  [string]$ExpectedLocation,
  [ValidateSet('HKCU', 'HKLM')][string]$Hive = 'HKCU'
) {
  $softwarePath = if ($Hive -eq 'HKLM') { 'HKLM:\Software' } else { 'HKCU:\Software' }
  $uninstallRoot = if ($Hive -eq 'HKLM') {
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
  } else {
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
  }
  $matches = @(Get-ChildItem -Path $softwarePath | ForEach-Object {
    try {
      $value = Get-ItemPropertyValue -LiteralPath $_.PSPath -Name InstallLocation -ErrorAction Stop
      if (Test-PathEqual $value $ExpectedLocation) { $_ }
    } catch {}
  })
  Assert-True ($matches.Count -eq 1) "Expected one Kun install registration for $ExpectedLocation, found $($matches.Count)."
  $script:installRegistryPath = $matches[0].PSPath
  $script:uninstallRegistryPath = Join-Path $uninstallRoot $matches[0].PSChildName
  $script:installRegistryPaths += $script:installRegistryPath
  $script:uninstallRegistryPaths += $script:uninstallRegistryPath
  Assert-True (Test-Path -LiteralPath $script:uninstallRegistryPath) 'The matching Kun uninstall registration is missing.'
}

function Set-RegisteredLocation([string]$Location) {
  $uninstaller = Join-Path $Location 'Uninstall Kun.exe'
  Set-ItemProperty -LiteralPath $script:installRegistryPath -Name InstallLocation -Value $Location
  Set-ItemProperty -LiteralPath $script:uninstallRegistryPath -Name UninstallString -Value ('"' + $uninstaller + '" /currentuser')
  Set-ItemProperty -LiteralPath $script:uninstallRegistryPath -Name QuietUninstallString -Value ('"' + $uninstaller + '" /currentuser /S')
  Set-ItemProperty -LiteralPath $script:uninstallRegistryPath -Name DisplayIcon -Value ((Join-Path $Location 'Kun.exe') + ',0')
}

function Move-RegisteredInstall([string]$From, [string]$To) {
  [IO.Directory]::CreateDirectory((Split-Path -Parent $To)) | Out-Null
  Move-Item -LiteralPath $From -Destination $To
  Set-RegisteredLocation $To

  $fromBin = Join-Path $From 'bin'
  $toBin = Join-Path $To 'bin'
  $pathValue = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($pathValue -split ';' | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_) -and
    -not [string]::Equals($_.TrimEnd('\'), $fromBin.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
  })
  [Environment]::SetEnvironmentVariable('Path', (($parts + $toBin) -join ';'), 'User')
}

function Assert-RegisteredLocation([string]$ExpectedLocation) {
  $actual = Get-ItemPropertyValue -LiteralPath $script:installRegistryPath -Name InstallLocation
  Assert-True (Test-PathEqual $actual $ExpectedLocation) "Registered location is $actual, expected $ExpectedLocation."
  Assert-True (Test-Path -LiteralPath (Join-Path $ExpectedLocation 'Kun.exe')) "Kun.exe is missing from $ExpectedLocation."
}

function Assert-PathReconciled([string]$ExpectedLocation, [string[]]$RejectedLocations) {
  $parts = @([Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_)
  })
  $expectedBin = Join-Path $ExpectedLocation 'bin'
  $expectedCount = @($parts | Where-Object {
    [string]::Equals($_.TrimEnd('\'), $expectedBin.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
  }).Count
  Assert-True ($expectedCount -eq 1) "Expected exactly one PATH entry for $expectedBin, found $expectedCount."
  foreach ($location in $RejectedLocations) {
    $rejectedBin = Join-Path $location 'bin'
    Assert-True (-not ($parts | Where-Object {
      [string]::Equals($_.TrimEnd('\'), $rejectedBin.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
    })) "Stale PATH entry remains for $rejectedBin."
  }
}

function Get-ShortcutPaths([ValidateSet('CurrentUser', 'AllUsers')][string]$Scope) {
  if ($Scope -eq 'AllUsers') {
    return @(
      (Join-Path $env:PUBLIC 'Desktop\Kun.lnk'),
      (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Kun.lnk')
    )
  }
  return @(
    (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Kun.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Kun.lnk')
  )
}

function Assert-KunShortcuts([ValidateSet('CurrentUser', 'AllUsers')][string]$Scope) {
  foreach ($shortcut in @(Get-ShortcutPaths $Scope)) {
    Assert-True (Test-Path -LiteralPath $shortcut) "Kun shortcut is missing: $shortcut"
    $legacyShortcut = Join-Path (Split-Path -Parent $shortcut) 'DeepSeek GUI.lnk'
    Assert-True (-not (Test-Path -LiteralPath $legacyShortcut)) "Legacy shortcut remains: $legacyShortcut"
  }
}

function Assert-NoKunShortcuts([ValidateSet('CurrentUser', 'AllUsers')][string]$Scope) {
  foreach ($shortcut in @(Get-ShortcutPaths $Scope)) {
    Assert-True (-not (Test-Path -LiteralPath $shortcut)) "Kun shortcut remains: $shortcut"
    $legacyShortcut = Join-Path (Split-Path -Parent $shortcut) 'DeepSeek GUI.lnk'
    Assert-True (-not (Test-Path -LiteralPath $legacyShortcut)) "Legacy shortcut remains: $legacyShortcut"
  }
}

function Convert-ShortcutsToLegacy {
  foreach ($shortcut in @(Get-ShortcutPaths 'CurrentUser')) {
    if (Test-Path -LiteralPath $shortcut) {
      Move-Item -LiteralPath $shortcut -Destination (Join-Path (Split-Path -Parent $shortcut) 'DeepSeek GUI.lnk')
    }
  }
  Set-ItemProperty -LiteralPath $script:installRegistryPath -Name ShortcutName -Value 'DeepSeek GUI'
  Set-ItemProperty -LiteralPath $script:installRegistryPath -Name KeepShortcuts -Value 'true'
}

function Add-DataSentinel([string]$Directory) {
  [IO.Directory]::CreateDirectory($Directory) | Out-Null
  $path = Join-Path $Directory $script:markerName
  Set-Content -LiteralPath $path -Value 'preserve' -Encoding UTF8
  $script:sentinels += $path
}

try {
  [IO.Directory]::CreateDirectory($root) | Out-Null
  if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
    $candidate = Get-ChildItem -Path (Join-Path (Get-Location) 'dist') -Filter 'Kun-*-win-x64.exe' |
      Sort-Object LastWriteTimeUtc -Descending |
      Select-Object -First 1
    if ($null -eq $candidate) {
      throw 'No dist/Kun-*-win-x64.exe installer was found.'
    }
    $script:InstallerPath = $candidate.FullName
  } else {
    $script:InstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
  }

  $existingKun = @(@(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
  ) | ForEach-Object { Get-ChildItem $_ -ErrorAction SilentlyContinue } | ForEach-Object {
    try {
      $displayName = Get-ItemPropertyValue -LiteralPath $_.PSPath -Name DisplayName -ErrorAction Stop
      if ($displayName -eq 'Kun' -or $displayName -eq 'DeepSeek GUI') { $_ }
    } catch {}
  })
  Assert-True ($existingKun.Count -eq 0) 'The smoke requires a clean current-user Kun/DeepSeek GUI registration.'

  Add-DataSentinel (Join-Path $env:APPDATA 'Kun')
  Add-DataSentinel (Join-Path $env:APPDATA 'DeepSeek GUI')
  Add-DataSentinel (Join-Path $HOME '.kun')
  Add-DataSentinel (Join-Path $HOME '.deepseekgui')

  $seedParent = Join-Path $root 'seed'
  $seed = Join-Path $seedParent 'Kun'
  Invoke-Installer 'seed current-user install' @('/S', '/currentuser', "/D=$seedParent")
  Find-KunRegistration $seed
  Assert-RegisteredLocation $seed
  Assert-KunShortcuts 'CurrentUser'

  $legacySource = Join-Path $root 'legacy\DeepSeek GUI'
  $legacyTarget = Join-Path $root 'legacy\Kun'
  Move-RegisteredInstall $seed $legacySource
  Convert-ShortcutsToLegacy
  Set-ItemProperty -LiteralPath $script:installRegistryPath -Name InstallLocation -Value ''
  Set-Content -LiteralPath (Join-Path $legacySource 'legacy-note.txt') -Value 'keep legacy note'
  Invoke-Installer 'legacy uninstall-source recovery' @('--updated', '/currentuser')
  Assert-RegisteredLocation $legacyTarget
  Assert-True ((Get-Content -LiteralPath (Join-Path $legacySource 'legacy-note.txt') -Raw).Trim() -eq 'keep legacy note') 'Legacy unknown content was not preserved.'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $legacyTarget 'legacy-note.txt'))) 'Legacy unknown content leaked into the canonical target.'
  Assert-PathReconciled $legacyTarget @($seed, $legacySource)
  Assert-KunShortcuts 'CurrentUser'

  $nestedSource = Join-Path $root 'nested\DeepSeek GUI\Kun'
  $nestedTarget = Join-Path $root 'nested\Kun'
  Move-RegisteredInstall $legacyTarget $nestedSource
  Set-Content -LiteralPath (Join-Path $nestedSource 'nested-note.txt') -Value 'keep nested note'
  Invoke-Installer 'nested legacy path migration' @('/S', '/currentuser')
  Assert-RegisteredLocation $nestedTarget
  Assert-True (Test-Path -LiteralPath (Join-Path $nestedSource 'nested-note.txt')) 'Nested unknown content was not restored.'
  Assert-PathReconciled $nestedTarget @($legacyTarget, $nestedSource)

  $custom = Join-Path $root 'custom\My AI Tools'
  Move-RegisteredInstall $nestedTarget $custom
  Set-Content -LiteralPath (Join-Path $custom 'custom-note.txt') -Value 'keep custom note'
  Invoke-Installer 'custom path reinstall' @('/S', '/currentuser')
  Assert-RegisteredLocation $custom
  Assert-True (Test-Path -LiteralPath (Join-Path $custom 'custom-note.txt')) 'Custom install content was not restored in place.'

  $programsRoot = Join-Path $env:LOCALAPPDATA 'Programs'
  Set-RegisteredLocation $programsRoot
  Invoke-Installer 'protected root rejection' @('/S', '/currentuser') 2
  Assert-True (Test-Path -LiteralPath (Join-Path $custom 'Kun.exe')) 'Protected-root rejection changed the actual installation.'
  Set-RegisteredLocation $custom

  $junctionBacking = Join-Path $root 'junction-backing'
  $junctionTarget = Join-Path $root 'junction-target\Kun'
  [IO.Directory]::CreateDirectory($junctionBacking) | Out-Null
  [IO.Directory]::CreateDirectory((Split-Path -Parent $junctionTarget)) | Out-Null
  New-Item -ItemType Junction -Path $junctionTarget -Target $junctionBacking | Out-Null
  Invoke-Installer 'reparse target rejection' @('/S', '/currentuser', "/D=$junctionTarget") 2
  Assert-True (Test-Path -LiteralPath (Join-Path $custom 'Kun.exe')) 'Reparse-target rejection changed the source installation.'

  $linkedSource = Join-Path $root 'linked-source'
  New-Item -ItemType Junction -Path $linkedSource -Target $custom | Out-Null
  Set-RegisteredLocation $linkedSource
  Invoke-Installer 'reparse source rejection' @('/S', '/currentuser') 2
  Assert-True (Test-Path -LiteralPath (Join-Path $custom 'Kun.exe')) 'Reparse-source rejection changed the installation.'
  Set-RegisteredLocation $custom

  Move-Item -LiteralPath (Join-Path $custom 'Uninstall Kun.exe') -Destination (Join-Path $custom 'old-uninstaller.missing')
  Invoke-Installer 'missing uninstaller fallback cleanup' @('/S', '/currentuser')
  Assert-RegisteredLocation $custom
  Assert-True (Test-Path -LiteralPath (Join-Path $custom 'old-uninstaller.missing')) 'Fallback cleanup deleted preserved unknown content.'

  $conflictSource = Join-Path $root 'conflict\DeepSeek GUI'
  $conflictTarget = Join-Path $root 'conflict\Kun'
  Move-RegisteredInstall $custom $conflictSource
  [IO.Directory]::CreateDirectory($conflictTarget) | Out-Null
  Set-Content -LiteralPath (Join-Path $conflictTarget 'occupied.txt') -Value 'do not overwrite'
  Invoke-Installer 'occupied target rejection' @('/S', '/currentuser') 2
  Assert-True (Test-Path -LiteralPath (Join-Path $conflictSource 'Kun.exe')) 'Conflict handling changed the source installation.'
  Assert-True (Test-Path -LiteralPath (Join-Path $conflictTarget 'occupied.txt')) 'Conflict handling changed the target directory.'

  Remove-Item -LiteralPath $conflictTarget -Recurse -Force
  Invoke-Installer 'conflict retry migration' @('/S', '/currentuser')
  Assert-RegisteredLocation $conflictTarget

  foreach ($sentinel in $sentinels) {
    Assert-True (Test-Path -LiteralPath $sentinel) "User-data sentinel was removed: $sentinel"
  }

  $previousUserInstallRegistryPath = $script:installRegistryPath
  $previousUserUninstallRegistryPath = $script:uninstallRegistryPath
  $machineParent = Join-Path $root 'machine'
  $machineTarget = Join-Path $machineParent 'Kun'
  Invoke-Installer 'current-user to all-users migration' @('/S', '/allusers', "/D=$machineParent")
  Assert-True (-not (Test-Path -LiteralPath $previousUserInstallRegistryPath)) 'The current-user install registration remains after all-users migration.'
  Assert-True (-not (Test-Path -LiteralPath $previousUserUninstallRegistryPath)) 'The current-user uninstall registration remains after all-users migration.'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $conflictTarget 'Kun.exe'))) 'The current-user application payload remains after all-users migration.'
  Assert-NoKunShortcuts 'CurrentUser'
  Find-KunRegistration $machineTarget 'HKLM'
  Assert-RegisteredLocation $machineTarget
  Assert-PathReconciled $machineTarget @($conflictTarget)
  Assert-KunShortcuts 'AllUsers'

  $script:currentScenario = 'all-users uninstall'
  $machineUninstaller = Join-Path $machineTarget 'Uninstall Kun.exe'
  $machineUninstall = Start-Process -FilePath $machineUninstaller -ArgumentList @('/S', '/allusers') -Wait -PassThru
  Assert-True ($machineUninstall.ExitCode -eq 0) "All-users smoke uninstaller exited with $($machineUninstall.ExitCode)."
  foreach ($sentinel in $sentinels) {
    Assert-True (Test-Path -LiteralPath $sentinel) "All-users uninstall removed a user-data sentinel: $sentinel"
  }

  Write-Host 'Windows installer migration smoke passed.'
} finally {
  foreach ($sentinel in $sentinels) {
    Remove-Item -LiteralPath $sentinel -Force -ErrorAction SilentlyContinue
  }
  foreach ($registryPath in $installRegistryPaths) {
    Remove-Item -LiteralPath $registryPath -Recurse -Force -ErrorAction SilentlyContinue
  }
  foreach ($registryPath in $uninstallRegistryPaths) {
    Remove-Item -LiteralPath $registryPath -Recurse -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
