import { describe, expect, it } from 'vitest'
import type { AttachmentReference } from '../agent/types'
import { routeDesignPrompt } from './design-prompt-router'
import type { DesignArtifact } from './design-types'
import type { DesignWorkspaceState } from './design-workspace-store-types'

const now = '2026-07-02T00:00:00.000Z'

function artifact(id: string, kind: DesignArtifact['kind']): DesignArtifact {
  return {
    id,
    kind,
    title: id,
    relativePath: `.kun-design/doc/${id}/${kind === 'html' ? 'v1.html' : 'canvas.json'}`,
    createdAt: now,
    updatedAt: now,
    versions: []
  }
}

function state(patch: Partial<DesignWorkspaceState> = {}) {
  return {
    workspaceRoot: '/workspace',
    artifacts: [artifact('board', 'canvas')],
    activeArtifactId: 'board',
    designIntentMode: 'generate',
    multiPageMode: false,
    pagesRun: null,
    ...patch
  } as Pick<
    DesignWorkspaceState,
    'workspaceRoot' | 'artifacts' | 'activeArtifactId' | 'designIntentMode' | 'multiPageMode' | 'pagesRun'
  >
}

const attachment: AttachmentReference = {
  id: 'att_1',
  kind: 'image',
  name: 'wireframe.png'
}

describe('design prompt router', () => {
  it('ignores empty prompts without attachments', () => {
    expect(routeDesignPrompt({
      value: '  ',
      attachments: [],
      attachmentUploadEnabled: true,
      designState: state(),
      selectedCount: 0,
      imageOnlyDisplay: 'image display',
      imageOnlyPrompt: 'image prompt'
    })).toEqual({ kind: 'ignore' })
  })

  it('blocks attachments when the selected model cannot upload them', () => {
    expect(routeDesignPrompt({
      value: 'iterate this',
      attachments: [attachment],
      attachmentUploadEnabled: false,
      designState: state(),
      selectedCount: 0,
      imageOnlyDisplay: 'image display',
      imageOnlyPrompt: 'image prompt'
    })).toEqual({ kind: 'attachment-unsupported' })
  })

  it('routes from-scratch generate briefs to the multi-page lane by default', () => {
    expect(routeDesignPrompt({
      value: 'Design an operations app',
      attachments: [],
      attachmentUploadEnabled: true,
      designState: state(),
      selectedCount: 0,
      imageOnlyDisplay: 'image display',
      imageOnlyPrompt: 'image prompt'
    })).toMatchObject({
      kind: 'multi-page',
      brief: 'Design an operations app',
      workspaceRoot: '/workspace'
    })
  })

  it('routes from-scratch briefs to the multi-page lane when explicitly enabled', () => {
    expect(routeDesignPrompt({
      value: 'Design an operations app',
      attachments: [],
      attachmentUploadEnabled: true,
      designState: state({ multiPageMode: true }),
      selectedCount: 0,
      imageOnlyDisplay: 'image display',
      imageOnlyPrompt: 'image prompt'
    })).toEqual({
      kind: 'multi-page',
      brief: 'Design an operations app',
      workspaceRoot: '/workspace'
    })
  })

  it('routes active-page briefs to the multi-page lane when explicitly enabled', () => {
    expect(routeDesignPrompt({
      value: 'Design an operations app',
      attachments: [],
      attachmentUploadEnabled: true,
      designState: state({
        artifacts: [artifact('board', 'canvas'), artifact('home', 'html')],
        activeArtifactId: 'home',
        multiPageMode: true
      }),
      selectedCount: 0,
      imageOnlyDisplay: 'image display',
      imageOnlyPrompt: 'image prompt'
    })).toEqual({
      kind: 'multi-page',
      brief: 'Design an operations app',
      workspaceRoot: '/workspace'
    })
  })

  it('builds single-turn display and prompt text for image-only sends', () => {
    expect(routeDesignPrompt({
      value: ' ',
      attachments: [attachment],
      attachmentUploadEnabled: true,
      designState: state({ artifacts: [artifact('home', 'html')], activeArtifactId: 'home' }),
      selectedCount: 0,
      imageOnlyDisplay: 'image display',
      imageOnlyPrompt: 'image prompt'
    })).toEqual({
      kind: 'single-turn',
      text: '',
      promptText: 'image prompt',
      displayText: 'image display',
      workspaceRoot: '/workspace',
      attachments: [attachment],
      attachmentIds: ['att_1'],
      shouldClearInput: true
    })
  })

  it('uses fallback workspace and preserves input when display text is explicit', () => {
    expect(routeDesignPrompt({
      value: 'Refine settings',
      displayText: 'Repair design quality',
      attachments: [],
      attachmentUploadEnabled: true,
      designState: state({
        workspaceRoot: '',
        artifacts: [artifact('settings', 'html')],
        activeArtifactId: 'settings',
        designIntentMode: 'modify'
      }),
      fallbackWorkspaceRoot: '/fallback',
      selectedCount: 0,
      imageOnlyDisplay: 'image display',
      imageOnlyPrompt: 'image prompt'
    })).toMatchObject({
      kind: 'single-turn',
      workspaceRoot: '/fallback',
      displayText: 'Repair design quality',
      promptText: 'Refine settings',
      shouldClearInput: false
    })
  })
})
