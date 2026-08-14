import { describe, expect, it } from 'vitest'
import { ThreadSchema } from '../contracts/threads.js'
import {
  rowFromIndexRecord,
  summaryFromRow
} from '../adapters/hybrid/hybrid-thread-index-mapping.js'
import { createThreadRecord, toThreadSummary } from './thread.js'

const extensionMetadata = {
  ownerExtensionId: 'com.example.reviewer',
  ownerExtensionVersion: '1.2.3',
  accountId: 'account_primary',
  extensionVisibility: 'private' as const,
  extensionProfile: {
    id: 'reviewer',
    instructionDigest: 'sha256:profile',
    model: 'deepseek-chat',
    providerId: 'provider.example',
    accountId: 'account_primary',
    allowedToolScopes: ['workspace.read']
  },
  extensionBudget: {
    maxTokens: 20_000,
    maxElapsedMs: 300_000,
    maxConcurrentRuns: 2,
    maxModelRequests: 20,
    maxToolInvocations: 50,
    maxRetainedEvents: 2_000
  },
  toolCatalogEpoch: {
    id: 'epoch_01',
    fingerprint: 'sha256:catalog',
    toolCount: 1,
    canonicalToolIds: ['extension:com.example.reviewer/check'],
    schemaDigests: {
      'extension:com.example.reviewer/check': 'sha256:tool'
    },
    createdAt: '2026-07-11T00:00:00.000Z'
  }
}

const planBuildAdmissionMetadata = {
  planBuildRunId: 'run_plan_1',
  planBuildAdmissionFingerprint: 'a'.repeat(64),
  planBuildAdmissionCapabilityHash: 'b'.repeat(64)
}

describe('extension thread metadata', () => {
  it('survives the contract and public summary projection', () => {
    const thread = createThreadRecord({
      id: 'thr_extension',
      title: 'Extension run',
      workspace: '/workspace',
      model: 'deepseek-chat',
      createdAt: '2026-07-11T00:00:00.000Z',
      ...extensionMetadata
    })

    expect(ThreadSchema.parse(thread)).toMatchObject(extensionMetadata)
    expect(toThreadSummary(thread)).toMatchObject(extensionMetadata)
  })

  it('survives the hybrid SQLite index projection', () => {
    const thread = createThreadRecord({
      id: 'thr_extension_index',
      title: 'Indexed extension run',
      workspace: '/workspace',
      model: 'deepseek-chat',
      createdAt: '2026-07-11T00:00:00.000Z',
      ...extensionMetadata
    })
    const row = rowFromIndexRecord(
      { thread, messageCount: 0, eventSeqHighWater: 0, preview: '' },
      { metadataPath: 'thread.json', messagesPath: 'messages.jsonl', eventsPath: 'events.jsonl' }
    )

    expect(summaryFromRow(row)).toMatchObject(extensionMetadata)
  })

  it('keeps inert legacy plan-build metadata in public and indexed summaries', () => {
    const thread = createThreadRecord({
      id: 'thr_plan_admission',
      title: 'Plan executor',
      workspace: '/workspace',
      model: 'deepseek-chat',
      createdAt: '2026-07-11T00:00:00.000Z',
      ...planBuildAdmissionMetadata
    })
    const row = rowFromIndexRecord(
      { thread, messageCount: 0, eventSeqHighWater: 0, preview: '' },
      { metadataPath: 'thread.json', messagesPath: 'messages.jsonl', eventsPath: 'events.jsonl' }
    )

    expect(toThreadSummary(thread)).toMatchObject(planBuildAdmissionMetadata)
    expect(summaryFromRow(row)).toMatchObject(planBuildAdmissionMetadata)
  })
})
