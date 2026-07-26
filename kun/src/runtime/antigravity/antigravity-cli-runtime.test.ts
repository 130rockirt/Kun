import type { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { InMemorySessionStore } from '../../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../../adapters/in-memory-thread-store.js'
import { TurnSchema } from '../../contracts/turns.js'
import { makeUserItem } from '../../domain/item.js'
import { createThreadRecord } from '../../domain/thread.js'
import { LlmDebugRecorder } from '../../services/llm-debug-recorder.js'
import type { RuntimeEventRecorder } from '../../services/runtime-event-recorder.js'
import type { TurnService } from '../../services/turn-service.js'
import {
  AntigravityCliRuntime,
  buildAntigravityArgs,
  normalizeAntigravityEffort,
  normalizeAntigravityModel
} from './antigravity-cli-runtime.js'

describe('AntigravityCliRuntime', () => {
  it('passes safe mixed-family base model ids and supported effort values to agy', () => {
    expect(normalizeAntigravityModel('gemini-3.6-flash-high')).toBe('gemini-3.6-flash')
    expect(normalizeAntigravityModel('models/gemini-3.5-flash')).toBe('gemini-3.5-flash')
    expect(normalizeAntigravityModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
    expect(normalizeAntigravityModel('gpt-oss-120b-medium')).toBe('gpt-oss-120b')
    expect(() => normalizeAntigravityModel('../unsafe')).toThrow('Invalid Antigravity model id')
    expect(normalizeAntigravityEffort('max')).toBe('high')
    expect(normalizeAntigravityEffort('off')).toBe('medium')

    expect(buildAntigravityArgs({
      prompt: 'inspect',
      model: 'claude-opus-4-6-thinking',
      effort: 'high',
      timeoutMs: 60_000,
      planMode: true,
      approvalPolicy: 'auto',
      sandboxMode: 'workspace-write'
    })).toEqual(expect.arrayContaining([
      '--model',
      'claude-opus-4-6-thinking',
      '--effort',
      'high'
    ]))
  })

  it('fails an invalid persisted model before launching the CLI', async () => {
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const turn = TurnSchema.parse({
      id: 'turn-invalid-model',
      threadId: 'thread-invalid-model',
      status: 'running',
      prompt: 'hello',
      model: '../unsafe',
      createdAt: '2026-07-23T00:00:00.000Z'
    })
    await threadStore.upsert({
      ...createThreadRecord({
        id: turn.threadId,
        title: 'Invalid model',
        workspace: '/tmp',
        model: '../unsafe',
        providerId: 'gemini-subscription',
        status: 'running'
      }),
      turns: [turn]
    })
    await sessionStore.appendItem(
      turn.threadId,
      makeUserItem({
        id: 'item-user',
        threadId: turn.threadId,
        turnId: turn.id,
        text: 'hello'
      })
    )
    const finishTurn = vi.fn(async () => undefined)
    const spawnFn = vi.fn()
    const runtime = new AntigravityCliRuntime({
      providerConfigs: {},
      providerIds: new Set(['gemini-subscription']),
      defaultIsAntigravity: false,
      threadStore,
      sessionStore,
      turns: {
        applyItem: vi.fn(async () => undefined),
        finishTurn
      } as unknown as TurnService,
      events: { record: vi.fn(async () => undefined) } as unknown as RuntimeEventRecorder,
      ids: { next: () => 'item-assistant' },
      spawnFn: spawnFn as unknown as typeof spawn
    })

    await expect(runtime.runTurn(
      turn.threadId,
      turn.id,
      new AbortController().signal,
      'gemini-subscription'
    )).resolves.toBe('failed')
    expect(spawnFn).not.toHaveBeenCalled()
    expect(finishTurn).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: expect.stringContaining('Invalid Antigravity model id')
    }))
  })

  it('keeps read-only turns in plan+sandbox mode', () => {
    const args = buildAntigravityArgs({
      prompt: 'inspect only',
      model: 'gemini-3.6-flash',
      effort: 'low',
      timeoutMs: 60_000,
      planMode: false,
      approvalPolicy: 'on-request',
      sandboxMode: 'read-only'
    })
    expect(args.slice(0, 2)).toEqual(['--print', 'inspect only'])
    expect(args).toEqual(expect.arrayContaining(['--mode', 'plan', '--sandbox']))
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('fails closed to plan mode when GUI approval cannot be surfaced', () => {
    const args = buildAntigravityArgs({
      prompt: 'change files after approval',
      model: 'gemini-3.6-flash',
      effort: 'medium',
      timeoutMs: 60_000,
      planMode: false,
      approvalPolicy: 'on-request',
      sandboxMode: 'danger-full-access'
    })
    expect(args).toEqual(expect.arrayContaining(['--mode', 'plan', '--sandbox']))
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('maps Kun auto approval into the CLI while retaining workspace sandboxing', () => {
    const args = buildAntigravityArgs({
      prompt: 'make the change',
      model: 'gemini-3.5-flash',
      effort: 'medium',
      timeoutMs: 90_000,
      planMode: false,
      approvalPolicy: 'auto',
      sandboxMode: 'workspace-write'
    })
    expect(args).toEqual(expect.arrayContaining([
      '--dangerously-skip-permissions',
      '--sandbox',
      '--model',
      'gemini-3.5-flash'
    ]))
    expect(args).not.toContain('--continue')
    expect(args.some((value) => value.startsWith('--conversation'))).toBe(false)
  })

  it('forces delegated read-only children into plan and sandbox controls', async () => {
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const turn = TurnSchema.parse({
      id: 'turn-read-only',
      threadId: 'thread-read-only',
      status: 'running',
      prompt: 'inspect only',
      model: 'gemini-3.6-flash',
      clientSurface: 'tui',
      createdAt: '2026-07-23T00:00:00.000Z'
    })
    await threadStore.upsert({
      ...createThreadRecord({
        id: 'thread-read-only',
        title: 'Read-only child',
        workspace: '/tmp',
        model: 'gemini-3.6-flash',
        providerId: 'gemini-subscription',
        status: 'running',
        approvalPolicy: 'auto',
        sandboxMode: 'workspace-write'
      }),
      turns: [turn]
    })
    await sessionStore.appendItem(
      'thread-read-only',
      makeUserItem({
        id: 'item-user',
        threadId: 'thread-read-only',
        turnId: turn.id,
        text: 'inspect only'
      })
    )
    let spawnedArgs: readonly string[] = []
    const runtime = new AntigravityCliRuntime({
      providerConfigs: {},
      providerIds: new Set(['gemini-subscription']),
      defaultIsAntigravity: false,
      threadStore,
      sessionStore,
      turns: {
        applyItem: vi.fn(async () => undefined),
        finishTurn: vi.fn(async () => undefined)
      } as unknown as TurnService,
      events: { record: vi.fn(async () => undefined) } as unknown as RuntimeEventRecorder,
      ids: { next: () => 'item-assistant' },
      enforceReadOnly: true,
      systemPrompt: 'You are a scoped read-only child.',
      spawnFn: successfulSpawn('inspected\n', (args) => {
        spawnedArgs = args
      })
    })

    await expect(runtime.runTurn(
      'thread-read-only',
      turn.id,
      new AbortController().signal,
      'gemini-subscription'
    )).resolves.toBe('completed')
    expect(spawnedArgs).toEqual(expect.arrayContaining(['--mode', 'plan', '--sandbox']))
    expect(spawnedArgs).not.toContain('--dangerously-skip-permissions')
    expect(spawnedArgs[1]).toContain('You are a scoped read-only child.')
    expect(spawnedArgs[1]).toContain('Kun terminal TUI')
  })

  it('publishes delegated Gemini CLI turns to the Agent Perspective trace store', async () => {
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const turn = TurnSchema.parse({
      id: 'turn-gemini',
      threadId: 'thread-gemini',
      status: 'running',
      prompt: 'hello from Gemini',
      model: 'gemini-3.6-flash',
      reasoningEffort: 'high',
      createdAt: '2026-07-23T00:00:00.000Z'
    })
    const thread = {
      ...createThreadRecord({
        id: 'thread-gemini',
        title: 'Gemini trace',
        workspace: '/tmp',
        model: 'gemini-3.6-flash',
        providerId: 'gemini-subscription',
        status: 'running'
      }),
      turns: [turn]
    }
    await threadStore.upsert(thread)
    await sessionStore.appendItem(
      thread.id,
      makeUserItem({
        id: 'item-user',
        threadId: thread.id,
        turnId: turn.id,
        text: 'hello from Gemini'
      })
    )
    const recorder = new LlmDebugRecorder()
    const finishTurn = vi.fn(async () => undefined)
    const runtime = new AntigravityCliRuntime({
      providerConfigs: {},
      providerIds: new Set(['gemini-subscription']),
      defaultIsAntigravity: false,
      threadStore,
      sessionStore,
      turns: {
        applyItem: vi.fn(async () => undefined),
        finishTurn
      } as unknown as TurnService,
      events: {
        record: vi.fn(async () => undefined)
      } as unknown as RuntimeEventRecorder,
      ids: { next: () => 'item-assistant' },
      debugSink: recorder,
      spawnFn: successfulSpawn('Gemini delegated answer\n')
    })

    await expect(runtime.runTurn(
      thread.id,
      turn.id,
      new AbortController().signal,
      'gemini-subscription'
    )).resolves.toBe('completed')

    const trace = (await recorder.listThread(thread.id)).records[0]
    expect(trace).toMatchObject({
      threadId: thread.id,
      turnId: turn.id,
      provider: 'gemini-subscription',
      model: 'gemini-3.6-flash',
      transport: 'cli',
      endpointFormat: 'antigravity-cli',
      status: 'completed',
      delegated: {
        providerKind: 'antigravity-cli',
        phase: 'portable',
        contextManagement: 'sdk-managed',
        nativeHistory: 'none'
      },
      request: {
        method: 'CLI',
        url: 'antigravity-cli://local/print'
      },
      decoded: {
        text: 'Gemini delegated answer',
        stopReason: 'stop'
      }
    })
    expect(JSON.parse(trace.request.body.text)).toMatchObject({
      model: 'gemini-3.6-flash',
      input: expect.stringContaining('hello from Gemini'),
      effort: 'high'
    })
    expect(finishTurn).toHaveBeenCalledWith({
      threadId: thread.id,
      turnId: turn.id,
      status: 'completed'
    })
  })
})

function successfulSpawn(
  output: string,
  onSpawn?: (args: readonly string[]) => void
): typeof spawn {
  return ((_command: string, args: readonly string[]) => {
    onSpawn?.(args)
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      kill: () => boolean
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    queueMicrotask(() => {
      child.stdout.end(output)
      child.stderr.end()
      child.emit('exit', 0, null)
    })
    return child as unknown as ChildProcess
  }) as typeof spawn
}
