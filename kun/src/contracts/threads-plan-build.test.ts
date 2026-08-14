import { describe, expect, it } from 'vitest'
import { createThreadRecord } from '../domain/thread.js'
import { ForkThreadRequest, ThreadSchema, ThreadSchemaReadable } from './threads.js'

describe('legacy plan-build thread compatibility', () => {
  it('parses a legacy record without requiring an admission binding', () => {
    const legacy = createThreadRecord({
      id: 'thr_legacy_plan',
      title: 'Legacy plan',
      workspace: '/tmp/isolated-plan',
      model: 'm',
      relation: 'side',
      planBuildRunId: 'run-plan-1',
      planBuildAdmissionFrozen: true
    })

    expect(ThreadSchema.parse(legacy)).toMatchObject({
      planBuildRunId: 'run-plan-1',
      planBuildAdmissionFrozen: true
    })
    expect(ThreadSchemaReadable.safeParse(legacy).success).toBe(true)
  })

  it('does not accept plan-build lifecycle fields as fork options', () => {
    const parsed = ForkThreadRequest.parse({
      relation: 'side',
      planBuildRunId: 'run-plan-1',
      planBuildAgentSurface: 'code',
      planBuildAdmissionFingerprint: 'a'.repeat(64),
      planBuildAdmissionCapability: 'A'.repeat(43)
    })

    expect(parsed).toEqual({ relation: 'side' })
  })
})
