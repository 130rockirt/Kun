import { describe, expect, it } from 'vitest'
import { WORK_MODE_INSTRUCTION } from './work-mode.js'

describe('WORK_MODE_INSTRUCTION', () => {
  it('keeps stable Work behavior outside the visible user message', () => {
    expect(WORK_MODE_INSTRUCTION).toContain('The user message is the request')
    expect(WORK_MODE_INSTRUCTION).toContain('`work-reference-resource`')
    expect(WORK_MODE_INSTRUCTION).toContain('`work-reference-whiteboard`')
    expect(WORK_MODE_INSTRUCTION).toContain('access: "read-write"')
    expect(WORK_MODE_INSTRUCTION).toContain('Architecture maps')
    expect(WORK_MODE_INSTRUCTION).not.toMatch(/Workspace:\s*\//)
  })
})
