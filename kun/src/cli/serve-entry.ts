#!/usr/bin/env node
import process from 'node:process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseServeOptionsSafe, SERVE_USAGE, ServeExitCode } from './serve.js'
import {
  KUN_CLI_USAGE,
  runAgentCommand,
  splitKunCliCommand
} from './agent-cli.js'
import { startKunServe, type KunServeHandle } from '../server/runtime-factory.js'
import {
  resolveEventLoopStallThresholdMs,
  startEventLoopMonitor
} from '../server/event-loop-monitor.js'
import { installServeCrashHandlers } from './serve-crash-handlers.js'
import { runExtensionCommand } from './extension-cli.js'
import { resolveSharedRuntime, runRuntimeCommand } from './shared-runtime.js'
import { withRuntimeStartLock } from '../server/runtime-discovery.js'
import { RuntimeBuildIdSchema } from '../contracts/runtime-info.js'
import { readRuntimeBuildIdForEntry } from '../server/runtime-build-identity.js'
import { KUN_VERSION } from '../version.js'
import { runSelfUpdateCommand } from './self-update.js'

export const KUN_READY_PREFIX = 'KUN_READY '

/**
 * Serve-mode command. Kept separate from the dispatcher so GUI startup
 * still has the exact same KUN_READY handshake behavior.
 */
async function serveMain(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(SERVE_USAGE)
    return ServeExitCode.ok
  }
  const parsed = parseServeOptionsSafe(argv, process.env)
  if (!parsed.ok) {
    process.stderr.write(`kun serve: ${parsed.message}\n`)
    if (parsed.issues) {
      process.stderr.write(`${JSON.stringify(parsed.issues, null, 2)}\n`)
    }
    return parsed.exitCode
  }
  const launchMode = process.env.KUN_RUNTIME_LAUNCH_MODE === 'shared' ? 'shared' : 'foreground'
  const manifestBuildId = await readRuntimeBuildIdForEntry(import.meta.url)
  const environmentBuildId = RuntimeBuildIdSchema.safeParse(
    process.env.KUN_RUNTIME_BUILD_ID?.trim()
  )
  const buildId = manifestBuildId ?? (
    environmentBuildId.success ? environmentBuildId.data : undefined
  )
  const start = async (): Promise<
    { kind: 'existing'; existing: NonNullable<Awaited<ReturnType<typeof resolveSharedRuntime>>> } |
    { kind: 'started'; server: KunServeHandle }
  > => {
    const existing = await resolveSharedRuntime(parsed.options.dataDir)
    if (existing) return { kind: 'existing', existing }
    return {
      kind: 'started',
      server: await startKunServe({
        ...parsed.options,
        launchMode,
        ...(buildId ? { buildId } : {}),
        sharedMcpConfigPath: process.env.KUN_MCP_CONFIG_PATH || join(homedir(), '.kun', 'mcp.json'),
        ...(process.env.KUN_RUNTIME_LOG_PATH ? { logPath: process.env.KUN_RUNTIME_LOG_PATH } : {})
      })
    }
  }
  // Detached startup is already elected by the parent shared-runtime manager.
  // Foreground `kun serve` performs the same data-dir election itself.
  const elected = launchMode === 'foreground'
    ? await withRuntimeStartLock(parsed.options.dataDir, start)
    : await start()
  if (elected.kind === 'existing') {
    process.stderr.write(
      `kun serve: runtime already running at ${elected.existing.discovery.baseUrl} (PID ${elected.existing.discovery.pid}); ` +
      'use `kun runtime stop` first or choose another --data-dir.\n'
    )
    return ServeExitCode.runtime
  }
  let handle: KunServeHandle | null = null
  installServeCrashHandlers(() => handle)
  const server = elected.server
  handle = server
  await selfVerifyHealth(server.host, server.port)
  const info = server.runtime.info()
  const startupInfo = {
    service: 'kun',
    mode: 'serve',
    host: server.host,
    port: server.port,
    configPath: info.configPath,
    dataDir: info.dataDir,
    model: info.model,
    approvalPolicy: info.approvalPolicy,
    sandboxMode: info.sandboxMode,
    insecure: info.insecure,
    startedAt: info.startedAt,
    pid: info.pid,
    message: `kun runtime listening on http://${server.host}:${server.port}`
  }
  process.stdout.write(`${KUN_READY_PREFIX}${JSON.stringify(startupInfo)}\n`)
  process.stdout.write(JSON.stringify(startupInfo, null, 2) + '\n')
  // Watch for event-loop stalls so a hang that starves /health (and trips the
  // GUI watchdog) is attributable to CPU starvation vs a hard deadlock (#621).
  const loopMonitor = startEventLoopMonitor({
    stallThresholdMs: resolveEventLoopStallThresholdMs(process.env)
  })
  await new Promise<void>((resolve) => {
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      loopMonitor.stop()
      void server.close().finally(resolve)
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
    void server.shutdownRequested.then(stop)
  })
  return ServeExitCode.ok
}

/**
 * When the GUI launches kun without `ELECTRON_RUN_AS_NODE` (the host
 * computer-use mode on darwin), the child runs as a real Electron instance.
 * libnut's first screen-grab / mouse / keyboard call invokes
 * `[NSApplication sharedApplication]`, which promotes the process to a
 * regular Cocoa app and macOS adds a second Dock icon. Hiding it via
 * `app.dock.hide()` is the official Electron API; we never open a window
 * here so the icon serves no purpose. A no-op when running as Node.
 */
async function hideMacosDockIfRunningAsElectron(): Promise<void> {
  if (process.platform !== 'darwin') return
  if (!process.versions.electron) return
  try {
    const electron = (await import(/* @vite-ignore */ 'electron')) as {
      app?: { dock?: { hide?: () => void } }
    }
    electron.app?.dock?.hide?.()
  } catch {
    // Best-effort: when the electron module is unavailable (pure Node
    // fallback), leave the dock alone. The user still gets host control.
  }
}

const SELF_VERIFY_TIMEOUT_MS = 5_000
const SELF_VERIFY_POLL_MS = 100

async function selfVerifyHealth(host: string, port: number): Promise<void> {
  const url = `http://${host}:${port}/health`
  const deadline = Date.now() + SELF_VERIFY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(1_000)
      })
      if (res.ok) {
        const body = (await res.json()) as { status?: string }
        if (body?.status === 'ok') return
      }
    } catch {
      // retry
    }
    await new Promise<void>((r) => setTimeout(r, SELF_VERIFY_POLL_MS))
  }
  process.stderr.write(
    `[kun] warning: self-health-probe on http://${host}:${port}/health did not pass within ${SELF_VERIFY_TIMEOUT_MS}ms — proceeding anyway\n`
  )
}

export async function main(argv: readonly string[]): Promise<number> {
  await hideMacosDockIfRunningAsElectron()
  if (argv[0] === 'extension') {
    return runExtensionCommand(argv.slice(1), {
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
      cwd: () => process.cwd()
    })
  }
  const command = splitKunCliCommand(argv)
  if (command.command === 'help') {
    if (command.error) {
      process.stderr.write(`kun: ${command.error}\n`)
      process.stderr.write(KUN_CLI_USAGE)
      return ServeExitCode.usage
    }
    process.stdout.write(KUN_CLI_USAGE)
    return ServeExitCode.ok
  }
  if (command.command === 'serve') {
    return serveMain(command.args)
  }
  if (command.command === 'version') {
    process.stdout.write(`kun ${KUN_VERSION}\n`)
    return ServeExitCode.ok
  }
  if (command.command === 'runtime') {
    return runRuntimeCommand(command.args, {
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env
    })
  }
  if (command.command === 'update') {
    return runSelfUpdateCommand(command.args, {
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env
    })
  }
  return runAgentCommand(command.command, command.args, {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: () => process.cwd()
  })
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exit(code)
  },
  (error) => {
    process.stderr.write(`kun serve: ${String(error)}\n`)
    process.exit(ServeExitCode.runtime)
  }
)
