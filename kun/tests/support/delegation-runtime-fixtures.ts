import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryEventBus } from '../../src/adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../../src/adapters/in-memory-session-store.js'
import { CapabilityRegistry } from '../../src/adapters/tool/capability-registry.js'
import { buildDelegationToolProviders } from '../../src/adapters/tool/delegation-tool-provider.js'
import { LocalToolHost } from '../../src/adapters/tool/local-tool-host.js'
import { KunCapabilitiesConfig, type SubagentProfileConfig } from '../../src/contracts/capabilities.js'
import { emptyUsageSnapshot } from '../../src/contracts/usage.js'
import { BUILTIN_SUBAGENT_PROFILES } from '../../src/delegation/builtin-profiles.js'
import {
  ChildRunRecord,
  DelegationRuntime,
  FileDelegationStore,
  type ChildRunExecutor
} from '../../src/delegation/delegation-runtime.js'
import { SubagentRouter } from '../../src/delegation/subagent-router.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../../src/ports/model-client.js'
import type { ToolHostContext } from '../../src/ports/tool-host.js'
import { RuntimeEventRecorder } from '../../src/services/runtime-event-recorder.js'

export class StaticRouterModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'router-model'
  readonly requests: ModelRequest[] = []

  constructor(private readonly response: string) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    yield { kind: 'assistant_text_delta', text: this.response }
    yield { kind: 'usage', usage: emptyUsageSnapshot() }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
