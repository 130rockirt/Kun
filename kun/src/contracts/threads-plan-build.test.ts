import { describe, expect, it } from 'vitest'
import { createThreadRecord } from '../domain/thread.js'
import { ForkThreadRequest, ThreadSchema, ThreadSchemaReadable } from './threads.js'

const planBuildAdmissionFingerprint = 'a'.repeat(64)
const planBuildAdmissionCapability = 'A'.repeat(43)

describe('ThreadSchema plan-build binding invariant', () => {
  it('rejects a half-bound record (runId without the admission binding)', () => {
    const halfBound = createThreadRecord({
      id: 'thr_half_bound',
      title: 'Half bound',
      workspace: '/tmp/isolated-plan',
      model: 'm',
      planBuildRunId: 'run-plan-1'
    })
    expect(ThreadSchema.safeParse(halfBound).success).toBe(false)
    // The read-side tolerant schema still loads it so legacy repair can find it.
    expect(ThreadSchemaReadable.safeParse(halfBound).success).toBe(true)
  })

  it('accepts a fully bound record and rejects a mismatched one', () => {
    const bound = createThreadRecord({
      id: 'thr_bound',
      title: 'Bound',
      workspace: '/tmp/isolated-plan',
      model: 'm',
      planBuildRunId: 'run-plan-1',
      planBuildAdmissionFingerprint,
      planBuildAdmissionCapabilityHash: 'b'.repeat(64)
    })
    expect(ThreadSchema.safeParse(bound).success).toBe(true)
    expect(ThreadSchema.safeParse({
      ...bound,
      planBuildAdmissionCapabilityHash: undefined
    }).success).toBe(false)
    expect(ThreadSchema.safeParse({
      ...bound,
      planBuildAdmissionFingerprint: undefined
    }).success).toBe(false)
  })
})

describe('ForkThreadRequest plan build linkage', () => {
  it('accepts an absolute side fork with a bound first-turn admission proof', () => {
    expect(ForkThreadRequest.parse({
      relation: 'side',
      workspace: '/tmp/isolated-plan',
      planBuildRunId: 'run-plan-1',
      planBuildAgentSurface: 'code',
      planBuildAdmissionFingerprint,
      planBuildAdmissionCapability
    })).toMatchObject({
      relation: 'side',
      workspace: '/tmp/isolated-plan',
      planBuildRunId: 'run-plan-1',
      planBuildAgentSurface: 'code',
      planBuildAdmissionFingerprint,
      planBuildAdmissionCapability
    })
  })

  it('rejects arbitrary workspace overrides and incomplete linkage', () => {
    expect(() => ForkThreadRequest.parse({
      relation: 'fork',
      workspace: '/tmp/isolated-plan',
      planBuildRunId: 'run-plan-1',
      planBuildAgentSurface: 'code',
      planBuildAdmissionFingerprint,
      planBuildAdmissionCapability
    })).toThrow()
    expect(() => ForkThreadRequest.parse({
      relation: 'side',
      workspace: '/tmp/isolated-plan'
    })).toThrow()
    expect(() => ForkThreadRequest.parse({
      relation: 'side',
      workspace: 'relative/path',
      planBuildRunId: 'run-plan-1',
      planBuildAgentSurface: 'code',
      planBuildAdmissionFingerprint,
      planBuildAdmissionCapability
    })).toThrow()
    expect(() => ForkThreadRequest.parse({
      relation: 'side',
      workspace: '/tmp/isolated-plan',
      planBuildRunId: 'run-plan-1',
      planBuildAgentSurface: 'code',
      planBuildAdmissionFingerprint
    })).toThrow()
  })
})
