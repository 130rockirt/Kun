import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import type {
  DesignDocumentTarget,
  DesignTaskProfileInput
} from '../contracts/design-task-profile.js'
import { ContextCompactor } from '../loop/context-compactor.js'
import { InflightTracker } from '../loop/inflight-tracker.js'
import { SteeringQueue } from '../loop/steering-queue.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import { RuntimeEventRecorder } from './runtime-event-recorder.js'
import { ThreadService } from './thread-service.js'
import { TurnService } from './turn-service.js'

export const nowIso = () => '2026-08-12T12:00:00.000Z'

export function target(suffix = 'source'): DesignDocumentTarget {
  return { documentId: `doc_${suffix}`, boardArtifactId: `board_${suffix}` }
}

export function profile(
  documentTarget: DesignDocumentTarget = target(),
  outputMedium: 'html' | 'image' = 'html'
): DesignTaskProfileInput {
  return {
    version: 1,
    documentTarget,
    outputMedium,
    target: 'web',
    preset: 'ios',
    presetSource: 'explicit',
    context: {
      designType: 'product',
      brandColor: '#2563eb',
      tone: ['professional'],
      radius: 'rounded',
      density: 'cozy',
      fontStyle: 'system'
    }
  }
}

export function harness(sessionStore = new InMemorySessionStore()) {
  const threadStore = new InMemoryThreadStore()
  const eventBus = new InMemoryEventBus()
  const ids = new SequentialIdGenerator()
  const events = new RuntimeEventRecorder({
    eventBus,
    sessionStore,
    allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
    nowIso
  })
  const turns = new TurnService({
    threadStore,
    sessionStore,
    events,
    inflight: new InflightTracker(),
    steering: new SteeringQueue(),
    compactor: new ContextCompactor(),
    ids,
    nowIso
  })
  const threads = new ThreadService({ threadStore, sessionStore, events, ids, nowIso })
  return { threadStore, sessionStore, eventBus, ids, turns, threads }
}

export class FailFirstAppendStore extends InMemorySessionStore {
  private fails = true

  override async appendItem(...args: Parameters<InMemorySessionStore['appendItem']>): Promise<void> {
    if (this.fails) {
      this.fails = false
      throw new Error('first append failed')
    }
    await super.appendItem(...args)
  }
}

export class ControlledFailureSessionStore extends InMemorySessionStore {
  failNextEvent = false
  failNextSessionSnapshot = false

  override async appendEvent(...args: Parameters<InMemorySessionStore['appendEvent']>): Promise<void> {
    if (this.failNextEvent) {
      this.failNextEvent = false
      throw new Error('injected event failure')
    }
    await super.appendEvent(...args)
  }

  override async upsertSession(...args: Parameters<InMemorySessionStore['upsertSession']>): Promise<void> {
    if (this.failNextSessionSnapshot) {
      this.failNextSessionSnapshot = false
      throw new Error('injected session snapshot failure')
    }
    await super.upsertSession(...args)
  }
}
