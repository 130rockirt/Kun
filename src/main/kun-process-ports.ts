import { createServer } from 'node:net'
import { appendManagedLogLine } from './logger'
import {
  execFileAsync,
  formatKunLogLine,
  MAX_TCP_PORT,
  processController,
  sleep
} from './kun-process-state'

export async function reclaimKunPort(
  port: number
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (port <= 0) return { ok: true }
  if (await canBindTcpPort(port, '127.0.0.1')) return { ok: true }
  if (await killStaleKunOnPort(port) && await canBindTcpPort(port, '127.0.0.1')) {
    return { ok: true }
  }
  return { ok: false, message: `port ${port} is in use` }
}

export async function resolveAvailableKunPort(
  preferredPort: number
): Promise<{ port: number; changed: boolean; message?: string }> {
  if (preferredPort > 0) {
    // A temporarily unresponsive managed child still owns its configured
    // endpoint. Moving settings to another port here strands the live child
    // and makes every concurrent request launch/probe a port with no server.
    if (processController.isRunning() && processController.childPort === preferredPort) {
      return { port: preferredPort, changed: false }
    }
    if (await canBindTcpPort(preferredPort, '127.0.0.1')) {
      return { port: preferredPort, changed: false }
    }
    // Prefer reclaiming the configured port from a stale kun left by a
    // crashed previous app run over silently moving to a new port.
    if (
      await killStaleKunOnPort(preferredPort) &&
      await canBindTcpPort(preferredPort, '127.0.0.1')
    ) {
      return { port: preferredPort, changed: false }
    }
    for (let port = preferredPort + 1; port <= MAX_TCP_PORT; port += 1) {
      if (await canBindTcpPort(port, '127.0.0.1')) {
        return {
          port,
          changed: true,
          message: `port ${preferredPort} is in use`
        }
      }
    }
  }
  const port = await allocateTcpPort('127.0.0.1')
  return {
    port,
    changed: true,
    ...(preferredPort > 0 ? { message: `port ${preferredPort} is in use` } : {})
  }
}

/**
 * Kill a stale kun serve process from a previous app run that is still
 * holding the configured port. Only processes whose command line looks
 * like our serve entry are touched; anything else keeps the port and we
 * fall back to allocating a different one.
 *
 * Safe by construction on every platform: any failure to positively
 * identify the holder as our own serve-entry leaves it untouched and the
 * caller allocates a different port instead.
 */
export async function killStaleKunOnPort(port: number): Promise<boolean> {
  const pids = await listListeningPidsOnPort(port)
  let reclaimed = false
  for (const pid of pids) {
    if (processController.isCurrentPid(pid)) continue
    let command = ''
    try {
      command = await processCommandLine(pid)
    } catch {
      continue
    }
    if (!command.includes('serve-entry')) continue
    void appendManagedLogLine(
      'kun',
      formatKunLogLine('lifecycle', pid, `killing stale kun process holding port ${port}`)
    )
    if (await terminateStalePid(pid)) reclaimed = true
  }
  return reclaimed
}

/**
 * PIDs listening on `port`, excluding our own process. Uses `lsof` on
 * macOS/Linux and `netstat -ano` on Windows.
 */
export async function listListeningPidsOnPort(port: number): Promise<number[]> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('netstat', ['-ano'], {
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 8 * 1024 * 1024
      })
      return parseListeningPidsFromNetstat(stdout, port)
    } catch {
      return []
    }
  }
  try {
    const { stdout } = await execFileAsync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
    return stdout
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
  } catch {
    return []
  }
}

/**
 * Parse `netstat -ano` output into the PIDs holding a LISTENING TCP socket
 * on `port`. Columns are `Proto  Local  Foreign  State  PID`; UDP rows
 * (no State column) and non-matching ports are ignored. Matches both IPv4
 * (`127.0.0.1:<port>`) and IPv6 (`[::1]:<port>`) local addresses.
 */
export function parseListeningPidsFromNetstat(stdout: string, port: number): number[] {
  const pids = new Set<number>()
  for (const raw of stdout.split(/\r?\n/)) {
    const cols = raw.trim().split(/\s+/)
    if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP') continue
    if (cols[3].toUpperCase() !== 'LISTENING') continue
    if (!cols[1].endsWith(`:${port}`)) continue
    const pid = Number(cols[cols.length - 1])
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid)
  }
  return [...pids]
}

/** Read a process's full command line (best effort, platform-specific). */
export async function processCommandLine(pid: number): Promise<string> {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`
      ],
      { windowsHide: true, timeout: 5_000 }
    )
    return stdout.trim()
  }
  const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='])
  return stdout.trim()
}

/** Terminate a positively-identified stale kun process. */
export async function terminateStalePid(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5_000
      })
      return true
    } catch {
      // taskkill exits non-zero when the PID is already gone — treat the
      // port as reclaimed only if the process really is no longer alive.
      return await waitForPidExit(pid, 0)
    }
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return false
  }
  if (!(await waitForPidExit(pid, 2_000))) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    await waitForPidExit(pid, 1_000)
  }
  return true
}

/**
 * Terminate a process only while a caller can still prove that its identity is
 * the intended target. A PID can be reused between a graceful signal and a
 * forced signal, so Unix rechecks the caller's proof before escalating to
 * SIGKILL. The replacement lifecycle supplies proof from exact runtime
 * discovery, the expected command shape, and the recorded listening port.
 */
export async function terminateVerifiedPid(
  pid: number,
  verifyTarget: () => Promise<boolean>,
  waitForExit: (pid: number, timeoutMs: number) => Promise<boolean> = waitForPidExit
): Promise<boolean> {
  if (!(await verifyTarget())) return false
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5_000
      })
    } catch {
      return waitForExit(pid, 0)
    }
    return waitForExit(pid, 2_000)
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return waitForExit(pid, 0)
  }
  if (await waitForExit(pid, 2_000)) return true
  // Do not escalate after PID reuse or an identity change.
  if (!(await verifyTarget())) return false
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return waitForExit(pid, 0)
  }
  return waitForExit(pid, 2_000)
}

export async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      // EPERM means the process still exists but belongs to an identity we
      // cannot signal. Treat only a missing PID as an exit.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    }
    if (Date.now() >= deadline) return false
    await sleep(100)
  }
}

export function canBindTcpPort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const server = createServer()
    const settle = (available: boolean): void => {
      if (settled) return
      settled = true
      server.removeAllListeners('error')
      resolve(available)
    }
    server.unref()
    server.once('error', () => settle(false))
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => settle(true))
    })
  })
}
export function allocateTcpPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    const cleanup = (): void => {
      server.removeAllListeners('error')
      server.removeAllListeners('listening')
    }
    server.unref()
    server.once('error', (error) => {
      cleanup()
      reject(error)
    })
    server.listen({ port: 0, host, exclusive: true }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => {
        cleanup()
        if (error) reject(error)
        else if (port > 0) resolve(port)
        else reject(new Error('failed to allocate an available Kun port'))
      })
    })
  })
}
