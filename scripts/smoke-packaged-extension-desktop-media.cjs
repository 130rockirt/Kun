'use strict'

const {
  CONTRIBUTION_ID,
  GUEST_MEDIA_READY_TIMEOUT_MS,
  MEDIA_IMAGE_HANDLE_ID,
  MEDIA_PLAYBACK_HANDLE_ID,
  WEBVIEW_MARKER
} = require('./smoke-packaged-extension-desktop-constants.cjs')
const cdpSupport = require('./smoke-packaged-extension-desktop-cdp.cjs')
const {
  isExtensionGuestTarget,
  runGuestAsyncInspection,
  sendToGuestSession,
  sendToWorkbenchSession,
  waitForContributionAndClick,
  waitForContributionTabCloseAndClick,
  waitForTarget
} = cdpSupport
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

async function inspectGuestImagePlayback(cdp, sessionId, sendCommand) {
  const params = {
    expression: `(async () => {
      if (typeof globalThis.kunExtension?.request !== 'function') {
        return { imagePlaybackMode: 'unavailable', imagePlayback: null }
      }
      let image = null
      let lease = null
      try {
        lease = await globalThis.kunExtension.request(
          'media.openViewResource',
          { handleId: ${JSON.stringify(MEDIA_IMAGE_HANDLE_ID)} },
          { timeoutMs: 5_000 }
        )
        image = document.createElement('img')
        image.src = lease.url
        document.body.append(image)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('image metadata timeout')), 5_000)
          image.addEventListener('load', () => {
            clearTimeout(timer)
            resolve()
          }, { once: true })
          image.addEventListener('error', () => {
            clearTimeout(timer)
            reject(new Error('image element failed'))
          }, { once: true })
        })
        let imageReleaseMode = 'ok'
        try {
          await globalThis.kunExtension.request(
            'media.release',
            { resource: 'lease', leaseId: lease.leaseId },
            { timeoutMs: 5_000 }
          )
        } catch {
          imageReleaseMode = 'rejected'
        }
        return {
          imagePlaybackMode: 'ok',
          imageReleaseMode,
          imagePlayback: {
            scheme: new URL(lease.url).protocol,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
            leaseId: lease.leaseId
          }
        }
      } catch (error) {
        if (lease?.leaseId) {
          await globalThis.kunExtension.request(
            'media.release',
            { resource: 'lease', leaseId: lease.leaseId },
            { timeoutMs: 5_000 }
          ).catch(() => undefined)
        }
        return {
          imagePlaybackMode: 'rejected',
          imagePlayback: null,
          imagePlaybackError: error instanceof Error ? error.message : String(error)
        }
      } finally {
        image?.removeAttribute('src')
        image?.remove()
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  }
  return runGuestAsyncInspection({
    cdp,
    sessionId,
    sendCommand,
    expression: params.expression,
    userGesture: true,
    timeoutMs: GUEST_MEDIA_READY_TIMEOUT_MS,
    description: 'loading a sender-bound kun-media image under production CSP'
  })
}

async function inspectGuestMediaPlayback(cdp, sessionId, sendCommand) {
  const params = {
    expression: `(async () => {
      if (typeof globalThis.kunExtension?.request !== 'function') {
        return { mediaPlaybackMode: 'unavailable', mediaPlayback: null }
      }
      let audio = null
      let lease = null
      let stage = 'open-lease'
      try {
        lease = await globalThis.kunExtension.request(
          'media.openViewResource',
          { handleId: ${JSON.stringify(MEDIA_PLAYBACK_HANDLE_ID)} },
          { timeoutMs: 5_000 }
        )
        stage = 'load-metadata'
        audio = document.createElement('audio')
        audio.preload = 'auto'
        audio.src = lease.url
        document.body.append(audio)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('media metadata timeout')), 5_000)
          audio.addEventListener('loadedmetadata', () => {
            clearTimeout(timer)
            resolve()
          }, { once: true })
          audio.addEventListener('error', () => {
            clearTimeout(timer)
            reject(new Error('media element failed'))
          }, { once: true })
          audio.load()
        })
        stage = 'seek'
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('media seek timeout')), 5_000)
          audio.addEventListener('seeked', () => {
            clearTimeout(timer)
            resolve()
          }, { once: true })
          audio.addEventListener('error', () => {
            clearTimeout(timer)
            reject(new Error('media seek failed'))
          }, { once: true })
          audio.currentTime = 0.5
        })
        return {
          mediaPlaybackMode: 'ok',
          mediaLeaseUrl: lease.url,
          mediaPlayback: {
            scheme: new URL(lease.url).protocol,
            duration: audio.duration,
            currentTime: audio.currentTime,
            readyState: audio.readyState,
            leaseId: lease.leaseId
          }
        }
      } catch (error) {
        const result = {
          mediaPlaybackMode: 'rejected',
          mediaPlayback: null,
          mediaLeaseUrl: null,
          mediaPlaybackError: {
            stage,
            name: error instanceof Error ? error.name : typeof error,
            message: error instanceof Error ? error.message : String(error),
            mediaErrorCode: audio?.error?.code ?? null,
            mediaErrorMessage: audio?.error?.message ?? null,
            networkState: audio?.networkState ?? null,
            readyState: audio?.readyState ?? null
          }
        }
        if (lease?.leaseId) {
          await globalThis.kunExtension.request(
            'media.release',
            { resource: 'lease', leaseId: lease.leaseId },
            { timeoutMs: 5_000 }
          ).catch(() => undefined)
        }
        return result
      } finally {
        audio?.removeAttribute('src')
        audio?.load()
        audio?.remove()
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  }
  return runGuestAsyncInspection({
    cdp,
    sessionId,
    sendCommand,
    expression: params.expression,
    userGesture: true,
    timeoutMs: GUEST_MEDIA_READY_TIMEOUT_MS,
    description: 'loading sender-bound kun-media playback under production CSP'
  })
}

async function waitForGuestReady(cdp, sessionId, timeoutMs, readProcessState, sendCommand) {
  let lastGuestState
  try {
    await pollUntil(async () => {
      assertDesktopProcessRunning(readProcessState())
      const params = {
        expression: `(() => ({
          readyState: document.readyState,
          location: location.href,
          title: document.title,
          body: document.body?.innerText?.slice(0, 1_024) ?? '',
          marker: document.querySelector('[data-kun-packaged-webview-smoke="ready"]')?.textContent?.trim() ?? null,
          bridge: typeof globalThis.kunExtension === 'object'
        }))()`,
        returnByValue: true
      }
      const evaluated = sendCommand
        ? await sendCommand('Runtime.evaluate', params)
        : await cdp.send('Runtime.evaluate', params, sessionId)
      const value = evaluationValue(evaluated, 'waiting for the extension guest')
      lastGuestState = value
      return value?.readyState === 'complete' && value.marker === WEBVIEW_MARKER && value.bridge
    }, { timeoutMs, description: 'loaded kun-extension guest bridge and body marker' })
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; ` +
      `last guest state: ${JSON.stringify(lastGuestState ?? null)}`
    )
  }
}

async function inspectMediaUrlFetch(cdp, sessionId, url, description, sendCommand) {
  if (typeof url !== 'string' || url.length === 0) return 'invalid-url'
  const params = {
    expression: `(async () => {
      try {
        const response = await Promise.race([
          globalThis.fetch(${JSON.stringify(url)}, {
            cache: 'no-store',
            headers: { Range: 'bytes=0-43' }
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000))
        ])
        if (!response?.ok) return 'blocked'
        const bytes = await response.arrayBuffer()
        return bytes.byteLength > 0 ? 'allowed' : 'blocked'
      } catch {
        return 'blocked'
      }
    })()`,
    awaitPromise: true,
    returnByValue: true
  }
  const evaluated = sendCommand
    ? await sendCommand('Runtime.evaluate', params)
    : await cdp.send('Runtime.evaluate', params, sessionId)
  return evaluationValue(evaluated, description)
}

async function releaseGuestMediaLease(cdp, sessionId, leaseId, sendCommand) {
  if (typeof leaseId !== 'string' || leaseId.length === 0) return 'invalid-lease'
  const params = {
    expression: `(async () => {
      try {
        await globalThis.kunExtension.request(
          'media.release',
          { resource: 'lease', leaseId: ${JSON.stringify(leaseId)} },
          { timeoutMs: 5_000 }
        )
        return 'ok'
      } catch {
        return 'rejected'
      }
    })()`,
    awaitPromise: true,
    returnByValue: true
  }
  const evaluated = sendCommand
    ? await sendCommand('Runtime.evaluate', params)
    : await cdp.send('Runtime.evaluate', params, sessionId)
  return evaluationValue(evaluated, 'releasing the packaged media lease')
}

async function createGuestMediaLease(cdp, sessionId, sendCommand) {
  const params = {
    expression: `(async () => globalThis.kunExtension.request(
      'media.openViewResource',
      { handleId: ${JSON.stringify(MEDIA_PLAYBACK_HANDLE_ID)} },
      { timeoutMs: 5_000 }
    ))()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  }
  const evaluated = sendCommand
    ? await sendCommand('Runtime.evaluate', params)
    : await cdp.send('Runtime.evaluate', params, sessionId)
  return evaluationValue(evaluated, 'minting a media lease for stale View Session validation')
}

async function assertStaleViewSessionMediaBlocked({
  cdp,
  guestSession,
  guestTargetId,
  workbenchSession,
  timeoutMs,
  processState: readProcessState
}) {
  const sendGuest = (method, params, operation) => sendToGuestSession({
    cdp,
    session: guestSession,
    method,
    params,
    timeoutMs,
    processState: readProcessState,
    operation
  })
  const staleLease = await createGuestMediaLease(
    cdp,
    guestSession.sessionId,
    (method, params) => sendGuest(
      method,
      params,
      'minting a media lease for stale View Session validation'
    )
  )
  if (
    !staleLease ||
    typeof staleLease.url !== 'string' ||
    typeof staleLease.leaseId !== 'string'
  ) {
    throw new Error(`Could not create the stale-session media lease: ${JSON.stringify(staleLease)}`)
  }

  // Close the surface through the workbench, matching the production React
  // lifecycle that unmounts the Webview and disposes its View Session. The
  // guest bridge's dispose() only tears down bridge listeners and is not a UI
  // request to unmount its owning surface.
  await waitForContributionTabCloseAndClick({
    cdp,
    session: workbenchSession,
    contributionId: CONTRIBUTION_ID,
    timeoutMs,
    processState: readProcessState
  })
  const closedGuestTargetId = guestSession.targetId ?? guestTargetId
  await pollUntil(async () => {
    assertDesktopProcessRunning(readProcessState())
    const { targetInfos = [] } = await cdp.send('Target.getTargets')
    return targetInfos.every((target) => target.targetId !== closedGuestTargetId)
  }, { timeoutMs, description: 'disposed packaged Extension View Session' })

  await waitForContributionAndClick({
    cdp,
    session: workbenchSession,
    contributionId: CONTRIBUTION_ID,
    timeoutMs,
    processState: readProcessState
  })
  const replacementTarget = await waitForTarget(
    cdp,
    (target) => isExtensionGuestTarget(target) && target.targetId !== closedGuestTargetId,
    'replacement kun-extension guest for stale View Session validation',
    timeoutMs,
    readProcessState
  )
  const replacementSession = {
    targetId: replacementTarget.targetId,
    sessionId: undefined
  }
  const sendReplacementGuest = (method, params, operation) => sendToGuestSession({
    cdp,
    session: replacementSession,
    method,
    params,
    timeoutMs,
    processState: readProcessState,
    operation
  })
  await waitForGuestReady(
    cdp,
    replacementSession.sessionId,
    timeoutMs,
    readProcessState,
    (method, params) => sendReplacementGuest(
      method,
      params,
      'waiting for the replacement Extension guest'
    )
  )
  await sendReplacementGuest(
    'Page.enable',
    {},
    'enabling the replacement Extension guest page domain'
  )
  await sendReplacementGuest(
    'Page.setBypassCSP',
    { enabled: true },
    'enabling replacement Extension guest CSP bypass'
  )
  const staleViewSessionMode = await inspectMediaUrlFetch(
    cdp,
    replacementSession.sessionId,
    staleLease.url,
    'checking a stale View Session media URL from its replacement guest',
    (method, params) => sendReplacementGuest(
      method,
      params,
      'checking a stale View Session media URL from its replacement guest'
    )
  )
  if (staleViewSessionMode !== 'blocked') {
    throw new Error(
      `Stale View Session reused a kun-media URL: ${String(staleViewSessionMode)}`
    )
  }
}


module.exports = {
  inspectGuestImagePlayback,
  inspectGuestMediaPlayback,
  waitForGuestReady,
  inspectMediaUrlFetch,
  releaseGuestMediaLease,
  createGuestMediaLease,
  assertStaleViewSessionMediaBlocked
}
