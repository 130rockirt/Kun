import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const mainSmoke = readFileSync(
  join(root, 'scripts/smoke-windows-installer-migration.ps1'),
  'utf8'
)
const manualSmoke = readFileSync(
  join(root, 'scripts/smoke-windows-installer-manual-upgrade.ps1'),
  'utf8'
)

describe('Windows manual-upgrade packaged smoke contract', () => {
  it('proves old uninstallers cannot control manual overwrite', () => {
    expect(mainSmoke).toContain(". (Join-Path $PSScriptRoot 'smoke-windows-installer-manual-upgrade.ps1')")
    expect(manualSmoke).toContain("[ValidateSet('exit2', 'hang')]")
    expect(manualSmoke).toContain("'manual overwrite bypasses non-zero old uninstaller'")
    expect(manualSmoke).toContain("'manual overwrite bypasses hanging old uninstaller'")
    expect(manualSmoke).toContain("-Destination (Join-Path $Source 'Uninstall Kun.exe') -Force")
    expect(manualSmoke).toContain("Assert-True (-not (Test-Path -LiteralPath $marker))")
    expect(mainSmoke).toContain("'The elevated manual overwrite invoked the current-user old uninstaller fixture.'")
    expect(mainSmoke).toContain("$env:KUN_INSTALLER_SMOKE_REQUIRE_UAC_INNER -eq '1'")
    expect(mainSmoke).toContain("$_ -match 'uacInner=1'")
  })

  it('covers bounded execution, installer self-location, real blockers, and user files', () => {
    expect(mainSmoke).toContain('$process.WaitForExit($TimeoutSeconds * 1000)')
    expect(manualSmoke).toContain('-ExecutablePath $selfInstaller')
    expect(manualSmoke).toContain("'resources\\kun-installer-smoke-blocker.exe'")
    expect(manualSmoke).toContain("'manual overwrite stops an installed resource process'")
    expect(manualSmoke).toContain('Assert-ManualUpgradeUserFiles $manualUserHashes')
    expect(manualSmoke).toContain('Get-FileSha256 $manualBinaryFile')
    expect(mainSmoke).toContain('Assert-KunShortcuts')
    expect(mainSmoke).toContain('Assert-PathReconciled')
  })

  it('preserves failure evidence in every Windows packaging workflow', () => {
    expect(mainSmoke).toContain('KUN_INSTALLER_SMOKE_ARTIFACT_DIR')
    expect(mainSmoke).toContain("'failure-summary.json'")
    for (const workflow of [
      '.github/workflows/pr-checks.yml',
      '.github/workflows/daily-dev-prerelease.yml',
      '.github/workflows/release.yml'
    ]) {
      const source = readFileSync(join(root, workflow), 'utf8')
      expect(source).toContain('KUN_INSTALLER_SMOKE_ARTIFACT_DIR:')
      expect(source).toContain('artifacts/windows-installer-smoke/**')
      expect(source).toContain('if: always()')
    }
  })
})
