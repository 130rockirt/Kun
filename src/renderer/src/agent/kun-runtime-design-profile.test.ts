import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultKunRuntimeSettings,
  type AppSettingsV1
} from '@shared/app-settings'
import { KunRuntimeProvider } from './kun-runtime'
import { rendererRuntimeClient } from './runtime-client'

afterEach(() => {
  rendererRuntimeClient.invalidateSettings()
  vi.restoreAllMocks()
})

describe('KunRuntimeProvider Design profile', () => {
  it('sends and restores the immutable task contract', async () => {
    const submitted = {
      version: 1 as const,
      documentTarget: { documentId: 'doc_task', boardArtifactId: 'board_task' },
      outputMedium: 'image' as const,
      target: 'app' as const,
      preset: 'material' as const,
      context: { tone: ['bold'] }
    }
    const locked = { ...submitted, lockedAtTurnId: 'turn_design' }
    const designImagePlacementTarget = {
      shapeId: 'hero_holder', expectedHolderKind: 'implicit-rect' as const
    }
    vi.spyOn(rendererRuntimeClient, 'getSettings').mockResolvedValue({
      agents: { kun: defaultKunRuntimeSettings() }
    } as AppSettingsV1)
    vi.spyOn(rendererRuntimeClient, 'runtimeRequest').mockImplementation(
      async (path: string, method?: string, body?: string) => {
        expect(path).toBe('/v1/threads/thr_design/turns')
        expect(method).toBe('POST')
        expect(JSON.parse(body ?? '{}')).toMatchObject({
          prompt: 'Create an app illustration',
          agentSurface: 'design',
          designProfile: submitted,
          designDocumentTarget: submitted.documentTarget,
          designImagePlacementTarget
        })
        return {
          ok: true,
          status: 202,
          body: JSON.stringify({
            threadId: 'thr_design',
            turnId: 'turn_design',
            userMessageItemId: 'item_design',
            agentSurface: 'design',
            designProfile: locked,
            designDocumentTarget: submitted.documentTarget
          })
        }
      }
    )

    await expect(new KunRuntimeProvider().sendUserMessage(
      'thr_design',
      'Create an app illustration',
      {
        agentSurface: 'design',
        designProfile: submitted,
        designDocumentTarget: submitted.documentTarget,
        designImagePlacementTarget
      }
    )).resolves.toMatchObject({
      agentSurface: 'design',
      designProfile: locked,
      designDocumentTarget: submitted.documentTarget
    })
  })
})
