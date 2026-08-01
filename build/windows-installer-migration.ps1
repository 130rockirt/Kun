param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('ResolvePath', 'Recover', 'Prepare', 'FallbackCleanup', 'Restore', 'UpdatePath')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Get-EnvironmentValue([string]$Name) {
  return [Environment]::GetEnvironmentVariable($Name, 'Process')
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
  return [string]::Equals($Leaf, 'DeepSeek GUI', [StringComparison]::OrdinalIgnoreCase) -or
    [string]::Equals($Leaf, 'deepseek-gui', [StringComparison]::OrdinalIgnoreCase)
}

function Resolve-InstallTarget {
  $source = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_SOURCE')
  $candidate = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_CANDIDATE')
  if ([string]::IsNullOrWhiteSpace($candidate)) {
    throw 'The candidate installation path is empty.'
  }

  $leaf = Split-Path -Leaf $candidate
  $parent = Split-Path -Parent $candidate

  if ([string]::Equals($leaf, 'Kun', [StringComparison]::OrdinalIgnoreCase)) {
    $parentLeaf = Split-Path -Leaf $parent
    if (Test-LegacyLeaf $parentLeaf) {
      return Join-Path (Split-Path -Parent $parent) 'Kun'
    }
    return $candidate
  }

  if (Test-LegacyLeaf $leaf) {
    return Join-Path $parent 'Kun'
  }

  if (-not [string]::IsNullOrWhiteSpace($source) -and (Test-PathEqual $source $candidate)) {
    return $candidate
  }

  return Join-Path $candidate 'Kun'
}

function Write-ResolvedInstallTarget([string]$Target) {
  $resultPath = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_RESULT')
  if (-not [string]::IsNullOrWhiteSpace($resultPath)) {
    [IO.File]::WriteAllBytes($resultPath, [Text.Encoding]::Unicode.GetBytes($Target))
  }
  [Console]::Out.Write($Target)
}

function Get-JournalPath {
  $journalPath = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_JOURNAL')
  if ([string]::IsNullOrWhiteSpace($journalPath)) {
    throw 'KUN_INSTALLER_JOURNAL is required for migration actions.'
  }
  return $journalPath
}

function Write-Journal([hashtable]$Journal) {
  $journalPath = Get-JournalPath
  $journalParent = Split-Path -Parent $journalPath
  [IO.Directory]::CreateDirectory($journalParent) | Out-Null
  $temporaryPath = "$journalPath.tmp"
  $Journal.UpdatedAt = [DateTime]::UtcNow.ToString('o')
  $Journal | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
  Move-Item -LiteralPath $temporaryPath -Destination $journalPath -Force
}

function Read-Journal {
  $journalPath = Get-JournalPath
  if (-not (Test-Path -LiteralPath $journalPath -PathType Leaf)) {
    return $null
  }
  return Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
}

function Remove-Journal {
  $journalPath = Get-JournalPath
  if (Test-Path -LiteralPath $journalPath) {
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

  if (Test-ReparsePoint $normalized) {
    throw "$Label path is a reparse point: $normalized"
  }
}

function Test-KnownApplicationEntry([IO.FileSystemInfo]$Entry) {
  if ($Entry.PSIsContainer) {
    return @('resources', 'locales', 'bin') -contains $Entry.Name.ToLowerInvariant()
  }

  $knownFiles = @(
    'kun.exe',
    'deepseek gui.exe',
    'uninstall kun.exe',
    'uninstall deepseek gui.exe',
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
    if ($relativeLower -eq 'kun.exe' -or $relativeLower -eq 'deepseek gui.exe' -or
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

function Get-InstallSources {
  $sources = @(
    (Get-EnvironmentValue 'KUN_INSTALLER_SOURCE'),
    (Get-EnvironmentValue 'KUN_INSTALLER_SECONDARY_SOURCE')
  )
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
      SchemaVersion = 2
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

  $sources = @(Get-InstallSources)
  $target = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_TARGET')
  if ([string]::IsNullOrWhiteSpace($target)) {
    throw 'KUN_INSTALLER_TARGET is required.'
  }

  Assert-SafeInstallRoot $target 'Target'
  if ((Test-Path -LiteralPath $target) -and -not (Test-Path -LiteralPath $target -PathType Container)) {
    throw "The target exists but is not a directory: $target"
  }
  foreach ($source in $sources) {
    Assert-SafeInstallRoot $source 'Source'
  }

  $targetIsSource = $sources | Where-Object { Test-PathEqual $_ $target }
  if (-not $targetIsSource -and (Test-Path -LiteralPath $target -PathType Container)) {
    $targetEntries = @(Get-ChildItem -LiteralPath $target -Force)
    if ($targetEntries.Count -gt 0) {
      throw "The canonical target already contains files and cannot be merged safely: $target"
    }
  }

  $preservationSets = @()
  foreach ($source in $sources) {
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
      continue
    }
    $entries = @(Get-ChildItem -LiteralPath $source -Force)
    if ($entries.Count -eq 0) {
      continue
    }
    if (-not ($entries | Where-Object { Test-KnownApplicationEntry $_ })) {
      throw "The registered source has no recognized application payload: $source"
    }
    $unknown = @($entries | Where-Object { -not (Test-KnownApplicationEntry $_) })
    if ($unknown.Count -gt 0) {
      $stash = Get-PreservationRoot $source
      if (Test-Path -LiteralPath $stash) {
        throw "A preservation directory already exists without a recoverable journal: $stash"
      }
      $preservationSets += @{
        Source = $source
        Stash = $stash
        Unknown = $unknown
      }
    }
  }

  Stop-AppProcesses @($sources + $target)

  $journal = @{
    SchemaVersion = 2
    Phase = 'preserving'
    Records = @()
  }
  foreach ($set in $preservationSets) {
    $content = Join-Path $set.Stash 'content'
    [IO.Directory]::CreateDirectory($content) | Out-Null
    $stashItem = Get-Item -LiteralPath $set.Stash -Force
    $stashItem.Attributes = $stashItem.Attributes -bor [IO.FileAttributes]::Hidden
    $record = @{
      Source = $set.Source
      Target = $target
      RestoreDestination = if (Test-PathEqual $set.Source $target) { $target } else { $set.Source }
      Stash = $set.Stash
      Entries = @($set.Unknown | ForEach-Object { $_.Name })
    }
    $journal.Records += $record
    Write-Journal $journal
    foreach ($entry in $set.Unknown) {
      Move-Item -LiteralPath $entry.FullName -Destination (Join-Path $content $entry.Name)
    }
  }

  $journal.Phase = 'preserved'
  if ($journal.Records.Count -gt 0) {
    Write-Journal $journal
  }
}

function Invoke-FallbackCleanup {
  $source = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_SOURCE')
  if ([string]::IsNullOrWhiteSpace($source) -or -not (Test-Path -LiteralPath $source -PathType Container)) {
    return
  }
  Assert-SafeInstallRoot $source 'Source'

  foreach ($entry in @(Get-ChildItem -LiteralPath $source -Force)) {
    if (Test-KnownApplicationEntry $entry) {
      Remove-Item -LiteralPath $entry.FullName -Recurse -Force
    }
  }

  if (@(Get-ChildItem -LiteralPath $source -Force).Count -eq 0) {
    Remove-Item -LiteralPath $source -Force
  }
}

function Remove-EmptyLegacyContainers {
  $candidates = @()
  foreach ($source in @(Get-InstallSources)) {
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
  $sources = @(Get-InstallSources)
  $target = Normalize-FullPath (Get-EnvironmentValue 'KUN_INSTALLER_TARGET')
  if ([string]::IsNullOrWhiteSpace($target)) {
    throw 'KUN_INSTALLER_TARGET is required for PATH reconciliation.'
  }

  $sourceBins = @($sources | ForEach-Object { Join-Path $_ 'bin' })
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
  switch ($Action) {
    'ResolvePath' {
      Write-ResolvedInstallTarget (Resolve-InstallTarget)
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
    'UpdatePath' {
      Update-UserPath
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
