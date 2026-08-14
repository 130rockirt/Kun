import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_KUN_MODEL } from '@shared/app-settings'
import {
  WRITE_ASSISTANT_MODEL_KEY,
  filterWriteEntries,
  normalizeWriteAssistantModel,
  readStoredAssistantModel
} from './write-workspace-store-helpers'

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

function installStorage(): MemoryStorage {
  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage
  })
  return storage
}

function restoreLocalStorage(): void {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage)
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage')
  }
}

afterEach(() => {
  restoreLocalStorage()
})

describe('write workspace entry filtering', () => {
  it('hides Kun-owned canvas directories while retaining user folders and documents', () => {
    const entries = [
      { name: '.kun-write', path: '/work/.kun-write', type: 'directory' as const, ext: '' },
      { name: '.kun-canvas', path: '/work/.kun-canvas', type: 'directory' as const, ext: '' },
      { name: '.kun-whiteboards', path: '/work/.kun-whiteboards', type: 'directory' as const, ext: '' },
      { name: 'notes', path: '/work/notes', type: 'directory' as const, ext: '' },
      { name: 'draft.md', path: '/work/draft.md', type: 'file' as const, ext: '.md' }
    ]

    expect(filterWriteEntries(entries).map((entry) => entry.name)).toEqual([
      'notes',
      'draft.md'
    ])
  })
})

describe('write workspace assistant model helpers', () => {
  it('normalizes empty and legacy auto assistant models to the default Kun model', () => {
    expect(normalizeWriteAssistantModel('')).toBe(DEFAULT_KUN_MODEL)
    expect(normalizeWriteAssistantModel('auto')).toBe(DEFAULT_KUN_MODEL)
    expect(normalizeWriteAssistantModel(' AUTO ')).toBe(DEFAULT_KUN_MODEL)
    expect(normalizeWriteAssistantModel('custom-model')).toBe('custom-model')
  })

  it('migrates the stored legacy auto assistant model', () => {
    const storage = installStorage()
    storage.setItem(WRITE_ASSISTANT_MODEL_KEY, 'auto')

    expect(readStoredAssistantModel()).toBe(DEFAULT_KUN_MODEL)
    expect(storage.getItem(WRITE_ASSISTANT_MODEL_KEY)).toBe(DEFAULT_KUN_MODEL)
  })
})
