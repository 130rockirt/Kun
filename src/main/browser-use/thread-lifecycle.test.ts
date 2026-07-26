import { describe, expect, it } from 'vitest'
import { browserUseCleanupForRuntimeRequest } from './thread-lifecycle'

describe('Browser Use thread lifecycle cleanup', () => {
  it('recognizes successful archive and delete operations for one exact thread route', () => {
    expect(browserUseCleanupForRuntimeRequest({
      path: '/v1/threads/thread-1',
      method: 'PATCH',
      body: JSON.stringify({ status: 'archived' })
    })).toEqual({ threadId: 'thread-1', reason: 'thread-archived' })
    expect(browserUseCleanupForRuntimeRequest({
      path: '/v1/threads/thread%202',
      method: 'DELETE'
    })).toEqual({ threadId: 'thread 2', reason: 'thread-deleted' })
  })

  it('ignores restore, read, nested, malformed, and unrelated requests', () => {
    expect(browserUseCleanupForRuntimeRequest({
      path: '/v1/threads/thread-1',
      method: 'PATCH',
      body: JSON.stringify({ status: 'idle' })
    })).toBeUndefined()
    expect(browserUseCleanupForRuntimeRequest({
      path: '/v1/threads/thread-1/turns',
      method: 'DELETE'
    })).toBeUndefined()
    expect(browserUseCleanupForRuntimeRequest({
      path: '/v1/threads/thread-1',
      method: 'PATCH',
      body: '{'
    })).toBeUndefined()
  })
})
