import type { Rectangle } from 'electron'
import type {
  BrowserUseMode
} from '../../shared/browser-use'
import type { KunBrowserUseSettingsV1 } from '../../shared/app-settings'
import {
  BrowserUseToolResult,
  type BrowserUseKunApprovalMode,
  type BrowserUseSnapshot,
  type BrowserUseSnapshotNode,
  type BrowserUseToolResult as BrowserUseResult
} from '../../../kun/src/contracts/browser-use.js'
import { hardenRemoteSession } from '../browser-security/web-contents-hardening'
import {
  BrowserUseNetworkPolicyError,
  browserUseProxyConfiguration,
  normalizeBrowserUseOrigin,
  sanitizeBrowserUseUrl
} from './network-policy'
import { BrowserUseManagerFoundation } from './browser-use-manager-foundation'
import {
  BACKGROUND_VIEW_BOUNDS,
  INTERACTIVE_ROLES,
  MUTATION_EVENTS,
  attributesRecord,
  axProperties,
  axString,
  errorMessage,
  isNearViewport,
  isSensitiveTarget,
  originOnly,
  pathOnly,
  randomToken,
  resultError,
  resultOk,
  roundRect,
  safeOrigin,
  sanitizePageTitle,
  type AxNode,
  type BrowserSessionEntry,
  type BrowserTab,
  type BrowserTarget
} from './browser-use-manager-support'

export abstract class BrowserUseManagerNavigation extends BrowserUseManagerFoundation {
  protected createSession(
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

  protected async open(
    entry: BrowserSessionEntry,
    rawUrl: string,
    kunApprovalSource?: Exclude<BrowserUseKunApprovalMode, 'full-access'>
  ): Promise<BrowserUseResult> {
    let origin: string
    try {
      origin = normalizeBrowserUseOrigin(rawUrl, entry.mode)
    } catch (error) {
      const code = error instanceof BrowserUseNetworkPolicyError ? error.code : 'invalid_url'
      return resultError(code, errorMessage(error), entry)
    }

    if (!(await this.ensureOriginGrant(entry, origin, rawUrl, kunApprovalSource))) {
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

  protected async ensureProxy(entry: BrowserSessionEntry): Promise<void> {
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

  protected async ensureTab(entry: BrowserSessionEntry): Promise<BrowserTab> {
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

  protected hardenTab(entry: BrowserSessionEntry, tab: BrowserTab): void {
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

  protected async snapshot(entry: BrowserSessionEntry): Promise<BrowserUseResult> {
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

  protected async projectAxNode(
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
      const targetRef = randomToken()
      ref = targetRef
      const target: BrowserTarget = {
        ref: targetRef,
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
      entry.refs.set(targetRef, target)
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

  protected async screenshot(entry: BrowserSessionEntry): Promise<BrowserUseResult> {
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

}
