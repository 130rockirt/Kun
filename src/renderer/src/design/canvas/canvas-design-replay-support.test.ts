import { describe, expect, it, vi } from 'vitest'
import { createEmptyDocument, createHtmlFrameShape } from './canvas-types'
import {
  commitReadyCanvasReplayBarriers,
  dispatchNextPendingScreen,
  hasDispatchedScreenFollowup
} from './canvas-design-replay-support'

describe('durable Design follow-up replay support', () => {
  it('recognizes an already admitted HTML follow-up from its reserved artifact path', () => {
    expect(hasDispatchedScreenFollowup([{
      kind: 'user', id: 'screen-followup',
      text: 'Reserved artifact file: .kun-design/doc/home/v1.html\nBuild the screen.'
    }], '.kun-design/doc/home/v1.html')).toBe(true)
    expect(hasDispatchedScreenFollowup([], '.kun-design/doc/home/v1.html')).toBe(false)
  })

  it('does not let an older follow-up suppress a newer turn for the same artifact path', () => {
    const path = '.kun-design/doc/home/v1.html'
    const blocks = [
      { kind: 'user' as const, id: 'old-source', turnId: 'old-turn', text: 'old request' },
      { kind: 'user' as const, id: 'old-followup', text: `Reserved artifact file: ${path}` },
      { kind: 'user' as const, id: 'new-source', turnId: 'new-turn', text: 'new request' }
    ]
    expect(hasDispatchedScreenFollowup(blocks, path, 'new-turn')).toBe(false)
    expect(hasDispatchedScreenFollowup(blocks, path, 'old-turn')).toBe(true)
    const legacy = [...blocks, { kind: 'user' as const, id: 'legacy-source', text: 'legacy' }]
    expect(hasDispatchedScreenFollowup(legacy, path, 'legacy-source')).toBe(false)
  })

  it('never advances the watermark beyond an earlier turn with pending follow-ups', () => {
    const barriers = new Map([
      ['turn-1', {
        pendingScreenIds: new Set(['screen-1']), pendingSvgBlockIds: new Set<string>(),
        replayComplete: true
      }],
      ['turn-2', {
        pendingScreenIds: new Set<string>(), pendingSvgBlockIds: new Set<string>(),
        replayComplete: true
      }]
    ])
    const committed: string[] = []
    commitReadyCanvasReplayBarriers(barriers, (turnId) => committed.push(turnId))
    expect(committed).toEqual([])
    barriers.get('turn-1')?.pendingScreenIds.clear()
    commitReadyCanvasReplayBarriers(barriers, (turnId) => committed.push(turnId))
    expect(committed).toEqual(['turn-1', 'turn-2'])
  })

  it('keeps a rejected HTML follow-up retryable', async () => {
    const document = createEmptyDocument()
    const frame = createHtmlFrameShape('Home', 0, 0, 'artifact-home', 'desktop')
    document.objects[frame.id] = frame
    const pendingScreens = [{
      shapeId: frame.id, userPrompt: 'home', sourceTurnId: 'turn-home'
    }]
    await expect(dispatchNextPendingScreen({
      pendingScreens, document, currentTurnId: null, busy: false,
      pendingRuntimeWork: false, htmlArtifactIds: new Set(['artifact-home']),
      onDrop: vi.fn(), onDispatch: vi.fn().mockRejectedValue(new Error('thread switched'))
    })).resolves.toMatchObject({ status: 'failed' })
    expect(pendingScreens).toEqual([expect.objectContaining({
      shapeId: frame.id, sourceTurnId: 'turn-home', attempts: 1
    })])
  })
})
