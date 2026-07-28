import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../store/chat-store'
import type { ChatState } from '../store/chat-store-types'
import { createGuiPlanArtifact, useGuiPlanStore } from '../plan/plan-store'
import {
  buildDraftGuiPlanTurnOverrides,
  buildGuiPlanTurnOverrides,
  resolveAssociatedGuiPlan,
  resolvePlanTurnWorkspaceRoot,
  shouldAutoOpenPlanPanel,
  useWorkbenchPlanController
} from './workbench-plan-controller'

describe('workbench plan controller helpers', () => {
  it('prefers an explicit target workspace over stale workbench state', () => {
    expect(resolvePlanTurnWorkspaceRoot('/Users/codex/sdd-workspace/', '/Users/codex/stale-workspace')).toBe(
      '/Users/codex/sdd-workspace'
    )
    expect(resolvePlanTurnWorkspaceRoot(undefined, '/Users/codex/current-workspace/')).toBe(
      '/Users/codex/current-workspace'
    )
  })

  it('builds refine context only for the current plan workspace and thread', () => {
    const plan = createGuiPlanArtifact({
      workspaceRoot: '/Users/codex/app/',
      threadId: 'thread-current',
      relativePath: '.kunsdd/plan/checkout.md',
      sourceRequest: 'Improve checkout',
      now: 1
    })

    expect(buildGuiPlanTurnOverrides(plan, '/Users/codex/app', 'thread-current')).toMatchObject({
      guiPlan: {
        operation: 'refine',
        workspaceRoot: '/Users/codex/app',
        relativePath: '.kunsdd/plan/checkout.md',
        planId: '/Users/codex/app:.kunsdd/plan/checkout.md',
        sourceRequest: 'Improve checkout'
      }
    })
    expect(buildGuiPlanTurnOverrides(plan, '/Users/codex/app', 'thread-stale')).toBeUndefined()
    expect(buildGuiPlanTurnOverrides(plan, '/Users/codex/other', 'thread-current')).toBeUndefined()
  })

  it('restores a remembered thread plan when the panel state is empty', () => {
    const remembered = createGuiPlanArtifact({
      workspaceRoot: '/Users/codex/app',
      threadId: 'thread-current',
      relativePath: '.kunsdd/plan/checkout.md',
      sourceRequest: 'Improve checkout',
      now: 1
    })

    expect(resolveAssociatedGuiPlan(null, remembered, '/Users/codex/app', 'thread-current')).toBe(remembered)
    expect(resolveAssociatedGuiPlan(null, remembered, '/Users/codex/app', 'thread-other')).toBeNull()
    expect(resolveAssociatedGuiPlan(null, remembered, '/Users/codex/other', 'thread-current')).toBeNull()
  })

  it('auto-opens the plan panel only for a plan generated in the active thread', () => {
    // Freshly generated in the active thread → open.
    expect(shouldAutoOpenPlanPanel('thread-a', 'thread-a')).toBe(true)
    // Plan turn started in thread A, but we switched to thread B → do not open.
    expect(shouldAutoOpenPlanPanel('thread-a', 'thread-b')).toBe(false)
    // Thread reload / no plan turn in flight → do not open.
    expect(shouldAutoOpenPlanPanel(null, 'thread-a')).toBe(false)
    expect(shouldAutoOpenPlanPanel(null, null)).toBe(false)
  })

  it('builds draft context for first-class GUI plan turns', () => {
    const result = buildDraftGuiPlanTurnOverrides({
      request: 'Build Login: OAuth / SSO?',
      workspaceRoot: '/Users/codex/app/',
      activeThreadId: 'thread-current',
      existingRelativePaths: ['.kunsdd/plan/build-login-oauth-sso.md']
    })

    expect(result.guiPlan).toEqual({
      operation: 'draft',
      workspaceRoot: '/Users/codex/app',
      relativePath: '.kunsdd/plan/build-login-oauth-sso-2.md',
      planId: '/Users/codex/app:.kunsdd/plan/build-login-oauth-sso-2.md',
      sourceRequest: 'Build Login: OAuth / SSO?',
      title: 'build-login-oauth-sso-2'
    })
  })
})

describe('workbench plan build orchestration', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    useChatStore.setState({
      busy: false,
      runtimeConnection: 'ready',
      graphEnabled: true,
      composerOrchestration: 'direct',
      route: 'chat'
    })
    const plan = createGuiPlanArtifact({
      workspaceRoot: '/Users/codex/app',
      threadId: 'thread-current',
      relativePath: '.kunsdd/plan/checkout.md',
      sourceRequest: 'Improve checkout',
      now: 1
    })
    useGuiPlanStore.setState({
      activePlan: plan,
      content: '# Latest plan',
      lastSavedContent: '# Previous plan',
      saveStatus: 'dirty',
      operationStatus: 'ready',
      error: null
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.unstubAllGlobals()
  })

  function controllerHarness(options: {
    sendMessage: ChatState['sendMessage']
    setComposerMode?: ChatState['setComposerMode']
    setError?: ChatState['setError']
  }): ReturnType<typeof useWorkbenchPlanController> {
    let controller: ReturnType<typeof useWorkbenchPlanController> | null = null
    const setComposerMode = options.setComposerMode ?? vi.fn()
    const setError = options.setError ?? vi.fn()

    function Harness(): null {
      controller = useWorkbenchPlanController({
        blocks: [],
        busy: false,
        mode: 'agent',
        route: 'chat',
        sendMessage: options.sendMessage,
        setError,
        setComposerMode,
        setRightPanelMode: vi.fn(),
        setRightSidebarWidth: vi.fn(),
        t: (key) => key,
        workspaceRoot: '/Users/codex/app'
      })
      return null
    }

    act(() => {
      renderer = create(createElement(Harness))
    })
    if (!controller) throw new Error('Plan controller did not initialize')
    return controller
  }

  it('saves first and sends an explicit Direct build without changing the composer selection', async () => {
    const callOrder: string[] = []
    const writeWorkspaceFile = vi.fn(async () => {
      callOrder.push('save')
      return {
        ok: true as const,
        path: '/Users/codex/app/.kunsdd/plan/checkout.md',
        savedAt: '2026-07-29T00:00:00.000Z'
      }
    })
    vi.stubGlobal('window', { kunGui: { writeWorkspaceFile } })
    useChatStore.setState({ composerOrchestration: 'graph' })
    const sendMessage = vi.fn(async () => {
      callOrder.push('send')
      return true
    })
    const setComposerMode = vi.fn()
    const controller = controllerHarness({ sendMessage, setComposerMode })

    await act(async () => {
      await controller.buildGuiPlan('direct')
    })

    expect(callOrder).toEqual(['save', 'send'])
    expect(writeWorkspaceFile).toHaveBeenCalledWith({
      workspaceRoot: '/Users/codex/app',
      path: '.kunsdd/plan/checkout.md',
      content: '# Latest plan'
    })
    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('orchestration selected for this turn'),
      'agent',
      {
        displayText: 'planBuildDirect: .kunsdd/plan/checkout.md',
        orchestration: 'direct'
      }
    )
    expect(setComposerMode).toHaveBeenCalledWith('agent')
    expect(useChatStore.getState().composerOrchestration).toBe('graph')
  })

  it('sends an explicit Graph build without selecting Graph for later messages', async () => {
    vi.stubGlobal('window', {
      kunGui: {
        writeWorkspaceFile: vi.fn(async () => ({
          ok: true as const,
          path: '/Users/codex/app/.kunsdd/plan/checkout.md',
          savedAt: '2026-07-29T00:00:00.000Z'
        }))
      }
    })
    useChatStore.setState({ composerOrchestration: 'direct' })
    const sendMessage = vi.fn(async () => true)
    const controller = controllerHarness({ sendMessage })

    await act(async () => {
      await controller.buildGuiPlan('graph')
    })

    expect(sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      'agent',
      {
        displayText: 'planBuildGraph: .kunsdd/plan/checkout.md',
        orchestration: 'graph'
      }
    )
    expect(useChatStore.getState().composerOrchestration).toBe('direct')
  })

  it('does not save or send a Graph build when Graph is disabled', async () => {
    const writeWorkspaceFile = vi.fn()
    vi.stubGlobal('window', { kunGui: { writeWorkspaceFile } })
    useChatStore.setState({ graphEnabled: false })
    const sendMessage = vi.fn()
    const setError = vi.fn()
    const controller = controllerHarness({ sendMessage, setError })

    await act(async () => {
      await controller.buildGuiPlan('graph')
    })

    expect(writeWorkspaceFile).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledWith('graphModeDisabledHint')
  })

  it('does not save or send while another turn runs or the plan is already saving', async () => {
    const writeWorkspaceFile = vi.fn()
    vi.stubGlobal('window', { kunGui: { writeWorkspaceFile } })
    const sendMessage = vi.fn()
    const setError = vi.fn()
    const controller = controllerHarness({ sendMessage, setError })

    useChatStore.setState({ busy: true })
    await act(async () => {
      await controller.buildGuiPlan('direct')
    })

    expect(writeWorkspaceFile).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledWith('composerQueuePlaceholder')

    useChatStore.setState({ busy: false })
    useGuiPlanStore.setState({ saveStatus: 'saving' })
    await act(async () => {
      await controller.buildGuiPlan('graph')
    })

    expect(writeWorkspaceFile).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('does not send when the runtime is offline or saving the plan fails', async () => {
    const writeWorkspaceFile = vi.fn(async () => ({
      ok: false as const,
      message: 'disk full'
    }))
    vi.stubGlobal('window', { kunGui: { writeWorkspaceFile } })
    const sendMessage = vi.fn()
    const setError = vi.fn()
    const offlineController = controllerHarness({ sendMessage, setError })
    useChatStore.setState({ runtimeConnection: 'offline' })

    await act(async () => {
      await offlineController.buildGuiPlan('direct')
    })

    expect(writeWorkspaceFile).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledWith('runtimeActionNeedsConnection')

    useChatStore.setState({ runtimeConnection: 'ready' })
    await act(async () => {
      await offlineController.buildGuiPlan('direct')
    })

    expect(writeWorkspaceFile).toHaveBeenCalledOnce()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(useGuiPlanStore.getState()).toMatchObject({
      saveStatus: 'error',
      error: 'disk full'
    })
  })
})
