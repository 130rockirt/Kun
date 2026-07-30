import { ExtensionContributionsSchema } from '@kun/extension-api'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  ContributionRegistry,
  ExtensionWorkbenchSnapshotSchema
} from './contribution-registry'
import { ExtensionDeclarativeSettingsPane } from './ExtensionDeclarativeSettingsPane'
import type { ExtensionSettingsService } from './extension-settings-service'

function settingsContributions(titles: readonly string[]) {
  const registry = new ContributionRegistry()
  registry.replaceExtensions(ExtensionWorkbenchSnapshotSchema.parse({
    schemaVersion: 1,
    extensions: [{
      id: 'acme.settings',
      version: '1.0.0',
      enabled: true,
      compatible: true,
      workspaceTrusted: true,
      grantedPermissions: ['ui.actions'],
      contributes: ExtensionContributionsSchema.parse({
        settings: titles.map((title, index) => ({
          id: `preferences-${index + 1}`,
          title,
          scope: 'workspace',
          properties: {
            density: { type: 'integer', minimum: 1, maximum: 3, default: 2 }
          }
        }))
      })
    }]
  }))
  return registry.list('settings')
}

function contribution() {
  return settingsContributions(['Preferences'])[0]
}

describe('ExtensionDeclarativeSettingsPane', () => {
  it('loads and updates only through the injected revisioned service', async () => {
    const item = contribution()
    const load = vi.fn(async () => ({
      schemaVersion: 1 as const,
      revision: 4,
      values: { [item.id]: { density: 2 } }
    }))
    const update = vi.fn(async () => ({
      schemaVersion: 1 as const,
      revision: 5,
      values: { [item.id]: { density: 3 } }
    }))
    const service: ExtensionSettingsService = { load, update }
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(ExtensionDeclarativeSettingsPane, {
        contributions: [item],
        workspaceRoot: '/workspace',
        service
      }))
    })

    expect(load).toHaveBeenCalledWith({
      contributionIds: [item.id],
      workspaceRoot: '/workspace'
    })
    const input = renderer!.root.findByType('input')
    await act(async () => {
      input.props.onChange({ currentTarget: { value: '3' } })
    })
    expect(update).toHaveBeenCalledWith({
      contributionId: item.id,
      key: 'density',
      value: 3,
      expectedRevision: 4,
      workspaceRoot: '/workspace'
    })
    expect(renderer!.root.findByType('input').props.value).toBe(3)
  })

  it('uses persistent secondary tabs when three or more setting groups exist', async () => {
    const items = settingsContributions(['General', 'Appearance', 'Tools'])
    const load = vi.fn(async () => ({
      schemaVersion: 1 as const,
      revision: 1,
      values: Object.fromEntries(items.map((item) => [item.id, { density: 2 }]))
    }))
    const service: ExtensionSettingsService = {
      load,
      update: vi.fn()
    }
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(ExtensionDeclarativeSettingsPane, {
        contributions: items,
        workspaceRoot: '/workspace',
        service
      }))
    })

    const tabs = renderer!.root.findAll(
      (node) => node.type === 'button' && node.props.role === 'tab'
    )
    const panels = renderer!.root.findAll((node) => node.props.role === 'tabpanel')
    expect(tabs.map((tab) => tab.findByType('span').children.join(''))).toEqual([
      'General',
      'Appearance',
      'Tools'
    ])
    expect(panels).toHaveLength(3)
    expect(panels.map((panel) => panel.props.hidden)).toEqual([false, true, true])
    expect(renderer!.root.findAll(
      (node) => typeof node.props['data-contribution-id'] === 'string'
    )).toHaveLength(3)

    act(() => {
      tabs[1].props.onClick()
    })
    expect(panels.map((panel) => panel.props.hidden)).toEqual([true, false, true])
    expect(tabs.map((tab) => tab.props['aria-selected'])).toEqual([false, true, false])
  })

  it('keeps compact pages without secondary navigation', async () => {
    const items = settingsContributions(['General', 'Appearance'])
    const service: ExtensionSettingsService = {
      load: vi.fn(async () => ({
        schemaVersion: 1 as const,
        revision: 1,
        values: Object.fromEntries(items.map((item) => [item.id, { density: 2 }]))
      })),
      update: vi.fn()
    }
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(ExtensionDeclarativeSettingsPane, {
        contributions: items,
        workspaceRoot: '/workspace',
        service
      }))
    })

    expect(renderer!.root.findAll((node) => node.props.role === 'tablist')).toHaveLength(0)
    expect(renderer!.root.findAll(
      (node) => typeof node.props['data-contribution-id'] === 'string'
    )).toHaveLength(2)
  })
})
