import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KunCapabilitiesConfig, type SubagentsCapabilityConfig } from '../contracts/capabilities.js'
import type { RuntimeEvent } from '../contracts/events.js'
import type { EventBus } from '../ports/event-bus.js'
import {
  type ChildRunExecutor,
  type ChildRunRecord,
  DelegationRuntime,
  FileDelegationStore
} from './delegation-runtime.js'
import { deferred, waitFor } from '../../tests/support/delegation-runtime-fixtures.js'

describe('DelegationRuntime live concurrency reconfiguration', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'kun-delegation-reconfigure-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('admits existing FIFO waiters before later arrivals after raising maxParallel', async () => {
    const firstGate = deferred<void>()
    const startOrder: string[] = []
    const runtime = createRuntime({
      maxParallel: 1,
      executor: async ({ prompt }) => {
        startOrder.push(prompt)
        if (prompt === 'first') await firstGate.promise
        return { summary: prompt }
      }
    })
    const signal = new AbortController().signal
    const first = run(runtime, 'first', signal)
    await waitFor(() => startOrder.length === 1)
    const second = run(runtime, 'second', signal)
    await waitFor(async () => (await runtime.diagnostics()).childRuns.some(
      (child) => child.prompt === 'second' && child.status === 'queued'
    ))

    runtime.replaceConfig(subagentConfig(2))
    const third = run(runtime, 'third', signal)
    await waitFor(() => startOrder.length >= 2)
    expect(startOrder.slice(0, 2)).toEqual(['first', 'second'])

    firstGate.resolve()
    await Promise.all([first, second, third])
    expect(startOrder).toEqual(['first', 'second', 'third'])
  })

  it('does not admit another waiter above a lowered maxParallel', async () => {
    const gates = {
      first: deferred<void>(),
      second: deferred<void>(),
      third: deferred<void>()
    }
    const startOrder: string[] = []
    const runtime = createRuntime({
      maxParallel: 2,
      executor: async ({ prompt }) => {
        startOrder.push(prompt)
        await gates[prompt as keyof typeof gates].promise
        return { summary: prompt }
      }
    })
    const signal = new AbortController().signal
    const first = run(runtime, 'first', signal)
    const second = run(runtime, 'second', signal)
    await waitFor(() => startOrder.length === 2)
    const third = run(runtime, 'third', signal)
    await waitFor(async () => (await runtime.diagnostics()).childRuns.some(
      (child) => child.prompt === 'third' && child.status === 'queued'
    ))

    runtime.replaceConfig(subagentConfig(1))
    gates.first.resolve()
    await first
    expect(startOrder).toHaveLength(2)
    expect(startOrder).toEqual(expect.arrayContaining(['first', 'second']))
    expect((await runtime.diagnostics()).childRuns.find((child) => child.prompt === 'third'))
      .toMatchObject({ status: 'queued' })

    gates.second.resolve()
    await second
    await waitFor(() => startOrder.includes('third'))
    gates.third.resolve()
    await expect(third).resolves.toMatchObject({ status: 'completed' })
  })

  it('keeps queued children paused while delegation is disabled', async () => {
    const firstGate = deferred<void>()
    const startOrder: string[] = []
    const runtime = createRuntime({
      maxParallel: 1,
      executor: async ({ prompt }) => {
        startOrder.push(prompt)
        if (prompt === 'first') await firstGate.promise
        return { summary: prompt }
      }
    })
    const signal = new AbortController().signal
    const first = run(runtime, 'first', signal)
    await waitFor(() => startOrder.length === 1)
    const second = run(runtime, 'second', signal)
    await waitFor(async () => (await runtime.diagnostics()).childRuns.some(
      (child) => child.prompt === 'second' && child.status === 'queued'
    ))

    runtime.replaceConfig({ ...subagentConfig(1), enabled: false })
    firstGate.resolve()
    await first
    expect(startOrder).toEqual(['first'])

    runtime.replaceConfig(subagentConfig(1))
    await expect(second).resolves.toMatchObject({ status: 'completed' })
    expect(startOrder).toEqual(['first', 'second'])
  })

  it('releases the slot when persisting the running transition fails', async () => {
    const store = new FailFirstRunningTransitionStore(join(directory, 'children'))
    let executions = 0
    const runtime = createRuntime({
      maxParallel: 1,
      store,
      executor: async ({ prompt }) => {
        executions += 1
        return { summary: prompt }
      }
    })
    const signal = new AbortController().signal

    await expect(run(runtime, 'first', signal)).resolves.toMatchObject({
      status: 'failed',
      error: 'simulated running write failure'
    })
    await expect(run(runtime, 'second', signal)).resolves.toMatchObject({ status: 'completed' })
    await expect(runtime.diagnostics()).resolves.toMatchObject({ active: 0 })
    expect(executions).toBe(1)
  })

  it('releases the slot when activity subscription cleanup throws', async () => {
    const eventBus = new ThrowingUnsubscribeEventBus()
    const runtime = createRuntime({
      maxParallel: 1,
      eventBus,
      executor: async ({ prompt }) => ({ summary: prompt })
    })
    const signal = new AbortController().signal

    await expect(run(runtime, 'first', signal)).resolves.toMatchObject({ status: 'completed' })
    await expect(run(runtime, 'second', signal)).resolves.toMatchObject({ status: 'completed' })
    await expect(runtime.diagnostics()).resolves.toMatchObject({ active: 0 })
    expect(eventBus.unsubscribeCalls).toBe(2)
  })

  function createRuntime(options: {
    maxParallel: number
    store?: FileDelegationStore
    eventBus?: EventBus
    executor: ChildRunExecutor
  }): DelegationRuntime {
    let sequence = 0
    return new DelegationRuntime({
      config: subagentConfig(options.maxParallel),
      store: options.store ?? new FileDelegationStore(join(directory, 'children')),
      idGenerator: () => `child_${++sequence}`,
      eventBus: options.eventBus,
      executor: options.executor
    })
  }
})

function subagentConfig(maxParallel: number): SubagentsCapabilityConfig {
  return KunCapabilitiesConfig.parse({
    subagents: {
      enabled: true,
      useExistingAgents: true,
      maxParallel,
      profiles: { general: { toolPolicy: 'inherit' } }
    }
  }).subagents
}

function run(runtime: DelegationRuntime, prompt: string, signal: AbortSignal): Promise<ChildRunRecord> {
  return runtime.runChild({
    parentThreadId: 'parent',
    parentTurnId: `turn_${prompt}`,
    prompt,
    signal
  })
}

class FailFirstRunningTransitionStore extends FileDelegationStore {
  private failed = false

  override async upsert(record: ChildRunRecord): Promise<void> {
    if (!this.failed && record.status === 'running') {
      this.failed = true
      throw new Error('simulated running write failure')
    }
    await super.upsert(record)
  }
}

class ThrowingUnsubscribeEventBus implements EventBus {
  unsubscribeCalls = 0

  publish(_event: RuntimeEvent): void {}

  subscribe(_threadId: string, _handler: (event: RuntimeEvent) => void): () => void {
    return () => {
      this.unsubscribeCalls += 1
      throw new Error('simulated unsubscribe failure')
    }
  }

  snapshotSince(_threadId: string, _sinceSeq: number): RuntimeEvent[] {
    return []
  }

  highestSeq(_threadId: string): number {
    return 0
  }

  reset(): void {}
}
