import { describe, expect, it } from 'vitest'
import { KnowledgeBaseError, type KnowledgeBaseService } from '../../knowledge/knowledge-base-service.js'
import { getThreadKnowledgeBases, reindexThreadKnowledgeBase } from './knowledge-bases.js'

describe('knowledge-base routes', () => {
  it('returns the mounted roots and index states for the renderer', async () => {
    const service = {
      listForThread: async () => ({
        mounts: [{
          id: 'kb_docs', root: '/tmp/docs', name: 'Docs',
          source: 'write-workspace' as const, access: 'read-only' as const
        }],
        statuses: [{ id: 'kb_docs', state: 'ready' as const, documentCount: 2, nodeCount: 5 }]
      })
    } as unknown as KnowledgeBaseService

    const response = await getThreadKnowledgeBases(service, 'thr_1')
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      mounts: [{ id: 'kb_docs', access: 'read-only' }],
      statuses: [{ id: 'kb_docs', state: 'ready' }]
    })
  })

  it('maps running-thread rebuild guards to conflict responses', async () => {
    const service = {
      reindex: async () => {
        throw new KnowledgeBaseError('thread is running', 'busy')
      }
    } as unknown as KnowledgeBaseService

    const response = await reindexThreadKnowledgeBase(service, 'thr_1', 'kb_docs')
    expect(response.status).toBe(409)
    expect(JSON.parse(response.body).code).toBe('conflict')
  })

  it('reports unavailable capability when the runtime has no service', async () => {
    expect((await getThreadKnowledgeBases(undefined, 'thr_1')).status).toBe(503)
  })
})
