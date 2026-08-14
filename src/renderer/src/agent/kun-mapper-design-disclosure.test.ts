import { describe, expect, it } from 'vitest'
import type { ChatBlock } from './types'
import type { CoreTurnItemJson } from './kun-contract'
import { chatBlockFromItem } from './kun-mapper'
import { applyRuntimeDisclosureMeta } from './kun-mapper-core'

function userItem(): CoreTurnItemJson {
  return {
    id: 'item_design',
    turnId: 'turn_design',
    threadId: 'thread_design',
    role: 'user',
    status: 'completed',
    kind: 'user_message',
    text: 'Design a dashboard',
    createdAt: '2026-08-12T12:00:00.000Z',
    designProfile: {
      version: 1,
      documentTarget: { documentId: 'doc_design', boardArtifactId: 'board_design' },
      outputMedium: 'html',
      target: 'web',
      preset: 'geist',
      context: { tone: ['calm'] },
      lockedAtTurnId: 'turn_design'
    },
    designDocumentTarget: { documentId: 'doc_design', boardArtifactId: 'board_design' },
    designImagePlacementTarget: {
      shapeId: 'hero_image', expectedImageUrl: '/workspace/original.png'
    }
  }
}

describe('Design runtime disclosure metadata', () => {
  it('clones the durable profile and document target onto user blocks', () => {
    const item = userItem()
    const block = chatBlockFromItem(item) as Extract<ChatBlock, { kind: 'user' }>

    expect(block.meta).toMatchObject({
      turnId: 'turn_design',
      designProfile: {
        documentTarget: { documentId: 'doc_design', boardArtifactId: 'board_design' },
        context: { tone: ['calm'] },
        lockedAtTurnId: 'turn_design'
      },
      designDocumentTarget: { documentId: 'doc_design', boardArtifactId: 'board_design' },
      designImagePlacementTarget: {
        shapeId: 'hero_image', expectedImageUrl: '/workspace/original.png'
      }
    })

    item.designProfile!.context.tone[0] = 'mutated'
    item.designProfile!.documentTarget.documentId = 'mutated'
    item.designDocumentTarget!.boardArtifactId = 'mutated'
    item.designImagePlacementTarget!.shapeId = 'mutated'
    expect(block.meta?.designProfile?.context.tone).toEqual(['calm'])
    expect(block.meta?.designProfile?.documentTarget.documentId).toBe('doc_design')
    expect(block.meta?.designDocumentTarget?.boardArtifactId).toBe('board_design')
    expect(block.meta?.designImagePlacementTarget?.shapeId).toBe('hero_image')
  })

  it('does not disclose Design routing metadata on non-user items', () => {
    const item = { ...userItem(), role: 'assistant' as const, kind: 'assistant_message' }
    const meta: Record<string, unknown> = {}
    applyRuntimeDisclosureMeta(meta, item)

    expect(meta).not.toHaveProperty('designDocumentTarget')
    expect(meta).not.toHaveProperty('designProfile')
    expect(meta).not.toHaveProperty('designImagePlacementTarget')
  })
})
