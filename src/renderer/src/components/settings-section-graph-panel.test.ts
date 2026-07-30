import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  defaultKunGraphSettings,
  defaultModelProviderSettings,
  type ModelProviderProfileV1
} from '@shared/app-settings'
import { GraphModeSettingsPanel } from './settings-section-graph-panel'

describe('GraphModeSettingsPanel', () => {
  it('keeps Graph configuration but does not offer a persistent default mode', () => {
    const html = renderToStaticMarkup(createElement(GraphModeSettingsPanel, {
      t: (key: string) => key,
      value: {
        ...defaultKunGraphSettings(),
        enabled: true,
        defaultStrategy: 'graph'
      },
      modelProviders: [{
        ...defaultModelProviderSettings().providers[0]!,
        models: ['lead-model']
      }],
      leadProviderId: 'default',
      leadModel: 'lead-model',
      selectControlClass: 'select',
      onChange: () => undefined
    }))

    expect(html).toContain('graphSettingsEnable')
    expect(html).toContain('graphSettingsConcurrency')
    expect(html).toContain('graphSettingsWorkerModelMode')
    expect(html).toContain('graphSettingsWorkerModelInherit')
    expect(html).not.toContain('graphSettingsRollout')
    expect(html).not.toContain('graphSettingsDefaultStrategy')
  })

  it('configures a model-supported reasoning effort for fixed Graph workers', () => {
    const provider = defaultModelProviderSettings().providers[0]!
    const baseProfile = Object.values(provider.modelProfiles)[0]!
    const onChange = vi.fn()
    const modelProviders: ModelProviderProfileV1[] = [{
      ...provider,
      models: ['worker-model'],
      modelProfiles: {
        'worker-model': {
          ...baseProfile,
          reasoning: {
            supportedEfforts: ['low', 'high'],
            defaultEffort: 'high',
            requestProtocol: 'openai-responses'
          }
        }
      }
    }]
    const value = {
      ...defaultKunGraphSettings(),
      enabled: true,
      workerModel: {
        mode: 'fixed' as const,
        providerId: provider.id,
        model: 'worker-model',
        reasoningEffort: 'high' as const
      }
    }
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(GraphModeSettingsPanel, {
        t: (key: string) => key,
        value,
        modelProviders,
        leadProviderId: provider.id,
        leadModel: 'worker-model',
        selectControlClass: 'select',
        onChange
      }))
    })

    const reasoningSelect = renderer.root.findByProps({
      'aria-label': 'graphSettingsWorkerReasoning'
    })
    expect(reasoningSelect.props.value).toBe('high')
    expect(reasoningSelect.findAllByType('option').map((option) => option.props.value))
      .toEqual(['', 'low', 'high'])

    act(() => reasoningSelect.props.onChange({ target: { value: 'low' } }))

    expect(onChange).toHaveBeenCalledWith({
      workerModel: {
        mode: 'fixed',
        providerId: provider.id,
        model: 'worker-model',
        reasoningEffort: 'low'
      }
    })
  })
})
