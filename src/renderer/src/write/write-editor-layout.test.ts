import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addTabToGroup,
  createWriteDocumentSession,
  emptyWriteEditorLayout,
  persistWriteEditorLayout,
  projectFocusedDocument,
  readWriteEditorLayout
} from './write-editor-layout'

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

afterEach(() => vi.unstubAllGlobals())

describe('write editor layout', () => {
  it('deduplicates tabs inside one group while allowing per-group occurrences', () => {
    let layout = addTabToGroup(emptyWriteEditorLayout(), 'primary', '/work/a.md', 'live')
    layout = addTabToGroup(layout, 'primary', '/work/a.md', 'preview')
    expect(layout.groups[0].tabs).toEqual([{ path: '/work/a.md', viewMode: 'live' }])
    expect(layout.groups[0].activePath).toBe('/work/a.md')
  })

  it('projects the focused group document and its occurrence view mode', () => {
    const layout = addTabToGroup(emptyWriteEditorLayout(), 'primary', '/work/a.md', 'preview')
    const document = createWriteDocumentSession({
      path: '/work/a.md',
      kind: 'text',
      fileContent: 'draft',
      persistedContent: 'saved',
      saveStatus: 'dirty'
    })
    expect(projectFocusedDocument(layout, { '/work/a.md': document })).toMatchObject({
      activeFilePath: '/work/a.md',
      fileContent: 'draft',
      saveStatus: 'dirty',
      previewMode: 'preview'
    })
  })

  it('restores layout metadata but rejects paths outside the workspace', () => {
    const storage = new MemoryStorage()
    vi.stubGlobal('window', { localStorage: storage })
    const layout = {
      ...emptyWriteEditorLayout(),
      groups: [{
        id: 'primary' as const,
        activePath: '/work/a.md',
        tabs: [
          { path: '/work/a.md', viewMode: 'live' as const },
          { path: '/other/secret.md', viewMode: 'source' as const }
        ]
      }]
    }
    persistWriteEditorLayout('/work', layout)
    expect(readWriteEditorLayout('/work')?.groups[0]).toEqual({
      id: 'primary',
      activePath: '/work/a.md',
      tabs: [{ path: '/work/a.md', viewMode: 'live' }]
    })
  })
})
