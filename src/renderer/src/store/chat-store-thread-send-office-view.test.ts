import { describe, expect, it } from 'vitest'
import type { ComposerContextAttachment } from '@kun/extension-api'
import { routeComposerContextsForTests } from './chat-store-thread-send'

function context(input: {
  id: string
  source: 'workspace-view' | 'dev-preview'
  kind: string
}): ComposerContextAttachment {
  const hex = input.id.padEnd(64, 'a').slice(0, 64).replace(/[^a-f0-9]/g, 'a')
  const workspaceId = 'b'.repeat(64)
  const view = input.kind === 'office-view-position'
  return {
    schemaVersion: 1,
    id: input.id,
    title: input.id,
    summary: input.id,
    reference: view ? {
      kind: input.kind, schemaVersion: 1, sourceName: 'deck.pptx', sourceFormat: 'pptx',
      sourceSha256: 'c'.repeat(64), location: { kind: 'presentation', slide: 3, slideCount: 9 }
    } : { kind: input.kind },
    revision: 1,
    generation: 0,
    attachmentId: `${input.source === 'workspace-view' ? 'workspace-view' : 'dev-preview'}-context:${hex}`,
    provenance: { source: input.source, workspaceId }
  }
}

describe('Write composer context routing', () => {
  it('admits only valid first-party current-view and PPT workflow contexts', () => {
    const currentView = context({ id: 'current', source: 'workspace-view', kind: 'office-view-position' })
    const workReference = context({ id: 'workref', source: 'workspace-view', kind: 'work-reference-office' })
    const forgedView = context({ id: 'forged', source: 'dev-preview', kind: 'office-view-position' })
    const review = context({ id: 'review', source: 'dev-preview', kind: 'ppt-review' })
    const unrelated = context({ id: 'issue', source: 'dev-preview', kind: 'issue' })

    expect(routeComposerContextsForTests(
      'write', [forgedView, review, unrelated, currentView, workReference], []
    )).toEqual([workReference, currentView, review])
  })

  it('keeps one current view first and caps the routed contexts at eight', () => {
    const firstView = context({ id: 'viewa', source: 'workspace-view', kind: 'office-view-position' })
    const secondView = context({ id: 'viewb', source: 'workspace-view', kind: 'office-view-position' })
    const workflows = Array.from({ length: 9 }, (_, index) =>
      context({ id: `review${index}`, source: 'dev-preview', kind: 'ppt-review' }))

    const routed = routeComposerContextsForTests(
      'write', [secondView, ...workflows, firstView], []
    )
    expect(routed).toHaveLength(8)
    expect(routed[0]).toBe(secondView)
    expect(routed).not.toContain(firstView)
  })
})
