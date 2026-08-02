import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorageRelocationStatus } from '@shared/storage-relocation'
import i18n from '../i18n'
import { StorageRelocationSettingsSection } from './settings-section-storage-relocation'

function textContent(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : textContent(child)).join('')
}

function status(overrides: Partial<StorageRelocationStatus> = {}): StorageRelocationStatus {
  return {
    supported: true,
    enabled: true,
    platform: 'win32',
    state: 'default',
    roots: [{
      name: '.kun',
      logicalPath: 'C:\\Users\\Alice\\.kun',
      physicalPath: 'C:\\Users\\Alice\\.kun',
      exists: true,
      junction: false,
      appOwned: false,
      files: 2,
      directories: 2,
      links: 0,
      bytes: 1024
    }],
    totalUniqueBytes: 1024,
    recoveryRequired: false,
    ...overrides
  }
}

describe('StorageRelocationSettingsSection', () => {
  beforeEach(async () => { await i18n.changeLanguage('en') })
  afterEach(() => vi.unstubAllGlobals())

  it('shows logical and physical locations plus the excluded C-drive scope', async () => {
    vi.stubGlobal('window', { kunGui: { storageRelocation: {
      getStatus: vi.fn(async () => status()),
      onProgress: vi.fn(() => vi.fn())
    } } })
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(StorageRelocationSettingsSection)) })
    const text = textContent(renderer.root)
    expect(text).toContain('C:\\Users\\Alice\\.kun')
    expect(text).toContain('%APPDATA%\\Kun')
    expect(text).toContain('.devin')
  })

  it('shows the main-process disabled reason without enabling the move action', async () => {
    vi.stubGlobal('window', { kunGui: { storageRelocation: {
      getStatus: vi.fn(async () => status({
        enabled: false,
        disabledReason: 'Internal rollout is disabled.'
      })),
      onProgress: vi.fn(() => vi.fn())
    } } })
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(StorageRelocationSettingsSection)) })
    expect(textContent(renderer.root)).toContain('Internal rollout is disabled.')
    const choose = renderer.root.findAllByType('button').find((node) => textContent(node).includes('Choose location'))!
    expect(choose.props.disabled).toBe(true)
  })

  it('renders preflight space and active-work confirmation before scheduling', async () => {
    const schedule = vi.fn(async () => status({ state: 'pending' }))
    const api = {
      getStatus: vi.fn(async () => status()),
      onProgress: vi.fn(() => vi.fn()),
      pickDestination: vi.fn(async () => ({ canceled: false, path: 'D:\\KunData' })),
      preflight: vi.fn(async () => ({
        operationId: '123e4567-e89b-42d3-a456-426614174000',
        kind: 'move' as const,
        destinationRoot: 'D:\\KunData',
        targetRoots: { '.kun': 'D:\\KunData\\.kun', '.deepseekgui': 'D:\\KunData\\.deepseekgui' },
        sources: status().roots,
        uniqueBytes: 1024,
        requiredBytes: 5 * 1024 * 1024 * 1024 + 1024,
        availableBytes: 20 * 1024 * 1024 * 1024,
        expectedReleasedBytes: 1024,
        activeWork: [{ kind: 'turn' as const, id: 'production:thread:turn', label: 'Active chat', interruptible: true }],
        warnings: [],
        createdAt: '2026-08-01T00:00:00.000Z'
      })),
      schedule,
      restoreDefault: vi.fn(),
      cancel: vi.fn(),
      retry: vi.fn(),
      rollback: vi.fn()
    }
    vi.stubGlobal('window', { kunGui: { storageRelocation: api }, confirm: vi.fn(() => true) })
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(StorageRelocationSettingsSection)) })
    const choose = renderer.root.findAllByType('button').find((node) => textContent(node).includes('Choose location'))!
    await act(async () => { await choose.props.onClick() })
    expect(textContent(renderer.root)).toContain('Active chat')
    expect(textContent(renderer.root)).toContain('20.0 GB')
    const start = renderer.root.findAllByType('button').find((node) => textContent(node).includes('Restart and move'))!
    expect(start.props.disabled).toBe(true)
    const confirmation = renderer.root.findByType('input')
    await act(async () => { confirmation.props.onChange({ target: { checked: true } }) })
    expect(start.props.disabled).toBe(false)
    await act(async () => { await start.props.onClick() })
    expect(schedule).toHaveBeenCalledWith(expect.objectContaining({ interruptActiveWork: true }))
  })
})
