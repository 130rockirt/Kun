'use strict'

const {
  CONTRIBUTION_ID,
  DEFAULT_CDP_COMMAND_TIMEOUT_MS,
  EXTENSION_ID
} = require('./smoke-packaged-extension-desktop-constants.cjs')
const processSupport = require('./smoke-packaged-extension-desktop-process.cjs')
const {
  startNetworkCanary,
  evaluationValue,
  pollUntil,
  processState,
  assertDesktopProcessRunning,
  terminateProcessTree,
  signalLiveProcess,
  isProcessRunning,
  remainingMilliseconds,
  waitForProcessExit,
  waitForPortsClosed,
  isLoopbackPortOpen,
  availablePort,
  argumentValue,
  positiveIntegerArgument,
  delay
} = processSupport

class CdpConnection {
  constructor(socket, commandTimeoutMs = DEFAULT_CDP_COMMAND_TIMEOUT_MS) {
    this.socket = socket
    this.commandTimeoutMs = commandTimeoutMs
    this.sequence = 0
    this.pending = new Map()
    this.eventListeners = new Map()
    socket.addEventListener('message', (event) => this.onMessage(event.data))
    socket.addEventListener('close', () => this.rejectPending(new Error('CDP WebSocket closed')))
    socket.addEventListener('error', () => this.rejectPending(new Error('CDP WebSocket failed')))
  }

  static async connect(
    url,
    WebSocketClass = globalThis.WebSocket,
    commandTimeoutMs = DEFAULT_CDP_COMMAND_TIMEOUT_MS
  ) {
    if (typeof WebSocketClass !== 'function') {
      throw new Error('The desktop smoke requires the WebSocket global from Node.js 22 or newer')
    }
    const socket = new WebSocketClass(url)
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to CDP: ${url}`)), 10_000)
      const finish = (callback) => {
        clearTimeout(timer)
        callback()
      }
      socket.addEventListener('open', () => finish(resolvePromise), { once: true })
      socket.addEventListener('error', () => finish(() => reject(new Error(`Cannot connect to CDP: ${url}`))), {
        once: true
      })
    })
    return new CdpConnection(socket, commandTimeoutMs)
  }

  send(method, params = {}, sessionId) {
    if (this.socket.readyState !== 1) return Promise.reject(new Error('CDP WebSocket is not open'))
    this.sequence += 1
    const id = this.sequence
    const envelope = { id, method, params, ...(sessionId ? { sessionId } : {}) }
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command timed out: ${method}`))
      }, this.commandTimeoutMs)
      this.pending.set(id, { resolvePromise, reject, timer, method })
      this.socket.send(JSON.stringify(envelope))
    })
  }

  onEvent(method, listener) {
    if (typeof method !== 'string' || typeof listener !== 'function') {
      throw new TypeError('CDP event subscriptions require a method and listener')
    }
    const listeners = this.eventListeners.get(method) ?? new Set()
    listeners.add(listener)
    this.eventListeners.set(method, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.eventListeners.delete(method)
    }
  }

  onMessage(raw) {
    if (typeof raw !== 'string') return
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (!Number.isSafeInteger(message.id)) {
      if (typeof message.method !== 'string') return
      for (const listener of this.eventListeners.get(message.method) ?? []) {
        try {
          listener(message.params ?? {}, message)
        } catch {
          // Event observation must not corrupt the CDP command channel.
        }
      }
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) {
      pending.reject(new Error(
        `CDP ${pending.method} failed (${message.error.code ?? 'unknown'}): ${message.error.message ?? 'unknown error'}`
      ))
      return
    }
    pending.resolvePromise(message.result ?? {})
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  close() {
    this.eventListeners.clear()
    if (this.socket.readyState === 0 || this.socket.readyState === 1) this.socket.close()
  }
}

let guestAsyncInspectionSequence = 0

async function runGuestAsyncInspection({
  cdp,
  sessionId,
  sendCommand,
  expression,
  userGesture = false,
  timeoutMs,
  description
}) {
  guestAsyncInspectionSequence += 1
  const resultKey = `__kunPackagedGuestInspection${guestAsyncInspectionSequence}`
  const serializedKey = JSON.stringify(resultKey)
  const send = (method, params) => sendCommand
    ? sendCommand(method, params)
    : cdp.send(method, params, sessionId)
  const start = () => send('Runtime.evaluate', {
    expression: `(() => {
      const key = ${serializedKey}
      globalThis[key] = { state: 'pending' }
      Promise.resolve(${expression}).then(
        (value) => { globalThis[key] = { state: 'fulfilled', value } },
        (error) => {
          globalThis[key] = {
            state: 'rejected',
            error: error instanceof Error ? error.message : String(error)
          }
        }
      )
      return key
    })()`,
    returnByValue: true,
    userGesture
  })
  await start()
  try {
    const completed = await pollUntil(async () => {
      const evaluated = await send('Runtime.evaluate', {
        expression: `globalThis[${serializedKey}] ?? null`,
        returnByValue: true
      })
      const state = evaluationValue(evaluated, description)
      if (state === null || state === undefined) {
        // A guest main-frame navigation replaces the execution context without
        // necessarily invalidating the flattened target session. Restart the
        // inspection in the current context instead of waiting on the orphaned
        // promise from the previous document.
        await start()
        return undefined
      }
      if (state?.state === 'rejected') {
        throw new Error(`${description} rejected: ${String(state.error ?? 'unknown error')}`)
      }
      return state?.state === 'fulfilled' ? { value: state.value } : undefined
    }, { timeoutMs, description })
    return completed.value
  } finally {
    await send('Runtime.evaluate', {
      expression: `delete globalThis[${serializedKey}]`,
      returnByValue: true
    }).catch(() => undefined)
  }
}

async function waitForCdpEndpoint({ port, timeoutMs, processState: readProcessState }) {
  const endpoint = `http://127.0.0.1:${port}`
  return pollUntil(async () => {
    assertDesktopProcessRunning(readProcessState())
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(1_500)
      })
      if (!response.ok) return undefined
      const body = await response.json()
      return typeof body.webSocketDebuggerUrl === 'string' ? body : undefined
    } catch {
      return undefined
    }
  }, {
    timeoutMs,
    description: `CDP endpoint on ${endpoint}`
  })
}

async function waitForTarget(cdp, predicate, description, timeoutMs, readProcessState) {
  let observedTargets = []
  try {
    return await pollUntil(async () => {
      assertDesktopProcessRunning(readProcessState())
      const { targetInfos = [] } = await cdp.send('Target.getTargets')
      observedTargets = targetInfos
      return targetInfos.find(predicate)
    }, { timeoutMs, description })
  } catch (error) {
    const detail = observedTargets
      .slice(0, 20)
      .map((target) => `${String(target.type)}:${String(target.url).slice(0, 512)}`)
      .join(', ')
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; ` +
      `observed CDP targets: ${detail || '(none)'}`
    )
  }
}

function isWorkbenchTarget(target) {
  if (!target || target.type !== 'page' || typeof target.url !== 'string') return false
  try {
    const url = new URL(target.url)
    return (
      url.protocol === 'file:' &&
      url.hostname === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.pathname.replaceAll('\\', '/').endsWith('/app.asar/out/renderer/index.html')
    )
  } catch {
    return false
  }
}

function isExtensionGuestTarget(target) {
  if (
    !target ||
    typeof target.targetId !== 'string' ||
    target.targetId.length === 0 ||
    target.type !== 'webview' ||
    typeof target.url !== 'string'
  ) return false
  try {
    const url = new URL(target.url)
    const queryKeys = [...url.searchParams.keys()]
    return (
      url.protocol === 'kun-extension:' &&
      url.hostname === EXTENSION_ID &&
      url.pathname === '/dist/webview/index.html' &&
      queryKeys.length === 1 &&
      queryKeys[0] === 'kunViewSession' &&
      Boolean(url.searchParams.get('kunViewSession')) &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

async function attachToTarget(cdp, targetId) {
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  if (typeof attached.sessionId !== 'string') throw new Error(`CDP did not attach to target ${targetId}`)
  await cdp.send('Runtime.enable', {}, attached.sessionId)
  return attached.sessionId
}

function isRecoverableCdpSessionError(error) {
  return error instanceof Error &&
    /(?:Session with given id not found|No session with given id|Target (?:closed|is detached)|Execution context was destroyed|Cannot find context with specified id)/iu.test(error.message)
}

function isCdpCommandTimeout(error) {
  return error instanceof Error && /CDP command timed out:/u.test(error.message)
}

async function sendToRecoverableTargetSession({
  cdp,
  session,
  targetMatches,
  targetDescription,
  method,
  params,
  timeoutMs,
  processState: readProcessState,
  operation
}) {
  const deadline = Date.now() + timeoutMs
  let lastSessionError
  while (Date.now() < deadline) {
    assertDesktopProcessRunning(readProcessState())
    if (!session.sessionId) {
      const { targetInfos = [] } = await cdp.send('Target.getTargets')
      const target = targetInfos.find((candidate) =>
        candidate.targetId === session.targetId && targetMatches(candidate)) ??
        targetInfos.find(targetMatches)
      if (!target) {
        await delay(100)
        continue
      }
      try {
        session.targetId = target.targetId
        session.sessionId = await attachToTarget(cdp, target.targetId)
      } catch (error) {
        if (!isRecoverableCdpSessionError(error) && !isCdpCommandTimeout(error)) throw error
        lastSessionError = error
        session.sessionId = undefined
        await delay(100)
        continue
      }
    }
    try {
      return await cdp.send(method, params, session.sessionId)
    } catch (error) {
      if (
        !isRecoverableCdpSessionError(error) &&
        !(method === 'Runtime.evaluate' && isCdpCommandTimeout(error))
      ) throw error
      lastSessionError = error
      session.sessionId = undefined
      await delay(100)
    }
  }
  throw new Error(
    `Timed out while ${operation} after the packaged ${targetDescription} CDP session was replaced; ` +
    `last error: ${lastSessionError instanceof Error ? lastSessionError.message : 'session unavailable'}`
  )
}

function sendToWorkbenchSession(options) {
  return sendToRecoverableTargetSession({
    ...options,
    targetMatches: isWorkbenchTarget,
    targetDescription: 'workbench'
  })
}

function sendToGuestSession(options) {
  return sendToRecoverableTargetSession({
    ...options,
    targetMatches: isExtensionGuestTarget,
    targetDescription: 'Extension guest'
  })
}

const WORKBENCH_DISCOVERY_RETRY_DELAYS_MS = [0, 250, 1_000, 3_000, 6_000]

function hasWorkbenchContribution(response, contributionId) {
  if (!response || response.ok !== true || typeof response.body !== 'string') return false
  try {
    const snapshot = JSON.parse(response.body)
    return Array.isArray(snapshot?.extensions) && snapshot.extensions.some((extension) =>
      extension?.id === EXTENSION_ID &&
      extension.workspaceTrusted === true &&
      Array.isArray(extension.grantedPermissions) &&
      extension.grantedPermissions.includes('ui.views') &&
      extension.grantedPermissions.includes('webview') &&
      Array.isArray(extension?.contributes?.['views.rightSidebar']) &&
      extension.contributes['views.rightSidebar'].some(
        (view) => `extension:${extension.id}/${view?.id}` === contributionId
      )
    )
  } catch {
    return false
  }
}

async function synchronizeWorkbenchContributionDiscovery({
  cdp,
  session,
  workspaceRoot,
  contributionId,
  timeoutMs,
  processState: readProcessState
}) {
  let lastResponse
  try {
    await pollUntil(async () => {
      assertDesktopProcessRunning(readProcessState())
      const evaluated = await sendToWorkbenchSession({
        cdp,
        session,
        method: 'Runtime.evaluate',
        params: {
          expression: `(async () => {
            const root = document.getElementById('root')
            const bridge = globalThis.kunGui
            if (!root?.hasChildNodes() || !bridge || typeof bridge.extensionGetWorkbench !== 'function') {
              return null
            }
            return bridge.extensionGetWorkbench({ workspaceRoot: ${JSON.stringify(workspaceRoot)} })
          })()`,
          awaitPromise: true,
          returnByValue: true
        },
        timeoutMs,
        processState: readProcessState,
        operation: 'reading the packaged workbench contribution snapshot'
      })
      lastResponse = evaluationValue(
        evaluated,
        'reading the packaged workbench contribution snapshot'
      )
      return hasWorkbenchContribution(lastResponse, contributionId) ? lastResponse : undefined
    }, { timeoutMs, description: `packaged workbench discovery for ${contributionId}` })
  } catch (error) {
    const diagnostic = lastResponse === undefined
      ? 'no bridge response'
      : JSON.stringify(lastResponse).slice(0, 2_000)
    throw new Error(`${error instanceof Error ? error.message : String(error)}; last bridge response: ${diagnostic}`)
  }

  // The bridge response proves that the runtime, registry, workspace grant,
  // and renderer preload are ready. Start discovery only after that point.
  // Further retries are issued on demand while the smoke waits for the
  // committed control below: scheduling all retries here can clear the
  // registry after the control has been clicked and unmount its new webview.
  await notifyWorkbenchContributionListener({
    cdp,
    session,
    timeoutMs,
    processState: readProcessState
  })
}

async function notifyWorkbenchContributionListener({
  cdp,
  session,
  timeoutMs,
  processState: readProcessState
}) {
  await sendToWorkbenchSession({
    cdp,
    session,
    method: 'Runtime.evaluate',
    params: {
      expression: "(() => { window.dispatchEvent(new Event('kun:extensions-changed')); return true })()",
      returnByValue: true
    },
    timeoutMs,
    processState: readProcessState,
    operation: 'notifying the packaged workbench contribution listener'
  })
}

async function waitForContributionAndClick({
  cdp,
  session,
  contributionId,
  timeoutMs,
  processState: readProcessState
}) {
  // The direct bridge call above proves the runtime has the trusted smoke
  // contribution, but React can still be committing that snapshot. Clicking
  // an untrusted discovery launcher before the committed reload finishes is
  // intentionally a no-op when its workspace context is not ready. Retry
  // discovery only while no committed trusted control exists; each refresh
  // clears the registry, so no retry may remain queued after the click that
  // opens the webview. Use the committed control for both open and re-open
  // validation.
  const selector = `.ds-extension-side-rail-group button[data-contribution-id="${contributionId}"][data-extension-trusted="true"]`
  const discoveryStartedAt = Date.now()
  let retryIndex = 1
  const point = await pollUntil(async () => {
    assertDesktopProcessRunning(readProcessState())
    const evaluated = await sendToWorkbenchSession({
      cdp,
      session,
      method: 'Runtime.evaluate',
      params: {
        expression: `(() => {
          const element = document.querySelector(${JSON.stringify(selector)})
          if (!(element instanceof HTMLElement) || element.matches(':disabled')) return null
          element.scrollIntoView({ block: 'center', inline: 'center' })
          const rectangle = element.getBoundingClientRect()
          if (rectangle.width <= 0 || rectangle.height <= 0) return null
          return {
            x: rectangle.left + rectangle.width / 2,
            y: rectangle.top + rectangle.height / 2
          }
        })()`,
        returnByValue: true
      },
      timeoutMs,
      processState: readProcessState,
      operation: `locating ${selector}`
    })
    const candidate = evaluationValue(evaluated, `locating ${selector}`)
    if (candidate) return candidate

    while (
      retryIndex < WORKBENCH_DISCOVERY_RETRY_DELAYS_MS.length &&
      Date.now() - discoveryStartedAt >= WORKBENCH_DISCOVERY_RETRY_DELAYS_MS[retryIndex]
    ) {
      await notifyWorkbenchContributionListener({
        cdp,
        session,
        timeoutMs,
        processState: readProcessState
      })
      retryIndex += 1
    }
    return undefined
  }, { timeoutMs, description: `workbench contribution ${contributionId}` })

  await sendToWorkbenchSession({
    cdp,
    session,
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mouseMoved', x: point.x, y: point.y },
    timeoutMs,
    processState: readProcessState,
    operation: `moving to ${selector}`
  })
  await sendToWorkbenchSession({
    cdp,
    session,
    method: 'Input.dispatchMouseEvent',
    params: {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 1,
      clickCount: 1
    },
    timeoutMs,
    processState: readProcessState,
    operation: `pressing ${selector}`
  })
  await sendToWorkbenchSession({
    cdp,
    session,
    method: 'Input.dispatchMouseEvent',
    params: {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 0,
      clickCount: 1
    },
    timeoutMs,
    processState: readProcessState,
    operation: `releasing ${selector}`
  })
}

async function waitForContributionTabCloseAndClick({
  cdp,
  session,
  contributionId,
  timeoutMs,
  processState: readProcessState
}) {
  const selector = `.ds-extension-view[data-contribution-id="${contributionId}"]`
  const point = await pollUntil(async () => {
    assertDesktopProcessRunning(readProcessState())
    const evaluated = await sendToWorkbenchSession({
      cdp,
      session,
      method: 'Runtime.evaluate',
      params: {
        expression: `(() => {
          const view = document.querySelector(${JSON.stringify(selector)})
          const panel = view?.closest('[role="tabpanel"]')
          const tabId = panel?.getAttribute('aria-labelledby')
          const tab = tabId ? document.getElementById(tabId) : null
          const closeButton = tab?.parentElement?.querySelector('button:not([role="tab"])')
          if (!(closeButton instanceof HTMLElement) || closeButton.matches(':disabled')) return null
          closeButton.scrollIntoView({ block: 'center', inline: 'center' })
          const rectangle = closeButton.getBoundingClientRect()
          if (rectangle.width <= 0 || rectangle.height <= 0) return null
          return {
            x: rectangle.left + rectangle.width / 2,
            y: rectangle.top + rectangle.height / 2
          }
        })()`,
        returnByValue: true
      },
      timeoutMs,
      processState: readProcessState,
      operation: `locating the close control for ${selector}`
    })
    return evaluationValue(evaluated, `locating the close control for ${selector}`)
  }, { timeoutMs, description: `workbench contribution tab close ${contributionId}` })

  await sendToWorkbenchSession({
    cdp,
    session,
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mouseMoved', x: point.x, y: point.y },
    timeoutMs,
    processState: readProcessState,
    operation: `moving to the close control for ${selector}`
  })
  await sendToWorkbenchSession({
    cdp,
    session,
    method: 'Input.dispatchMouseEvent',
    params: {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 1,
      clickCount: 1
    },
    timeoutMs,
    processState: readProcessState,
    operation: `pressing the close control for ${selector}`
  })
  await sendToWorkbenchSession({
    cdp,
    session,
    method: 'Input.dispatchMouseEvent',
    params: {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 0,
      clickCount: 1
    },
    timeoutMs,
    processState: readProcessState,
    operation: `releasing the close control for ${selector}`
  })
}


module.exports = {
  CdpConnection,
  WORKBENCH_DISCOVERY_RETRY_DELAYS_MS,
  waitForCdpEndpoint,
  waitForTarget,
  isWorkbenchTarget,
  isExtensionGuestTarget,
  attachToTarget,
  isRecoverableCdpSessionError,
  isCdpCommandTimeout,
  sendToRecoverableTargetSession,
  runGuestAsyncInspection,
  sendToWorkbenchSession,
  sendToGuestSession,
  hasWorkbenchContribution,
  synchronizeWorkbenchContributionDiscovery,
  notifyWorkbenchContributionListener,
  waitForContributionAndClick,
  waitForContributionTabCloseAndClick
}
