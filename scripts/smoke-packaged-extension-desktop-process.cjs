'use strict'

const { spawnSync } = require('node:child_process')
const { createServer: createHttpServer } = require('node:http')
const { createConnection, createServer } = require('node:net')
const {
  MAX_CLEANUP_TIMEOUT_MS,
  MAX_REMOVE_RETRIES,
  REMOVE_RETRY_DELAY_MS
} = require('./smoke-packaged-extension-desktop-constants.cjs')

async function startNetworkCanary() {
  let requests = 0
  const server = createHttpServer((_request, response) => {
    requests += 1
    response.setHeader('access-control-allow-origin', '*')
    response.setHeader('cache-control', 'no-store')
    response.end('network access must remain blocked')
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  if (!port) {
    await new Promise((resolvePromise) => server.close(resolvePromise))
    throw new Error('Could not allocate the desktop smoke network canary')
  }
  const origin = `http://127.0.0.1:${port}`
  return {
    origin,
    port,
    url: `${origin}/extension-network-canary`,
    popupUrl: `${origin}/extension-popup-canary`,
    requestCount: () => requests,
    close: () => new Promise((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise())
      server.closeAllConnections?.()
    })
  }
}

function evaluationValue(evaluated, operation) {
  if (evaluated.exceptionDetails) {
    const description = evaluated.exceptionDetails.exception?.description ??
      evaluated.exceptionDetails.text ??
      'unknown exception'
    throw new Error(`CDP Runtime.evaluate failed while ${operation}: ${description}`)
  }
  return evaluated.result?.value
}

async function pollUntil(operation, { timeoutMs, description, intervalMs = 250 }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await operation()
    if (result) return result
    await delay(intervalMs)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function processState(child) {
  return {
    exitCode: child.exitCode,
    signalCode: child.signalCode
  }
}

function assertDesktopProcessRunning(state) {
  if (state.exitCode !== null || state.signalCode !== null) {
    throw new Error(
      `Packaged Electron exited before the desktop smoke completed ` +
      `(exit=${String(state.exitCode)}, signal=${String(state.signalCode)})`
    )
  }
}

async function terminateProcessTree(child, platform, {
  timeoutMs = MAX_CLEANUP_TIMEOUT_MS,
  ports = [],
  spawnSyncCommand = spawnSync,
  killProcessGroup = (pid, signal) => process.kill(-pid, signal),
  verifyPortsClosed = waitForPortsClosed
} = {}) {
  const deadline = Date.now() + timeoutMs
  let terminationDiagnostic

  // Never signal a stale PID. If the launcher is already gone, only verify that
  // its isolated runtime/CDP ports disappeared and report an orphan if not.
  if (isProcessRunning(child)) {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
      terminationDiagnostic = 'Packaged Electron has no safe process ID for cleanup'
    } else if (platform === 'win32') {
      const result = spawnSyncCommand('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        timeout: Math.max(1, Math.min(10_000, remainingMilliseconds(deadline))),
        killSignal: 'SIGKILL',
        windowsHide: true
      })
      if (result.error?.code === 'ETIMEDOUT') {
        terminationDiagnostic = `taskkill timed out for packaged Electron PID ${child.pid}`
      } else if (result.error) {
        terminationDiagnostic = `taskkill failed for packaged Electron PID ${child.pid}: ${result.error.message}`
      } else if (result.status !== 0) {
        terminationDiagnostic = `taskkill exited with status ${String(result.status)} for packaged Electron PID ${child.pid}`
      }
      await waitForProcessExit(child, Math.min(5_000, remainingMilliseconds(deadline)))
    } else {
      terminationDiagnostic = signalLiveProcess(child, 'SIGTERM', killProcessGroup)
      await waitForProcessExit(child, Math.min(5_000, remainingMilliseconds(deadline)))
      if (isProcessRunning(child)) {
        terminationDiagnostic = signalLiveProcess(child, 'SIGKILL', killProcessGroup) ?? terminationDiagnostic
        await waitForProcessExit(child, remainingMilliseconds(deadline))
      }
    }
  }

  const failures = []
  if (isProcessRunning(child)) {
    failures.push(
      terminationDiagnostic ?? `Packaged Electron PID ${String(child.pid)} did not exit before cleanup timeout`
    )
  }
  try {
    await verifyPortsClosed(ports, remainingMilliseconds(deadline))
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
  if (failures.length > 0) throw new Error(failures.join('; '))
}

function signalLiveProcess(child, signal, killProcessGroup) {
  if (!isProcessRunning(child)) return undefined
  try {
    killProcessGroup(child.pid, signal)
    return undefined
  } catch (groupError) {
    if (!isProcessRunning(child)) return undefined
    try {
      if (child.kill(signal)) return undefined
    } catch (childError) {
      return `Could not send ${signal} to packaged Electron PID ${child.pid}: ${childError instanceof Error ? childError.message : String(childError)}`
    }
    return `Could not send ${signal} to packaged Electron PID ${child.pid}: ${groupError instanceof Error ? groupError.message : String(groupError)}`
  }
}

function isProcessRunning(child) {
  return child.exitCode === null && child.signalCode === null
}

function remainingMilliseconds(deadline) {
  return Math.max(0, deadline - Date.now())
}

async function waitForProcessExit(child, timeoutMs) {
  if (!isProcessRunning(child)) return true
  if (timeoutMs <= 0) return false
  return new Promise((resolvePromise) => {
    const finish = (exited) => {
      clearTimeout(timer)
      child.off?.('exit', onExit)
      resolvePromise(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
    if (!isProcessRunning(child)) finish(true)
  })
}

async function waitForPortsClosed(ports, timeoutMs) {
  const remainingPorts = [...new Set(ports)]
    .filter((port) => Number.isSafeInteger(port) && port > 0 && port <= 65_535)
  if (remainingPorts.length === 0) return
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (true) {
    const openPorts = []
    for (const port of remainingPorts) {
      if (await isLoopbackPortOpen(port)) openPorts.push(port)
    }
    if (openPorts.length === 0) return
    if (Date.now() >= deadline) {
      throw new Error(
        `Packaged Electron left isolated loopback port(s) open: ${openPorts.join(', ')}; ` +
        'refusing to signal an exited launcher PID because it may have been reused'
      )
    }
    await delay(Math.min(100, Math.max(1, remainingMilliseconds(deadline))))
  }
}

function isLoopbackPortOpen(port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (open) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise(open)
    }
    socket.setTimeout(250, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.unref()
  })
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise())
  })
  if (!port) throw new Error('Could not allocate a desktop smoke CDP port')
  return port
}

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function positiveIntegerArgument(name, fallback) {
  const raw = argumentValue(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

module.exports = {
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
}
