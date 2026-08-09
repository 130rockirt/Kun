#!/usr/bin/env node

const { execFileSync, spawnSync } = require('node:child_process')
const { createServer } = require('node:net')
const { existsSync, realpathSync } = require('node:fs')
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { basename, dirname, join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const {
  DEFAULT_EXTENSION_IDS,
  PACKAGED_EXTENSION_SMOKE_SUCCESS_MARKER,
  assertPackagedSmokeChildResult,
  createPackagedExtensionSmokeReexecEnvironment,
  makeTreeWritable,
  packagedResourceCandidates,
  resolvePackagedRuntimeExecutable,
  resolveResources,
  resolvedPackagedResourceCandidates,
  validatePackagedResources
} = require('./smoke-packaged-extensions-resources.cjs')

const EXTENSION_ID = 'kun-smoke.packaged'
const RUNTIME_TOKEN = 'kun-packaged-extension-smoke-token'

async function main() {
  // Headless release smoke profiles must not depend on an interactive OS
  // credential service. The runtime still exercises encrypted 0600 key-file
  // storage; production keeps its normal fail-closed keychain behavior.
  process.env.KUN_DISABLE_OS_CREDENTIAL_STORE = '1'
  const resourcesDir = resolveResources(argumentValue('--resources'))
  if (process.env.KUN_PACKAGED_EXTENSION_SMOKE_REEXEC !== '1') {
    const runtimeExecutable = resolvePackagedRuntimeExecutable(
      resourcesDir,
      argumentValue('--runtime-executable')
    )
    if (runtimeExecutable) {
      const result = spawnSync(runtimeExecutable, [__filename, ...process.argv.slice(2)], {
        cwd: process.cwd(),
        env: createPackagedExtensionSmokeReexecEnvironment(process.env),
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      if (result.stdout) process.stdout.write(result.stdout)
      if (result.stderr) process.stderr.write(result.stderr)
      assertPackagedSmokeChildResult(result)
      return
    }
  }
  const unpackedRoot = join(resourcesDir, 'app.asar.unpacked')
  const runtimeEntry = join(unpackedRoot, 'kun', 'dist', 'cli', 'serve-entry.js')
  validatePackagedResources(resourcesDir, unpackedRoot)

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kun-packaged-extension-smoke-'))
  let server
  let primaryFailed = false
  let primaryError
  let cleanupFailed = false
  let cleanupError
  try {
    const profile = join(temporaryRoot, 'profile')
    const workspace = join(temporaryRoot, 'workspace')
    await mkdir(workspace, { recursive: true })
    await installSmokeExtensionFixture({
      temporaryRoot,
      profile,
      runCli: (args) => runKun(runtimeEntry, args)
    })

    const [{ parseServeOptions }, { startKunServe }, { makeUserItem }] = await Promise.all([
      importFresh(join(unpackedRoot, 'kun', 'dist', 'cli', 'serve.js')),
      importFresh(join(unpackedRoot, 'kun', 'dist', 'server', 'runtime-factory.js')),
      importFresh(join(unpackedRoot, 'kun', 'dist', 'domain', 'item.js'))
    ])
    const port = await availablePort()
    const options = parseServeOptions([
      '--host', '127.0.0.1',
      '--port', String(port),
      '--data-dir', profile,
      '--bundled-extensions-dir', join(resourcesDir, 'bundled-extensions'),
      '--runtime-token', RUNTIME_TOKEN,
      '--api-key', 'packaged-smoke-placeholder',
      '--base-url', 'https://invalid.example',
      '--model', 'packaged-smoke-model',
      '--approval-policy', 'auto',
      '--sandbox-mode', 'danger-full-access'
    ], {})
    server = await startKunServe(options)

    const activated = await activateSmokeExtension(server.runtime, workspace)
    await smokeWorkbenchAndWebview(port, activated.workspace)
    const tool = await smokeHeadlessTool(server.runtime, activated.workspace)
    const provider = await smokeCustomProvider(server.runtime, activated.host, makeUserItem)
    await smokeAgentTool(server.runtime, activated.workspace, tool, provider)

    const diagnostics = await server.runtime.toolDiagnostics()
    if (!diagnostics.extensions.tools.some((tool) => tool.extensionId === EXTENSION_ID)) {
      throw new Error('Packaged extension tool is absent from runtime diagnostics')
    }
    if (diagnostics.extensions.providers.length !== 1) {
      throw new Error('Packaged custom Provider is absent from runtime diagnostics')
    }

    await server.close()
    server = undefined
    runKun(runtimeEntry, ['extension', 'doctor', EXTENSION_ID, '--data-dir', profile, '--json'])
    runKun(runtimeEntry, ['extension', 'uninstall', EXTENSION_ID, '--data-dir', profile, '--json'])
    const listed = JSON.parse(runKun(runtimeEntry, [
      'extension', 'list', '--data-dir', profile, '--json'
    ]))
    if (!Array.isArray(listed.extensions) || listed.extensions.length !== DEFAULT_EXTENSION_IDS.length) {
      throw new Error('Packaged default extensions were not seeded through the normal registry')
    }
    for (const id of DEFAULT_EXTENSION_IDS) {
      const installed = listed.extensions.find((extension) => extension?.id === id)
      if (installed?.globallyEnabled !== false) {
        throw new Error(`Packaged default extension was not registered as disabled: ${id}`)
      }
      runKun(runtimeEntry, [
        'extension', 'uninstall', id, '--data-dir', profile, '--json'
      ])
    }
    server = await startKunServe(options)
    await server.close()
    server = undefined
    const afterRemoval = JSON.parse(runKun(runtimeEntry, [
      'extension', 'list', '--data-dir', profile, '--json'
    ]))
    if (!Array.isArray(afterRemoval.extensions) || afterRemoval.extensions.length !== 0) {
      throw new Error('Packaged default extension was resurrected after explicit uninstall')
    }

  } catch (error) {
    primaryFailed = true
    primaryError = error
  } finally {
    await server?.close().catch(() => undefined)
    if (process.env.KUN_KEEP_PACKAGED_EXTENSION_SMOKE === '1') {
      process.stderr.write(`Preserved packaged Extension smoke profile: ${temporaryRoot}\n`)
    } else {
      try {
        await makeTreeWritable(temporaryRoot)
        await rm(temporaryRoot, { recursive: true, force: true })
      } catch (error) {
        cleanupFailed = true
        cleanupError = error
      }
    }
  }
  if (primaryFailed) {
    if (cleanupFailed) {
      process.stderr.write(
        `Could not clean packaged Extension smoke profile ${temporaryRoot}: ${String(cleanupError)}\n`
      )
    }
    throw primaryError
  }
  if (cleanupFailed) throw cleanupError
  process.stdout.write(
    `${PACKAGED_EXTENSION_SMOKE_SUCCESS_MARKER}${process.platform}): resources, bundled-default seed/removal, .kunx lifecycle, Webview session, headless tool, Agent/tool round-trip, custom Provider/account stream, diagnostics, and uninstall.\n`
  )
}

async function createSmokeExtension(root, { webviewConnectUrls = [] } = {}) {
  const webviewCsp = smokeWebviewCsp(webviewConnectUrls)
  await mkdir(join(root, 'dist', 'webview'), { recursive: true })
  await writeFile(join(root, 'kun-extension.json'), `${JSON.stringify({
    manifestVersion: 1,
    apiVersion: '1.2.0',
    publisher: 'kun-smoke',
    name: 'packaged',
    version: '1.0.0',
    displayName: 'Packaged Extension Smoke',
    description: 'Release-only deterministic packaged Extension Platform smoke fixture.',
    license: 'MIT',
    engines: { kun: '>=0.1.0' },
    main: 'dist/extension.js',
    browser: 'dist/webview/index.html',
    activationEvents: ['onTool:echo', 'onProvider:echo', 'onView:smoke'],
    contributes: {
      'views.rightSidebar': [{
        id: 'smoke',
        title: 'Packaged smoke',
        entry: 'dist/webview/index.html',
        localResourceRoots: ['dist/webview']
      }],
      tools: [{
        id: 'echo',
        description: 'Echo one bounded value through the packaged Extension Host.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', minLength: 1, maxLength: 256 } },
          required: ['text'],
          additionalProperties: false
        },
        outputSchema: {
          type: 'object',
          properties: { echo: { type: 'string' } },
          required: ['echo'],
          additionalProperties: false
        },
        sideEffects: 'none',
        idempotent: true
      }],
      modelProviders: [{
        id: 'echo',
        displayName: 'Packaged Echo Provider',
        credentialHosts: [],
        adapterApiVersion: '1.0.0',
        models: [{
          id: 'echo-1',
          displayName: 'Packaged Echo 1',
          capabilities: {
            input: ['text'],
            output: ['text'],
            reasoning: false,
            tools: true,
            parallelTools: false,
            streaming: true,
            maxContextTokens: 8192,
            maxOutputTokens: 1024
          }
        }]
      }]
    },
    permissions: [
      'ui.views',
      'webview',
      'tools.register',
      'providers.register',
      'agent.run',
      'agent.threads.readOwn',
      'workspace.read',
      'media.read',
      'accounts.read',
      'accounts.manage:echo',
      'accounts.use:echo'
    ],
    stateSchemaVersion: 1
  }, null, 2)}\n`)
  await writeFile(join(root, 'LICENSE'), 'MIT\n')
  await writeFile(join(root, 'README.md'), '# Packaged Extension smoke fixture\n')
  await writeFile(join(root, 'dist', 'webview', 'index.html'), [
    '<!doctype html>',
    `<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${webviewCsp}"></head>`,
    '<body><main data-kun-packaged-webview-smoke="ready">Packaged Webview smoke</main></body></html>',
    ''
  ].join('\n'))
  await writeFile(join(root, 'dist', 'extension.js'), `
const provider = {
  id: 'echo',
  displayName: 'Packaged Echo Provider',
  credentialHosts: [],
  adapterApiVersion: '1.0.0',
  models: [{
    id: 'echo-1',
    displayName: 'Packaged Echo 1',
    capabilities: {
      input: ['text'], output: ['text'], reasoning: false, tools: true,
      parallelTools: false, streaming: true, maxContextTokens: 8192, maxOutputTokens: 1024
    }
  }]
}

export async function activate(context) {
  context.subscriptions.add(await context.tools.registerTool({
    id: 'echo',
    description: 'Echo one bounded value through the packaged Extension Host.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1, maxLength: 256 } },
      required: ['text'],
      additionalProperties: false
    },
    outputSchema: {
      type: 'object', properties: { echo: { type: 'string' } },
      required: ['echo'], additionalProperties: false
    },
    sideEffects: 'none',
    idempotent: true
  }, async (input) => ({ content: { echo: input.text } })))

  context.subscriptions.add(await context.modelProviders.registerProvider(provider, {
    async probe() { return { ok: true, latencyMs: 0, message: 'packaged-provider-ok' } },
    async listModels() { return provider.models },
    async *stream(request) {
      const smokeTool = request.tools.find((tool) =>
        tool.description.includes('Echo one bounded value through the packaged Extension Host.')
      )
      const hasToolResult = request.messages.some((message) => message.role === 'tool')
      if (smokeTool && !hasToolResult) {
        yield {
          requestId: request.requestId,
          sequence: 0,
          type: 'toolCallComplete',
          callId: 'packaged_agent_tool_call',
          name: smokeTool.name,
          input: { text: 'packaged-agent-tool-ok' }
        }
        yield {
          requestId: request.requestId,
          sequence: 1,
          type: 'completed',
          finishReason: 'tool_calls',
          usage: { inputTokens: 1, outputTokens: 1 }
        }
        return
      }
      yield { requestId: request.requestId, sequence: 0, type: 'textDelta', delta: 'packaged-provider-ok' }
      yield {
        requestId: request.requestId,
        sequence: 1,
        type: 'completed',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 }
      }
    },
    cancel() {}
  }))
}

export async function deactivate() {}
`.trimStart())
}

async function installSmokeExtensionFixture({
  temporaryRoot,
  profile,
  runCli,
  webviewConnectUrls = []
}) {
  if (typeof runCli !== 'function') throw new TypeError('runCli must be a function')
  const source = join(temporaryRoot, 'source')
  const archive = join(temporaryRoot, 'packaged-smoke.kunx')
  await createSmokeExtension(source, { webviewConnectUrls })

  runCli(['extension', 'validate', source, '--json'])
  runCli([
    'extension', 'pack', source,
    '--output', archive,
    '--include', 'dist',
    '--overwrite',
    '--json'
  ])
  runCli([
    'extension', 'install', archive,
    '--data-dir', profile,
    '--accept-permissions',
    '--json'
  ])

  const installedRoot = join(profile, 'extensions', EXTENSION_ID, '1.0.0')
  assertExists(join(installedRoot, 'kun-extension.json'), 'installed Manifest')
  assertExists(join(installedRoot, 'dist', 'webview', 'index.html'), 'installed Webview resource')
  return { source, archive, installedRoot }
}

function smokeWebviewCsp(webviewConnectUrls = []) {
  if (!Array.isArray(webviewConnectUrls)) {
    throw new TypeError('webviewConnectUrls must be an array')
  }
  const connectSources = [...new Set(webviewConnectUrls.map((value) => {
    let url
    try {
      url = new URL(value)
    } catch {
      throw new TypeError(`Invalid desktop smoke Webview connect URL: ${String(value)}`)
    }
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      url.username ||
      url.password
    ) {
      throw new TypeError(`Desktop smoke Webview connect URL must be an explicit loopback origin: ${value}`)
    }
    return url.origin
  }))]
  return [
    "default-src 'none'",
    "style-src 'self'",
    "img-src 'self' data: kun-media:",
    "media-src 'self' kun-media:",
    `connect-src ${connectSources.length > 0 ? connectSources.join(' ') : "'none'"}`
  ].join('; ')
}

async function smokeWorkbenchAndWebview(port, workspace) {
  const workbench = await runtimeJson(
    port,
    `/v1/extensions/workbench?workspace_root=${encodeURIComponent(workspace)}`
  )
  const installed = workbench.extensions?.find((extension) => extension.id === EXTENSION_ID)
  if (!installed?.contributes?.['views.rightSidebar']?.some((view) => view.id === 'smoke')) {
    throw new Error('Packaged workbench snapshot does not expose the smoke Webview')
  }
  const created = await runtimeJson(port, '/v1/extensions/view-sessions', {
    method: 'POST',
    body: JSON.stringify({
      contributionId: `extension:${EXTENSION_ID}/smoke`,
      workspaceRoot: workspace
    })
  })
  if (typeof created.sessionId !== 'string' || typeof created.nonce !== 'string') {
    throw new Error('Packaged runtime did not create a bound Webview session')
  }
  await runtimeJson(port, `/v1/extensions/view-sessions/${encodeURIComponent(created.sessionId)}`, {
    method: 'DELETE'
  })
}

async function activateSmokeExtension(runtime, workspace) {
  const platform = runtime.extensionPlatform
  const entry = await platform.registry.get(EXTENSION_ID)
  const active = entry?.useDevelopment
    ? entry.development
    : entry?.selectedVersion
      ? entry.versions[entry.selectedVersion]
      : undefined
  if (!active) throw new Error('Packaged smoke extension has no selected registry version')
  const canonicalWorkspace = realpathSync(workspace)
  const workspaceKey = platform.paths.workspaceKey(canonicalWorkspace)
  await platform.registry.setWorkspaceEnabled(EXTENSION_ID, workspaceKey, true)
  await platform.registry.setWorkspacePermissionGrant(
    EXTENSION_ID,
    workspaceKey,
    [...active.grantedPermissions],
    active.manifest.version
  )
  const host = await platform.manager.activate(EXTENSION_ID, 'onTool:echo', {
    workspaceRoot: canonicalWorkspace,
    workspaceContext: {
      id: workspaceKey,
      name: basename(canonicalWorkspace) || 'Packaged smoke workspace',
      root: canonicalWorkspace,
      trusted: true,
      active: true
    }
  })
  if (!host) throw new Error('Packaged extension Node Host did not activate')
  return { host, workspace: canonicalWorkspace }
}

async function smokeHeadlessTool(runtime, workspace) {
  const registration = runtime.extensionPlatform.tools.list(EXTENSION_ID)[0]
  if (!registration) throw new Error('Packaged extension tool did not register')
  const result = await runtime.toolHost.execute({
    callId: 'packaged_smoke_tool_call',
    toolName: registration.modelAlias,
    providerId: `extension:${EXTENSION_ID}`,
    arguments: { text: 'packaged-tool-ok' }
  }, {
    threadId: 'packaged_smoke_thread',
    turnId: 'packaged_smoke_turn',
    workspace,
    approvalPolicy: 'auto',
    sandboxMode: 'danger-full-access',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  })
  if (
    result.item.isError ||
    result.item.output?.content?.echo !== 'packaged-tool-ok'
  ) {
    throw new Error(`Packaged headless tool returned an invalid result: ${JSON.stringify(result.item.output)}`)
  }
  return registration
}

async function smokeCustomProvider(runtime, host, makeUserItem) {
  const provider = (await runtime.extensionPlatform.providerAccounts.listProviders())
    .find((candidate) => candidate.ownerExtensionId === EXTENSION_ID)
  if (!provider) throw new Error('Packaged custom Provider definition did not register')
  const principal = {
    extensionId: EXTENSION_ID,
    extensionVersion: host.principal.version,
    permissions: [
      'providers.register',
      'accounts.read',
      `accounts.manage:${provider.id}`,
      `accounts.use:${provider.id}`
    ],
    workspaceRoots: [],
    workspaceTrusted: true
  }
  const account = await runtime.extensionPlatform.accounts.createApiKeyAccount({
    principal,
    providerId: provider.id,
    label: 'Packaged smoke account',
    apiKey: 'packaged-smoke-secret-never-serialized',
    protectedInput: true
  })
  const client = runtime.extensionPlatform.modelProviders.clientMap().get(provider.id)
  if (!client) throw new Error('Packaged custom Provider client is unavailable')
  const chunks = []
  for await (const chunk of client.stream({
    threadId: 'packaged_smoke_thread',
    turnId: 'packaged_smoke_turn',
    model: 'echo-1',
    providerId: provider.id,
    accountId: account.id,
    systemPrompt: 'Packaged smoke stable prefix',
    contextInstructions: [],
    prefix: [],
    history: [makeUserItem({
      id: 'packaged_smoke_user',
      threadId: 'packaged_smoke_thread',
      turnId: 'packaged_smoke_turn',
      text: 'Use the packaged custom Provider.'
    })],
    attachments: [],
    tools: [],
    abortSignal: new AbortController().signal
  })) chunks.push(chunk)
  if (!chunks.some((chunk) => chunk.kind === 'assistant_text_delta' && chunk.text === 'packaged-provider-ok')) {
    throw new Error(`Packaged custom Provider stream is invalid: ${JSON.stringify(chunks)}`)
  }
  const accountProjection = JSON.stringify(account)
  if (accountProjection.includes('packaged-smoke-secret') || accountProjection.includes('credentialRef')) {
    throw new Error('Packaged account projection exposed credential material')
  }
  return { provider, account, principal }
}

async function smokeAgentTool(runtime, workspace, tool, providerContext) {
  const principal = {
    ...providerContext.principal,
    permissions: [
      ...providerContext.principal.permissions,
      'agent.run',
      'agent.threads.readOwn'
    ],
    workspaceRoots: [workspace]
  }
  const run = await runtime.extensionPlatform.agent.createRun(principal, {
    input: 'Call the packaged smoke extension tool, then finish.',
    workspace,
    providerBinding: {
      providerId: providerContext.provider.id,
      accountId: providerContext.account.id,
      modelId: 'echo-1'
    },
    allowedTools: [tool.canonicalToolId],
    budget: {
      maxElapsedMs: 20_000,
      maxModelRequests: 4,
      maxToolInvocations: 2
    }
  })
  const deadline = Date.now() + 20_000
  let current = run
  while (current.status === 'running' && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    current = await runtime.extensionPlatform.agent.getRun(principal, run.id)
  }
  if (current.status !== 'completed') {
    throw new Error(
      `Packaged Agent/tool run did not complete (${current.status}): ${current.error ?? 'no error detail'}`
    )
  }
  const thread = await runtime.threadService.get(run.threadId)
  const turn = thread?.turns.find((candidate) => candidate.id === run.id)
  const toolResult = turn?.items.find((item) =>
    item.kind === 'tool_result' && item.toolName === tool.modelAlias
  )
  if (
    !toolResult ||
    toolResult.isError ||
    toolResult.output?.content?.echo !== 'packaged-agent-tool-ok'
  ) {
    throw new Error(`Packaged Agent did not execute the extension tool: ${JSON.stringify(toolResult)}`)
  }
  const finalText = turn?.items.find((item) =>
    item.kind === 'assistant_text' && item.text.includes('packaged-provider-ok')
  )
  if (!finalText) {
    throw new Error('Packaged Agent did not complete the second Provider round after the tool result')
  }
}

async function runtimeJson(port, path, init = {}) {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${RUNTIME_TOKEN}`)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers })
  const body = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed (${response.status}): ${body}`)
  return body ? JSON.parse(body) : undefined
}

function runKun(entry, args) {
  return execFileSync(process.execPath, [entry, ...args], {
    cwd: dirname(entry),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024
  })
}

function importFresh(path) {
  return import(`${pathToFileURL(path).href}?smoke=${Date.now()}-${Math.random()}`)
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
  if (!port) throw new Error('Could not allocate a packaged smoke port')
  return port
}

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function assertExists(path, label) {
  if (!existsSync(path)) throw new Error(`Missing packaged ${label}: ${path}`)
}

module.exports = {
  EXTENSION_ID,
  PACKAGED_EXTENSION_SMOKE_SUCCESS_MARKER,
  assertPackagedSmokeChildResult,
  createPackagedExtensionSmokeReexecEnvironment,
  createSmokeExtension,
  installSmokeExtensionFixture,
  makeTreeWritable,
  packagedResourceCandidates,
  resolvePackagedRuntimeExecutable,
  resolveResources,
  resolvedPackagedResourceCandidates,
  smokeWebviewCsp,
  validatePackagedResources
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
