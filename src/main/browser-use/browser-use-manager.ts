import { createHash, randomBytes } from 'node:crypto'
import {
  BrowserWindow,
  WebContentsView,
  type Rectangle
} from 'electron'
import type {
  BrowserUseActionConsentRequest,
  BrowserUseAuditEntry,
  BrowserUseBudgetState,
  BrowserUseDecisionInput,
  BrowserUseMode,
  BrowserUseOriginConsentRequest,
  BrowserUseRect,
  BrowserUseViewState
} from '../../shared/browser-use'
import type { KunBrowserUseSettingsV1 } from '../../shared/app-settings'
import {
  BrowserUseActionInput,
  BrowserUseToolResult,
  type BrowserUseActionInput as BrowserUseAction,
  type BrowserUseSnapshot,
  type BrowserUseSnapshotNode,
  type BrowserUseToolResult as BrowserUseResult
} from '../../../kun/src/contracts/browser-use.js'
import {
  hardenRemoteSession,
  hardenedRemoteWebPreferences
} from '../browser-security/web-contents-hardening'
import {
  BrowserUseNetworkPolicyError,
  BrowserUsePolicyProxy,
  browserUseProxyConfiguration,
  normalizeBrowserUseOrigin,
  sanitizeBrowserUseUrl
} from './network-policy'

const ORIGIN_DECISION_TIMEOUT_MS = 60_000
const ACTION_DECISION_TIMEOUT_MS = 30_000
const MOUNT_TIMEOUT_MS = 15_000
const PREPARED_ACTION_TTL_MS = 30_000
const MAX_AUDIT_ENTRIES = 2_000
const BACKGROUND_VIEW_BOUNDS: Rectangle = {
  x: 0,
  y: 0,
  width: 1280,
  height: 800
}
const MUTATION_EVENTS = new Set([
  'DOM.attributeModified',
  'DOM.attributeRemoved',
  'DOM.characterDataModified',
  'DOM.childNodeCountUpdated',
  'DOM.childNodeInserted',
  'DOM.childNodeRemoved',
  'DOM.documentUpdated',
  'DOM.shadowRootPopped',
  'DOM.shadowRootPushed'
])
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem'
])
const SENSITIVE_AUTOCOMPLETE = /(?:^|\s)(?:cc-|current-password|new-password|one-time-code|webauthn|username|email)/i
const SENSITIVE_FIELD = /(?:pass(?:word|code)?|passwd|username|user.?name|e-?mail|api.?key|secret|access.?token|otp|one.?time|2fa|mfa|auth.?code|verification.?code|captcha|human.?verification|card.?number|credit.?card|cvv|cvc|security.?code|ssn|social.?security|file.?upload)/i
const SENSITIVE_COMMIT_ACTION = /(?:\bbuy now\b|\bpay now\b|\bpurchase\b|\bplace order\b|\bconfirm order\b|\bcheckout\b|\btransfer\b|\bsend money\b|\bwithdraw\b|\bsubscribe\b)/i

type BrowserUseManagerOptions = {
  settings: () => KunBrowserUseSettingsV1
  now?: () => Date
  createView?: (partition: string) => WebContentsView
  createProxy?: (
    mode: BrowserUseMode,
    exactLocalOrigin: string | undefined,
    onPolicyEvent: (event: {
      outcome: 'allowed' | 'blocked'
      sanitizedUrl: string
      code?: string
    }) => void
  ) => BrowserUsePolicyProxy
  onState?: (state: BrowserUseViewState) => void
  onAudit?: (entry: BrowserUseAuditEntry) => void | Promise<void>
}

type BrowserMount = {
  window: BrowserWindow
  bounds: Rectangle
  visible: boolean
  supervisionActive: boolean
  onRendererLost?: () => void
}

type BrowserTarget = {
  ref: string
  tabId: string
  documentGeneration: number
  backendNodeId: number
  role: string
  name: string
  sensitive: boolean
  rect: BrowserUseRect
  fingerprint: string
}

type PreparedAction = {
  id: string
  action: Extract<BrowserUseAction, { action: 'click' | 'type' | 'select' | 'press' }>
  target: BrowserTarget
  origin: string
  createdAt: number
  expiresAt: number
  used: boolean
}

type PendingDecision = {
  id: string
  resolve: (decision: BrowserDecision) => void
  timer: ReturnType<typeof setTimeout>
}

type BrowserDecision = 'allow-once' | 'deny' | 'expired' | 'cancelled'

type BrowserTab = {
  id: string
  view: WebContentsView
  loading: boolean
  error?: string
}

type TurnBudget = {
  observationUsed: number
  interactionUsed: number
}

type BrowserSessionEntry = {
  id: string
  threadId: string
  mode: BrowserUseMode
  partition: string
  createdAt: number
  lastActivityAt: number
  lifecycle: BrowserUseViewState['lifecycle']
  controlOwner: BrowserUseViewState['controlOwner']
  mount?: BrowserMount
  mountWaiters: Set<() => void>
  proxy?: BrowserUsePolicyProxy
  proxyUrl?: string
  exactLocalOrigin?: string
  grants: Set<string>
  tabs: Map<string, BrowserTab>
  activeTabId?: string
  documentGeneration: number
  refs: Map<string, BrowserTarget>
  prepared: Map<string, PreparedAction>
  pendingOrigin?: BrowserUseOriginConsentRequest
  pendingAction?: BrowserUseActionConsentRequest
  pendingOriginDecision?: PendingDecision
  pendingActionDecision?: PendingDecision
  turnBudgets: Map<string, TurnBudget>
  activeTurnId?: string
  idleTimer?: ReturnType<typeof setTimeout>
  stopping: boolean
  agentInputDispatchActive: boolean
}

type AxValue = {
  value?: unknown
}

type AxProperty = {
  name?: string
  value?: AxValue
}

type AxNode = {
  ignored?: boolean
  backendDOMNodeId?: number
  role?: AxValue
  name?: AxValue
  value?: AxValue
  properties?: AxProperty[]
}

type DomDescription = {
  node?: {
    backendNodeId?: number
    localName?: string
    nodeName?: string
    attributes?: string[]
  }
}

type BoxModelResult = {
  model?: {
    border?: number[]
    content?: number[]
  }
}

export class BrowserUseManager {
  private readonly sessions = new Map<string, BrowserSessionEntry>()
  private readonly auditEntries: BrowserUseAuditEntry[] = []
  private readonly now: () => Date
  private readonly createView: (partition: string) => WebContentsView
  private readonly createProxy: NonNullable<BrowserUseManagerOptions['createProxy']>
  private readonly fingerprintKey = randomBytes(32)

  constructor(private readonly options: BrowserUseManagerOptions) {
    this.now = options.now ?? (() => new Date())
    this.createView = options.createView ?? createBrowserUseView
    this.createProxy = options.createProxy ?? ((mode, exactLocalOrigin, onPolicyEvent) =>
      new BrowserUsePolicyProxy({ mode, exactLocalOrigin, onPolicyEvent }))
  }

  async execute(
    threadId: string,
    turnId: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<BrowserUseResult> {
    const parsed = BrowserUseActionInput.safeParse(input)
    if (!parsed.success) {
      return resultError('invalid_action', 'Browser Use rejected malformed or unsupported arguments.')
    }
    const settings = this.options.settings()
    if (!settings.enabled) {
      return resultError('browser_use_disabled', 'Browser Use is disabled in Settings.')
    }

    const action = parsed.data
    if (action.action === 'open') {
      const entry = this.sessions.get(threadId) ?? this.createSession(threadId, settings)
      if (entry.stopping) {
        return resultError(
          'session_stopped',
          'This Browser Use session was stopped. Clear it before starting a new session.',
          entry
        )
      }
      const budgetError = this.consumeBudget(entry, turnId, 'observation', settings)
      if (budgetError) return budgetError
      return this.withAbort(entry, signal, () => this.open(entry, action.url))
    }

    const entry = this.sessions.get(threadId)
    if (!entry) return resultError('session_not_found', 'Open an authorized origin first.')
    entry.activeTurnId = turnId
    this.touch(entry, settings)

    if (action.action === 'close') {
      await this.clear(threadId, 'closed')
      return resultOk('closed', 'Browser Use session closed.')
    }
    if (entry.stopping) {
      return resultError(
        'session_stopped',
        'This Browser Use session was stopped. Clear it before starting a new session.',
        entry
      )
    }

    const interaction = isInteractionAction(action)
    const budgetError = this.consumeBudget(
      entry,
      turnId,
      interaction ? 'interaction' : 'observation',
      settings
    )
    if (budgetError) return budgetError

    return this.withAbort(entry, signal, async () => {
      if (entry.controlOwner === 'manual') {
        return resultError(
          'manual_control_active',
          'The user currently has manual control. Wait until control is returned to Kun.',
          entry
        )
      }
      switch (action.action) {
        case 'snapshot':
          return this.snapshot(entry)
        case 'screenshot':
          return this.screenshot(entry)
        case 'click':
        case 'type':
        case 'select':
        case 'press':
          return this.interact(entry, action)
        case 'scroll':
          return this.scroll(entry, action.direction, action.amount)
        case 'wait':
          await abortableDelay(action.milliseconds, signal)
          return resultOk('waited', `Waited ${action.milliseconds}ms.`, entry)
        case 'tabs':
          return this.tabs(entry, action.operation, action.tabId)
        default:
          return resultError('unsupported_action', 'Unsupported Browser Use action.', entry)
      }
    })
  }

  mount(
    threadId: string,
    window: BrowserWindow,
    rawBounds: BrowserUseRect,
    visible: boolean,
    supervisionActive = visible
  ): BrowserUseViewState {
    const entry = this.sessions.get(threadId)
    if (!entry) return this.defaultState()
    if (entry.mount && entry.mount.window !== window) {
      throw new Error('Browser Use session is already bound to another window.')
    }
    const bounds = normalizeBounds(rawBounds, window.getContentBounds(), window.webContents.getZoomFactor())
    const onRendererLost = entry.mount?.onRendererLost ?? (() => {
      void this.clear(threadId, 'renderer-lost')
    })
    if (!entry.mount) {
      const rendererContents = window.webContents as typeof window.webContents & {
        once?: (event: string, listener: () => void) => void
      }
      const lifecycleWindow = window as BrowserWindow & {
        once?: (event: string, listener: () => void) => void
      }
      rendererContents.once?.('render-process-gone', onRendererLost)
      lifecycleWindow.once?.('closed', onRendererLost)
    }
    entry.mount = {
      window,
      bounds,
      visible: visible && bounds.width > 0 && bounds.height > 0,
      supervisionActive,
      onRendererLost
    }
    if (!supervisionActive && (entry.pendingOriginDecision || entry.pendingActionDecision)) {
      this.cancelPending(entry, 'cancelled')
    }
    if (!supervisionActive && entry.controlOwner === 'manual') {
      entry.controlOwner = 'agent'
      entry.lifecycle = 'ready'
      this.invalidateDocument(entry, 'hidden-manual-control')
      for (const browserTab of entry.tabs.values()) {
        browserTab.view.webContents.setIgnoreMenuShortcuts(true)
      }
    }
    const tab = this.activeTab(entry)
    if (tab) this.attachView(entry, tab)
    if (entry.mount.visible) {
      for (const waiter of entry.mountWaiters) waiter()
      entry.mountWaiters.clear()
      if (entry.lifecycle === 'mount-required') entry.lifecycle = 'ready'
    }
    this.publish(entry)
    return this.state(entry)
  }

  setControlOwner(
    threadId: string,
    controlOwner: BrowserUseViewState['controlOwner']
  ): BrowserUseViewState {
    const entry = this.requireSession(threadId)
    if (entry.controlOwner === controlOwner) return this.state(entry)
    entry.controlOwner = controlOwner
    entry.lifecycle = controlOwner === 'manual' ? 'manual-control' : 'ready'
    this.invalidateDocument(entry, 'control_handoff')
    if (controlOwner === 'manual') this.cancelPending(entry, 'cancelled')
    for (const tab of entry.tabs.values()) {
      tab.view.webContents.setIgnoreMenuShortcuts(controlOwner !== 'manual')
    }
    this.audit(entry, {
      category: 'lifecycle',
      action: controlOwner === 'manual' ? 'manual-control' : 'agent-control',
      outcome: 'success'
    })
    this.publish(entry)
    return this.state(entry)
  }

  decideOrigin(input: BrowserUseDecisionInput): BrowserUseViewState {
    const entry = this.requireSession(input.threadId)
    const pending = entry.pendingOriginDecision
    if (!pending || pending.id !== input.requestId) {
      throw new Error('Origin consent request is stale or does not belong to this session.')
    }
    pending.resolve(input.decision)
    return this.state(entry)
  }

  decideAction(input: BrowserUseDecisionInput): BrowserUseViewState {
    const entry = this.requireSession(input.threadId)
    const pending = entry.pendingActionDecision
    if (!pending || pending.id !== input.requestId) {
      throw new Error('Action consent request is stale or does not belong to this session.')
    }
    pending.resolve(input.decision)
    return this.state(entry)
  }

  stop(threadId: string): BrowserUseViewState {
    const entry = this.requireSession(threadId)
    entry.lifecycle = 'stopped'
    entry.stopping = true
    this.cancelPending(entry, 'cancelled')
    this.invalidateDocument(entry, 'stopped')
    this.audit(entry, {
      category: 'lifecycle',
      action: 'stop',
      outcome: 'aborted'
    })
    this.publish(entry)
    return this.state(entry)
  }

  async clear(threadId: string, reason = 'cleared'): Promise<boolean> {
    const entry = this.sessions.get(threadId)
    if (!entry) return false
    this.sessions.delete(threadId)
    entry.stopping = true
    this.cancelPending(entry, 'cancelled')
    const boundWindow = entry.mount?.window
    const rendererLost = entry.mount?.onRendererLost
    if (boundWindow && rendererLost) {
      const rendererContents = boundWindow.webContents as typeof boundWindow.webContents & {
        removeListener?: (event: string, listener: () => void) => void
      }
      const lifecycleWindow = boundWindow as BrowserWindow & {
        removeListener?: (event: string, listener: () => void) => void
      }
      rendererContents.removeListener?.('render-process-gone', rendererLost)
      lifecycleWindow.removeListener?.('closed', rendererLost)
    }
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    for (const tab of entry.tabs.values()) {
      this.detachView(entry, tab)
      const targetSession = tab.view.webContents.session
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
      await Promise.allSettled([
        targetSession.closeAllConnections(),
        targetSession.clearCache(),
        targetSession.clearStorageData()
      ])
    }
    entry.tabs.clear()
    if (entry.proxy) await entry.proxy.stop()
    this.audit(entry, {
      category: 'lifecycle',
      action: reason,
      outcome: 'success'
    })
    this.options.onState?.({
      ...this.defaultState(),
      threadId,
      mode: entry.mode,
      updatedAt: this.now().toISOString()
    })
    return true
  }

  async disposeAll(reason = 'runtime-shutdown'): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((threadId) => this.clear(threadId, reason)))
  }

  stateForThread(threadId: string): BrowserUseViewState {
    const entry = this.sessions.get(threadId)
    return entry ? this.state(entry) : this.defaultState()
  }

  isBoundToWindow(threadId: string, window: BrowserWindow): boolean {
    return this.sessions.get(threadId)?.mount?.window === window
  }

  navigate(
    threadId: string,
    command: 'back' | 'forward' | 'reload'
  ): BrowserUseViewState {
    const entry = this.requireSession(threadId)
    const tab = this.requireActiveTab(entry)
    const history = tab.view.webContents.navigationHistory
    this.cancelPending(entry, 'cancelled')
    this.invalidateDocument(entry, `user-${command}`)
    if (command === 'back' && history.canGoBack()) history.goBack()
    else if (command === 'forward' && history.canGoForward()) history.goForward()
    else if (command === 'reload') tab.view.webContents.reload()
    this.audit(entry, {
      category: 'lifecycle',
      action: `user-${command}`,
      outcome: 'success'
    }, tab.id)
    this.publish(entry)
    return this.state(entry)
  }

  auditSnapshot(): readonly BrowserUseAuditEntry[] {
    return this.auditEntries.map((entry) => ({ ...entry }))
  }

  private createSession(
    threadId: string,
    settings: KunBrowserUseSettingsV1
  ): BrowserSessionEntry {
    const id = randomToken()
    const now = this.now().getTime()
    const entry: BrowserSessionEntry = {
      id,
      threadId,
      mode: settings.mode,
      partition: `temp:kun-browser-use-${id}`,
      createdAt: now,
      lastActivityAt: now,
      lifecycle: 'ready',
      controlOwner: 'agent',
      mountWaiters: new Set(),
      grants: new Set(),
      tabs: new Map(),
      documentGeneration: 0,
      refs: new Map(),
      prepared: new Map(),
      turnBudgets: new Map(),
      stopping: false,
      agentInputDispatchActive: false
    }
    this.sessions.set(threadId, entry)
    this.touch(entry, settings)
    this.audit(entry, {
      category: 'lifecycle',
      action: 'create',
      outcome: 'success'
    })
    this.publish(entry)
    return entry
  }

  private async open(entry: BrowserSessionEntry, rawUrl: string): Promise<BrowserUseResult> {
    let origin: string
    try {
      origin = normalizeBrowserUseOrigin(rawUrl, entry.mode)
    } catch (error) {
      const code = error instanceof BrowserUseNetworkPolicyError ? error.code : 'invalid_url'
      return resultError(code, errorMessage(error), entry)
    }

    if (!(await this.ensureOriginGrant(entry, origin, rawUrl))) {
      return resultError('origin_denied', 'The exact origin was not granted for this session.', entry)
    }
    try {
      await this.ensureProxy(entry)
      const tab = await this.ensureTab(entry)
      entry.lifecycle = 'loading'
      this.publish(entry)
      await tab.view.webContents.loadURL(rawUrl)
      return resultOk('opened', `Opened ${sanitizeBrowserUseUrl(rawUrl)}.`, entry)
    } catch (error) {
      entry.lifecycle = 'error'
      const tab = this.activeTab(entry)
      if (tab) tab.error = errorMessage(error).slice(0, 1024)
      this.audit(entry, {
        category: 'execution',
        action: 'open',
        origin,
        sanitizedPath: pathOnly(rawUrl),
        outcome: 'error',
        errorCode: 'navigation_failed'
      })
      this.publish(entry)
      return resultError('navigation_failed', 'The authorized page failed to load.', entry)
    }
  }

  private async ensureProxy(entry: BrowserSessionEntry): Promise<void> {
    if (entry.proxy && entry.proxyUrl) return
    const proxy = this.createProxy(
      entry.mode,
      entry.exactLocalOrigin,
      (event) => this.audit(entry, {
        category: 'network-policy',
        action: 'network-request',
        sanitizedPath: pathOnly(event.sanitizedUrl),
        origin: originOnly(event.sanitizedUrl),
        outcome: event.outcome === 'allowed' ? 'success' : 'blocked',
        ...(event.code ? { errorCode: event.code } : {})
      })
    )
    const proxyUrl = await proxy.start()
    entry.proxy = proxy
    entry.proxyUrl = proxyUrl
  }

  private async ensureTab(entry: BrowserSessionEntry): Promise<BrowserTab> {
    const active = this.activeTab(entry)
    if (active) return active
    const settings = this.options.settings()
    if (entry.tabs.size >= settings.maxTabs) {
      throw new Error('Browser Use tab limit reached.')
    }
    if (!entry.proxyUrl) throw new Error('Browser Use policy proxy is unavailable.')
    const id = randomToken()
    const view = this.createView(entry.partition)
    view.setBounds(BACKGROUND_VIEW_BOUNDS)
    view.setVisible(false)
    const tab: BrowserTab = { id, view, loading: false }
    entry.tabs.set(id, tab)
    entry.activeTabId = id
    await view.webContents.session.setProxy(browserUseProxyConfiguration(entry.proxyUrl))
    hardenRemoteSession(view.webContents.session)
    view.webContents.session.webRequest.onBeforeRequest(
      { urls: ['<all_urls>'] },
      (details, callback) => {
        if (details.resourceType !== 'mainFrame') {
          callback({ cancel: false })
          return
        }
        const requestedOrigin = safeOrigin(details.url)
        const cancel = !requestedOrigin || !entry.grants.has(requestedOrigin)
        callback({ cancel })
        if (cancel && requestedOrigin) void this.queueOriginNavigation(entry, details.url)
      }
    )
    this.hardenTab(entry, tab)
    if (entry.mount) this.attachView(entry, tab)
    this.publish(entry)
    return tab
  }

  private hardenTab(entry: BrowserSessionEntry, tab: BrowserTab): void {
    const guest = tab.view.webContents
    guest.setAudioMuted(true)
    guest.setWindowOpenHandler(({ url }) => {
      const origin = safeOrigin(url)
      if (origin && !entry.grants.has(origin)) void this.queueOriginNavigation(entry, url)
      this.audit(entry, {
        category: 'network-policy',
        action: 'popup-blocked',
        origin: origin ?? undefined,
        sanitizedPath: pathOnly(url),
        outcome: 'blocked',
        errorCode: 'popup_blocked'
      })
      return { action: 'deny' }
    })
    guest.on('will-navigate', (event, url) => {
      const origin = safeOrigin(url)
      if (!origin || !entry.grants.has(origin)) {
        event.preventDefault()
        if (origin) void this.queueOriginNavigation(entry, url)
      }
    })
    guest.on('will-redirect', (event, url) => {
      const origin = safeOrigin(url)
      if (!origin || !entry.grants.has(origin)) {
        event.preventDefault()
        if (origin) void this.queueOriginNavigation(entry, url)
      }
    })
    guest.on('before-input-event', (event) => {
      if (entry.controlOwner === 'agent' && !entry.agentInputDispatchActive) {
        event.preventDefault()
      }
    })
    guest.on('before-mouse-event', (event) => {
      if (entry.controlOwner === 'agent' && !entry.agentInputDispatchActive) {
        event.preventDefault()
      }
    })
    guest.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) this.invalidateDocument(entry, 'navigation')
    })
    guest.on('did-start-loading', () => {
      tab.loading = true
      tab.error = undefined
      entry.lifecycle = 'loading'
      this.publish(entry)
    })
    guest.on('did-stop-loading', () => {
      tab.loading = false
      entry.lifecycle = 'ready'
      this.publish(entry)
    })
    guest.on('did-navigate', () => this.publish(entry))
    guest.on('did-navigate-in-page', () => this.publish(entry))
    guest.on('page-title-updated', () => this.publish(entry))
    guest.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      tab.loading = false
      tab.error = errorDescription.slice(0, 1024)
      entry.lifecycle = 'error'
      this.publish(entry)
    })
    guest.on('render-process-gone', () => {
      tab.error = 'Browser page process exited.'
      entry.lifecycle = 'error'
      this.cancelPending(entry, 'cancelled')
      this.invalidateDocument(entry, 'render-process-gone')
      this.audit(entry, {
        category: 'lifecycle',
        action: 'render-process-gone',
        outcome: 'error',
        errorCode: 'render_process_gone'
      })
      this.publish(entry)
    })
    guest.once('destroyed', () => {
      entry.tabs.delete(tab.id)
      if (entry.activeTabId === tab.id) entry.activeTabId = undefined
    })
    try {
      guest.debugger.attach('1.3')
      void guest.debugger.sendCommand('DOM.enable')
      void guest.debugger.sendCommand('Accessibility.enable')
      guest.debugger.on('message', (_event, method) => {
        if (MUTATION_EVENTS.has(method)) this.invalidateDocument(entry, 'dom-mutation')
      })
    } catch {
      tab.error = 'Structured browser observation is unavailable.'
      entry.lifecycle = 'error'
    }
  }

  private async snapshot(entry: BrowserSessionEntry): Promise<BrowserUseResult> {
    const tab = this.requireActiveTab(entry)
    const settings = this.options.settings()
    try {
      await tab.view.webContents.debugger.sendCommand('DOM.getDocument', {
        depth: 1,
        pierce: true
      })
      const response = await tab.view.webContents.debugger.sendCommand(
        'Accessibility.getFullAXTree',
        { depth: 8 }
      ) as { nodes?: AxNode[] }
      const nodes: BrowserUseSnapshotNode[] = []
      let textChars = 0
      let truncated = false
      entry.refs.clear()
      for (const axNode of response.nodes ?? []) {
        if (nodes.length >= settings.maxSnapshotNodes) {
          truncated = true
          break
        }
        const projected = await this.projectAxNode(entry, tab, axNode)
        if (!projected) continue
        const projectedChars = projected.role.length + projected.name.length + (projected.value?.length ?? 0)
        if (textChars + projectedChars > settings.maxSnapshotTextChars) {
          truncated = true
          break
        }
        textChars += projectedChars
        nodes.push(projected)
      }
      const snapshot: BrowserUseSnapshot = {
        untrustedContent: true,
        sessionId: entry.id,
        tabId: tab.id,
        origin: safeOrigin(tab.view.webContents.getURL()) ?? '',
        sanitizedUrl: sanitizeBrowserUseUrl(tab.view.webContents.getURL()),
        title: sanitizePageTitle(tab.view.webContents.getTitle()),
        documentGeneration: entry.documentGeneration,
        truncated,
        nodes
      }
      this.audit(entry, {
        category: 'execution',
        action: 'snapshot',
        origin: snapshot.origin,
        sanitizedPath: pathOnly(snapshot.sanitizedUrl),
        outcome: 'success'
      }, tab.id)
      return BrowserUseToolResult.parse({
        ok: true,
        code: 'snapshot',
        message: truncated
          ? 'Returned a bounded truncated snapshot of untrusted page content.'
          : 'Returned a bounded snapshot of untrusted page content.',
        sessionId: entry.id,
        tabId: tab.id,
        snapshot
      })
    } catch (error) {
      return resultError('snapshot_failed', errorMessage(error), entry, tab.id)
    }
  }

  private async projectAxNode(
    entry: BrowserSessionEntry,
    tab: BrowserTab,
    axNode: AxNode
  ): Promise<BrowserUseSnapshotNode | undefined> {
    if (axNode.ignored || !axNode.backendDOMNodeId) return undefined
    const role = axString(axNode.role).slice(0, 128)
    const name = axString(axNode.name).slice(0, 512)
    if (!role && !name) return undefined
    const box = await this.boxForNode(tab, axNode.backendDOMNodeId)
    if (!box || !isNearViewport(box, entry.mount?.bounds)) return undefined
    const description = await this.describeNode(tab, axNode.backendDOMNodeId)
    const attributes = attributesRecord(description.node?.attributes)
    const sensitive = isSensitiveTarget(role, name, description, attributes)
    const properties = axProperties(axNode.properties)
    const interactive = INTERACTIVE_ROLES.has(role.toLowerCase()) ||
      properties.get('focusable') === true
    let ref: string | undefined
    if (interactive && !sensitive) {
      ref = randomToken()
      const target: BrowserTarget = {
        ref,
        tabId: tab.id,
        documentGeneration: entry.documentGeneration,
        backendNodeId: axNode.backendDOMNodeId,
        role,
        name,
        sensitive,
        rect: box,
        fingerprint: this.fingerprint(entry, {
          tabId: tab.id,
          documentGeneration: entry.documentGeneration,
          backendNodeId: axNode.backendDOMNodeId,
          role,
          name,
          sensitive,
          rect: box,
          attributes
        })
      }
      entry.refs.set(ref, target)
    }
    const rawValue = axString(axNode.value).slice(0, 512)
    return {
      ...(ref ? { ref } : {}),
      role,
      name,
      ...(!sensitive && rawValue ? { value: rawValue } : {}),
      ...(typeof properties.get('disabled') === 'boolean'
        ? { disabled: properties.get('disabled') as boolean }
        : {}),
      ...(typeof properties.get('checked') === 'boolean'
        ? { checked: properties.get('checked') as boolean }
        : {}),
      ...(typeof properties.get('selected') === 'boolean'
        ? { selected: properties.get('selected') as boolean }
        : {}),
      ...(typeof properties.get('expanded') === 'boolean'
        ? { expanded: properties.get('expanded') as boolean }
        : {}),
      ...(sensitive ? { sensitive: true } : {}),
      rect: box
    }
  }

  private async screenshot(entry: BrowserSessionEntry): Promise<BrowserUseResult> {
    const tab = this.requireActiveTab(entry)
    try {
      const image = await tab.view.webContents.capturePage()
      const size = image.getSize()
      const max = this.options.settings().maxImageDimension
      const scale = Math.min(1, max / Math.max(size.width, size.height, 1))
      const bounded = scale < 1
        ? image.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale))
          })
        : image
      return BrowserUseToolResult.parse({
        ok: true,
        code: 'screenshot',
        message: 'Captured the visible isolated Browser Use page.',
        sessionId: entry.id,
        tabId: tab.id,
        image: {
          mediaType: 'image/png',
          data: bounded.toPNG().toString('base64')
        }
      })
    } catch (error) {
      return resultError('screenshot_failed', errorMessage(error), entry, tab.id)
    }
  }

  private async interact(
    entry: BrowserSessionEntry,
    action: Extract<BrowserUseAction, { action: 'click' | 'type' | 'select' | 'press' }>
  ): Promise<BrowserUseResult> {
    const tab = this.requireActiveTab(entry)
    const target = entry.refs.get(action.ref)
    if (!target || target.tabId !== tab.id || target.documentGeneration !== entry.documentGeneration) {
      return resultError(
        'stale_reference',
        'The element reference is stale or belongs to another browser document. Take a new snapshot.',
        entry,
        tab.id
      )
    }
    const current = await this.liveTarget(entry, tab, target)
    if (!current || current.fingerprint !== target.fingerprint) {
      this.invalidateDocument(entry, 'target-changed')
      return resultError(
        'stale_reference',
        'The live target changed. Take a new snapshot before trying again.',
        entry,
        tab.id
      )
    }
    if (current.sensitive || isForbiddenCommitTarget(current.name)) {
      return resultError(
        'manual_interaction_required',
        'Credentials, payment, MFA, file upload, and destructive transaction targets require manual control.',
        entry,
        tab.id
      )
    }
    const prepared: PreparedAction = {
      id: randomToken(),
      action,
      target: current,
      origin: safeOrigin(tab.view.webContents.getURL()) ?? '',
      createdAt: this.now().getTime(),
      expiresAt: this.now().getTime() + PREPARED_ACTION_TTL_MS,
      used: false
    }
    entry.prepared.set(prepared.id, prepared)
    const risk = action.action === 'type' ? 'text-entry' : 'interaction'
    const settings = this.options.settings()
    const requiresConsent = settings.approvalMode === 'always-ask' ||
      entry.mode === 'local-development'
    if (requiresConsent) {
      if (!(await this.ensureSupervised(entry))) {
        entry.prepared.delete(prepared.id)
        return resultError(
          'interaction_required',
          'Browser Use requires its authenticated floating preview for this approval.',
          entry,
          tab.id
        )
      }
      const previewDataUrl = await this.highlightedPreview(tab, current.backendNodeId)
      const request: BrowserUseActionConsentRequest = {
        id: prepared.id,
        sessionId: entry.id,
        threadId: entry.threadId,
        tabId: tab.id,
        origin: prepared.origin,
        pageTitle: sanitizePageTitle(tab.view.webContents.getTitle()),
        action: action.action,
        risk,
        targetRole: current.role,
        targetName: current.name,
        ...('text' in action ? { textPreview: action.text.slice(0, 512) } : {}),
        ...('value' in action ? { textPreview: action.value.slice(0, 512) } : {}),
        targetRect: current.rect,
        ...(previewDataUrl ? { previewDataUrl } : {}),
        expiresAt: new Date(prepared.expiresAt).toISOString()
      }
      entry.pendingAction = request
      entry.lifecycle = 'waiting-action-consent'
      this.publish(entry)
      const decision = await this.awaitActionDecision(entry, request)
      entry.pendingAction = undefined
      entry.lifecycle = 'ready'
      this.publish(entry)
      this.audit(entry, {
        category: 'action-consent',
        action: action.action,
        origin: prepared.origin,
        risk,
        decision: auditDecision(decision),
        outcome: decision === 'allow-once' ? 'success' : 'blocked',
        targetLabel: current.role.slice(0, 128)
      }, tab.id)
      if (decision !== 'allow-once') {
        entry.prepared.delete(prepared.id)
        return resultError(
          decision === 'expired'
            ? 'consent_expired'
            : decision === 'cancelled'
              ? 'consent_cancelled'
              : 'consent_denied',
          'The Browser Use action was not allowed.',
          entry,
          tab.id
        )
      }
    } else {
      this.audit(entry, {
        category: 'action-consent',
        action: `auto-${action.action}`,
        origin: prepared.origin,
        risk,
        decision: 'allowed',
        outcome: 'success',
        targetLabel: current.role.slice(0, 128)
      }, tab.id)
    }
    const validation = await this.validatePreparedAction(entry, tab, prepared)
    if (!validation.ok) {
      entry.prepared.delete(prepared.id)
      return resultError(validation.code, validation.message, entry, tab.id)
    }
    prepared.used = true
    entry.prepared.delete(prepared.id)
    try {
      await this.withAgentInputDispatch(entry, () => this.executePrepared(tab, prepared))
      this.audit(entry, {
        category: 'execution',
        action: action.action,
        origin: prepared.origin,
        risk,
        decision: 'allowed',
        outcome: 'success',
        targetLabel: current.role.slice(0, 128)
      }, tab.id)
      return resultOk(
        'action_executed',
        `Executed validated ${action.action} once. Take a new snapshot to verify the page state.`,
        entry,
        tab.id
      )
    } catch (error) {
      return resultError('action_failed', errorMessage(error), entry, tab.id)
    }
  }

  private async validatePreparedAction(
    entry: BrowserSessionEntry,
    tab: BrowserTab,
    prepared: PreparedAction
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const now = this.now().getTime()
    if (prepared.used || now > prepared.expiresAt || entry.prepared.get(prepared.id) !== prepared) {
      return { ok: false, code: 'prepared_action_expired', message: 'Prepared action expired or was already used.' }
    }
    if (
      prepared.target.tabId !== tab.id ||
      prepared.target.documentGeneration !== entry.documentGeneration ||
      prepared.origin !== (safeOrigin(tab.view.webContents.getURL()) ?? '')
    ) {
      return { ok: false, code: 'target_changed', message: 'The page changed while consent was pending.' }
    }
    const current = await this.liveTarget(entry, tab, prepared.target)
    if (!current || current.fingerprint !== prepared.target.fingerprint) {
      return { ok: false, code: 'target_changed', message: 'The target changed while consent was pending.' }
    }
    const centerX = Math.round(current.rect.x + current.rect.width / 2)
    const centerY = Math.round(current.rect.y + current.rect.height / 2)
    const resolved = await tab.view.webContents.debugger.sendCommand('DOM.resolveNode', {
      backendNodeId: current.backendNodeId
    }) as { object?: { objectId?: string } }
    const objectId = resolved.object?.objectId
    if (!objectId) {
      return { ok: false, code: 'target_changed', message: 'The target is no longer resolvable.' }
    }
    const hit = await tab.view.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        'function(x,y){const e=document.elementFromPoint(x,y);return !!e&&(e===this||this.contains(e));}',
      arguments: [{ value: centerX }, { value: centerY }],
      returnByValue: true,
      silent: true
    }) as { result?: { value?: unknown } }
    if (hit.result?.value !== true) {
      return { ok: false, code: 'target_changed', message: 'The target is no longer the live hit target.' }
    }
    return { ok: true }
  }

  private async executePrepared(tab: BrowserTab, prepared: PreparedAction): Promise<void> {
    const target = prepared.target
    const x = Math.round(target.rect.x + target.rect.width / 2)
    const y = Math.round(target.rect.y + target.rect.height / 2)
    if (prepared.action.action === 'click') {
      await dispatchClick(tab, x, y)
      return
    }
    if (prepared.action.action === 'type') {
      await dispatchClick(tab, x, y)
      await tab.view.webContents.debugger.sendCommand('Input.insertText', {
        text: prepared.action.text
      })
      return
    }
    if (prepared.action.action === 'press') {
      await dispatchClick(tab, x, y)
      await dispatchKey(tab, prepared.action.key)
      return
    }
    const resolved = await tab.view.webContents.debugger.sendCommand('DOM.resolveNode', {
      backendNodeId: target.backendNodeId
    }) as { object?: { objectId?: string } }
    const objectId = resolved.object?.objectId
    if (!objectId) throw new Error('Select target is no longer resolvable.')
    await tab.view.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        'function(value){if(!(this instanceof HTMLSelectElement))return false;this.value=value;this.dispatchEvent(new Event("input",{bubbles:true}));this.dispatchEvent(new Event("change",{bubbles:true}));return true;}',
      arguments: [{ value: prepared.action.value }],
      returnByValue: true,
      silent: true
    })
  }

  private async scroll(
    entry: BrowserSessionEntry,
    direction: 'up' | 'down' | 'left' | 'right',
    amount: number
  ): Promise<BrowserUseResult> {
    const tab = this.requireActiveTab(entry)
    const horizontal = direction === 'left' || direction === 'right'
    await this.withAgentInputDispatch(entry, () =>
      tab.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.max(1, Math.round((entry.mount?.bounds.width ?? 800) / 2)),
        y: Math.max(1, Math.round((entry.mount?.bounds.height ?? 600) / 2)),
        deltaX: horizontal ? (direction === 'left' ? -amount : amount) : 0,
        deltaY: horizontal ? 0 : (direction === 'up' ? -amount : amount)
      }))
    return resultOk('scrolled', `Scrolled ${direction} by ${amount}px.`, entry, tab.id)
  }

  private tabs(
    entry: BrowserSessionEntry,
    operation: 'list' | 'switch' | 'close',
    tabId?: string
  ): BrowserUseResult {
    if (operation === 'switch') {
      if (!tabId || !entry.tabs.has(tabId)) {
        return resultError('tab_not_found', 'The requested tab does not belong to this session.', entry)
      }
      const previous = this.activeTab(entry)
      if (previous) previous.view.setVisible(false)
      entry.activeTabId = tabId
      const active = entry.tabs.get(tabId)!
      this.attachView(entry, active)
      this.invalidateDocument(entry, 'tab-switch')
    } else if (operation === 'close') {
      if (!tabId || !entry.tabs.has(tabId)) {
        return resultError('tab_not_found', 'The requested tab does not belong to this session.', entry)
      }
      const tab = entry.tabs.get(tabId)!
      this.detachView(entry, tab)
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
      entry.tabs.delete(tabId)
      if (entry.activeTabId === tabId) entry.activeTabId = entry.tabs.keys().next().value
      const active = this.activeTab(entry)
      if (active) this.attachView(entry, active)
      this.invalidateDocument(entry, 'tab-close')
    }
    return BrowserUseToolResult.parse({
      ok: true,
      code: 'tabs',
      message: 'Returned bounded Browser Use tabs.',
      sessionId: entry.id,
      ...(entry.activeTabId ? { tabId: entry.activeTabId } : {}),
      tabs: [...entry.tabs.values()].map((tab) => ({
        id: tab.id,
        title: sanitizePageTitle(tab.view.webContents.getTitle()),
        origin: safeOrigin(tab.view.webContents.getURL()) ?? '',
        active: tab.id === entry.activeTabId
      }))
    })
  }

  private async ensureOriginGrant(
    entry: BrowserSessionEntry,
    origin: string,
    rawUrl: string
  ): Promise<boolean> {
    if (entry.grants.has(origin)) return true
    const settings = this.options.settings()
    if (settings.approvalMode === 'auto-safe' && entry.mode === 'public') {
      entry.grants.add(origin)
      this.audit(entry, {
        category: 'origin-consent',
        action: 'auto-grant-public-origin',
        origin,
        sanitizedPath: pathOnly(rawUrl),
        decision: 'allowed',
        outcome: 'success'
      })
      this.publish(entry)
      return true
    }
    if (entry.pendingOriginDecision) return false
    if (!(await this.ensureSupervised(entry))) return false
    const request: BrowserUseOriginConsentRequest = {
      id: randomToken(),
      sessionId: entry.id,
      threadId: entry.threadId,
      origin,
      sanitizedUrl: sanitizeBrowserUseUrl(rawUrl),
      mode: entry.mode,
      createdAt: this.now().toISOString()
    }
    entry.pendingOrigin = request
    entry.lifecycle = 'waiting-origin-consent'
    this.publish(entry)
    const decision = await this.awaitOriginDecision(entry, request)
    entry.pendingOrigin = undefined
    entry.lifecycle = 'ready'
    if (decision === 'allow-once') {
      if (entry.mode === 'local-development') {
        if (entry.exactLocalOrigin && entry.exactLocalOrigin !== origin) {
          this.publish(entry)
          return false
        }
        entry.exactLocalOrigin = origin
      }
      entry.grants.add(origin)
    }
    this.audit(entry, {
      category: 'origin-consent',
      action: 'grant-origin',
      origin,
      sanitizedPath: pathOnly(rawUrl),
      decision: auditDecision(decision),
      outcome: decision === 'allow-once' ? 'success' : 'blocked'
    })
    this.publish(entry)
    return decision === 'allow-once'
  }

  private async queueOriginNavigation(entry: BrowserSessionEntry, rawUrl: string): Promise<void> {
    if (entry.stopping || entry.pendingOriginDecision) return
    let origin: string
    try {
      origin = normalizeBrowserUseOrigin(rawUrl, entry.mode)
    } catch (error) {
      this.audit(entry, {
        category: 'network-policy',
        action: 'navigation-blocked',
        sanitizedPath: pathOnly(rawUrl),
        outcome: 'blocked',
        errorCode: error instanceof BrowserUseNetworkPolicyError ? error.code : 'invalid_url'
      })
      return
    }
    if (await this.ensureOriginGrant(entry, origin, rawUrl)) {
      const tab = this.activeTab(entry)
      if (tab && !entry.stopping) {
        await tab.view.webContents.loadURL(rawUrl).catch(() => undefined)
      }
    }
  }

  private awaitOriginDecision(
    entry: BrowserSessionEntry,
    request: BrowserUseOriginConsentRequest
  ): Promise<BrowserDecision> {
    return this.createDecision(entry, 'origin', request.id, ORIGIN_DECISION_TIMEOUT_MS)
  }

  private awaitActionDecision(
    entry: BrowserSessionEntry,
    request: BrowserUseActionConsentRequest
  ): Promise<BrowserDecision> {
    return this.createDecision(entry, 'action', request.id, ACTION_DECISION_TIMEOUT_MS)
  }

  private createDecision(
    entry: BrowserSessionEntry,
    kind: 'origin' | 'action',
    id: string,
    timeoutMs: number
  ): Promise<BrowserDecision> {
    return new Promise((resolve) => {
      const finish = once((decision: BrowserDecision) => {
        clearTimeout(pending.timer)
        if (kind === 'origin') entry.pendingOriginDecision = undefined
        else entry.pendingActionDecision = undefined
        resolve(decision)
      })
      const pending: PendingDecision = {
        id,
        resolve: finish,
        timer: setTimeout(() => finish('expired'), timeoutMs)
      }
      if (kind === 'origin') entry.pendingOriginDecision = pending
      else entry.pendingActionDecision = pending
    })
  }

  private cancelPending(entry: BrowserSessionEntry, decision: BrowserDecision): void {
    entry.pendingOriginDecision?.resolve(decision)
    entry.pendingActionDecision?.resolve(decision)
    entry.pendingOrigin = undefined
    entry.pendingAction = undefined
    for (const prepared of entry.prepared.values()) prepared.used = true
    entry.prepared.clear()
  }

  private async liveTarget(
    entry: BrowserSessionEntry,
    tab: BrowserTab,
    target: BrowserTarget
  ): Promise<BrowserTarget | undefined> {
    if (target.documentGeneration !== entry.documentGeneration) return undefined
    try {
      const description = await this.describeNode(tab, target.backendNodeId)
      if (!description.node?.backendNodeId) return undefined
      const attributes = attributesRecord(description.node.attributes)
      const box = await this.boxForNode(tab, target.backendNodeId)
      if (!box) return undefined
      const ax = await tab.view.webContents.debugger.sendCommand(
        'Accessibility.getPartialAXTree',
        { backendNodeId: target.backendNodeId, fetchRelatives: false }
      ) as { nodes?: AxNode[] }
      const node = ax.nodes?.[0]
      const role = axString(node?.role).slice(0, 128)
      const name = axString(node?.name).slice(0, 512)
      const sensitive = isSensitiveTarget(role, name, description, attributes)
      return {
        ...target,
        role,
        name,
        sensitive,
        rect: box,
        fingerprint: this.fingerprint(entry, {
          tabId: tab.id,
          documentGeneration: entry.documentGeneration,
          backendNodeId: target.backendNodeId,
          role,
          name,
          sensitive,
          rect: box,
          attributes
        })
      }
    } catch {
      return undefined
    }
  }

  private async describeNode(tab: BrowserTab, backendNodeId: number): Promise<DomDescription> {
    return tab.view.webContents.debugger.sendCommand('DOM.describeNode', {
      backendNodeId,
      depth: 0,
      pierce: true
    }) as Promise<DomDescription>
  }

  private async boxForNode(
    tab: BrowserTab,
    backendNodeId: number
  ): Promise<BrowserUseRect | undefined> {
    try {
      const result = await tab.view.webContents.debugger.sendCommand('DOM.getBoxModel', {
        backendNodeId
      }) as BoxModelResult
      const quad = result.model?.border ?? result.model?.content
      if (!quad || quad.length < 8) return undefined
      const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!]
      const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!]
      const minX = Math.min(...xs)
      const maxX = Math.max(...xs)
      const minY = Math.min(...ys)
      const maxY = Math.max(...ys)
      if (maxX <= minX || maxY <= minY) return undefined
      return {
        x: roundRect(minX),
        y: roundRect(minY),
        width: roundRect(maxX - minX),
        height: roundRect(maxY - minY)
      }
    } catch {
      return undefined
    }
  }

  private async highlightedPreview(
    tab: BrowserTab,
    backendNodeId: number
  ): Promise<string | undefined> {
    try {
      await tab.view.webContents.debugger.sendCommand('Overlay.enable')
      await tab.view.webContents.debugger.sendCommand('Overlay.highlightNode', {
        backendNodeId,
        highlightConfig: {
          showInfo: true,
          showStyles: false,
          contentColor: { r: 53, g: 132, b: 228, a: 0.12 },
          borderColor: { r: 53, g: 132, b: 228, a: 1 }
        }
      })
      const image = await tab.view.webContents.capturePage()
      await tab.view.webContents.debugger.sendCommand('Overlay.hideHighlight')
      const size = image.getSize()
      const scale = Math.min(1, 800 / Math.max(size.width, size.height, 1))
      const bounded = scale < 1
        ? image.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale))
          })
        : image
      return `data:image/png;base64,${bounded.toPNG().toString('base64')}`
    } catch {
      try {
        await tab.view.webContents.debugger.sendCommand('Overlay.hideHighlight')
      } catch {
        // Preview failure must never weaken the action validation path.
      }
      return undefined
    }
  }

  private fingerprint(
    entry: BrowserSessionEntry,
    target: Omit<BrowserTarget, 'ref' | 'fingerprint'> & {
      attributes: Readonly<Record<string, string>>
    }
  ): string {
    return createHash('sha256')
      .update(this.fingerprintKey)
      .update('\0')
      .update(entry.id)
      .update('\0')
      .update(JSON.stringify(target))
      .digest('base64url')
  }

  private consumeBudget(
    entry: BrowserSessionEntry,
    turnId: string,
    kind: 'observation' | 'interaction',
    settings: KunBrowserUseSettingsV1
  ): BrowserUseResult | undefined {
    let budget = entry.turnBudgets.get(turnId)
    if (!budget) {
      budget = { observationUsed: 0, interactionUsed: 0 }
      entry.turnBudgets.set(turnId, budget)
    }
    entry.activeTurnId = turnId
    const used = kind === 'observation' ? budget.observationUsed : budget.interactionUsed
    const max = kind === 'observation'
      ? settings.maxObservationActionsPerTurn
      : settings.maxInteractionActionsPerTurn
    if (used >= max) {
      return resultError(
        'action_budget_exhausted',
        `Browser Use ${kind} action limit (${max}) reached for this turn.`,
        entry
      )
    }
    if (kind === 'observation') budget.observationUsed += 1
    else budget.interactionUsed += 1
    if (entry.turnBudgets.size > 32) {
      for (const key of entry.turnBudgets.keys()) {
        if (key !== turnId) {
          entry.turnBudgets.delete(key)
          break
        }
      }
    }
    this.publish(entry)
    return undefined
  }

  private budgetState(entry: BrowserSessionEntry): BrowserUseBudgetState | undefined {
    if (!entry.activeTurnId) return undefined
    const used = entry.turnBudgets.get(entry.activeTurnId)
    if (!used) return undefined
    const settings = this.options.settings()
    return {
      observationRemaining: Math.max(
        0,
        settings.maxObservationActionsPerTurn - used.observationUsed
      ),
      interactionRemaining: Math.max(
        0,
        settings.maxInteractionActionsPerTurn - used.interactionUsed
      )
    }
  }

  private async ensureSupervised(entry: BrowserSessionEntry): Promise<boolean> {
    if (isVisibleMount(entry.mount)) return true
    entry.lifecycle = 'mount-required'
    this.publish(entry)
    await new Promise<void>((resolve) => {
      const done = once(resolve)
      entry.mountWaiters.add(done)
      setTimeout(() => {
        entry.mountWaiters.delete(done)
        done()
      }, MOUNT_TIMEOUT_MS)
    })
    return isVisibleMount(entry.mount)
  }

  private attachView(entry: BrowserSessionEntry, tab: BrowserTab): void {
    const mount = entry.mount
    if (!mount || mount.window.isDestroyed()) return
    const children = mount.window.contentView.children
    if (!children.includes(tab.view)) mount.window.contentView.addChildView(tab.view)
    tab.view.setBounds(mount.bounds)
    tab.view.setVisible(mount.visible && tab.id === entry.activeTabId)
    tab.view.webContents.setIgnoreMenuShortcuts(entry.controlOwner !== 'manual')
  }

  private detachView(entry: BrowserSessionEntry, tab: BrowserTab): void {
    tab.view.setVisible(false)
    const window = entry.mount?.window
    if (window && !window.isDestroyed() && window.contentView.children.includes(tab.view)) {
      window.contentView.removeChildView(tab.view)
    }
  }

  private invalidateDocument(entry: BrowserSessionEntry, _reason: string): void {
    entry.documentGeneration += 1
    entry.refs.clear()
    for (const prepared of entry.prepared.values()) prepared.used = true
    entry.prepared.clear()
    entry.pendingActionDecision?.resolve('cancelled')
    entry.pendingAction = undefined
  }

  private touch(entry: BrowserSessionEntry, settings: KunBrowserUseSettingsV1): void {
    entry.lastActivityAt = this.now().getTime()
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      void this.clear(entry.threadId, 'idle-expired')
    }, settings.idleTimeoutMs)
  }

  private async withAbort(
    entry: BrowserSessionEntry,
    signal: AbortSignal | undefined,
    operation: () => Promise<BrowserUseResult>
  ): Promise<BrowserUseResult> {
    if (signal?.aborted) return resultError('aborted', 'Browser Use action was cancelled.', entry)
    const onAbort = () => this.cancelPending(entry, 'cancelled')
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await operation()
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async withAgentInputDispatch<T>(
    entry: BrowserSessionEntry,
    operation: () => Promise<T>
  ): Promise<T> {
    entry.agentInputDispatchActive = true
    try {
      return await operation()
    } finally {
      entry.agentInputDispatchActive = false
    }
  }

  private state(entry: BrowserSessionEntry): BrowserUseViewState {
    const tabs = [...entry.tabs.values()].slice(0, 3).map((tab) => {
      const url = tab.view.webContents.getURL()
      const history = tab.view.webContents.navigationHistory
      return {
        id: tab.id,
        title: sanitizePageTitle(tab.view.webContents.getTitle()),
        origin: safeOrigin(url) ?? '',
        sanitizedUrl: sanitizeBrowserUseUrl(url),
        active: tab.id === entry.activeTabId,
        loading: tab.loading,
        canGoBack: history.canGoBack(),
        canGoForward: history.canGoForward()
      }
    })
    return {
      contractVersion: 1,
      capabilityStatus: 'available',
      sessionId: entry.id,
      threadId: entry.threadId,
      lifecycle: entry.lifecycle,
      controlOwner: entry.controlOwner,
      visible: entry.mount?.visible === true,
      mounted: Boolean(entry.mount),
      mode: entry.mode,
      tabs,
      ...(entry.activeTabId ? { activeTabId: entry.activeTabId } : {}),
      ...(this.budgetState(entry) ? { budget: this.budgetState(entry) } : {}),
      ...(entry.pendingOrigin ? { pendingOriginConsent: entry.pendingOrigin } : {}),
      ...(entry.pendingAction ? { pendingActionConsent: entry.pendingAction } : {}),
      updatedAt: this.now().toISOString()
    }
  }

  private defaultState(): BrowserUseViewState {
    const settings = this.options.settings()
    return {
      contractVersion: 1,
      capabilityStatus: settings.enabled ? 'available' : 'disabled',
      ...(!settings.enabled ? { reason: 'Browser Use is disabled in Settings.' } : {}),
      lifecycle: 'closed',
      controlOwner: 'agent',
      visible: false,
      mounted: false,
      mode: settings.mode,
      tabs: [],
      updatedAt: this.now().toISOString()
    }
  }

  private publish(entry: BrowserSessionEntry): void {
    const state = this.state(entry)
    this.options.onState?.(state)
    const window = entry.mount?.window
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('browser-use:state', state)
    }
  }

  private audit(
    entry: BrowserSessionEntry,
    value: Omit<BrowserUseAuditEntry, 'id' | 'timestamp' | 'threadId' | 'sessionId'>,
    tabId?: string
  ): void {
    const record: BrowserUseAuditEntry = {
      id: randomToken(),
      timestamp: this.now().toISOString(),
      threadId: entry.threadId,
      sessionId: entry.id,
      ...(tabId ? { tabId } : {}),
      ...value,
      ...(value.origin ? { origin: originOnly(value.origin) } : {}),
      ...(value.sanitizedPath ? { sanitizedPath: pathOnly(value.sanitizedPath) } : {}),
      ...(value.targetLabel ? { targetLabel: value.targetLabel.slice(0, 256) } : {})
    }
    this.auditEntries.push(record)
    if (this.auditEntries.length > MAX_AUDIT_ENTRIES) {
      this.auditEntries.splice(0, this.auditEntries.length - MAX_AUDIT_ENTRIES)
    }
    void this.options.onAudit?.(record)
  }

  private activeTab(entry: BrowserSessionEntry): BrowserTab | undefined {
    return entry.activeTabId ? entry.tabs.get(entry.activeTabId) : undefined
  }

  private requireActiveTab(entry: BrowserSessionEntry): BrowserTab {
    const tab = this.activeTab(entry)
    if (!tab) throw new Error('Browser Use has no active tab.')
    return tab
  }

  private requireSession(threadId: string): BrowserSessionEntry {
    const entry = this.sessions.get(threadId)
    if (!entry) throw new Error('Browser Use session not found.')
    return entry
  }
}

function createBrowserUseView(partition: string): WebContentsView {
  const view = new WebContentsView({
    webPreferences: hardenedRemoteWebPreferences(partition)
  })
  view.setBackgroundColor('#ffffff')
  return view
}

function isInteractionAction(
  action: BrowserUseAction
): action is Extract<BrowserUseAction, { action: 'click' | 'type' | 'select' | 'press' }> {
  return action.action === 'click' ||
    action.action === 'type' ||
    action.action === 'select' ||
    action.action === 'press'
}

function resultOk(
  code: string,
  message: string,
  entry?: BrowserSessionEntry,
  tabId?: string
): BrowserUseResult {
  return BrowserUseToolResult.parse({
    ok: true,
    code,
    message,
    ...(entry ? { sessionId: entry.id } : {}),
    ...(tabId ?? entry?.activeTabId ? { tabId: tabId ?? entry?.activeTabId } : {})
  })
}

function resultError(
  code: string,
  message: string,
  entry?: BrowserSessionEntry,
  tabId?: string
): BrowserUseResult {
  return BrowserUseToolResult.parse({
    ok: false,
    code,
    message: message.slice(0, 2048),
    ...(entry ? { sessionId: entry.id } : {}),
    ...(tabId ?? entry?.activeTabId ? { tabId: tabId ?? entry?.activeTabId } : {})
  })
}

function normalizeBounds(
  input: BrowserUseRect,
  windowBounds: Pick<Rectangle, 'width' | 'height'>,
  zoomFactor: number
): Rectangle {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  const x = clamp(Math.round(input.x * zoom), 0, windowBounds.width)
  const y = clamp(Math.round(input.y * zoom), 0, windowBounds.height)
  return {
    x,
    y,
    width: clamp(Math.round(input.width * zoom), 0, Math.max(0, windowBounds.width - x)),
    height: clamp(Math.round(input.height * zoom), 0, Math.max(0, windowBounds.height - y))
  }
}

function isVisibleMount(mount: BrowserMount | undefined): boolean {
  return Boolean(
    mount?.visible &&
    !mount.window.isDestroyed() &&
    mount.bounds.width > 0 &&
    mount.bounds.height > 0
  )
}

function safeOrigin(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

function originOnly(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).origin
  } catch {
    return undefined
  }
}

function pathOnly(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).pathname.slice(0, 1024)
  } catch {
    return undefined
  }
}

function attributesRecord(raw: string[] | undefined): Readonly<Record<string, string>> {
  const attributes: Record<string, string> = {}
  if (!raw) return attributes
  for (let index = 0; index + 1 < raw.length && index < 64; index += 2) {
    attributes[String(raw[index]).toLowerCase().slice(0, 64)] = String(raw[index + 1]).slice(0, 512)
  }
  return attributes
}

function isSensitiveTarget(
  role: string,
  name: string,
  description: DomDescription,
  attributes: Readonly<Record<string, string>>
): boolean {
  const type = attributes.type?.toLowerCase() ?? ''
  if (type === 'password' || type === 'file' || type === 'hidden') return true
  if (SENSITIVE_AUTOCOMPLETE.test(attributes.autocomplete ?? '')) return true
  const identity = [
    role,
    name,
    description.node?.localName,
    description.node?.nodeName,
    attributes.name,
    attributes.id,
    attributes.placeholder,
    attributes['aria-label']
  ].filter(Boolean).join(' ')
  return SENSITIVE_FIELD.test(identity)
}

function isForbiddenCommitTarget(name: string): boolean {
  return SENSITIVE_COMMIT_ACTION.test(name)
}

function axString(value: AxValue | undefined): string {
  return typeof value?.value === 'string' ? value.value : ''
}

function axProperties(properties: AxProperty[] | undefined): Map<string, unknown> {
  return new Map((properties ?? []).flatMap((property) =>
    property.name ? [[property.name, property.value?.value] as const] : []
  ))
}

function isNearViewport(rect: BrowserUseRect, bounds: Rectangle | undefined): boolean {
  const width = bounds?.width ?? 1920
  const height = bounds?.height ?? 1080
  const margin = Math.max(width, height)
  return rect.x + rect.width >= -margin &&
    rect.y + rect.height >= -margin &&
    rect.x <= width + margin &&
    rect.y <= height + margin
}

async function dispatchClick(tab: BrowserTab, x: number, y: number): Promise<void> {
  await tab.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await tab.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
}

async function dispatchKey(tab: BrowserTab, key: string): Promise<void> {
  await tab.view.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key
  })
  await tab.view.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key
  })
}

function randomToken(): string {
  return randomBytes(24).toString('base64url')
}

function sanitizePageTitle(value: string): string {
  return value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\b(?:sk|pk|api|token)[-_][A-Za-z0-9_-]{8,}\b/gi, '[redacted]')
    .replace(/\b(token|secret|api[_ -]?key)=\S+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512)
}

function roundRect(value: number): number {
  return Math.round(value * 100) / 100
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function once<T extends (...args: never[]) => void>(callback: T): T {
  let called = false
  return ((...args: never[]) => {
    if (called) return
    called = true
    callback(...args)
  }) as T
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason ?? new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function auditDecision(
  decision: BrowserDecision
): 'allowed' | 'denied' | 'expired' | 'cancelled' {
  if (decision === 'allow-once') return 'allowed'
  if (decision === 'deny') return 'denied'
  return decision
}
