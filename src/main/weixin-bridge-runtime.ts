import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { logError, logInfo } from './logger'
import {
  activeLogins,
  contextTokenStore,
  monitors,
  runtimeAbortController,
  WEIXIN_BRIDGE_HEALTH_TIMEOUT_MS,
  WEIXIN_BRIDGE_MAX_PORT_ATTEMPTS,
  WEIXIN_BRIDGE_PORT,
  WEIXIN_PLUGIN_ID,
  weixinBridgeState,
  type JsonRecord,
  type WeixinBridgeSendResult
} from './weixin-bridge-state'
import {
  buildBaseInfo,
  configureWeixinBridgeRuntimeContextProvider,
  listIndexedWeixinAccountIds,
  normalizeAccountId,
  prepareBridgeState,
  readBridgeConfig,
  recordString,
  resolveRpcUrl,
  resolveWeixinAccount
} from './weixin-bridge-storage'
import {
  getContextToken,
  postToDeepSeekGuiWebhook,
  restoreContextTokens,
  sendGeneratedFilesWeixin,
  sendMessageWeixin,
  startWeixinChannels,
  startWeixinLogin,
  stopWeixinChannels,
  waitForWeixinLogin,
  webhookGeneratedFiles,
  type WeixinOutboundFile
} from './weixin-bridge-channel'
import { asRecord } from './weixin-bridge-storage'

export { configureWeixinBridgeRuntimeContextProvider } from './weixin-bridge-storage'
export type { WeixinBridgeSendResult } from './weixin-bridge-state'

async function dispatchRpc(method: string, params: JsonRecord): Promise<JsonRecord> {
  switch (method) {
    case 'web.login.start':
      return startWeixinLogin(params)
    case 'web.login.wait':
      return waitForWeixinLogin(params)
    case 'channels.start':
      if (recordString(params, 'channel') && recordString(params, 'channel') !== WEIXIN_PLUGIN_ID) {
        throw new Error(`Unsupported channel: ${recordString(params, 'channel')}`)
      }
      return startWeixinChannels(params)
    case 'channels.stop':
      return stopWeixinChannels(params)
    case 'accounts.list':
      return { accounts: await listIndexedWeixinAccountIds() }
    default:
      throw new Error(`Unknown WeChat bridge method: ${method}`)
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(`${JSON.stringify(body)}\n`)
}

async function handleBridgeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url || '/', `http://127.0.0.1:${weixinBridgeState.activeBridgePort}`)
    if (request.method === 'GET' && url.pathname === '/health') {
      writeJson(response, 200, { ok: true, status: 'live' })
      return
    }
    if (request.method !== 'POST' || url.pathname !== '/api/v1/admin/rpc') {
      writeJson(response, 404, { ok: false, message: 'Not found' })
      return
    }
    const body = asRecord(JSON.parse(await readRequestBody(request)) as unknown)
    const id = body.id ?? null
    const method = recordString(body, 'method')
    const params = asRecord(body.params)
    if (!method) throw new Error('JSON-RPC method is required.')
    const result = await dispatchRpc(method, params)
    writeJson(response, 200, { jsonrpc: '2.0', id, ok: true, result })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeJson(response, 200, {
      jsonrpc: '2.0',
      id: null,
      ok: false,
      error: { message }
    })
  }
}

async function fetchBridgeHealth(port = weixinBridgeState.activeBridgePort): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(WEIXIN_BRIDGE_HEALTH_TIMEOUT_MS)
    })
    if (!res.ok) return false
    const data = await res.json().catch(() => null) as { ok?: unknown; status?: unknown } | null
    return data?.ok === true || data?.status === 'live' || data?.status === 'ok'
  } catch {
    return false
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer()
    probe.unref()
    probe.once('error', () => resolve(false))
    probe.listen({ host: '127.0.0.1', port }, () => {
      probe.close(() => resolve(true))
    })
  })
}

async function resolveAvailableBridgePort(): Promise<number> {
  if (weixinBridgeState.server && await fetchBridgeHealth(weixinBridgeState.activeBridgePort)) return weixinBridgeState.activeBridgePort
  for (let offset = 0; offset < WEIXIN_BRIDGE_MAX_PORT_ATTEMPTS; offset += 1) {
    const port = WEIXIN_BRIDGE_PORT + offset
    if (await isPortAvailable(port)) return port
  }
  throw new Error('Built-in WeChat login component could not find an available local port.')
}

async function listen(serverToStart: HttpServer, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      serverToStart.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      serverToStart.off('error', onError)
      resolve()
    }
    serverToStart.once('error', onError)
    serverToStart.once('listening', onListening)
    serverToStart.listen({ host: '127.0.0.1', port })
  })
}

async function startBridgeServer(): Promise<string> {
  if (weixinBridgeState.runtimeStopped) throw new Error('Built-in WeChat bridge is stopped.')
  if (weixinBridgeState.server && await fetchBridgeHealth(weixinBridgeState.activeBridgePort)) return resolveRpcUrl()
  const port = await resolveAvailableBridgePort()
  weixinBridgeState.activeBridgePort = port
  await prepareBridgeState(port)
  if (weixinBridgeState.runtimeStopped) throw new Error('Built-in WeChat bridge is stopped.')
  weixinBridgeState.server = createHttpServer((request, response) => {
    void handleBridgeRequest(request, response)
  })
  await listen(weixinBridgeState.server, port)
  if (weixinBridgeState.runtimeStopped) {
    await closeBridgeServer()
    throw new Error('Built-in WeChat bridge is stopped.')
  }
  logInfo('weixin-bridge', `started built-in GUI WeChat bridge on port ${port}`)
  await startWeixinChannels({})
  return resolveRpcUrl()
}

export async function ensureWeixinBridgeRpcUrl(): Promise<string> {
  if (weixinBridgeState.runtimeStopped) throw new Error('Built-in WeChat bridge is stopped.')
  if (!weixinBridgeState.startPromise) {
    weixinBridgeState.startPromise = startBridgeServer().catch((error) => {
      weixinBridgeState.startPromise = null
      throw error
    })
  }
  return weixinBridgeState.startPromise
}

/**
 * WeChat user id (`ilink_user_id`) that bound this bot account during QR
 * login, or '' when the account is not configured. Used by Claw to greet
 * the owner right after the first connection.
 */
export async function getWeixinBridgeAccountUserId(accountId: string): Promise<string> {
  const normalized = normalizeAccountId(accountId)
  if (!normalized) return ''
  try {
    const account = await resolveWeixinAccount(normalized)
    return account.configured ? account.userId ?? '' : ''
  } catch {
    return ''
  }
}

export async function sendWeixinBridgeMessage(options: {
  accountId: string
  to: string
  text?: string
  files?: readonly WeixinOutboundFile[]
}): Promise<WeixinBridgeSendResult> {
  const accountId = normalizeAccountId(options.accountId)
  const to = options.to.trim()
  const text = options.text?.trim() ?? ''
  const files = options.files ?? []
  if (!accountId) return { ok: false, message: 'WeChat account id is missing.' }
  if (!to) return { ok: false, message: 'WeChat recipient is missing.' }
  if (!text && files.length === 0) return { ok: false, message: 'Message is empty.' }

  try {
    await ensureWeixinBridgeRpcUrl()
    const cfg = await readBridgeConfig()
    void cfg
    const account = await resolveWeixinAccount(accountId)
    if (!account.configured || !account.token?.trim()) {
      return { ok: false as const, message: 'WeChat account is not configured.' }
    }
    await restoreContextTokens(account.accountId)
    const contextToken = getContextToken(account.accountId, to)
    let messageId = ''
    if (text) {
      const result = await sendMessageWeixin({
        account,
        to,
        text,
        contextToken
      })
      messageId = result.messageId
    }
    if (files.length > 0) {
      await sendGeneratedFilesWeixin(account, to, files, contextToken)
    }
    return { ok: true as const, messageId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logError('weixin-bridge', 'Failed to send WeChat message from GUI.', {
      message,
      accountId,
      to
    })
    return { ok: false, message }
  }
}

async function closeBridgeServer(): Promise<void> {
  const runningServer = weixinBridgeState.server
  weixinBridgeState.server = null
  if (!runningServer) return
  await new Promise<void>((resolve) => {
    runningServer.close(() => resolve())
    runningServer.closeAllConnections?.()
  })
}

export async function stopWeixinBridgeRuntime(): Promise<void> {
  weixinBridgeState.runtimeStopped = true
  runtimeAbortController.abort()
  const starting = weixinBridgeState.startPromise
  weixinBridgeState.startPromise = null
  const activeMonitors = [...monitors.values()]
  for (const monitor of activeMonitors) monitor.controller.abort()
  activeLogins.clear()
  contextTokenStore.clear()
  await Promise.allSettled(activeMonitors.map((monitor) => monitor.promise))
  monitors.clear()
  await closeBridgeServer()
  await starting?.catch(() => undefined)
  // A start that was between its final checks when shutdown began may have
  // published a weixinBridgeState.server after the first close. Close that generation too.
  await closeBridgeServer()
}

export const weixinBridgeRuntimeInternals = {
  buildBaseInfo,
  normalizeAccountId,
  postToDeepSeekGuiWebhook,
  webhookGeneratedFiles
}
