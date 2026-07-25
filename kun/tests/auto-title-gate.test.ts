import { describe, it, expect } from 'vitest'
import { canUpgradeThreadTitle } from '../src/loop/agent-loop.js'

/**
 * Guards the "placeholder → LLM-summary upgrade" titling contract: the backend
 * LLM titler (fired in parallel at first-turn start) may overwrite a
 * placeholder or an explicitly-provisional title, but must never clobber a
 * user-renamed (locked) one. Regression coverage for the bug where the
 * renderer's eager first-message rename pre-empted the backend titler.
 */
describe('canUpgradeThreadTitle', () => {
  it('upgrades placeholder titles when titleAuto is absent (legacy)', () => {
    expect(canUpgradeThreadTitle({ title: '新会话' })).toBe(true)
    expect(canUpgradeThreadTitle({ title: 'New Thread' })).toBe(true)
    expect(canUpgradeThreadTitle({ title: '' })).toBe(true)
    expect(canUpgradeThreadTitle({ title: undefined })).toBe(true)
  })

  it('does NOT upgrade a real legacy title with no auto flag', () => {
    expect(canUpgradeThreadTitle({ title: 'Fix the login bug' })).toBe(false)
  })

  it('upgrades a provisional (titleAuto:true) title even when it is a real string', () => {
    // The renderer writes the raw first message with titleAuto:true; the backend
    // must still be allowed to replace it with a summarized LLM title.
    expect(canUpgradeThreadTitle({ title: '用三个subagent更我说你好', titleAuto: true })).toBe(true)
  })

  it('never upgrades a user-locked (titleAuto:false) title', () => {
    expect(canUpgradeThreadTitle({ title: 'My pinned title', titleAuto: false })).toBe(false)
    // titleAuto:false wins even over a placeholder-looking string.
    expect(canUpgradeThreadTitle({ title: '新会话', titleAuto: false })).toBe(false)
  })
})
