'use strict'

const assert = require('node:assert/strict')
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { mkdtemp, readFile } = require('node:fs/promises')
const { createServer } = require('node:net')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')
const { parse: parseYaml } = require('yaml')
const {
  EXTENSION_ID,
  PACKAGED_EXTENSION_SMOKE_SUCCESS_MARKER,
  assertPackagedSmokeChildResult,
  createPackagedExtensionSmokeReexecEnvironment,
  installSmokeExtensionFixture,
  packagedResourceCandidates,
  resolvedPackagedResourceCandidates,
  smokeWebviewCsp
} = require('../smoke-packaged-extensions.cjs')
const {
  CdpConnection,
  CONTRIBUTION_ID,
  WEBVIEW_MARKER,
  assertGuestSecurityResult,
  createDesktopLaunchPlan,
  createIsolatedEnvironment,
  desktopApplicationEntry,
  desktopResourceCandidates,
  desktopSmokeSettings,
  desktopSmokeWorkspaceParent,
  desktopUserDataCandidates,
  findUnexpectedPopupTargets,
  hasWorkbenchContribution,
  WORKBENCH_DISCOVERY_RETRY_DELAYS_MS,
  runGuestAsyncInspection,
  sendToGuestSession,
  synchronizeWorkbenchContributionDiscovery,
  waitForSuccessfulGuestInspection,
  isExtensionGuestTarget,
  isWorkbenchTarget,
  isVerifiedIsolatedKunCommand,
  platformDesktopArguments,
  resolvedDesktopResourceCandidates,
  resolveDesktopLaunchSelection,
  runPackagedKun,
  terminateProcessTree,
  waitForPortsClosed
} = require('../smoke-packaged-extension-desktop.cjs')
const {
  withTimeout: withGraphWorkbenchTimeout
} = require('../smoke-development-graph-workbench.cjs')

const root = resolve(__dirname, '../..')
const linuxUserNamespaceStepName = 'Prepare and verify Linux user namespace sandbox'
const linuxUserNamespaceSetup = [
  'if [[ -e /proc/sys/kernel/unprivileged_userns_clone ]]; then',
  '  sudo sysctl -w kernel.unprivileged_userns_clone=1',
  'fi',
  'if [[ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]]; then',
  '  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
  'fi',
  'unshare --user --map-root-user /bin/true'
].join('\n')

function readDesktopSmokeSource() {
  return [
    'smoke-packaged-extension-desktop.cjs',
    'smoke-packaged-extension-desktop-runtime.cjs',
    'smoke-packaged-extension-desktop-cdp.cjs',
    'smoke-packaged-extension-desktop-guest.cjs',
    'smoke-packaged-extension-desktop-media.cjs',
    'smoke-packaged-extension-desktop-process.cjs'
  ].map((name) => readFileSync(join(root, 'scripts', name), 'utf8')).join('\n')
}

class FakeWebSocket {
  constructor() {
    this.readyState = 1
    this.listeners = new Map()
    this.sent = []
    this.onSend = () => undefined
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? []
    listeners.push(listener)
    this.listeners.set(name, listeners)
  }

  send(body) {
    const payload = JSON.parse(body)
    this.sent.push(payload)
    queueMicrotask(() => this.onSend(payload))
  }

  emit(name, event) {
    for (const listener of this.listeners.get(name) ?? []) listener(event)
  }

  close() {
    this.readyState = 3
    this.emit('close', {})
  }
}

test('runs long guest inspections as a started task with short result polls', async () => {
  const expressions = []
  let polls = 0
  let starts = 0
  const result = await runGuestAsyncInspection({
    cdp: {},
    sessionId: 'guest-session',
    sendCommand: async (_method, params) => {
      expressions.push(params.expression)
      if (params.expression.includes('Promise.resolve')) {
        starts += 1
        return { result: { value: '__kunPackagedGuestInspectionTest' } }
      }
      if (params.expression.startsWith('delete ')) return { result: { value: true } }
      polls += 1
      if (polls === 1) return { result: { value: null } }
      if (polls === 2) return { result: { value: { state: 'pending' } } }
      return { result: { value: { state: 'fulfilled', value: { mode: 'ok' } } } }
    },
    expression: '(async () => ({ mode: \'ok\' }))()',
    userGesture: true,
    timeoutMs: 1_000,
    description: 'test asynchronous guest inspection'
  })
  assert.deepEqual(result, { mode: 'ok' })
  assert.equal(polls, 3)
  assert.equal(starts, 2)
  assert.equal(expressions.some((expression) => expression.includes('Promise.resolve')), true)
  assert.equal(expressions.at(-1)?.startsWith('delete '), true)
})

test('waits for the packaged Extension guest main-frame media binding to become current', async () => {
  let attempts = 0
  const result = await waitForSuccessfulGuestInspection({
    inspect: async () => {
      attempts += 1
      return attempts === 1
        ? { mediaPlaybackMode: 'rejected', mediaPlaybackError: { message: 'binding pending' } }
        : { mediaPlaybackMode: 'ok', mediaPlayback: { leaseId: 'lease-1' } }
    },
    isSuccessful: (value) => value.mediaPlaybackMode === 'ok',
    timeoutMs: 1_000,
    description: 'test guest media binding'
  })
  assert.equal(attempts, 2)
  assert.deepEqual(result, {
    mediaPlaybackMode: 'ok',
    mediaPlayback: { leaseId: 'lease-1' }
  })
})

test('uses a command budget that covers bounded packaged guest security checks', () => {
  const cdp = new CdpConnection(new FakeWebSocket())
  assert.equal(cdp.commandTimeoutMs, 30_000)
  cdp.close()
})

test('routes flattened CDP commands and rejects protocol errors', async () => {
  const socket = new FakeWebSocket()
  const cdp = new CdpConnection(socket, 1_000)
  const events = []
  const stop = cdp.onEvent('Target.targetCreated', (params, message) => {
    events.push({ params, sessionId: message.sessionId })
  })
  socket.emit('message', {
    data: JSON.stringify({
      method: 'Target.targetCreated',
      params: { targetInfo: { targetId: 'popup-1' } },
      sessionId: 'browser-session'
    })
  })
  assert.deepEqual(events, [
    {
      params: { targetInfo: { targetId: 'popup-1' } },
      sessionId: 'browser-session'
    }
  ])
  stop()
  socket.emit('message', {
    data: JSON.stringify({
      method: 'Target.targetCreated',
      params: { targetInfo: { targetId: 'popup-2' } }
    })
  })
  assert.equal(events.length, 1)
  socket.onSend = (payload) => {
    if (payload.method === 'Target.getTargets') {
      socket.emit('message', {
        data: JSON.stringify({
          id: payload.id,
          result: { targetInfos: [{ targetId: 'page-1' }] }
        })
      })
      return
    }
    socket.emit('message', {
      data: JSON.stringify({
        id: payload.id,
        error: { code: -32601, message: 'unknown method' }
      })
    })
  }

  assert.deepEqual(await cdp.send('Target.getTargets', {}, 'browser-session'), {
    targetInfos: [{ targetId: 'page-1' }]
  })
  assert.equal(socket.sent[0].sessionId, 'browser-session')
  await assert.rejects(cdp.send('Missing.method'), /unknown method/)
  cdp.close()
})

test('detects a user-gesture popup target even when it changes URL after creation', () => {
  const popupUrl = 'http://127.0.0.1:43123/extension-popup-canary'
  assert.deepEqual(
    findUnexpectedPopupTargets({
      beforeTargetIds: new Set(['workbench', 'guest', 'old-popup']),
      observedTargets: [
        {
          targetId: 'popup-1',
          type: 'page',
          url: '',
          openerId: 'guest'
        }
      ],
      targetsAfter: [
        { targetId: 'popup-1', type: 'page', url: popupUrl, openerId: 'guest' },
        {
          targetId: 'old-popup',
          type: 'page',
          url: popupUrl,
          openerId: 'guest'
        },
        { targetId: 'background', type: 'page', url: 'about:blank' }
      ],
      guestTargetId: 'guest',
      popupUrl
    }),
    [
      {
        targetId: 'popup-1',
        type: 'page',
        url: popupUrl,
        openerId: 'guest'
      }
    ]
  )
})

test('fails closed unless the guest exposes only the narrow bridge and blocked browser egress', () => {
  const secure = {
    href: `kun-extension://${EXTENSION_ID}/dist/webview/index.html?kunViewSession=view-123`,
    marker: WEBVIEW_MARKER,
    bridgeMethods: ['request', 'notify', 'onNotification', 'registerHandler', 'dispose'],
    bridgeOwnKeys: ['dispose', 'notify', 'onNotification', 'registerHandler', 'request'].map((name) => ({
      kind: 'string',
      name
    })),
    bridgeRequestMode: 'ok',
    theme: {
      kind: 'dark',
      tokens: { foreground: '#ffffff' },
      zoomFactor: 1,
      reducedMotion: false
    },
    viewStateRoundTripMode: 'ok',
    viewState: {
      found: true,
      value: {
        schemaVersion: 1,
        marker: 'packaged-desktop-view-state-round-trip',
        nested: { count: 1, enabled: true }
      }
    },
    mediaPlaybackMode: 'ok',
    mediaPlayback: {
      scheme: 'kun-media:',
      duration: 2,
      currentTime: 0.5,
      readyState: 4,
      leaseId: 'media_lease_packaged_test'
    },
    imagePlaybackMode: 'ok',
    imagePlayback: {
      scheme: 'kun-media:',
      naturalWidth: 1,
      naturalHeight: 1,
      leaseId: 'image_lease_packaged_test'
    },
    imageReleaseMode: 'ok',
    copiedMediaUrlMode: 'blocked',
    arbitraryLocalPathMode: 'blocked',
    releaseMode: 'ok',
    postReleaseMediaUrlMode: 'blocked',
    hasKunGui: false,
    hasElectron: false,
    hasIpcRenderer: false,
    hasBuffer: false,
    hasRequire: false,
    hasProcess: false,
    fetchMode: 'rejected',
    popupMode: 'denied',
    popupTargets: []
  }
  assert.doesNotThrow(() => assertGuestSecurityResult(secure))
  assert.throws(() => assertGuestSecurityResult({ ...secure, hasKunGui: true }), /privileged window\.kunGui/)
  assert.throws(
    () =>
      assertGuestSecurityResult({
        ...secure,
        bridgeOwnKeys: [...secure.bridgeOwnKeys, { kind: 'symbol', name: 'hidden' }]
      }),
    /unexpected own keys/
  )
  assert.throws(
    () => assertGuestSecurityResult({ ...secure, bridgeRequestMode: 'rejected' }),
    /request round-trip failed/
  )
  assert.throws(() => assertGuestSecurityResult({ ...secure, hasIpcRenderer: true }), /ipcRenderer/)
  assert.throws(
    () =>
      assertGuestSecurityResult({
        ...secure,
        theme: { ...secure.theme, zoomFactor: 0 }
      }),
    /zoomFactor/
  )
  assert.throws(
    () =>
      assertGuestSecurityResult({
        ...secure,
        viewState: { found: true, value: { marker: 'forged' } }
      }),
    /View-state round-trip failed/
  )
  assert.throws(
    () => assertGuestSecurityResult({ ...secure, mediaPlayback: { ...secure.mediaPlayback, scheme: 'file:' } }),
    /kun-media desktop playback\/seek failed/
  )
  assert.throws(
    () => assertGuestSecurityResult({
      ...secure,
      imagePlayback: { ...secure.imagePlayback, naturalWidth: 0 }
    }),
    /kun-media desktop image playback failed/
  )
  assert.throws(
    () => assertGuestSecurityResult({
      ...secure,
      mediaPlaybackMode: 'rejected',
      mediaPlayback: null,
      copiedMediaUrlMode: 'invalid-url'
    }),
    /kun-media desktop playback\/seek failed: rejected null/
  )
  assert.throws(
    () => assertGuestSecurityResult({ ...secure, fetchMode: 'allowed' }),
    /loopback fetch was not rejected by the Host filter/
  )
  assert.throws(
    () => assertGuestSecurityResult({ ...secure, copiedMediaUrlMode: 'allowed' }),
    /copied sender URL was not blocked/
  )
  assert.throws(
    () => assertGuestSecurityResult({ ...secure, arbitraryLocalPathMode: 'allowed' }),
    /arbitrary local file URL was not blocked/
  )
  assert.throws(
    () => assertGuestSecurityResult({ ...secure, releaseMode: 'rejected' }),
    /media lease release failed/
  )
  assert.throws(
    () => assertGuestSecurityResult({ ...secure, postReleaseMediaUrlMode: 'allowed' }),
    /post-release URL was not blocked/
  )
  assert.throws(() => assertGuestSecurityResult({ ...secure, popupMode: 'allowed' }), /window\.open was not blocked/)
  assert.throws(
    () =>
      assertGuestSecurityResult({
        ...secure,
        popupTargets: [{ targetId: 'popup-1', type: 'page', url: 'about:blank' }]
      }),
    /created a CDP target/
  )
  assert.throws(() => assertGuestSecurityResult(secure, 1), /network canary/)
})
