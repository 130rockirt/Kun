param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('ResolvePath', 'ResolveSource', 'ResolveUpdateScope', 'ResolveUninstaller', 'StopProcesses', 'Recover', 'Prepare', 'FallbackCleanup', 'Restore', 'ValidatePayload', 'CleanupInPlaceLeftovers', 'UpdatePath')]
  [string]$Action,
  [string]$ResultPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0


. (Join-Path $PSScriptRoot 'windows-installer-migration-paths.ps1')
. (Join-Path $PSScriptRoot 'windows-installer-migration-journal.ps1')
. (Join-Path $PSScriptRoot 'windows-installer-migration-filesystem.ps1')
. (Join-Path $PSScriptRoot 'windows-installer-migration-actions.ps1')

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
    'CleanupInPlaceLeftovers' {
      Invoke-CleanupInPlaceLeftovers
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
