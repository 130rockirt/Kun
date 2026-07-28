import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import * as pty from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSharedRuntime, stopSharedRuntime } from '../cli/shared-runtime.js'
import { readRuntimeBuildIdForEntry } from '../server/runtime-build-identity.js'
import { startKunServe, type KunServeHandle } from '../server/runtime-factory.js'
import { KunTuiClient } from './client.js'
import { sanitizeTerminalText } from './layout.js'

const worktreeRoot = resolve(import.meta.dirname, '../../..')
const cliEntry = join(worktreeRoot, 'kun/dist/cli/serve-entry.js')
const roots: string[] = []
const servers: KunServeHandle[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
  await Promise.all(roots.map((root) => stopSharedRuntime(root).catch(() => false)))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32' || !existsSync(cliEntry))('kun tui PTY smoke', () => {
  it('starts, creates and opens a thread, accepts input and resize, interrupts, and restores the terminal on exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-tui-pty-'))
    roots.push(root)
    const runtimeToken = 'pty-runtime-token'
    const buildId = await readRuntimeBuildIdForEntry(cliEntry)
    const server = await startKunServe({
      host: '127.0.0.1',
      port: 0,
      dataDir: root,
      runtimeToken,
      apiKey: 'pty-test-key',
      baseUrl: 'http://127.0.0.1:9',
      model: 'gpt-5.6-luna',
      models: {
        profiles: {
          'gpt-5.6-luna': {
            contextWindowTokens: 372_000
          }
        }
      },
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      tokenEconomyMode: false,
      insecure: false,
      ...(buildId ? { buildId } : {})
    })
    servers.push(server)
    const client = new KunTuiClient({
      baseUrl: `http://${server.host}:${server.port}`,
      runtimeToken
    })

    const terminal = pty.spawn(process.execPath, [
      cliEntry,
      'tui',
      '--data-dir', root,
      '--workspace', root
    ], {
      name: 'xterm-256color',
      cols: 88,
      rows: 26,
      cwd: worktreeRoot,
      env: stringEnvironment(process.env)
    })
    let output = ''
    const dataSubscription = terminal.onData((data) => { output += data })
    const exited = new Promise<{ exitCode: number; signal?: number }>((accept) => {
      terminal.onExit(accept)
    })

    try {
      await waitFor(() =>
        output.includes('Welcome to Kun') &&
        output.includes('/connect') &&
        output.includes('/sessions') &&
        output.includes('┌') &&
        output.includes('Ctrl+P')
      )
      expect(output).not.toContain('\x1b[?1049h')
      expect(output).toContain('/connect')
      expect(output).toContain('/sessions')
      expect(output).toContain('Workspace')
      expect(output).toContain('┌')
      expect(output).toContain('Ctrl+P')
      expect(output).not.toContain('/model')
      expect(output).not.toContain('runtime ready')
      expect(output).not.toContain('MCP ')
      expect(output).not.toContain('No threads found')

      await waitFor(() => sanitizeTerminalText(output).includes('gpt-5.6-luna · high'))
      terminal.write('\x14') // Ctrl+T cycles high -> max.
      await waitFor(() => output.includes('Reasoning effort: max'))
      await waitFor(() => sanitizeTerminalText(output).includes('gpt-5.6-luna · max'))

      terminal.write('\x18n') // Ctrl+X N
      const thread = await waitForValue(async () =>
        (await client.listThreads()).find((item) => item.title === 'Terminal chat')
      ).catch((error) => {
        const visibleTail = sanitizeTerminalText(output).slice(-2_000)
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nPTY output tail:\n${visibleTail}`)
      })
      await waitFor(() => output.includes('Terminal chat'))

      terminal.write('/rename PTY smoke\r')
      await waitFor(async () => (await client.getThread(thread.id)).title === 'PTY smoke')

      const beforeResize = output.length
      terminal.resize(52, 14)
      await waitFor(() => output.length > beforeResize)
      const beforeWideResize = output.length
      terminal.resize(112, 26)
      await waitFor(() => output.length > beforeWideResize)

      const turn = await server.runtime.turnService.startTurn({
        threadId: thread.id,
        request: { prompt: 'hold for interrupt', model: 'gpt-5.6-luna', mode: 'agent' }
      })
      await waitFor(() => {
        const visible = sanitizeTerminalText(output)
        return visible.includes('Esc stop') && visible.includes('Waiting')
      })
      expect(sanitizeTerminalText(output)).not.toContain('Tip:')
      const itemBase = {
        id: 'item_pty_stream', threadId: thread.id, turnId: turn.turnId, role: 'assistant' as const,
        status: 'running' as const, createdAt: new Date().toISOString(), kind: 'assistant_text' as const
      }
      const reasoningBase = {
        ...itemBase,
        id: 'item_pty_reasoning',
        kind: 'assistant_reasoning' as const
      }
      await server.runtime.events.record({
        kind: 'assistant_reasoning_delta', threadId: thread.id, turnId: turn.turnId,
        itemId: reasoningBase.id, item: { ...reasoningBase, text: 'Inspect the active model capability.' }
      })
      await waitFor(() => output.includes('/thinking expand'))
      expect(output).not.toContain('Inspect the active model capability.')
      expect(output).not.toContain('\x1b[?1000h\x1b[?1006h')
      expect(sanitizeTerminalText(output)).toContain('History')

      terminal.write('\x18p') // Ctrl+X P opts into direct transcript clicks.
      await waitFor(() =>
        output.includes('Mouse clicks enabled') &&
        output.includes('\x1b[?1000h\x1b[?1006h')
      )
      terminal.write('\x18p') // The same binding restores native scroll and selection.
      await waitFor(() =>
        output.includes('Text selection mode') &&
        output.lastIndexOf('\x1b[?1000l\x1b[?1006l') >
          output.lastIndexOf('\x1b[?1000h\x1b[?1006h')
      )
      expect((await client.getThread(thread.id)).turns.find((candidate) => candidate.id === turn.turnId)?.status).toBe('running')

      terminal.write('/thinking\r')
      await waitFor(() => output.includes('Thinking is expanded'))
      await waitFor(() => output.includes('Inspect the active model capability.'))
      terminal.write('/thinking\r')
      await waitFor(() => output.includes('Thinking is collapsed'))
      const beforeHiddenReasoning = output.length
      await server.runtime.events.record({
        kind: 'assistant_reasoning_delta', threadId: thread.id, turnId: turn.turnId,
        itemId: reasoningBase.id, item: { ...reasoningBase, text: ' This fragment stays hidden.' }
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(output.slice(beforeHiddenReasoning)).not.toContain('This fragment stays hidden.')
      terminal.write('/thinking\r')
      await waitFor(() => output.slice(beforeHiddenReasoning).includes('Thinking is expanded'))

      const beforeAssistantDelta = output.length
      await server.runtime.events.record({
        kind: 'assistant_text_delta', threadId: thread.id, turnId: turn.turnId,
        itemId: itemBase.id, item: { ...itemBase, text: 'Hel' }
      })
      await waitFor(() =>
        output.slice(beforeAssistantDelta).includes('Hel') &&
        output.slice(beforeAssistantDelta).includes('Responding')
      )
      expect(output).toContain('▍')
      expect((await client.getThread(thread.id)).turns.find((candidate) => candidate.id === turn.turnId)?.status).toBe('running')
      await server.runtime.events.record({
        kind: 'assistant_text_delta', threadId: thread.id, turnId: turn.turnId,
        itemId: itemBase.id, item: { ...itemBase, text: 'lo' }
      })
      await waitFor(() => output.includes('Hello'))

      terminal.write('\x1b') // Escape interrupts the active turn
      await waitFor(async () => {
        const detail = await client.getThread(thread.id)
        return detail.turns.find((candidate) => candidate.id === turn.turnId)?.status === 'aborted'
      })

      terminal.write('/quit\r')
      const exit = await withTimeout(exited, 5_000, 'PTY process did not exit')
      expect(exit.exitCode).toBe(0)
      expect(output).toContain('\x1b[?2004l')
      expect(output).not.toContain('\x1b[?1049l')
      expect(output).not.toContain('\x1b[3J')
    } finally {
      dataSubscription.dispose()
      try { terminal.kill() } catch { /* already exited */ }
    }
  }, 30_000)

  it('starts its own shared runtime and leaves it alive after the standalone TUI exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-tui-standalone-'))
    roots.push(root)
    const terminal = pty.spawn(process.execPath, [
      cliEntry,
      '--data-dir', root,
      '--workspace', root
    ], {
      name: 'xterm-256color',
      cols: 88,
      rows: 26,
      cwd: worktreeRoot,
      env: stringEnvironment(process.env)
    })
    let output = ''
    const dataSubscription = terminal.onData((data) => { output += data })
    const exited = new Promise<{ exitCode: number; signal?: number }>((accept) => {
      terminal.onExit(accept)
    })

    try {
      await waitFor(
        () =>
          output.includes('Welcome to Kun') &&
          output.includes('/connect') &&
          output.includes('/sessions'),
        30_000
      )
      const connection = await waitForValue(
        async () => (await resolveSharedRuntime(root)) ?? undefined,
        30_000
      )
      expect(connection.discovery.launchMode).toBe('shared')

      terminal.write('\x03')
      await new Promise((resolve) => setTimeout(resolve, 80))
      terminal.write('\x03')
      const exit = await withTimeout(exited, 5_000, 'standalone TUI process did not exit')
      expect(exit.exitCode).toBe(0)
      expect(output).not.toContain('\x1b[?1049h')
      expect(output).not.toContain('\x1b[?1049l')
      expect(await resolveSharedRuntime(root)).not.toBeNull()

      expect(await stopSharedRuntime(root)).toBe(true)
      expect(await resolveSharedRuntime(root)).toBeNull()
    } finally {
      dataSubscription.dispose()
      try { terminal.kill() } catch { /* already exited */ }
    }
  }, 45_000)
})

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for PTY state')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function waitForValue<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 5_000
): Promise<T> {
  let value: T | undefined
  await waitFor(async () => {
    value = await read()
    return value !== undefined
  }, timeoutMs)
  return value as T
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    void promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}
