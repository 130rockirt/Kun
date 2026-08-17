import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeAppSettings } from '@shared/app-settings'
import i18n from '../../i18n'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { resetPlanWorktreePreferenceStoreForTests, usePlanWorktreePreferenceStore } from '../../plan/plan-worktree-preference-store'
import { PlanBuildActions } from './PlanBuildActions'

function collectText(node: ReactTestInstance, into: string[]): void {
  for (const child of node.children) {
    if (typeof child === 'string') into.push(child)
    else if (child && typeof child === 'object' && 'children' in child) {
      collectText(child as ReactTestInstance, into)
    }
  }
}

function rendererText(renderer: ReactTestRenderer): string {
  const parts: string[] = []
  collectText(renderer.root, parts)
  return parts.join('|')
}

async function selectMode(renderer: ReactTestRenderer, mode: string): Promise<void> {
  const select = renderer.root.findByProps({ 'data-plan-build-mode': true })
  await act(async () => {
    select.props.onChange({ target: { value: mode } })
  })
}

describe('PlanBuildActions card i18n', () => {
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      kunGui: {}
    })
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    resetPlanWorktreePreferenceStoreForTests()
    usePlanWorktreePreferenceStore.getState().initializePlan('plan-1', true, 'codex/')
    vi.spyOn(rendererRuntimeClient, 'getSettings')
      .mockResolvedValue(normalizeAppSettings({} as never))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetPlanWorktreePreferenceStoreForTests()
    await i18n.changeLanguage('en')
  })

  it.each([
    ['en', 'Start build', 'Set schedule', 'Start Graph build'],
    ['zh', '开始构建', '设置定时', '开始 Graph 构建']
  ] as const)(
    'renders translated direct, scheduled, and Graph actions in %s',
    async (locale, directLabel, scheduleLabel, graphLabel) => {
      await i18n.changeLanguage(locale)
      let renderer!: ReactTestRenderer
      await act(async () => {
        renderer = create(createElement(PlanBuildActions, {
          disabled: false,
          graphEnabled: true,
          variant: 'card',
          planId: 'plan-1',
          onBuild: vi.fn()
        }))
      })

      expect(rendererText(renderer)).toContain(directLabel)
      expect(rendererText(renderer)).not.toContain('planBuildStart')

      await selectMode(renderer, 'scheduled')
      expect(rendererText(renderer)).toContain(scheduleLabel)
      expect(rendererText(renderer)).not.toContain('planScheduleBuildSet')

      await selectMode(renderer, 'graph')
      expect(rendererText(renderer)).toContain(graphLabel)
      expect(rendererText(renderer)).not.toContain('planBuildGraphStart')

      await act(async () => {
        renderer.unmount()
      })
    }
  )
})
