import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  defaultKunGraphSettings,
  defaultModelProviderSettings
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
    expect(html).not.toContain('graphSettingsDefaultStrategy')
  })
})
