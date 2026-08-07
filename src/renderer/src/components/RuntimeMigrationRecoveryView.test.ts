import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeDataRecoveryStatus } from '@shared/runtime-data-recovery'
import { RuntimeMigrationRecoveryPanel } from './RuntimeMigrationRecoveryView'

describe('RuntimeMigrationRecoveryPanel', () => {
  it('renders only redacted candidate metadata and never renders the opaque ID', () => {
    const candidateId = 'a'.repeat(43)
    const html = render(candidateStatus({
      candidates: [{
        candidateId,
        kind: 'backup',
        label: 'Preserved migration backup / 已保留的迁移备份',
        modifiedAt: '2026-08-05T01:02:03.000Z',
        inventory: {
          files: 12,
          directories: 4,
          symlinks: 0,
          bytes: 4096,
          threads: 3,
          providers: 2,
          graphs: 1
        },
        credentialState: 'complete',
        journalReferenced: true,
        recoveryVerified: false,
        journalVerified: true,
        equivalentCopies: 2,
        warnings: []
      }]
    }))

    expect(html).toContain('Preserved migration backup')
    expect(html).toContain('Threads / 会话')
    expect(html).toContain('journal verified')
    expect(html).not.toContain(candidateId)
    expect(html).not.toContain('/Users/')
  })

  it('separates new-install initialization from historical start-over confirmation', () => {
    const newInstallHtml = render(candidateStatus({
      state: 'new-install',
      historicalEvidence: false,
      candidates: []
    }))
    const startOverHtml = render(candidateStatus({
      state: 'start-over-required',
      historicalEvidence: true,
      candidates: [],
      invalidEvidenceCount: 1
    }))

    expect(newInstallHtml).toContain('No historical data found')
    expect(newInstallHtml).toContain('Initialize Kun')
    expect(newInstallHtml).not.toContain('Preserve backups and start over')
    expect(startOverHtml).toContain('Historical evidence needs attention')
    expect(startOverHtml).toContain('Preserve backups and start over')
    expect(startOverHtml).toContain('disabled=""')
  })

  it('shows completion without offering another mutation', () => {
    const html = render(candidateStatus({ state: 'completed', candidates: [] }))
    expect(html).toContain('Recovery completed')
    expect(html).not.toContain('Restore / 恢复')
    expect(html).not.toContain('Initialize Kun')
  })
})

function render(status: RuntimeDataRecoveryStatus): string {
  return renderToStaticMarkup(createElement(RuntimeMigrationRecoveryPanel, {
    status,
    busy: false,
    error: '',
    onRestore: vi.fn(),
    onInitialize: vi.fn(),
    onStartOver: vi.fn()
  }))
}

function candidateStatus(
  patch: Partial<RuntimeDataRecoveryStatus>
): RuntimeDataRecoveryStatus {
  return {
    schemaVersion: 1,
    generation: '123e4567-e89b-42d3-a456-426614174000',
    state: 'candidate-ready',
    historicalEvidence: true,
    candidates: [],
    invalidEvidenceCount: 0,
    warnings: [],
    ...patch
  }
}
