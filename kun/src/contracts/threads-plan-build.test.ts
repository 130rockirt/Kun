import { describe, expect, it } from 'vitest'
import { ForkThreadRequest } from './threads.js'

const planBuildAdmissionFingerprint = 'a'.repeat(64)
const planBuildAdmissionCapability = 'A'.repeat(43)

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
