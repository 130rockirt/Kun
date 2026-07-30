import { describe, expect, it } from 'vitest'
import {
  defaultKunGraphSettings,
  defaultKunRuntimeSettings,
  mergeKunRuntimeSettings,
  normalizeAppSettings,
  normalizeKunGraphSettings,
  type AppSettingsV1
} from './app-settings'

describe('Kun Graph settings', () => {
  it('keeps Graph disabled and direct for old settings', () => {
    const legacy = defaultKunRuntimeSettings() as Partial<ReturnType<typeof defaultKunRuntimeSettings>>
    delete legacy.graph
    const normalized = normalizeAppSettings({
      version: 1,
      agents: { kun: legacy }
    } as unknown as AppSettingsV1)

    expect(normalized.agents.kun.graph).toEqual(defaultKunGraphSettings())
    expect(normalized.agents.kun.graph.enabled).toBe(false)
    expect(normalized.agents.kun.graph.defaultStrategy).toBe('direct')
    expect(normalized.agents.kun.graph.rolloutStage).toBe('stable')
    expect(normalized.agents.kun.graph.workerModel).toEqual({ mode: 'inherit' })
    expect(normalized.agents.kun.graph.scheduler.maxRunWallTimeMs)
      .toBe(7 * 24 * 60 * 60 * 1_000)
  })

  it('migrates legacy rollout cohorts to the complete stable capability set', () => {
    expect(normalizeKunGraphSettings({
      ...defaultKunGraphSettings(),
      rolloutStage: 'experimental'
    }).rolloutStage).toBe('stable')
  })

  it('normalizes invalid and over-broad values to host bounds', () => {
    const normalized = normalizeKunGraphSettings({
      enabled: false,
      defaultStrategy: 'graph',
      scheduler: {
        ...defaultKunGraphSettings().scheduler,
        maxConcurrentNodes: 2,
        maxConcurrentNodesPerRun: 99,
        maxAttemptsPerNode: 999,
        maxLoopIterations: -1,
        budgetWarningRatio: 4
      },
      learning: {
        ...defaultKunGraphSettings().learning,
        mode: 'off',
        allowReadOnlyExploration: true
      }
    })

    expect(normalized.defaultStrategy).toBe('direct')
    expect(normalized.scheduler.maxConcurrentNodesPerRun).toBe(2)
    expect(normalized.scheduler.maxAttemptsPerNode).toBe(20)
    expect(normalized.scheduler.maxLoopIterations).toBe(5)
    expect(normalized.scheduler.budgetWarningRatio).toBe(0.8)
    expect(normalized.learning.allowReadOnlyExploration).toBe(false)
  })

  it('deep-merges a partial Graph patch without resetting sibling policy', () => {
    const current = mergeKunRuntimeSettings(defaultKunRuntimeSettings(), {
      graph: {
        enabled: true,
        scheduler: { maxConcurrentNodes: 12 },
        learning: { mode: 'suggest' }
      }
    })
    const next = mergeKunRuntimeSettings(current, {
      graph: {
        scheduler: { maxConcurrentNodesPerRun: 3 }
      }
    })

    expect(next.graph).toMatchObject({
      enabled: true,
      defaultStrategy: 'direct',
      scheduler: {
        maxConcurrentNodes: 12,
        maxConcurrentNodesPerRun: 3
      },
      learning: { mode: 'suggest' }
    })
  })

  it('normalizes and deep-merges a fixed worker model policy', () => {
    const fixed = mergeKunRuntimeSettings(defaultKunRuntimeSettings(), {
      graph: {
        workerModel: {
          mode: 'fixed',
          providerId: 'provider-b',
          model: 'worker-model',
          reasoningEffort: 'high'
        }
      }
    })
    const updated = mergeKunRuntimeSettings(fixed, {
      graph: {
        workerModel: { model: 'worker-model-2' }
      }
    })

    expect(updated.graph.workerModel).toEqual({
      mode: 'fixed',
      providerId: 'provider-b',
      model: 'worker-model-2',
      reasoningEffort: 'high'
    })
    expect(normalizeKunGraphSettings({
      ...defaultKunGraphSettings(),
      workerModel: {
        mode: 'fixed',
        providerId: '',
        model: ''
      }
    }).workerModel).toEqual({ mode: 'inherit' })

    expect(normalizeKunGraphSettings({
      ...defaultKunGraphSettings(),
      workerModel: {
        mode: 'fixed',
        providerId: 'provider-b',
        model: 'worker-model',
        reasoningEffort: 'invalid'
      }
    } as unknown as Parameters<typeof normalizeKunGraphSettings>[0]).workerModel).toEqual({
      mode: 'fixed',
      providerId: 'provider-b',
      model: 'worker-model'
    })
  })

  it('drops unknown persisted keys during normalization', () => {
    const normalized = normalizeAppSettings({
      version: 1,
      agents: {
        kun: {
          ...defaultKunRuntimeSettings(),
          graph: {
            ...defaultKunGraphSettings(),
            unknownPolicy: 'ignored'
          }
        }
      }
    } as unknown as AppSettingsV1)

    expect(normalized.agents.kun.graph).not.toHaveProperty('unknownPolicy')
  })

  it('drops the legacy Graph token ceiling during normalization', () => {
    const normalized = normalizeKunGraphSettings({
      ...defaultKunGraphSettings(),
      scheduler: {
        ...defaultKunGraphSettings().scheduler,
        maxTotalTokens: 1
      }
    } as Parameters<typeof normalizeKunGraphSettings>[0])

    expect(normalized.scheduler).not.toHaveProperty('maxTotalTokens')
  })
})
