import { describe, expect, it } from 'vitest'
import {
  inspectRuntimeProcess,
  runtimeProcessInspectionMatchesRecord,
  runtimeProcessIsAlive
} from './runtime-process-identity.js'

describe('runtime process identity', () => {
  it('reads a stable identity for the current process', () => {
    const inspection = inspectRuntimeProcess(process.pid)
    expect(inspection?.identity).toMatch(/-v1:/u)
    const startedAt = new Date().toISOString()
    expect(runtimeProcessIsAlive(process.pid, {
      startedAt,
      processIdentity: inspection?.identity
    })).toBe(true)
    expect(runtimeProcessIsAlive(process.pid, {
      startedAt,
      processIdentity: `${inspection?.identity}:reused`
    })).toBe(false)
  })

  it('rejects a live PID whose process birth identity changed', () => {
    expect(runtimeProcessInspectionMatchesRecord(
      { startedAt: '2026-08-16T00:00:00.000Z', processIdentity: 'win32-v1:old' },
      { identity: 'win32-v1:reused', startedAtMs: Date.parse('2026-08-16T00:01:00.000Z') }
    )).toBe(false)
  })

  it('recovers legacy records when the current process started later', () => {
    const record = { startedAt: '2026-08-16T00:00:00.000Z' }
    expect(runtimeProcessInspectionMatchesRecord(record, {
      startedAtMs: Date.parse('2026-08-16T00:01:00.000Z')
    })).toBe(false)
    expect(runtimeProcessInspectionMatchesRecord(record, {
      startedAtMs: Date.parse('2026-08-15T23:59:00.000Z')
    })).toBe(true)
  })

  it('fails closed when process birth identity cannot be inspected', () => {
    expect(runtimeProcessInspectionMatchesRecord({
      startedAt: '2026-08-16T00:00:00.000Z',
      processIdentity: 'win32-v1:owner'
    }, undefined)).toBe(true)
  })
})
