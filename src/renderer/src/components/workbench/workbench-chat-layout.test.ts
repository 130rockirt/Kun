import { describe, expect, it } from 'vitest'
import { shouldUseEmptyTaskLayout } from './workbench-chat-layout'

const readyEmptyState = {
  activeThreadId: 'thread-a',
  threadLoadingId: null,
  hasConversationContent: false,
  runtimeReady: true,
  hasWorkspace: true
}

describe('shouldUseEmptyTaskLayout', () => {
  it('uses the centered layout for a genuinely empty ready task', () => {
    expect(shouldUseEmptyTaskLayout(readyEmptyState)).toBe(true)
  })

  it('keeps the centered home layout while the runtime is waking', () => {
    expect(shouldUseEmptyTaskLayout({
      ...readyEmptyState,
      runtimeReady: false
    })).toBe(true)
  })

  it('keeps the conversation layout while the selected thread hydrates', () => {
    expect(shouldUseEmptyTaskLayout({
      ...readyEmptyState,
      threadLoadingId: 'thread-a'
    })).toBe(false)
  })

  it('does not let a stale background loading id suppress an empty task', () => {
    expect(shouldUseEmptyTaskLayout({
      ...readyEmptyState,
      threadLoadingId: 'thread-b'
    })).toBe(true)
  })

  it('keeps the conversation layout whenever timeline content exists', () => {
    expect(shouldUseEmptyTaskLayout({
      ...readyEmptyState,
      hasConversationContent: true
    })).toBe(false)
  })

  it('does not use the empty-task layout before a workspace is selected', () => {
    expect(shouldUseEmptyTaskLayout({
      ...readyEmptyState,
      hasWorkspace: false
    })).toBe(false)
  })
})
