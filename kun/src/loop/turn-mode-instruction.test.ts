import { describe, expect, it } from 'vitest'
import { PLAN_MODE_INSTRUCTION } from './plan-mode.js'
import { WORK_MODE_INSTRUCTION } from './work-mode.js'
import { buildTurnModeInstruction } from './turn-mode-instruction.js'

describe('buildTurnModeInstruction', () => {
  it('activates Work policy without replacing an additional turn mode', () => {
    expect(buildTurnModeInstruction({
      agentSurface: 'write', orchestration: 'direct'
    }, true)).toBe(`${WORK_MODE_INSTRUCTION}\n\n${PLAN_MODE_INSTRUCTION}`)
  })

  it('emits no surface policy for an ordinary Code turn', () => {
    expect(buildTurnModeInstruction({ orchestration: 'direct' }, false)).toBe('')
  })
})
