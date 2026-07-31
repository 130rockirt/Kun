import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { FileSessionStore } from '../adapters/file/file-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { makeToolResultItem } from '../domain/item.js'
import { createThreadRecord } from '../domain/thread.js'
import { createTurnRecord } from '../domain/turn.js'
import { ContextCompactor } from './context-compactor.js'
import { InflightTracker } from './inflight-tracker.js'
import { SteeringQueue } from './steering-queue.js'
import { ToolExecutionService } from './tool-execution-service.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { TurnService } from '../services/turn-service.js'

const roots: string[] = []
const TEN_MINUTE_100MS_UPDATES = 10 * 60 * 10
const OUTPUT_BYTES = 500 * 1024

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('tool execution bounded-memory release regression', () => {
  it('bounds durable growth for a ten-minute-equivalent 500KB progress stream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-memory-growth-'))
    roots.push(root)
    const threadId = 'thread_memory_growth'
    const turnId = 'turn_memory_growth'
    const callId = 'call_memory_growth'
    const sessionStore = new FileSessionStore({
      dataDir: root,
      itemHistoryCompactionMinBytes: 256 * 1024,
      itemsCacheMaxBytes: 4 * 1024 * 1024
    })
    const threadStore = new InMemoryThreadStore()
    await threadStore.upsert({
      ...createThreadRecord({
        id: threadId,
        title: 'Memory growth regression',
        workspace: '/tmp/workspace',
        model: 'test'
      }),
      turns: [createTurnRecord({
        id: turnId,
        threadId,
        prompt: 'stream output',
        status: 'running'
      })]
    })
    const eventBus = new InMemoryEventBus({ maxRetainedBytes: 2 * 1024 * 1024 })
    const nowIso = () => '2026-07-31T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (id) => eventBus.allocateSeq(id),
      nowIso
    })
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      ids: new SequentialIdGenerator(),
      nowIso
    })
    const payload = 'x'.repeat(OUTPUT_BYTES)
    let transientCount = 0
    eventBus.subscribe(threadId, (event) => {
      if (event.kind === 'item_updated') transientCount += 1
    })
    const service = new ToolExecutionService({
      toolHost: {
        id: 'memory-regression',
        listTools: async () => [],
        execute: async (_call, _context, onUpdate) => {
          for (let index = 0; index < TEN_MINUTE_100MS_UPDATES; index += 1) {
            const length = Math.max(
              1,
              Math.floor(((index + 1) / TEN_MINUTE_100MS_UPDATES) * payload.length)
            )
            await onUpdate?.(makeToolResultItem({
              id: `item_${callId}`,
              threadId,
              turnId,
              callId,
              toolName: 'bash',
              output: {
                output: payload.slice(0, length),
                update: index,
                partial: true
              },
              status: 'running'
            }))
          }
          return {
            item: makeToolResultItem({
              id: `item_${callId}`,
              threadId,
              turnId,
              callId,
              toolName: 'bash',
              output: { output: payload, partial: false },
              status: 'completed'
            }),
            approved: true
          }
        }
      },
      inflight: new InflightTracker(),
      turns,
      events,
      nowIso
    })
    const context = {
      threadId,
      turnId,
      workspace: '/tmp/workspace',
      approvalPolicy: 'auto',
      sandboxMode: 'workspace-write',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow' as const
    } as ToolHostContext
    const call = { callId, toolName: 'bash', arguments: { command: 'stress' } }

    const result = await service.executeSafely({ threadId, turnId, call, context })
    await service.persistResult(threadId, turnId, call, result)

    const threadDir = join(root, 'threads', threadId)
    const messagesBytes = (await stat(join(threadDir, 'messages.jsonl'))).size
    const eventsBytes = (await stat(join(threadDir, 'events.jsonl'))).size
    sessionStore.clearThreadMemory(threadId)
    const items = await sessionStore.loadItems(threadId)

    expect(transientCount).toBe(TEN_MINUTE_100MS_UPDATES - 1)
    expect(messagesBytes).toBeLessThan(700 * 1024)
    expect(eventsBytes).toBeLessThan(1_400 * 1024)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: `item_${callId}`,
      status: 'completed',
      output: { output: payload, partial: false }
    })
  }, 120_000)
})
