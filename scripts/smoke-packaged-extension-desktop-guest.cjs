'use strict'

const {
  CONTRIBUTION_ID,
  EXTENSION_ID,
  GUEST_MEDIA_READY_TIMEOUT_MS,
  POPUP_SETTLE_MS,
  WEBVIEW_MARKER
} = require('./smoke-packaged-extension-desktop-constants.cjs')
const cdpSupport = require('./smoke-packaged-extension-desktop-cdp.cjs')
const {
  runGuestAsyncInspection,
  sendToGuestSession,
  sendToWorkbenchSession,
  waitForTarget
} = cdpSupport
const mediaSupport = require('./smoke-packaged-extension-desktop-media.cjs')
const {
  inspectGuestImagePlayback,
  inspectGuestMediaPlayback,
  waitForGuestReady,
  inspectMediaUrlFetch,
  releaseGuestMediaLease,
  createGuestMediaLease,
  assertStaleViewSessionMediaBlocked
} = mediaSupport
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

async function inspectGuestSecurity({
  cdp,
  session,
  targetId,
  workbenchSession,
  localFileUrl,
  fetchUrl,
  popupUrl,
  timeoutMs,
  processState: readProcessState
}) {
  const sendGuest = (method, params, operation) => sendToGuestSession({
    cdp,
    session,
    method,
    params,
    timeoutMs,
    processState: readProcessState,
    operation
  })
  await waitForGuestReady(
    cdp,
    session.sessionId,
    timeoutMs,
    readProcessState,
    (method, params) => sendGuest(method, params, 'waiting for the extension guest')
  )

  await sendGuest('Page.enable', {}, 'enabling the Extension guest page domain')
  // Prove sender-bound kun-media loading and seeking under the production CSP
  // before the separate Host network-filter test intentionally bypasses CSP.
  const mediaPlaybackResult = await waitForSuccessfulGuestInspection({
    inspect: () => inspectGuestMediaPlayback(
      cdp,
      session.sessionId,
      (method, params) => sendGuest(method, params, 'loading sender-bound kun-media playback')
    ),
    isSuccessful: (result) => result?.mediaPlaybackMode === 'ok',
    timeoutMs,
    description: 'sender-bound kun-media playback readiness'
  })
  const imagePlaybackResult = await waitForSuccessfulGuestInspection({
    inspect: () => inspectGuestImagePlayback(
      cdp,
      session.sessionId,
      (method, params) => sendGuest(method, params, 'loading a sender-bound kun-media image')
    ),
    isSuccessful: (result) => result?.imagePlaybackMode === 'ok',
    timeoutMs,
    description: 'sender-bound kun-media image readiness'
  })

  // The protocol response carries the production `connect-src 'none'` baseline in
  // addition to the fixture's explicit loopback source. Bypass CSP only after
  // media playback so the Host webRequest filter is the fetch control under test.
  await sendGuest(
    'Page.setBypassCSP',
    { enabled: true },
    'enabling Extension guest CSP bypass for network-filter validation'
  )
  const sendWorkbench = (method, params, operation) => sendToWorkbenchSession({
    cdp,
    session: workbenchSession,
    method,
    params,
    timeoutMs,
    processState: readProcessState,
    operation
  })
  await sendWorkbench('Page.enable', {}, 'enabling the packaged workbench page domain')
  await sendWorkbench(
    'Page.setBypassCSP',
    { enabled: true },
    'enabling workbench CSP bypass for sender-isolation validation'
  )

  let mediaIsolationResult
  try {
    const copiedMediaUrlMode = await inspectMediaUrlFetch(
      cdp,
      workbenchSession.sessionId,
      mediaPlaybackResult.mediaLeaseUrl,
      'checking a copied kun-media URL from the workbench sender',
      (method, params) => sendWorkbench(
        method,
        params,
        'checking a copied kun-media URL from the workbench sender'
      )
    )
    const arbitraryLocalPathMode = await inspectMediaUrlFetch(
      cdp,
      session.sessionId,
      localFileUrl,
      'checking an arbitrary file URL from the extension guest',
      (method, params) => sendGuest(
        method,
        params,
        'checking an arbitrary file URL from the extension guest'
      )
    )
    const releaseMode = await releaseGuestMediaLease(
      cdp,
      session.sessionId,
      mediaPlaybackResult.mediaPlayback?.leaseId,
      (method, params) => sendGuest(method, params, 'releasing the packaged media lease')
    )
    const postReleaseMediaUrlMode = await inspectMediaUrlFetch(
      cdp,
      session.sessionId,
      mediaPlaybackResult.mediaLeaseUrl,
      'checking a released kun-media URL from its original guest',
      (method, params) => sendGuest(
        method,
        params,
        'checking a released kun-media URL from its original guest'
      )
    )
    mediaIsolationResult = {
      copiedMediaUrlMode,
      arbitraryLocalPathMode,
      releaseMode,
      postReleaseMediaUrlMode
    }
  } finally {
    await releaseGuestMediaLease(
      cdp,
      session.sessionId,
      mediaPlaybackResult.mediaPlayback?.leaseId,
      (method, params) => sendGuest(method, params, 'cleaning up the packaged media lease')
    ).catch(() => undefined)
  }

  const { targetInfos: targetsBefore = [] } = await cdp.send('Target.getTargets')
  const beforeTargetIds = new Set(targetsBefore.map((target) => target.targetId).filter(Boolean))
  const observedTargets = []
  const stopObservingTargets = cdp.onEvent('Target.targetCreated', (params) => {
    if (params?.targetInfo) observedTargets.push(params.targetInfo)
  })
  let value
  let targetsAfter = []
  try {
    const evaluated = await sendGuest('Runtime.evaluate', {
      expression: `(async () => {
        const bridgeMethods = ['request', 'notify', 'onNotification', 'registerHandler', 'dispose']
          .filter((name) => typeof globalThis.kunExtension?.[name] === 'function')
        const bridgeOwnKeys = globalThis.kunExtension && typeof globalThis.kunExtension === 'object'
          ? Reflect.ownKeys(globalThis.kunExtension)
              .map((key) => typeof key === 'symbol'
                ? { kind: 'symbol', name: String(key.description ?? '') }
                : { kind: 'string', name: key })
              .sort((left, right) => (left.kind + ':' + left.name).localeCompare(right.kind + ':' + right.name))
          : []
        const bounded = (promise) => new Promise((resolve) => {
          let finished = false
          const finish = (value) => {
            if (finished) return
            finished = true
            clearTimeout(timer)
            resolve(value)
          }
          const timer = setTimeout(() => finish({ mode: 'timeout' }), 5_000)
          Promise.resolve(promise).then(
            (result) => finish({ mode: 'ok', result }),
            () => finish({ mode: 'rejected' })
          )
        })

        let bridgeRequestMode = 'unavailable'
        let theme = null
        let viewStateRoundTripMode = 'unavailable'
        let viewState = null
        if (typeof globalThis.kunExtension?.request === 'function') {
          const themeOutcome = await bounded(
            globalThis.kunExtension.request('ui.getTheme', {}, { timeoutMs: 5_000 })
          )
          bridgeRequestMode = themeOutcome.mode === 'ok' && themeOutcome.result && typeof themeOutcome.result === 'object'
            ? 'ok'
            : themeOutcome.mode === 'ok' ? 'invalid' : themeOutcome.mode
          if (bridgeRequestMode === 'ok') theme = themeOutcome.result

          const expectedViewState = {
            schemaVersion: 1,
            marker: 'packaged-desktop-view-state-round-trip',
            nested: { count: 1, enabled: true }
          }
          const viewStateOutcome = await bounded((async () => {
            await globalThis.kunExtension.request(
              'ui.setViewState',
              { value: expectedViewState },
              { timeoutMs: 5_000 }
            )
            return globalThis.kunExtension.request('ui.getViewState', {}, { timeoutMs: 5_000 })
          })())
          viewStateRoundTripMode = viewStateOutcome.mode
          if (viewStateOutcome.mode === 'ok') viewState = viewStateOutcome.result

        }

        let fetchMode = 'unavailable'
        if (typeof globalThis.fetch === 'function') {
          try {
            const outcome = await bounded(globalThis.fetch(${JSON.stringify(fetchUrl)}, {
              cache: 'no-store',
              mode: 'cors'
            }))
            fetchMode = outcome.mode === 'ok' ? 'allowed' : outcome.mode
          } catch {
            fetchMode = 'threw'
          }
        }

        let popupMode = 'unavailable'
        if (typeof globalThis.open === 'function') {
          try {
            const popup = globalThis.open(${JSON.stringify(popupUrl)})
            popupMode = popup === null ? 'denied' : 'allowed'
          } catch {
            popupMode = 'threw'
          }
        }

        return {
          href: globalThis.location.href,
          marker: document.querySelector('[data-kun-packaged-webview-smoke="ready"]')?.textContent?.trim() ?? null,
          bridgeMethods,
          bridgeOwnKeys,
          bridgeRequestMode,
          theme,
          viewStateRoundTripMode,
          viewState,
          hasKunGui: 'kunGui' in globalThis,
          hasElectron: 'electron' in globalThis,
          hasIpcRenderer: 'ipcRenderer' in globalThis,
          hasBuffer: 'Buffer' in globalThis,
          hasRequire: typeof globalThis.require !== 'undefined' || typeof require !== 'undefined',
          hasProcess: typeof globalThis.process !== 'undefined' || typeof process !== 'undefined',
          fetchMode,
          popupMode
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }, 'inspecting extension guest security')
    value = evaluationValue(evaluated, 'inspecting extension guest security')
    await delay(POPUP_SETTLE_MS)
    ;({ targetInfos: targetsAfter = [] } = await cdp.send('Target.getTargets'))
  } finally {
    stopObservingTargets()
  }
  return {
    ...value,
    ...mediaPlaybackResult,
    ...imagePlaybackResult,
    ...mediaIsolationResult,
    popupTargets: findUnexpectedPopupTargets({
      beforeTargetIds,
      observedTargets,
      targetsAfter,
      guestTargetId: targetId,
      popupUrl
    })
  }
}

async function waitForSuccessfulGuestInspection({
  inspect,
  isSuccessful,
  timeoutMs,
  description
}) {
  let lastResult
  try {
    return await pollUntil(async () => {
      lastResult = await inspect()
      return isSuccessful(lastResult) ? lastResult : undefined
    }, {
      timeoutMs: Math.min(timeoutMs, GUEST_MEDIA_READY_TIMEOUT_MS),
      description
    })
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; ` +
      `last guest inspection: ${JSON.stringify(lastResult ?? null)}`
    )
  }
}

function findUnexpectedPopupTargets({
  beforeTargetIds,
  observedTargets,
  targetsAfter,
  guestTargetId,
  popupUrl
}) {
  const candidates = new Map()
  for (const target of [...observedTargets, ...targetsAfter]) {
    if (!target?.targetId || beforeTargetIds.has(target.targetId) || target.targetId === guestTargetId) continue
    candidates.set(target.targetId, { ...candidates.get(target.targetId), ...target })
  }
  return [...candidates.values()]
    .filter((target) => (
      target.type === 'page' &&
      (target.openerId === guestTargetId || target.url === popupUrl)
    ))
    .map((target) => ({
      targetId: target.targetId,
      type: target.type,
      url: typeof target.url === 'string' ? target.url : '',
      openerId: typeof target.openerId === 'string' ? target.openerId : undefined
    }))
    .sort((left, right) => left.targetId.localeCompare(right.targetId))
}

function assertGuestSecurityResult(result, networkCanaryRequests = 0) {
  if (!result || typeof result !== 'object') throw new Error('Extension guest returned no security result')
  if (result.marker !== WEBVIEW_MARKER) {
    throw new Error(`Extension guest body marker mismatch: ${String(result.marker)}`)
  }
  const expectedMethods = ['request', 'notify', 'onNotification', 'registerHandler', 'dispose']
  if (JSON.stringify(result.bridgeMethods) !== JSON.stringify(expectedMethods)) {
    throw new Error(`kunExtension bridge is missing methods: ${JSON.stringify(result.bridgeMethods)}`)
  }
  const expectedOwnKeys = [...expectedMethods]
    .sort()
    .map((name) => ({ kind: 'string', name }))
  if (JSON.stringify(result.bridgeOwnKeys) !== JSON.stringify(expectedOwnKeys)) {
    throw new Error(`kunExtension bridge exposes unexpected own keys: ${JSON.stringify(result.bridgeOwnKeys)}`)
  }
  if (result.bridgeRequestMode !== 'ok') {
    throw new Error(`kunExtension bridge request round-trip failed: ${String(result.bridgeRequestMode)}`)
  }
  assertTheme(result.theme)
  const expectedViewState = {
    found: true,
    value: {
      schemaVersion: 1,
      marker: 'packaged-desktop-view-state-round-trip',
      nested: { count: 1, enabled: true }
    }
  }
  if (
    result.viewStateRoundTripMode !== 'ok' ||
    JSON.stringify(result.viewState) !== JSON.stringify(expectedViewState)
  ) {
    throw new Error(
      `kunExtension runtime View-state round-trip failed: ` +
      `${String(result.viewStateRoundTripMode)} ${JSON.stringify(result.viewState)}`
    )
  }
  if (
    result.mediaPlaybackMode !== 'ok' ||
    result.mediaPlayback?.scheme !== 'kun-media:' ||
    !Number.isFinite(result.mediaPlayback?.duration) ||
    result.mediaPlayback.duration <= 0 ||
    result.mediaPlayback.currentTime < 0.4 ||
    result.mediaPlayback.readyState < 1 ||
    typeof result.mediaPlayback.leaseId !== 'string'
  ) {
    throw new Error(
      `kun-media desktop playback/seek failed: ` +
      `${String(result.mediaPlaybackMode)} ${JSON.stringify(result.mediaPlayback)} ` +
      `${JSON.stringify(result.mediaPlaybackError ?? null)}`
    )
  }
  if (
    result.imagePlaybackMode !== 'ok' ||
    result.imagePlayback?.scheme !== 'kun-media:' ||
    result.imagePlayback?.naturalWidth !== 1 ||
    result.imagePlayback?.naturalHeight !== 1 ||
    typeof result.imagePlayback?.leaseId !== 'string'
  ) {
    throw new Error(
      `kun-media desktop image playback failed: ` +
      `${String(result.imagePlaybackMode)} ${JSON.stringify(result.imagePlayback)} ` +
      `${JSON.stringify(result.imagePlaybackError ?? null)}`
    )
  }
  if (result.imageReleaseMode !== 'ok') {
    throw new Error(`Extension guest image lease release failed: ${String(result.imageReleaseMode)}`)
  }
  for (const [label, mode] of [
    ['copied sender URL', result.copiedMediaUrlMode],
    ['arbitrary local file URL', result.arbitraryLocalPathMode],
    ['post-release URL', result.postReleaseMediaUrlMode]
  ]) {
    if (mode !== 'blocked') {
      throw new Error(`Extension guest ${label} was not blocked: ${String(mode)}`)
    }
  }
  if (result.releaseMode !== 'ok') {
    throw new Error(`Extension guest media lease release failed: ${String(result.releaseMode)}`)
  }
  if (result.hasKunGui) throw new Error('Extension guest can see the privileged window.kunGui bridge')
  if (result.hasElectron) throw new Error('Extension guest can see an Electron bridge')
  if (result.hasIpcRenderer) throw new Error('Extension guest can see ipcRenderer')
  if (result.hasBuffer) throw new Error('Extension guest can see Node Buffer')
  if (result.hasRequire) throw new Error('Extension guest can see Node require')
  if (result.hasProcess) throw new Error('Extension guest can see Node process')
  if (result.fetchMode !== 'rejected') {
    throw new Error(`Extension guest loopback fetch was not rejected by the Host filter: ${String(result.fetchMode)}`)
  }
  if (networkCanaryRequests !== 0) {
    throw new Error(`Extension guest reached the loopback network canary (${networkCanaryRequests} requests)`)
  }
  if (result.popupMode !== 'denied') {
    throw new Error(`Extension guest window.open was not blocked: ${String(result.popupMode)}`)
  }
  if (!Array.isArray(result.popupTargets) || result.popupTargets.length !== 0) {
    throw new Error(`Extension guest window.open created a CDP target: ${JSON.stringify(result.popupTargets)}`)
  }
  if (!isExactExtensionGuestUrl(result.href)) {
    throw new Error(`Extension guest has an unexpected origin: ${String(result.href)}`)
  }
}

function assertTheme(theme) {
  if (!theme || typeof theme !== 'object' || Array.isArray(theme)) {
    throw new Error(`kunExtension Theme is not an object: ${JSON.stringify(theme)}`)
  }
  const expectedKeys = ['kind', 'reducedMotion', 'tokens', 'zoomFactor']
  if (JSON.stringify(Object.keys(theme).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error(`kunExtension Theme has unexpected fields: ${JSON.stringify(theme)}`)
  }
  if (!['light', 'dark', 'high-contrast'].includes(theme.kind)) {
    throw new Error(`kunExtension Theme has an invalid kind: ${String(theme.kind)}`)
  }
  if (!theme.tokens || typeof theme.tokens !== 'object' || Array.isArray(theme.tokens)) {
    throw new Error(`kunExtension Theme has invalid tokens: ${JSON.stringify(theme.tokens)}`)
  }
  for (const [key, value] of Object.entries(theme.tokens)) {
    if (!key || typeof value !== 'string') {
      throw new Error(`kunExtension Theme has an invalid token: ${JSON.stringify([key, value])}`)
    }
  }
  if (!Number.isFinite(theme.zoomFactor) || theme.zoomFactor <= 0) {
    throw new Error(`kunExtension Theme has an invalid zoomFactor: ${String(theme.zoomFactor)}`)
  }
  if (typeof theme.reducedMotion !== 'boolean') {
    throw new Error(`kunExtension Theme has invalid reducedMotion: ${String(theme.reducedMotion)}`)
  }
}

function isExactExtensionGuestUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false
  try {
    const url = new URL(rawUrl)
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


module.exports = {
  inspectGuestSecurity,
  waitForSuccessfulGuestInspection,
  findUnexpectedPopupTargets,
  assertGuestSecurityResult,
  assertTheme,
  isExactExtensionGuestUrl
}
