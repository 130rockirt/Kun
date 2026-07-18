import { describe, expect, it } from 'vitest'
import { ThreadStoreDiagnosticReport } from '../src/contracts/thread-store-diagnostics.js'

describe('ThreadStoreDiagnosticReport', () => {
  it('keeps diagnostics bounded and rejects path/content leaks', () => {
    const report = {
      schemaVersion: 1 as const,
      checkedAt: '2026-07-18T00:00:00.000Z',
      complete: true,
      limits: {
        maxThreads: 2,
        maxDirectoryEntries: 4,
        maxAttachments: 2,
        maxAttachmentScopeEntries: 4,
        maxAttachmentScopeItemChars: 256,
        maxRecordsPerArtifact: 4,
        maxTotalRecords: 8,
        maxArtifactBytes: 1024,
        maxTotalBytes: 4096
      },
      scanned: { threads: 0, attachments: 0, records: 0, bytes: 0 },
      issues: [],
      threads: []
    }
    expect(ThreadStoreDiagnosticReport.parse(report)).toEqual(report)
    expect(() => ThreadStoreDiagnosticReport.parse({ ...report, dataDir: '/private/store' })).toThrow()
    expect(() => ThreadStoreDiagnosticReport.parse({
      ...report,
      issues: [{ code: 'bad', message: 'x'.repeat(1025), severity: 'error' }]
    })).toThrow()
  })
})
