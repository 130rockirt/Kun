import { describe, expect, it, vi } from 'vitest'
import { resolveManagedRuntimeStartupTarget } from './managed-runtime-startup-attach'

describe('managed runtime startup attach', () => {
  it('ensures the runtime when auto-start is enabled', async () => {
    const settings = { revision: 1 }
    const next = { revision: 2 }
    const ensure = vi.fn(async () => next)
    const resolveExisting = vi.fn(async () => true)

    await expect(resolveManagedRuntimeStartupTarget(settings, true, {
      ensure,
      resolveExisting
    })).resolves.toBe(next)
    expect(ensure).toHaveBeenCalledWith(settings)
    expect(resolveExisting).not.toHaveBeenCalled()
  })

  it('attaches an existing runtime without starting one when auto-start is disabled', async () => {
    const settings = { revision: 1 }
    const ensure = vi.fn(async () => settings)
    const resolveExisting = vi.fn(async () => true)

    await expect(resolveManagedRuntimeStartupTarget(settings, false, {
      ensure,
      resolveExisting
    })).resolves.toBe(settings)
    expect(resolveExisting).toHaveBeenCalledWith(settings)
    expect(ensure).not.toHaveBeenCalled()
  })

  it('does nothing when auto-start is disabled and no shared runtime exists', async () => {
    const settings = { revision: 1 }
    const ensure = vi.fn(async () => settings)
    const resolveExisting = vi.fn(async () => false)

    await expect(resolveManagedRuntimeStartupTarget(settings, false, {
      ensure,
      resolveExisting
    })).resolves.toBeNull()
    expect(ensure).not.toHaveBeenCalled()
  })
})
