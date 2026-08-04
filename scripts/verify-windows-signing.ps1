[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string[]]$FilePath
)

$ErrorActionPreference = 'Stop'

function Find-SignTool {
  $command = Get-Command 'signtool.exe' -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($command) {
    return $command.Source
  }

  $programFilesX86 = ${env:ProgramFiles(x86)}
  if (-not $programFilesX86) {
    $programFilesX86 = $env:ProgramFiles
  }
  $windowsKitsBin = Join-Path $programFilesX86 'Windows Kits\10\bin'
  if (Test-Path -LiteralPath $windowsKitsBin -PathType Container) {
    $candidate = Get-ChildItem -LiteralPath $windowsKitsBin -Filter 'signtool.exe' -File -Recurse `
      -ErrorAction SilentlyContinue |
      Where-Object { $_.Directory.Name -in @('x64', 'x86') } |
      Sort-Object -Property FullName -Descending |
      Select-Object -First 1
    if ($candidate) {
      return $candidate.FullName
    }
  }

  throw 'signtool.exe was not found. Install the Windows SDK signing tools or add signtool.exe to PATH.'
}

$signTool = Find-SignTool
$resolvedFiles = foreach ($candidatePath in $FilePath) {
  $item = Get-Item -LiteralPath $candidatePath -ErrorAction Stop
  if ($item.PSIsContainer) {
    throw "Expected a file to verify, got directory: $($item.FullName)"
  }
  if ($item.Length -le 0) {
    throw "Cannot verify an empty file: $($item.FullName)"
  }
  $item.FullName
}

foreach ($file in $resolvedFiles) {
  Write-Host "Verifying Authenticode signature and timestamp: $file"
  & $signTool verify /pa /all /tw /v $file
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "signtool verification failed for $file (exit code $exitCode)."
  }
}
