import { describe, expect, it, vi } from 'vitest'
import {
  signBrowserUseKunApprovalGrant,
  type BrowserUseToolResult,
  BrowserUseActionInput,
  type BrowserUseKunApprovalGrant
} from '../../../kun/src/contracts/browser-use'
import { ToolOperationJournal } from '../../../kun/src/reliability/operation-journal'
import type { KunBrowserUseSettingsV1 } from '../../shared/app-settings'
import type { BrowserUseViewState } from '../../shared/browser-use'
import { BrowserUseManager } from './browser-use-manager'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  WebContentsView: class {}
}))

const settings: KunBrowserUseSettingsV1 = {
  enabled: true,
  mode: 'public',
  approvalMode: 'auto-safe',
  maxTabs: 2,
  maxObservationActionsPerTurn: 30,
  maxInteractionActionsPerTurn: 12,
  maxSnapshotNodes: 250,
  maxSnapshotTextChars: 20_000,
  maxImageDimension: 1280,
  idleTimeoutMs: 300_000
}

let nextGrantId = 0
const APPROVAL_SIGNING_KEY = 's'.repeat(43)
function kunApprovalGrant(
  action: BrowserUseActionInput,
  source: BrowserUseKunApprovalGrant['source'] = 'agent',
  threadId = 'thread-1',
  turnId = 'turn-1'
): BrowserUseKunApprovalGrant {
  nextGrantId += 1
  const issuedAt = new Date()
  return signBrowserUseKunApprovalGrant({
    id: `${source === 'full-access' ? 'grant' : 'appr'}_${nextGrantId.toString(16).padStart(32, '0')}`,
    source,
    toolName: 'browser_use',
    threadId,
    turnId,
    callId: `call-browser-${nextGrantId}`,
    argumentsHash: ToolOperationJournal.argsHash(action),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 2 * 60 * 1_000).toISOString()
  }, APPROVAL_SIGNING_KEY)
}

function expectedTarget(result: BrowserUseToolResult) {
  const snapshot = result.snapshot
  const node = snapshot?.nodes.find((candidate) => candidate.ref)
  if (!snapshot || !node?.ref) {
    throw new Error('test snapshot did not contain an actionable Browser Use target')
  }
  return {
    sessionId: snapshot.sessionId,
    tabId: snapshot.tabId,
    documentGeneration: snapshot.documentGeneration,
    origin: snapshot.origin,
    sanitizedUrl: snapshot.sanitizedUrl,
    role: node.role,
    name: node.name
  }
}

function clickAction(result: BrowserUseToolResult) {
  const target = expectedTarget(result)
  const node = result.snapshot!.nodes.find((candidate) => candidate.ref)!
  return {
    action: 'click' as const,
    ref: node.ref!,
    expectedTarget: target
  }
}

function fakeHarness(settingsPatch: Partial<KunBrowserUseSettingsV1> = {}) {
  const effectiveSettings = { ...settings, ...settingsPatch }
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const debuggerListeners = new Map<string, Array<(...args: unknown[]) => void>>()
  let currentUrl = ''
  let currentTitle = 'Example'
  let currentBox = [10, 10, 110, 10, 110, 50, 10, 50]
  let currentTarget = {
    role: 'button',
    name: 'Continue',
    localName: 'button',
    nodeName: 'BUTTON',
    attributes: ['type', 'button']
  }
  const sendCommand = vi.fn(async (method: string) => {
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [{
          backendDOMNodeId: 7,
          role: { value: currentTarget.role },
          name: { value: currentTarget.name },
          properties: [{ name: 'focusable', value: { value: true } }]
        }]
      }
    }
    if (method === 'Accessibility.getPartialAXTree') {
      return {
        nodes: [{
          backendDOMNodeId: 7,
          role: { value: currentTarget.role },
          name: { value: currentTarget.name }
        }]
      }
    }
    if (method === 'DOM.describeNode') {
      return {
        node: {
          backendNodeId: 7,
          localName: currentTarget.localName,
          nodeName: currentTarget.nodeName,
          attributes: currentTarget.attributes
        }
      }
    }
    if (method === 'DOM.getBoxModel') return { model: { border: currentBox } }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'target-object' } }
    if (method === 'Runtime.callFunctionOn') return { result: { value: true } }
    return {}
  })
  const session = {
    setProxy: vi.fn(async () => undefined),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    on: vi.fn(),
    closeAllConnections: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    clearStorageData: vi.fn(async () => undefined),
    webRequest: { onBeforeRequest: vi.fn() }
  }
  const image = {
    getSize: () => ({ width: 800, height: 600 }),
    resize: () => image,
    toPNG: () => Buffer.from('bounded-image')
  }
  const webContents = {
    id: 77,
    session,
    debugger: {
      attach: vi.fn(),
      sendCommand,
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        debuggerListeners.set(event, [...(debuggerListeners.get(event) ?? []), listener])
      })
    },
    navigationHistory: {
      canGoBack: () => false,
      canGoForward: () => false
    },
    setAudioMuted: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    }),
    once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    }),
    loadURL: vi.fn(async (url: string) => {
      currentUrl = url
      for (const listener of listeners.get('did-start-loading') ?? []) listener()
      for (const listener of listeners.get('did-stop-loading') ?? []) listener()
    }),
    getURL: () => currentUrl,
    getTitle: () => currentTitle,
    capturePage: vi.fn(async () => image),
    isDestroyed: () => false,
    close: vi.fn()
  }
  const view = {
    webContents,
    setBackgroundColor: vi.fn(),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    setBorderRadius: vi.fn()
  }
  const children: unknown[] = []
  const window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 900 }),
    contentView: {
      children,
      addChildView: (child: unknown) => children.push(child),
      removeChildView: (child: unknown) => {
        const index = children.indexOf(child)
        if (index >= 0) children.splice(index, 1)
      }
    },
    webContents: {
      getZoomFactor: () => 1,
      isDestroyed: () => false,
      send: vi.fn()
    }
  }
  const proxy = {
    start: vi.fn(async () => 'http://127.0.0.1:34567'),
    stop: vi.fn(async () => undefined)
  }
  const states: BrowserUseViewState[] = []
  const manager = new BrowserUseManager({
    settings: () => effectiveSettings,
    createView: () => view as never,
    createProxy: () => proxy as never,
    onState: (state) => states.push(state)
  })
  return {
    manager,
    settings: effectiveSettings,
    states,
    view,
    webContents,
    sendCommand,
    proxy,
    window,
    setBox: (box: number[]) => {
      currentBox = box
    },
    setTarget: (target: typeof currentTarget) => {
      currentTarget = target
    },
    setTitle: (title: string) => {
      currentTitle = title
    },
    emitWebContents: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    }
  }
}

async function openAuthorized(
  harness: ReturnType<typeof fakeHarness>,
  url = 'https://example.com/start?secret=redacted'
): Promise<void> {
  const pending = harness.manager.execute(
    'thread-1',
    'turn-1',
    { action: 'open', url }
  )
  await vi.waitFor(() => {
    expect(harness.states.at(-1)?.sessionId).toBeTruthy()
  })
  harness.manager.mount(
    'thread-1',
    harness.window as never,
    { x: 10, y: 10, width: 800, height: 600 },
    true
  )
  if (harness.settings.approvalMode === 'always-ask' ||
    harness.settings.mode === 'local-development') {
    await vi.waitFor(() => {
      expect(harness.manager.stateForThread('thread-1').pendingOriginConsent).toBeTruthy()
    })
    const request = harness.manager.stateForThread('thread-1').pendingOriginConsent!
    harness.manager.decideOrigin({
      threadId: 'thread-1',
      requestId: request.id,
      decision: 'allow-once'
    })
  }
  await expect(pending).resolves.toMatchObject({ ok: true, code: 'opened' })
}

describe('BrowserUseManager', () => {
  it('opens a policy-vetted public origin in a hidden background viewport', async () => {
    const harness = fakeHarness()
    await expect(harness.manager.execute(
      'thread-1',
      'turn-1',
      { action: 'open', url: 'https://example.com/start?secret=redacted' }
    )).resolves.toMatchObject({ ok: true, code: 'opened' })

    expect(harness.webContents.loadURL).toHaveBeenCalledWith(
      'https://example.com/start?secret=redacted'
    )
    expect(harness.view.setBounds).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: 1280,
      height: 800
    })
    expect(harness.view.setVisible).toHaveBeenCalledWith(false)
    expect(harness.manager.stateForThread('thread-1')).toMatchObject({
      visible: false,
      mounted: false
    })
    expect(harness.proxy.start).toHaveBeenCalledOnce()
    expect(harness.manager.stateForThread('thread-1').pendingOriginConsent).toBeUndefined()
    expect(harness.manager.auditSnapshot().some((entry) =>
      entry.category === 'origin-consent' &&
      entry.action === 'auto-grant-public-origin' &&
      entry.decision === 'allowed' &&
      entry.origin === 'https://example.com'
    )).toBe(true)
    expect(JSON.stringify(harness.manager.auditSnapshot())).not.toContain('secret=redacted')
  })

  it('stops a cross-origin redirect and asks for a new exact-origin decision', async () => {
    const harness = fakeHarness({ approvalMode: 'always-ask' })
    const open = {
      action: 'open' as const,
      url: 'https://example.com/start?secret=redacted'
    }
    await expect(harness.manager.execute(
      'thread-1',
      'turn-1',
      open,
      undefined,
      kunApprovalGrant(open, 'user'),
      'user'
    )).resolves.toMatchObject({ ok: true, code: 'opened' })
    harness.manager.mount(
      'thread-1',
      harness.window as never,
      { x: 10, y: 10, width: 800, height: 600 },
      true
    )
    const redirectEvent = { preventDefault: vi.fn() }
    harness.emitWebContents(
      'will-redirect',
      redirectEvent,
      'https://other.example/landing?token=secret'
    )

    await vi.waitFor(() => {
      expect(harness.manager.stateForThread('thread-1').pendingOriginConsent?.origin)
        .toBe('https://other.example')
    })
    expect(redirectEvent.preventDefault).toHaveBeenCalledOnce()
    expect(harness.manager.stateForThread('thread-1').pendingOriginConsent?.sanitizedUrl)
      .toBe('https://other.example/landing')
    const request = harness.manager.stateForThread('thread-1').pendingOriginConsent!
    harness.manager.decideOrigin({
      threadId: 'thread-1',
      requestId: request.id,
      decision: 'deny'
    })
  })

  it('still requires exact-origin approval in local-development mode', async () => {
    const harness = fakeHarness({ mode: 'local-development' })
    const pending = harness.manager.execute(
      'thread-1',
      'turn-1',
      { action: 'open', url: 'http://127.0.0.1:4173/app' }
    )
    await vi.waitFor(() => {
      expect(harness.states.at(-1)?.sessionId).toBeTruthy()
    })
    harness.manager.mount(
      'thread-1',
      harness.window as never,
      { x: 10, y: 10, width: 800, height: 600 },
      true
    )
    await vi.waitFor(() => {
      expect(harness.manager.stateForThread('thread-1').pendingOriginConsent?.origin)
        .toBe('http://127.0.0.1:4173')
    })
    const request = harness.manager.stateForThread('thread-1').pendingOriginConsent!
    harness.manager.decideOrigin({
      threadId: 'thread-1',
      requestId: request.id,
      decision: 'allow-once'
    })
    await expect(pending).resolves.toMatchObject({ ok: true, code: 'opened' })
  })

  it('uses an agent Kun grant without exposing ordinary origin/action consent controls', async () => {
    const harness = fakeHarness({
      mode: 'local-development',
      approvalMode: 'always-ask'
    })
    const open = {
      action: 'open' as const,
      url: 'http://127.0.0.1:4173/app'
    }
    await expect(harness.manager.execute(
      'thread-1',
      'turn-1',
      open,
      undefined,
      kunApprovalGrant(open),
      'agent'
    )).resolves.toMatchObject({ ok: true, code: 'opened' })
    expect(harness.manager.stateForThread('thread-1').pendingOriginConsent).toBeUndefined()

    const snapshot = await harness.manager.execute(
      'thread-1',
      'turn-1',
      { action: 'snapshot' }
    )
    const click = clickAction(snapshot)
    await expect(harness.manager.execute(
      'thread-1',
      'turn-1',
      click,
      undefined,
      kunApprovalGrant(click),
      'agent'
    )).resolves.toMatchObject({ ok: true, code: 'action_executed' })

    const state = harness.manager.stateForThread('thread-1')
    expect(state.pendingOriginConsent).toBeUndefined()
    expect(state.pendingActionConsent).toBeUndefined()
    expect(harness.sendCommand).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed' })
    )
  })

  it('retains Main origin and action consent in Full access', async () => {
    const harness = fakeHarness({
      mode: 'local-development',
      approvalMode: 'always-ask'
    })
    const open = {
      action: 'open' as const,
      url: 'http://127.0.0.1:4173/app'
    }
    const pendingOpen = harness.manager.execute(
      'thread-1',
      'turn-1',
      open,
      undefined,
      kunApprovalGrant(open, 'full-access'),
      'full-access'
    )
    await vi.waitFor(() => {
      expect(harness.states.at(-1)?.sessionId).toBeTruthy()
    })
    harness.manager.mount(
      'thread-1',
      harness.window as never,
      { x: 10, y: 10, width: 800, height: 600 },
      true
    )
    await vi.waitFor(() => {
      expect(harness.manager.stateForThread('thread-1').pendingOriginConsent).toBeTruthy()
    })
    const originRequest = harness.manager.stateForThread('thread-1').pendingOriginConsent!
    harness.manager.decideOrigin({
      threadId: 'thread-1',
      requestId: originRequest.id,
      decision: 'allow-once'
    })
    await expect(pendingOpen).resolves.toMatchObject({ ok: true, code: 'opened' })

    const snapshot = await harness.manager.execute(
      'thread-1',
      'turn-1',
      { action: 'snapshot' },
      undefined,
      undefined,
      'full-access'
    )
    const click = clickAction(snapshot)
    const pendingClick = harness.manager.execute(
      'thread-1',
      'turn-1',
      click,
      undefined,
      kunApprovalGrant(click, 'full-access'),
      'full-access'
    )
    await vi.waitFor(() => {
      expect(harness.manager.stateForThread('thread-1').pendingActionConsent).toBeTruthy()
    })
    const actionRequest = harness.manager.stateForThread('thread-1').pendingActionConsent!
    harness.manager.decideAction({
      threadId: 'thread-1',
      requestId: actionRequest.id,
      decision: 'allow-once'
    })
    await expect(pendingClick).resolves.toMatchObject({ ok: true, code: 'action_executed' })
  })

  it('does not reuse a Kun-approved call for page-driven re-origin navigation', async () => {
    const harness = fakeHarness({ approvalMode: 'always-ask' })
    const open = {
      action: 'open' as const,
      url: 'https://example.com/start'
    }
    await harness.manager.execute(
      'thread-1',
      'turn-1',
      open,
      undefined,
      kunApprovalGrant(open),
      'agent'
    )

    const redirectEvent = { preventDefault: vi.fn() }
    harness.emitWebContents(
      'will-redirect',
      redirectEvent,
      'https://other.example/landing?token=secret'
    )

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(redirectEvent.preventDefault).toHaveBeenCalledOnce()
    expect(harness.webContents.loadURL).not.toHaveBeenCalledWith(
      'https://other.example/landing?token=secret'
    )
    expect(harness.manager.stateForThread('thread-1').pendingOriginConsent).toBeUndefined()
    expect(harness.manager.auditSnapshot()).toContainEqual(expect.objectContaining({
      category: 'origin-consent',
      action: 'agent-review-required',
      origin: 'https://other.example',
      decision: 'denied',
      outcome: 'blocked'
    }))
  })

  it('does not let an unsigned observation replace a signed agent route', async () => {
    const harness = fakeHarness({ approvalMode: 'always-ask' })
    const open = {
      action: 'open' as const,
      url: 'https://example.com/start'
    }
    await harness.manager.execute(
      'thread-1',
      'turn-1',
      open,
      undefined,
      kunApprovalGrant(open),
      'agent'
    )
    await harness.manager.execute(
      'thread-1',
      'turn-1',
      { action: 'snapshot' },
      undefined,
      undefined,
      'full-access'
    )

    const redirectEvent = { preventDefault: vi.fn() }
    harness.emitWebContents(
      'will-redirect',
      redirectEvent,
      'https://mode-injection.example/landing'
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(redirectEvent.preventDefault).toHaveBeenCalledOnce()
    expect(harness.webContents.loadURL).not.toHaveBeenCalledWith(
      'https://mode-injection.example/landing'
    )
    expect(harness.manager.stateForThread('thread-1').pendingOriginConsent).toBeUndefined()
    expect(harness.manager.auditSnapshot()).toContainEqual(expect.objectContaining({
      category: 'origin-consent',
      action: 'agent-review-required',
      origin: 'https://mode-injection.example',
      outcome: 'blocked'
    }))
  })

  it('keeps exact local re-origin validation after a Kun grant', async () => {
    const harness = fakeHarness({
      mode: 'local-development',
      approvalMode: 'always-ask'
    })
    const open = {
      action: 'open' as const,
      url: 'http://127.0.0.1:4173/app'
    }
    await harness.manager.execute(
      'thread-1',
      'turn-1',
      open,
      undefined,
      kunApprovalGrant(open),
      'agent'
    )

    const redirectEvent = { preventDefault: vi.fn() }
    harness.emitWebContents(
      'will-redirect',
      redirectEvent,
      'http://127.0.0.1:4174/other'
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(redirectEvent.preventDefault).toHaveBeenCalledOnce()
    expect(harness.webContents.loadURL).not.toHaveBeenCalledWith(
      'http://127.0.0.1:4174/other'
    )
    expect(harness.manager.stateForThread('thread-1').pendingOriginConsent).toBeUndefined()
  })

  it('fails closed instead of surfacing manual origin controls for agent-reviewed turns', async () => {
    const harness = fakeHarness({ approvalMode: 'always-ask' })
    const open = {
      action: 'open' as const,
      url: 'https://example.com/start'
    }
    await harness.manager.execute(
      'thread-1',
      'turn-1',
      open,
      undefined,
      kunApprovalGrant(open),
      'agent'
    )
    await harness.manager.execute(
      'thread-1',
      'turn-2',
      { action: 'snapshot' },
      undefined,
      undefined,
      'agent'
    )

    const redirectEvent = { preventDefault: vi.fn() }
    harness.emitWebContents(
      'will-redirect',
      redirectEvent,
      'https://unreviewed.example/landing'
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(redirectEvent.preventDefault).toHaveBeenCalledOnce()
    expect(harness.webContents.loadURL).not.toHaveBeenCalledWith(
      'https://unreviewed.example/landing'
    )
    expect(harness.manager.stateForThread('thread-1').pendingOriginConsent).toBeUndefined()
    expect(harness.manager.auditSnapshot()).toContainEqual(expect.objectContaining({
      category: 'origin-consent',
      action: 'agent-review-required',
      origin: 'https://unreviewed.example',
      outcome: 'blocked'
    }))
  })

  it('retains Main re-origin consent in Full access', async () => {
    const harness = fakeHarness({ approvalMode: 'always-ask' })
    const open = {
      action: 'open' as const,
      url: 'https://example.com/start'
    }
    const pendingOpen = harness.manager.execute(
      'thread-1',
      'turn-1',
      open,
      undefined,
      kunApprovalGrant(open, 'full-access'),
      'full-access'
    )
    await vi.waitFor(() => {
      expect(harness.states.at(-1)?.sessionId).toBeTruthy()
    })
    harness.manager.mount(
      'thread-1',
      harness.window as never,
      { x: 10, y: 10, width: 800, height: 600 },
      true
    )
    await vi.waitFor(() => {
      expect(harness.manager.stateForThread('thread-1').pendingOriginConsent).toBeTruthy()
    })
    const initialRequest = harness.manager.stateForThread('thread-1').pendingOriginConsent!
    harness.manager.decideOrigin({
      threadId: 'thread-1',
      requestId: initialRequest.id,
      decision: 'allow-once'
    })
    await expect(pendingOpen).resolves.toMatchObject({ ok: true, code: 'opened' })
    await harness.manager.execute(
      'thread-1',
      'turn-1',
      { action: 'snapshot' },
      undefined
    )

    const redirectEvent = { preventDefault: vi.fn() }
    harness.emitWebContents(
      'will-redirect',
      redirectEvent,
      'https://full-access.example/landing'
    )
    await vi.waitFor(() => {
      expect(harness.manager.stateForThread('thread-1').pendingOriginConsent?.origin)
        .toBe('https://full-access.example')
    })
    expect(harness.webContents.loadURL).not.toHaveBeenCalledWith(
      'https://full-access.example/landing'
    )
    const redirectRequest = harness.manager.stateForThread('thread-1').pendingOriginConsent!
    harness.manager.decideOrigin({
      threadId: 'thread-1',
      requestId: redirectRequest.id,
      decision: 'allow-once'
    })
    await vi.waitFor(() => {
      expect(harness.webContents.loadURL).toHaveBeenCalledWith(
        'https://full-access.example/landing'
      )
    })

    expect(redirectEvent.preventDefault).toHaveBeenCalledOnce()
    expect(harness.manager.stateForThread('thread-1').pendingOriginConsent).toBeUndefined()
  })

  it('redacts secret-like values from page titles before publishing state', async () => {
    const harness = fakeHarness()
    harness.setTitle('Dashboard token=top-secret api_live_1234567890')
    await openAuthorized(harness)

    const title = harness.manager.stateForThread('thread-1').tabs[0]?.title
    expect(title).toBe('Dashboard token=[redacted] [redacted]')
    expect(JSON.stringify(harness.states)).not.toContain('top-secret')
    expect(JSON.stringify(harness.states)).not.toContain('1234567890')
  })

  it('returns opaque refs and never bypasses target-specific allow-once consent', async () => {
    const harness = fakeHarness({ approvalMode: 'always-ask' })
    await openAuthorized(harness)
    const snapshot = await harness.manager.execute('thread-1', 'turn-1', { action: 'snapshot' })
    const ref = snapshot.snapshot?.nodes[0]?.ref
    expect(ref).toBeTruthy()
    expect(ref).not.toContain('button')

    const pending = harness.manager.execute(
      'thread-1',
      'turn-1',
      clickAction(snapshot)
    )
    await vi.waitFor(() => {
      expect(harness.manager.stateForThread('thread-1').pendingActionConsent).toBeTruthy()
    })
    const request = harness.manager.stateForThread('thread-1').pendingActionConsent!
    harness.manager.decideAction({
      threadId: 'thread-1',
      requestId: request.id,
      decision: 'deny'
    })

    await expect(pending).resolves.toMatchObject({ ok: false, code: 'consent_denied' })
    expect(harness.sendCommand).not.toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.anything()
    )
    expect(() => harness.manager.decideAction({
      threadId: 'thread-1',
      requestId: request.id,
      decision: 'allow-once'
    })).toThrow('stale')
    expect(JSON.stringify(harness.manager.auditSnapshot())).not.toContain('Continue')
  })

  it('auto-executes a validated low-risk public interaction without a consent prompt', async () => {
    const harness = fakeHarness()
    await expect(harness.manager.execute(
      'thread-1',
      'turn-1',
      { action: 'open', url: 'https://example.com/start' }
    )).resolves.toMatchObject({ ok: true, code: 'opened' })
    const snapshot = await harness.manager.execute('thread-1', 'turn-1', { action: 'snapshot' })

    await expect(harness.manager.execute(
      'thread-1',
      'turn-1',
      clickAction(snapshot)
    )).resolves.toMatchObject({ ok: true, code: 'action_executed' })

    expect(harness.manager.stateForThread('thread-1').pendingActionConsent).toBeUndefined()
    expect(harness.sendCommand).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed' })
    )
    expect(harness.manager.auditSnapshot()).toContainEqual(expect.objectContaining({
      category: 'action-consent',
      action: 'auto-click',
      decision: 'allowed',
      outcome: 'success'
    }))
  })

  it('keeps public page refs usable when the floating preview is closed', async () => {
    const harness = fakeHarness()
    await openAuthorized(harness)
    const snapshot = await harness.manager.execute('thread-1', 'turn-1', { action: 'snapshot' })

    harness.manager.mount(
      'thread-1',
      harness.window as never,
      { x: 10, y: 10, width: 420, height: 640 },
      false,
      false
    )

    expect(harness.manager.stateForThread('thread-1')).toMatchObject({
      visible: false,
      mounted: true,
      controlOwner: 'agent'
    })
    await expect(harness.manager.execute(
      'thread-1',
      'turn-1',
      clickAction(snapshot)
    )).resolves.toMatchObject({ ok: true, code: 'action_executed' })
  })

  it('never auto-executes a transaction commit target', async () => {
    const harness = fakeHarness()
    harness.setTarget({
      role: 'button',
      name: 'Place order',
      localName: 'button',
      nodeName: 'BUTTON',
      attributes: ['type', 'button']
    })
    await openAuthorized(harness)
    const snapshot = await harness.manager.execute('thread-1', 'turn-1', { action: 'snapshot' })

    await expect(harness.manager.execute(
      'thread-1',
      'turn-1',
      clickAction(snapshot)
    )).resolves.toMatchObject({
      ok: false,
      code: 'manual_interaction_required'
    })
    expect(harness.manager.stateForThread('thread-1').pendingActionConsent).toBeUndefined()
    expect(harness.sendCommand).not.toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.anything()
    )
  })

  it('does not let a Kun grant bypass live target fingerprint validation', async () => {
    const harness = fakeHarness({ approvalMode: 'always-ask' })
    const open = {
      action: 'open' as const,
      url: 'https://example.com/start'
    }
    await harness.manager.execute(
      'thread-1',
      'turn-1',
      open,
      undefined,
      kunApprovalGrant(open),
      'agent'
    )
    const snapshot = await harness.manager.execute(
      'thread-1',
      'turn-1',
      { action: 'snapshot' }
    )
    const click = clickAction(snapshot)
    harness.setBox([20, 20, 120, 20, 120, 60, 20, 60])

    await expect(harness.manager.execute(
      'thread-1',
      'turn-1',
      click,
      undefined,
      kunApprovalGrant(click),
      'agent'
    )).resolves.toMatchObject({ ok: false, code: 'stale_reference' })
    expect(harness.manager.stateForThread('thread-1').pendingActionConsent).toBeUndefined()
    expect(harness.sendCommand).not.toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.anything()
    )
  })

  it.each([
    ['sessionId', 'different-session-1234567890'],
    ['tabId', 'different-tab'],
    ['documentGeneration', 99],
    ['origin', 'https://other.example'],
    ['sanitizedUrl', 'https://example.com/other-path'],
    ['role', 'link'],
    ['name', 'Different target']
  ] as const)('rejects a reviewer-visible expectedTarget %s substitution', async (field, value) => {
    const harness = fakeHarness({ approvalMode: 'always-ask' })
    const open = {
      action: 'open' as const,
      url: 'https://example.com/start'
    }
    await harness.manager.execute(
      'thread-1',
      'turn-1',
      open,
      undefined,
      kunApprovalGrant(open),
      'agent'
    )
    const snapshot = await harness.manager.execute(
      'thread-1',
      'turn-1',
      { action: 'snapshot' }
    )
    const click = clickAction(snapshot)
    const substituted = {
      ...click,
      expectedTarget: {
        ...click.expectedTarget,
        [field]: value
      }
    }

    await expect(harness.manager.execute(
      'thread-1',
      'turn-1',
      substituted,
      undefined,
      kunApprovalGrant(substituted),
      'agent'
    )).resolves.toMatchObject({
      ok: false,
      code: 'target_binding_mismatch'
    })
    expect(harness.sendCommand).not.toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.anything()
    )
  })

  it.each([
    {
      role: 'textbox',
      name: 'Password',
      localName: 'input',
      nodeName: 'INPUT',
      attributes: ['type', 'password']
    },
    {
      role: 'textbox',
      name: 'Enter CAPTCHA',
      localName: 'input',
      nodeName: 'INPUT',
      attributes: ['type', 'text', 'aria-label', 'Human verification CAPTCHA']
    },
    {
      role: 'textbox',
      name: 'Email',
      localName: 'input',
      nodeName: 'INPUT',
      attributes: ['type', 'email', 'autocomplete', 'username']
    }
  ])('never issues an actionable ref for sensitive targets %#', async (target) => {
    const harness = fakeHarness()
    harness.setTarget(target)
    await openAuthorized(harness)
    const snapshot = await harness.manager.execute('thread-1', 'turn-1', { action: 'snapshot' })
    expect(snapshot.snapshot?.nodes[0]).toMatchObject({ sensitive: true })
    expect(snapshot.snapshot?.nodes[0]?.ref).toBeUndefined()
    expect(snapshot.snapshot?.nodes[0]?.value).toBeUndefined()
  })

  it('rejects a live geometry mutation after consent instead of replaying the click', async () => {
    const harness = fakeHarness({ approvalMode: 'always-ask' })
    await openAuthorized(harness)
    const snapshot = await harness.manager.execute('thread-1', 'turn-1', { action: 'snapshot' })
    const pending = harness.manager.execute(
      'thread-1',
      'turn-1',
      clickAction(snapshot)
    )
    await vi.waitFor(() => {
      expect(harness.manager.stateForThread('thread-1').pendingActionConsent).toBeTruthy()
    })
    harness.setBox([20, 20, 120, 20, 120, 60, 20, 60])
    const request = harness.manager.stateForThread('thread-1').pendingActionConsent!
    harness.manager.decideAction({
      threadId: 'thread-1',
      requestId: request.id,
      decision: 'allow-once'
    })

    await expect(pending).resolves.toMatchObject({ ok: false, code: 'target_changed' })
    expect(harness.sendCommand).not.toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.anything()
    )
  })

  it.each([
    ['same-origin path', async (harness: ReturnType<typeof fakeHarness>) => {
      await harness.webContents.loadURL('https://example.com/changed-after-consent')
    }],
    ['target name', async (harness: ReturnType<typeof fakeHarness>) => {
      harness.setTarget({
        role: 'button',
        name: 'Delete account',
        localName: 'button',
        nodeName: 'BUTTON',
        attributes: ['type', 'button']
      })
    }]
  ] as const)(
    'rechecks the reviewer-visible %s after Main consent before sending input',
    async (_case, mutate) => {
      const harness = fakeHarness({ approvalMode: 'always-ask' })
      await openAuthorized(harness)
      const snapshot = await harness.manager.execute(
        'thread-1',
        'turn-1',
        { action: 'snapshot' }
      )
      const pending = harness.manager.execute(
        'thread-1',
        'turn-1',
        clickAction(snapshot)
      )
      await vi.waitFor(() => {
        expect(harness.manager.stateForThread('thread-1').pendingActionConsent).toBeTruthy()
      })
      await mutate(harness)
      const request = harness.manager.stateForThread('thread-1').pendingActionConsent!
      harness.manager.decideAction({
        threadId: 'thread-1',
        requestId: request.id,
        decision: 'allow-once'
      })

      await expect(pending).resolves.toMatchObject({
        ok: false,
        code: 'target_binding_mismatch'
      })
      expect(harness.sendCommand).not.toHaveBeenCalledWith(
        'Input.dispatchMouseEvent',
        expect.anything()
      )
      expect(harness.sendCommand).not.toHaveBeenCalledWith(
        'Input.insertText',
        expect.anything()
      )
    }
  )

  it('cancels a pending decision when the owning supervision surface is hidden', async () => {
    const harness = fakeHarness({ approvalMode: 'always-ask' })
    await openAuthorized(harness)
    const snapshot = await harness.manager.execute('thread-1', 'turn-1', { action: 'snapshot' })
    const pending = harness.manager.execute(
      'thread-1',
      'turn-1',
      clickAction(snapshot)
    )
    await vi.waitFor(() => {
      expect(harness.manager.stateForThread('thread-1').pendingActionConsent).toBeTruthy()
    })

    harness.manager.mount(
      'thread-1',
      harness.window as never,
      { x: 10, y: 10, width: 800, height: 600 },
      false,
      false
    )

    await expect(pending).resolves.toMatchObject({ ok: false, code: 'consent_cancelled' })
    expect(harness.sendCommand).not.toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.anything()
    )
  })

  it('revokes refs during manual takeover and destroys temporary session state', async () => {
    const harness = fakeHarness()
    await openAuthorized(harness)
    const blockedMouse = { preventDefault: vi.fn() }
    harness.emitWebContents('before-mouse-event', blockedMouse)
    expect(blockedMouse.preventDefault).toHaveBeenCalledOnce()

    const snapshot = await harness.manager.execute('thread-1', 'turn-1', { action: 'snapshot' })
    const click = clickAction(snapshot)
    harness.manager.setControlOwner('thread-1', 'manual')
    const manualMouse = { preventDefault: vi.fn() }
    harness.emitWebContents('before-mouse-event', manualMouse)
    expect(manualMouse.preventDefault).not.toHaveBeenCalled()
    await expect(harness.manager.execute(
      'thread-1',
      'turn-1',
      click
    )).resolves.toMatchObject({ ok: false, code: 'manual_control_active' })

    harness.manager.setControlOwner('thread-1', 'agent')
    await expect(harness.manager.execute(
      'thread-1',
      'turn-1',
      click
    )).resolves.toMatchObject({ ok: false, code: 'stale_reference' })

    await expect(harness.manager.clear('thread-1')).resolves.toBe(true)
    expect(harness.webContents.close).toHaveBeenCalledOnce()
    expect(harness.proxy.stop).toHaveBeenCalledOnce()
    const closedState = harness.manager.stateForThread('thread-1')
    expect(closedState.lifecycle).toBe('closed')
    expect(closedState).not.toHaveProperty('sessionId')
  })

  it('returns manual control to the agent when the floating preview closes', async () => {
    const harness = fakeHarness()
    await openAuthorized(harness)
    harness.manager.setControlOwner('thread-1', 'manual')

    harness.manager.mount(
      'thread-1',
      harness.window as never,
      { x: 10, y: 10, width: 420, height: 640 },
      false,
      false
    )

    expect(harness.manager.stateForThread('thread-1')).toMatchObject({
      visible: false,
      controlOwner: 'agent',
      lifecycle: 'ready'
    })
    expect(harness.webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
  })

  it('keeps Stop fail-closed until the user clears the session', async () => {
    const harness = fakeHarness()
    await openAuthorized(harness)
    expect(harness.manager.stop('thread-1').lifecycle).toBe('stopped')
    await expect(harness.manager.execute('thread-1', 'turn-2', { action: 'snapshot' }))
      .resolves.toMatchObject({ ok: false, code: 'session_stopped' })
    await expect(harness.manager.execute('thread-1', 'turn-2', {
      action: 'open',
      url: 'https://example.com/again'
    })).resolves.toMatchObject({ ok: false, code: 'session_stopped' })
    await expect(harness.manager.clear('thread-1')).resolves.toBe(true)
  })
})
