import { describe, expect, it, vi } from 'vitest'
import { NativeDialogCoordinator } from './native-dialog-coordinator'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('NativeDialogCoordinator', () => {
  it('serializes dialogs for one window and exposes an idle promise while queued', async () => {
    const coordinator = new NativeDialogCoordinator()
    const owner = {}
    const first = deferred()
    const opened: string[] = []

    const firstDialog = coordinator.run(owner, async () => {
      opened.push('first')
      await first.promise
      return 'first'
    })
    const secondDialog = coordinator.run(owner, async () => {
      opened.push('second')
      return 'second'
    })

    await vi.waitFor(() => expect(opened).toEqual(['first']))
    const idle = coordinator.deferUntilIdle(owner)
    expect(idle).toBeDefined()

    first.resolve()
    await expect(firstDialog).resolves.toBe('first')
    await expect(secondDialog).resolves.toBe('second')
    await idle

    expect(opened).toEqual(['first', 'second'])
    expect(coordinator.deferUntilIdle(owner)).toBeUndefined()
  })
})
