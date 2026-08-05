import { describe, expect, it } from 'vitest'
import { RuntimeSettingsIntentSequencer } from './runtime-settings-intent-sequencer'

function createGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

describe('RuntimeSettingsIntentSequencer', () => {
  it('invalidates rollback ownership as soon as newer durable intent is reserved', () => {
    const sequencer = new RuntimeSettingsIntentSequencer()
    const first = sequencer.reserve()
    expect(sequencer.isCurrent(first)).toBe(true)

    const second = sequencer.reserve()

    expect(second).toBe(first + 1)
    expect(sequencer.isCurrent(first)).toBe(false)
    expect(sequencer.isCurrent(second)).toBe(true)
  })

  it('keeps a guarded rollback behind a newer persistence transaction', async () => {
    const sequencer = new RuntimeSettingsIntentSequencer()
    const persistGate = createGate()
    const trace: string[] = []

    const persisted = sequencer.serializePersistence(async () => {
      trace.push('persist:start')
      await persistGate.promise
      const generation = sequencer.reserve()
      trace.push(`persist:reserved:${generation}`)
      return generation
    })
    const rollback = sequencer.serializePersistence(async () => {
      trace.push('rollback:check')
      return sequencer.isCurrent(0)
    })

    await Promise.resolve()
    expect(trace).toEqual(['persist:start'])
    persistGate.release()

    await expect(persisted).resolves.toBe(1)
    await expect(rollback).resolves.toBe(false)
    expect(trace).toEqual(['persist:start', 'persist:reserved:1', 'rollback:check'])
  })
})
