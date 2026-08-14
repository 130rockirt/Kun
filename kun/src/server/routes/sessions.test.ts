import { describe, expect, it, vi } from 'vitest'
import type { ThreadService } from '../../services/thread-service.js'
import { getResumeSessionMetadata as getResumeSessionMetadataRoute } from './sessions.js'

describe('session resume metadata route', () => {
  it('returns recoverable Design source metadata before the clone is created', async () => {
    const metadata = {
      sessionId: 'session_design',
      sourceAgentSurface: 'code' as const,
      sourceDesignProfile: {
        version: 1 as const,
        documentTarget: { documentId: 'doc_source', boardArtifactId: 'board_source' },
        outputMedium: 'html' as const,
        target: 'web' as const,
        preset: 'ios' as const,
        presetSource: 'explicit' as const,
        context: { tone: [] },
        lockedAtTurnId: 'turn_source'
      },
      sourceDesignDocumentTarget: {
        documentId: 'doc_source',
        boardArtifactId: 'board_source'
      },
      requiresIndependentDesignTarget: true
    }
    const getResumeSessionMetadata = vi.fn(async () => metadata)
    const service = { getResumeSessionMetadata } as unknown as ThreadService

    const response = await getResumeSessionMetadataRoute(service, metadata.sessionId)

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual(metadata)
    expect(getResumeSessionMetadata).toHaveBeenCalledWith(metadata.sessionId)
  })

  it('maps an unknown persisted session to not_found', async () => {
    const service = {
      getResumeSessionMetadata: vi.fn(async () => {
        throw new Error('session not found: missing')
      })
    } as unknown as ThreadService

    const response = await getResumeSessionMetadataRoute(service, 'missing')

    expect(response.status).toBe(404)
    expect(JSON.parse(response.body)).toEqual({
      code: 'not_found',
      message: 'session not found: missing'
    })
  })
})
