import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemorySessionStore } from '../../src/adapters/in-memory-session-store.js'
import { InMemoryEventBus } from '../../src/adapters/in-memory-event-bus.js'
import { InMemoryThreadStore } from '../../src/adapters/in-memory-thread-store.js'
import { SequentialIdGenerator } from '../../src/ports/id-generator.js'
import { ThreadService } from '../../src/services/thread-service.js'
import { RuntimeEventRecorder } from '../../src/services/runtime-event-recorder.js'
import { createThreadRecord, touchThread } from '../../src/domain/thread.js'
import { createTurnRecord, startTurn } from '../../src/domain/turn.js'
import { makeAssistantTextItem, makeToolCallItem, makeToolResultItem, makeUserItem } from '../../src/domain/item.js'
import type { TurnItem } from '../../src/contracts/items.js'
import { DEFAULT_KUN_MODEL } from '../../src/config/kun-config.js'

export function buildService(): {
  service: ThreadService
  threadStore: InMemoryThreadStore
  sessionStore: InMemorySessionStore
  nowIso: () => string
} {
  const bus = new InMemoryEventBus()
  const threadStore = new InMemoryThreadStore()
  const sessionStore = new InMemorySessionStore()
  const ids = new SequentialIdGenerator()
  let now = 1_700_000_000_000
  const nowIso = () => new Date((now += 1000)).toISOString()
  const events = new RuntimeEventRecorder({
    eventBus: bus,
    sessionStore,
    allocateSeq: (threadId) => bus.allocateSeq(threadId),
    nowIso
  })
  return {
    service: new ThreadService({ threadStore, sessionStore, events, ids, nowIso }),
    threadStore,
    sessionStore,
    nowIso
  }
}

export function withId(item: TurnItem, id: string): TurnItem {
  return { ...item, id }
}

export async function seedParentWithTurns(
  service: ThreadService,
  threadStore: InMemoryThreadStore,
  sessionStore: InMemorySessionStore,
  nowIso: () => string,
  options: { parentId: string; inflight?: boolean }
): Promise<void> {
  await service.create(
    { workspace: '/tmp/p', model: 'deepseek-chat', mode: 'agent' },
    { id: options.parentId, title: 'Parent' }
  )
  const completed = startTurn(
    createTurnRecord({
      id: 'turn_completed',
      threadId: options.parentId,
      prompt: 'first ask',
      createdAt: nowIso()
    }),
    nowIso()
  )
  const completedItems: TurnItem[] = [
    withId(
      makeUserItem({ id: 'item_user_1', turnId: completed.id, threadId: options.parentId, text: 'first ask' }),
      'item_user_1'
    ),
    withId(
      makeAssistantTextItem({
        id: 'item_a_1',
        turnId: completed.id,
        threadId: options.parentId,
        text: 'first answer'
      }),
      'item_a_1'
    )
  ]
  completed.items = completedItems

  const running = startTurn(
    createTurnRecord({
      id: 'turn_inflight',
      threadId: options.parentId,
      prompt: 'mid-flight ask',
      createdAt: nowIso()
    }),
    nowIso()
  )
  const runningItems: TurnItem[] = [
    withId(
      makeUserItem({ id: 'item_user_2', turnId: running.id, threadId: options.parentId, text: 'mid-flight ask' }),
      'item_user_2'
    ),
    withId(
      makeAssistantTextItem({
        id: 'item_a_2',
        turnId: running.id,
        threadId: options.parentId,
        text: 'partial reasoning...',
        status: 'running'
      }),
      'item_a_2'
    ),
    withId(
      makeToolCallItem({
        id: 'item_t_2',
        turnId: running.id,
        threadId: options.parentId,
        callId: 'call_inflight',
        toolName: 'noop',
        arguments: { partial: true },
        status: 'running'
      }),
      'item_t_2'
    )
  ]
  running.items = runningItems

  const turns = options.inflight ? [completed, running] : [completed]
  const parent = await threadStore.get(options.parentId)
  if (!parent) throw new Error('parent missing')
  await threadStore.upsert(touchThread({ ...parent, turns }, nowIso()))
  for (const turn of turns) {
    for (const item of turn.items) {
      await sessionStore.appendItem(parent.id, item)
    }
  }
}
