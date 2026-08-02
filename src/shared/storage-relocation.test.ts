import { describe, expect, it } from 'vitest'
import {
  STORAGE_RELOCATION_MINIMUM_RESERVE_BYTES,
  isStorageRelocationPhaseTransitionAllowed,
  storageRelocationRequiredBytes
} from './storage-relocation'

describe('storage relocation contract', () => {
  it('adds the larger of five GiB or ten percent as target reserve', () => {
    expect(storageRelocationRequiredBytes(1_024)).toBe(1_024 + STORAGE_RELOCATION_MINIMUM_RESERVE_BYTES)
    const large = 100 * 1024 * 1024 * 1024
    expect(storageRelocationRequiredBytes(large)).toBe(110 * 1024 * 1024 * 1024)
  })

  it('allows only durable forward, retry, cleanup, and rollback transitions', () => {
    expect(isStorageRelocationPhaseTransitionAllowed('prepared', 'draining')).toBe(true)
    expect(isStorageRelocationPhaseTransitionAllowed('draining', 'copying')).toBe(true)
    expect(isStorageRelocationPhaseTransitionAllowed('health-check', 'completed')).toBe(true)
    expect(isStorageRelocationPhaseTransitionAllowed('cleanup-pending', 'health-check')).toBe(true)
    expect(isStorageRelocationPhaseTransitionAllowed('failed', 'copying')).toBe(true)
    expect(isStorageRelocationPhaseTransitionAllowed('completed', 'copying')).toBe(false)
    expect(isStorageRelocationPhaseTransitionAllowed('copying', 'completed')).toBe(false)
    expect(isStorageRelocationPhaseTransitionAllowed('rolling-back', 'cutover')).toBe(false)
  })
})
