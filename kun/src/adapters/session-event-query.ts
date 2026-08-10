import type { RuntimeEvent } from '../contracts/events.js'
import type { SessionStore } from '../ports/session-store.js'

/**
 * Stream-aware event lookups. Prefer `iterateEventsSince` so callers never
 * materialize a whole events.jsonl just to answer a boolean or find one row.
 */
export async function findSessionEvent(
  store: SessionStore,
  threadId: string,
  match: (event: RuntimeEvent) => boolean,
  sinceSeq = 0
): Promise<RuntimeEvent | null> {
  if (store.iterateEventsSince) {
    for await (const event of store.iterateEventsSince(threadId, sinceSeq)) {
      if (match(event)) return event
    }
    return null
  }
  return (await store.loadEventsSince(threadId, sinceSeq)).find(match) ?? null
}

export async function sessionEventExists(
  store: SessionStore,
  threadId: string,
  match: (event: RuntimeEvent) => boolean,
  sinceSeq = 0
): Promise<boolean> {
  return (await findSessionEvent(store, threadId, match, sinceSeq)) !== null
}

export async function collectSessionEvents(
  store: SessionStore,
  threadId: string,
  match: (event: RuntimeEvent) => boolean,
  sinceSeq = 0
): Promise<RuntimeEvent[]> {
  const matched: RuntimeEvent[] = []
  if (store.iterateEventsSince) {
    for await (const event of store.iterateEventsSince(threadId, sinceSeq)) {
      if (match(event)) matched.push(event)
    }
    return matched
  }
  return (await store.loadEventsSince(threadId, sinceSeq)).filter(match)
}

export async function collectSessionEventsOfKind<Kind extends RuntimeEvent['kind']>(
  store: SessionStore,
  threadId: string,
  kind: Kind,
  sinceSeq = 0
): Promise<Array<Extract<RuntimeEvent, { kind: Kind }>>> {
  const matched: Array<Extract<RuntimeEvent, { kind: Kind }>> = []
  if (store.iterateEventsSince) {
    for await (const event of store.iterateEventsSince(threadId, sinceSeq)) {
      if (event.kind === kind) matched.push(event as Extract<RuntimeEvent, { kind: Kind }>)
    }
    return matched
  }
  for (const event of await store.loadEventsSince(threadId, sinceSeq)) {
    if (event.kind === kind) matched.push(event as Extract<RuntimeEvent, { kind: Kind }>)
  }
  return matched
}

export async function findLatestUsageEvent(
  store: SessionStore,
  threadId: string
): Promise<Extract<RuntimeEvent, { kind: 'usage' }> | null> {
  let latest: Extract<RuntimeEvent, { kind: 'usage' }> | null = null
  if (store.iterateEventsSince) {
    for await (const event of store.iterateEventsSince(threadId, 0)) {
      if (event.kind !== 'usage') continue
      if (!latest || event.seq > latest.seq) latest = event
    }
    return latest
  }
  for (const event of await store.loadEventsSince(threadId, 0)) {
    if (event.kind !== 'usage') continue
    if (!latest || event.seq > latest.seq) latest = event
  }
  return latest
}
