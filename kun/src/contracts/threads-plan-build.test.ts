import { describe, expect, it } from 'vitest'
import { ForkThreadRequest } from './threads.js'

describe('ForkThreadRequest plan build linkage', () => {
  it('accepts an absolute side-fork workspace paired with a bounded run id', () => {
    expect(ForkThreadRequest.parse({
      relation: 'side',
      workspace: '/tmp/isolated-plan',
      planBuildRunId: 'run-plan-1',
      planBuildAgentSurface: 'code'
    })).toMatchObject({
      relation: 'side',
      workspace: '/tmp/isolated-plan',
      planBuildRunId: 'run-plan-1',
      planBuildAgentSurface: 'code'
    })
  })

  it('rejects arbitrary workspace overrides and incomplete linkage', () => {
    expect(() => ForkThreadRequest.parse({
      relation: 'fork',
      workspace: '/tmp/isolated-plan',
      planBuildRunId: 'run-plan-1',
      planBuildAgentSurface: 'code'
    })).toThrow()
    expect(() => ForkThreadRequest.parse({
      relation: 'side',
      workspace: '/tmp/isolated-plan'
    })).toThrow()
    expect(() => ForkThreadRequest.parse({
      relation: 'side',
      workspace: 'relative/path',
      planBuildRunId: 'run-plan-1',
      planBuildAgentSurface: 'code'
    })).toThrow()
  })
})
