function New-ManualUpgradeFixtureExecutable([string]$PathValue) {
  $source = @'
using System;
using System.IO;
using System.Threading;

public static class KunInstallerManualUpgradeFixture
{
    public static void Main()
    {
        var marker = Environment.GetEnvironmentVariable("KUN_INSTALLER_SMOKE_FIXTURE_MARKER");
        var behavior = Environment.GetEnvironmentVariable("KUN_INSTALLER_SMOKE_FIXTURE_BEHAVIOR") ?? "exit2";
        if (!String.IsNullOrWhiteSpace(marker))
        {
            File.AppendAllText(marker, behavior + Environment.NewLine);
        }
        if (String.Equals(behavior, "hang", StringComparison.OrdinalIgnoreCase))
        {
            Thread.Sleep(Timeout.Infinite);
        }
        Environment.Exit(2);
    }
}
'@
  Add-Type -TypeDefinition $source -OutputAssembly $PathValue -OutputType ConsoleApplication
}

function Install-SmokeOldUninstallerFixture([string]$Source) {
  Copy-Item -LiteralPath $script:manualUpgradeFixturePath `
    -Destination (Join-Path $Source 'Uninstall Kun.exe') -Force
}

function Invoke-OldUninstallerBypassSmoke(
  [string]$Scenario,
  [string]$Source,
  [ValidateSet('exit2', 'hang')][string]$Behavior,
  [int]$TimeoutSeconds
) {
  $marker = Join-Path $script:root ($Behavior + '-old-uninstaller-ran.txt')
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  Install-SmokeOldUninstallerFixture $Source
  $oldMarker = [Environment]::GetEnvironmentVariable('KUN_INSTALLER_SMOKE_FIXTURE_MARKER', 'Process')
  $oldBehavior = [Environment]::GetEnvironmentVariable('KUN_INSTALLER_SMOKE_FIXTURE_BEHAVIOR', 'Process')
  try {
    [Environment]::SetEnvironmentVariable('KUN_INSTALLER_SMOKE_FIXTURE_MARKER', $marker, 'Process')
    [Environment]::SetEnvironmentVariable('KUN_INSTALLER_SMOKE_FIXTURE_BEHAVIOR', $Behavior, 'Process')
    Invoke-Installer -Scenario $Scenario -Arguments @('/S', '/currentuser') `
      -TimeoutSeconds $TimeoutSeconds
  } finally {
    [Environment]::SetEnvironmentVariable('KUN_INSTALLER_SMOKE_FIXTURE_MARKER', $oldMarker, 'Process')
    [Environment]::SetEnvironmentVariable('KUN_INSTALLER_SMOKE_FIXTURE_BEHAVIOR', $oldBehavior, 'Process')
  }
  Assert-True (-not (Test-Path -LiteralPath $marker)) `
    'The manual overwrite invoked the old uninstaller fixture.'
  Assert-RegisteredLocation $Source
}

function Assert-ManualUpgradeUserFiles($ExpectedHashes) {
  foreach ($path in @($ExpectedHashes.Keys)) {
    Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "Preserved user file is missing: $path"
    Assert-True ((Get-FileSha256 $path) -eq $ExpectedHashes[$path]) `
      "Preserved user file changed: $path"
  }
}

$script:manualUpgradeFixturePath = Join-Path $root 'manual-upgrade-fixture.exe'
New-ManualUpgradeFixtureExecutable $script:manualUpgradeFixturePath

Invoke-OldUninstallerBypassSmoke `
  'manual overwrite bypasses non-zero old uninstaller' $custom 'exit2' 600
Invoke-OldUninstallerBypassSmoke `
  'manual overwrite bypasses hanging old uninstaller' $custom 'hang' 600

$manualUserRoot = Join-Path $custom ($unicodeDirectoryName + '-user-files')
$manualNestedRoot = Join-Path $manualUserRoot 'nested'
[IO.Directory]::CreateDirectory($manualNestedRoot) | Out-Null
$manualTextFile = Join-Path $manualUserRoot 'notes.txt'
$manualBinaryFile = Join-Path $manualNestedRoot 'payload.bin'
Set-Content -LiteralPath $manualTextFile -Value 'preserve unicode and nested user content' -Encoding UTF8
[IO.File]::WriteAllBytes($manualBinaryFile, [byte[]](0, 1, 2, 127, 128, 254, 255))
$manualUserHashes = @{}
$manualUserHashes[$manualTextFile] = Get-FileSha256 $manualTextFile
$manualUserHashes[$manualBinaryFile] = Get-FileSha256 $manualBinaryFile

$selfInstaller = Join-Path $custom 'Kun-manual-upgrade-smoke.exe'
Copy-Item -LiteralPath $script:InstallerPath -Destination $selfInstaller
$selfInstallerHash = Get-FileSha256 $selfInstaller
Invoke-Installer -Scenario 'installer runs from the previous application directory' `
  -Arguments @('/S', '/currentuser') -TimeoutSeconds 600 -ExecutablePath $selfInstaller
Assert-True (Test-Path -LiteralPath $selfInstaller -PathType Leaf) `
  'The running installer was removed from the previous application directory.'
Assert-True ((Get-FileSha256 $selfInstaller) -eq $selfInstallerHash) `
  'The running installer was modified during manual overwrite.'
Assert-ManualUpgradeUserFiles $manualUserHashes
Assert-RegisteredLocation $custom

$resourceMarker = Join-Path $root 'resource-process-started.txt'
$resourceFixture = Join-Path $custom 'resources\kun-installer-smoke-blocker.exe'
Copy-Item -LiteralPath $script:manualUpgradeFixturePath -Destination $resourceFixture -Force
$oldMarker = [Environment]::GetEnvironmentVariable('KUN_INSTALLER_SMOKE_FIXTURE_MARKER', 'Process')
$oldBehavior = [Environment]::GetEnvironmentVariable('KUN_INSTALLER_SMOKE_FIXTURE_BEHAVIOR', 'Process')
$resourceProcess = $null
try {
  [Environment]::SetEnvironmentVariable('KUN_INSTALLER_SMOKE_FIXTURE_MARKER', $resourceMarker, 'Process')
  [Environment]::SetEnvironmentVariable('KUN_INSTALLER_SMOKE_FIXTURE_BEHAVIOR', 'hang', 'Process')
  $resourceProcess = Start-Process -FilePath $resourceFixture -PassThru
  $markerDeadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not (Test-Path -LiteralPath $resourceMarker) -and [DateTime]::UtcNow -lt $markerDeadline) {
    Start-Sleep -Milliseconds 100
  }
  Assert-True (Test-Path -LiteralPath $resourceMarker) 'The installed resource blocker did not start.'
  Invoke-Installer -Scenario 'manual overwrite stops an installed resource process' `
    -Arguments @('/S', '/currentuser') -TimeoutSeconds 600
  Assert-True ($resourceProcess.WaitForExit(10000)) `
    'The verified installed resource process remained alive after manual overwrite.'
} finally {
  if ($null -ne $resourceProcess -and -not $resourceProcess.HasExited) {
    & "$env:SystemRoot\System32\taskkill.exe" /PID $resourceProcess.Id /T /F | Out-Null
  }
  [Environment]::SetEnvironmentVariable('KUN_INSTALLER_SMOKE_FIXTURE_MARKER', $oldMarker, 'Process')
  [Environment]::SetEnvironmentVariable('KUN_INSTALLER_SMOKE_FIXTURE_BEHAVIOR', $oldBehavior, 'Process')
}
Assert-ManualUpgradeUserFiles $manualUserHashes
Assert-RegisteredLocation $custom
