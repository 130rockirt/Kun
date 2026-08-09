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

test('recognizes the workbench and kun-extension guest CDP targets', () => {
  assert.equal(CONTRIBUTION_ID, 'extension:kun-smoke.packaged/smoke')
  assert.equal(
    isWorkbenchTarget({
      type: 'page',
      url: 'file:///Applications/Kun.app/Contents/Resources/app.asar/out/renderer/index.html'
    }),
    true
  )
  assert.equal(
    isWorkbenchTarget({
      type: 'page',
      url: 'file:///app/out/renderer/index.html'
    }),
    false
  )
  assert.equal(isWorkbenchTarget({ type: 'page', url: 'http://localhost:5173/' }), false)
  assert.equal(isWorkbenchTarget({ type: 'page', url: 'http://127.0.0.1:5173/' }), false)
  assert.equal(
    isWorkbenchTarget({
      type: 'webview',
      url: `kun-extension://${EXTENSION_ID}/index.html`
    }),
    false
  )
  assert.equal(
    isExtensionGuestTarget({
      targetId: 'guest-1',
      type: 'webview',
      url: `kun-extension://${EXTENSION_ID}/dist/webview/index.html?kunViewSession=123`
    }),
    true
  )
  assert.equal(
    isExtensionGuestTarget({
      targetId: 'guest-2',
      type: 'webview',
      url: 'kun-extension://other.example/index.html'
    }),
    false
  )
  assert.equal(
    isExtensionGuestTarget({
      targetId: 'guest-3',
      type: 'page',
      url: `kun-extension://${EXTENSION_ID}/dist/webview/index.html?kunViewSession=123`
    }),
    false
  )
  assert.equal(
    isExtensionGuestTarget({
      targetId: 'guest-4',
      type: 'webview',
      url: `kun-extension://${EXTENSION_ID}/dist/webview/index.html`
    }),
    false
  )
  assert.equal(
    isExtensionGuestTarget({
      targetId: 'guest-5',
      type: 'webview',
      url: `kun-extension://${EXTENSION_ID}/dist/webview/index.html?kunViewSession=123&extra=1`
    }),
    false
  )
})

test('synchronizes renderer discovery after the trusted bridge sees the installed smoke view', async () => {
  assert.deepEqual(WORKBENCH_DISCOVERY_RETRY_DELAYS_MS, [0, 250, 1_000, 3_000, 6_000])
  const response = {
    ok: true,
    status: 200,
    body: JSON.stringify({
      schemaVersion: 1,
      revision: 7,
      extensions: [{
        id: EXTENSION_ID,
        workspaceTrusted: true,
        grantedPermissions: ['ui.views', 'webview'],
        contributes: { 'views.rightSidebar': [{ id: 'smoke' }] }
      }]
    })
  }
  assert.equal(hasWorkbenchContribution(response, CONTRIBUTION_ID), true)
  assert.equal(hasWorkbenchContribution(response, 'extension:other.example/smoke'), false)
  assert.equal(hasWorkbenchContribution({
    ...response,
    body: JSON.stringify({
      schemaVersion: 1,
      revision: 8,
      extensions: [{
        id: EXTENSION_ID,
        workspaceTrusted: false,
        grantedPermissions: ['ui.views', 'webview'],
        contributes: { 'views.rightSidebar': [{ id: 'smoke' }] }
      }]
    })
  }, CONTRIBUTION_ID), false)
  assert.equal(hasWorkbenchContribution({
    ...response,
    body: JSON.stringify({
      schemaVersion: 1,
      revision: 9,
      extensions: [{
        id: EXTENSION_ID,
        workspaceTrusted: true,
        grantedPermissions: ['ui.views'],
        contributes: { 'views.rightSidebar': [{ id: 'smoke' }] }
      }]
    })
  }, CONTRIBUTION_ID), false)
  const calls = []
  const session = { targetId: 'workbench-target', sessionId: 'workbench-session' }
  await synchronizeWorkbenchContributionDiscovery({
    cdp: {
      send: async (...args) => {
        calls.push(args)
        return args[1].expression.includes('extensionGetWorkbench')
          ? { result: { value: response } }
          : { result: { value: true } }
      }
    },
    session,
    workspaceRoot: '/workspace',
    contributionId: CONTRIBUTION_ID,
    timeoutMs: 1_000,
    processState: () => ({ exitCode: null, signalCode: null })
  })
  assert.deepEqual(calls.map(([method, params, sessionId]) => ({ method, sessionId, params: {
    awaitPromise: params.awaitPromise,
    returnByValue: params.returnByValue
  } })), [
    {
      method: 'Runtime.evaluate',
      sessionId: 'workbench-session',
      params: { awaitPromise: true, returnByValue: true }
    },
    {
      method: 'Runtime.evaluate',
      sessionId: 'workbench-session',
      params: { awaitPromise: undefined, returnByValue: true }
    }
  ])
  assert.match(calls[0][1].expression, /extensionGetWorkbench/)
  assert.match(calls[1][1].expression, /window\.dispatchEvent/)
  assert.doesNotMatch(calls[1][1].expression, /window\.setTimeout/)
})

test('reattaches renderer discovery when the packaged workbench CDP session is replaced', async () => {
  const response = {
    ok: true,
    status: 200,
    body: JSON.stringify({
      extensions: [{
        id: EXTENSION_ID,
        workspaceTrusted: true,
        grantedPermissions: ['ui.views', 'webview'],
        contributes: { 'views.rightSidebar': [{ id: 'smoke' }] }
      }]
    })
  }
  const calls = []
  let rejectedOldSession = false
  const session = { targetId: 'old-target', sessionId: 'old-session' }
  await synchronizeWorkbenchContributionDiscovery({
    cdp: {
      send: async (method, params, sessionId) => {
        calls.push([method, params, sessionId])
        if (method === 'Runtime.evaluate' && sessionId === 'old-session' && !rejectedOldSession) {
          rejectedOldSession = true
          throw new Error('CDP Runtime.evaluate failed (-32001): Session with given id not found.')
        }
        if (method === 'Target.getTargets') {
          return {
            targetInfos: [{
              targetId: 'replacement-target',
              type: 'page',
              url: 'file:///opt/Kun/resources/app.asar/out/renderer/index.html'
            }]
          }
        }
        if (method === 'Target.attachToTarget') return { sessionId: 'replacement-session' }
        if (method === 'Runtime.enable') return {}
        return params.expression.includes('extensionGetWorkbench')
          ? { result: { value: response } }
          : { result: { value: true } }
      }
    },
    session,
    workspaceRoot: '/workspace',
    contributionId: CONTRIBUTION_ID,
    timeoutMs: 1_000,
    processState: () => ({ exitCode: null, signalCode: null })
  })
  assert.deepEqual(session, {
    targetId: 'replacement-target',
    sessionId: 'replacement-session'
  })
  assert.equal(calls.some(([method]) => method === 'Target.getTargets'), true)
  assert.equal(calls.some(([method]) => method === 'Target.attachToTarget'), true)
  assert.equal(
    calls.filter(([method, , sessionId]) =>
      method === 'Runtime.evaluate' && sessionId === 'replacement-session').length,
    2
  )
})

test('retries renderer discovery when the initial packaged workbench target is replaced before attach', async () => {
  const response = {
    ok: true,
    status: 200,
    body: JSON.stringify({
      extensions: [{
        id: EXTENSION_ID,
        workspaceTrusted: true,
        grantedPermissions: ['ui.views', 'webview'],
        contributes: { 'views.rightSidebar': [{ id: 'smoke' }] }
      }]
    })
  }
  const calls = []
  let targetLookupCount = 0
  const session = { targetId: 'initial-target', sessionId: undefined }
  await synchronizeWorkbenchContributionDiscovery({
    cdp: {
      send: async (method, params, sessionId) => {
        calls.push([method, params, sessionId])
        if (method === 'Target.getTargets') {
          targetLookupCount += 1
          return {
            targetInfos: [{
              targetId: targetLookupCount === 1 ? 'initial-target' : 'replacement-target',
              type: 'page',
              url: 'file:///opt/Kun/resources/app.asar/out/renderer/index.html'
            }]
          }
        }
        if (method === 'Target.attachToTarget') {
          return {
            sessionId: params.targetId === 'initial-target'
              ? 'initial-session'
              : 'replacement-session'
          }
        }
        if (method === 'Runtime.enable' && sessionId === 'initial-session') {
          throw new Error('CDP Runtime.enable failed (-32001): Session with given id not found.')
        }
        if (method === 'Runtime.enable') return {}
        return params.expression.includes('extensionGetWorkbench')
          ? { result: { value: response } }
          : { result: { value: true } }
      }
    },
    session,
    workspaceRoot: '/workspace',
    contributionId: CONTRIBUTION_ID,
    timeoutMs: 1_000,
    processState: () => ({ exitCode: null, signalCode: null })
  })
  assert.deepEqual(session, {
    targetId: 'replacement-target',
    sessionId: 'replacement-session'
  })
  assert.equal(targetLookupCount, 2)
  assert.equal(calls.some(([method, params]) =>
    method === 'Target.attachToTarget' && params.targetId === 'replacement-target'), true)
  assert.equal(
    calls.filter(([method, , sessionId]) =>
      method === 'Runtime.evaluate' && sessionId === 'replacement-session').length,
    2
  )
})

test('reattaches a replaced packaged Extension guest before replaying its CDP command', async () => {
  const calls = []
  let rejectedOldSession = false
  const session = { targetId: 'old-guest', sessionId: 'old-guest-session' }
  const response = await sendToGuestSession({
    cdp: {
      send: async (method, params, sessionId) => {
        calls.push([method, params, sessionId])
        if (method === 'Runtime.evaluate' && sessionId === 'old-guest-session' && !rejectedOldSession) {
          rejectedOldSession = true
          throw new Error('CDP Runtime.evaluate failed (-32001): Session with given id not found.')
        }
        if (method === 'Target.getTargets') {
          return {
            targetInfos: [{
              targetId: 'replacement-guest',
              type: 'webview',
              url: `kun-extension://${EXTENSION_ID}/dist/webview/index.html?kunViewSession=replacement`
            }]
          }
        }
        if (method === 'Target.attachToTarget') return { sessionId: 'replacement-guest-session' }
        if (method === 'Runtime.enable') return {}
        return { result: { value: 'replayed' } }
      }
    },
    session,
    method: 'Runtime.evaluate',
    params: { expression: 'location.href', returnByValue: true },
    timeoutMs: 1_000,
    processState: () => ({ exitCode: null, signalCode: null }),
    operation: 'testing guest recovery'
  })
  assert.deepEqual(response, { result: { value: 'replayed' } })
  assert.deepEqual(session, {
    targetId: 'replacement-guest',
    sessionId: 'replacement-guest-session'
  })
  assert.equal(calls.some(([method, params]) =>
    method === 'Target.attachToTarget' && params.targetId === 'replacement-guest'), true)
  assert.equal(calls.at(-1)?.[2], 'replacement-guest-session')
})

test('reattaches and replays a guest Runtime evaluation after a silent CDP timeout', async () => {
  let timedOut = false
  const session = { targetId: 'guest-target', sessionId: 'timed-out-session' }
  const response = await sendToGuestSession({
    cdp: {
      send: async (method, params, sessionId) => {
        if (method === 'Runtime.evaluate' && !timedOut) {
          timedOut = true
          throw new Error('CDP command timed out: Runtime.evaluate')
        }
        if (method === 'Target.getTargets') {
          return {
            targetInfos: [{
              targetId: 'guest-target',
              type: 'webview',
              url: `kun-extension://${EXTENSION_ID}/dist/webview/index.html?kunViewSession=current`
            }]
          }
        }
        if (method === 'Target.attachToTarget') return { sessionId: 'reattached-session' }
        if (method === 'Runtime.enable') return {}
        return { result: { value: params.expression } }
      }
    },
    session,
    method: 'Runtime.evaluate',
    params: { expression: 'document.readyState', returnByValue: true },
    timeoutMs: 1_000,
    processState: () => ({ exitCode: null, signalCode: null }),
    operation: 'testing silent guest timeout recovery'
  })
  assert.deepEqual(response, { result: { value: 'document.readyState' } })
  assert.equal(session.sessionId, 'reattached-session')
})
