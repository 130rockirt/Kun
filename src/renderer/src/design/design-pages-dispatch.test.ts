import { describe, expect, it, vi } from 'vitest'
import {
  buildDesignPagesRunLabels,
  buildDesignPagesRunOptions,
  runDesignPagesDispatch,
  type DesignPagesPromptState
} from './design-pages-dispatch'
import type { RunDesignPagesDeps } from './design-pages-run'

const promptState: DesignPagesPromptState = {
  assistantModel: '  deepseek-chat  ',
  assistantProviderId: '  ',
  generationPrompt: 'Use a product-grade design system.',
  designContext: { designTarget: 'web' }
}

const sendMessage: RunDesignPagesDeps['sendMessage'] = async () => true

describe('design pages dispatch', () => {
  it('builds localized labels for the multi-page runner', () => {
    const t = vi.fn((key: string, options?: Record<string, string | number>) => {
      if (!options) return key
      return `${key}:${Object.entries(options)
        .map(([name, value]) => `${name}=${value}`)
        .join(',')}`
    })
    const labels = buildDesignPagesRunLabels(t)

    expect(labels.plan?.('Ops app')).toBe('designPagesPlanDisplay:brief=Ops app')
    expect(labels.page?.('Home', 1, 3)).toBe('designPagesPageDisplay:title=Home,index=1,total=3')
    expect(labels.foundationStep?.('spec')).toBe('designFoundationStepSpec')
    expect(labels.foundationStep?.('system')).toBe('designFoundationStepSystem')
    expect(labels.foundationStep?.('logo')).toBe('designFoundationStepLogo')
    expect(labels.specDisplay?.('Ops app')).toBe('designFoundationSpecDisplay:brief=Ops app')
    expect(labels.systemDisplay?.()).toBe('designFoundationSystemDisplay')
    expect(labels.logoDisplay?.()).toBe('designFoundationLogoDisplay')
    expect(labels.systemTitle?.()).toBe('designFoundationSystemTitle')
    expect(labels.logoTitle?.()).toBe('designFoundationLogoTitle')
  })

  it('trims model settings and falls back to the composer provider resolver', () => {
    const resolveProviderId = vi.fn(() => 'deepseek')

    const options = buildDesignPagesRunOptions({
      brief: 'Design an ops app',
      workspaceRoot: '/workspace',
      sendMessage,
      promptState,
      resolveProviderId,
      reasoningEffort: 'medium',
      serviceTier: 'priority',
      expectedThreadId: 'thr_design',
      waitForRuntimeAdmission: true
    })

    expect(options).toMatchObject({
      brief: 'Design an ops app',
      workspaceRoot: '/workspace',
      model: 'deepseek-chat',
      providerId: 'deepseek',
      reasoningEffort: 'medium',
      serviceTier: 'priority',
      expectedThreadId: 'thr_design',
      waitForRuntimeAdmission: true,
      generationPrompt: 'Use a product-grade design system.',
      designContext: { designTarget: 'web' }
    })
    expect(resolveProviderId).toHaveBeenCalledWith('deepseek-chat')
  })

  it('prefers an explicit provider and omits empty optional request fields', () => {
    const resolveProviderId = vi.fn(() => 'fallback')

    const options = buildDesignPagesRunOptions({
      brief: 'Design an ops app',
      workspaceRoot: '/workspace',
      sendMessage,
      promptState: {
        assistantModel: '   ',
        assistantProviderId: ' openai ',
        generationPrompt: '',
        designContext: { designTarget: 'app' }
      },
      resolveProviderId,
      reasoningEffort: ''
    })

    expect(options.providerId).toBe('openai')
    expect(options.designContext).toEqual({ designTarget: 'app' })
    expect('model' in options).toBe(false)
    expect('generationPrompt' in options).toBe(false)
    expect('reasoningEffort' in options).toBe(false)
    expect(resolveProviderId).not.toHaveBeenCalled()
  })

  it('uses the shared composer selection for a Design task', () => {
    const options = buildDesignPagesRunOptions({
      brief: 'Design an ops app',
      workspaceRoot: '/workspace',
      sendMessage,
      promptState,
      model: 'shared-composer-model',
      providerId: 'shared-provider',
      resolveProviderId: () => 'fallback'
    })

    expect(options.model).toBe('shared-composer-model')
    expect(options.providerId).toBe('shared-provider')
  })

  it('uses the immutable task profile instead of mutable Design settings', () => {
    const options = buildDesignPagesRunOptions({
      brief: 'Design an ops app', workspaceRoot: '/workspace', sendMessage, promptState,
      resolveProviderId: () => 'deepseek',
      designProfile: {
        version: 1, documentTarget: { documentId: 'doc', boardArtifactId: 'board' },
        outputMedium: 'html', target: 'app', preset: 'ios', presetSource: 'explicit',
        context: { tone: ['calm'], density: 'compact' }
      }
    })

    expect(options.designContext).toEqual({
      designTarget: 'app', designSystemPreset: 'ios', tone: ['calm'], density: 'compact'
    })
    expect('generationPrompt' in options).toBe(false)
  })

  it('runs the injected multi-page runner with the built options', async () => {
    const runPages = vi.fn(async (_deps: RunDesignPagesDeps) => undefined)
    const onFirstSendSettled = vi.fn()

    await runDesignPagesDispatch({
      brief: 'Design an ops app',
      workspaceRoot: '/workspace',
      sendMessage,
      promptState,
      resolveProviderId: () => 'deepseek',
      onFirstSendSettled,
      runPages
    })

    expect(runPages).toHaveBeenCalledWith(expect.objectContaining({
      brief: 'Design an ops app',
      workspaceRoot: '/workspace',
      model: 'deepseek-chat',
      providerId: 'deepseek',
      generationPrompt: 'Use a product-grade design system.',
      onFirstSendSettled
    }))
  })
})
