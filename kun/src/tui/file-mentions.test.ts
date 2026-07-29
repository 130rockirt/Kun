import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  WorkspaceFileAutocompleteProvider,
  parseTuiFileMentions,
  walkWorkspaceFilesFallback,
  type WorkspaceFileEntry
} from './file-mentions.js'

describe('parseTuiFileMentions', () => {
  it('parses relative, quoted, and multiple mentions while deduplicating paths', () => {
    expect(parseTuiFileMentions(
      'Compare @src/main.ts with @"docs/design notes.md" and @src/main.ts'
    )).toEqual({
      mentions: [
        { raw: '@src/main.ts', relativePath: 'src/main.ts' },
        { raw: '@"docs/design notes.md"', relativePath: 'docs/design notes.md' }
      ],
      invalid: []
    })
  })

  it('ignores email addresses and escaped at signs', () => {
    expect(parseTuiFileMentions(
      'Email dev@example.com or write \\@literal without attaching anything.'
    )).toEqual({ mentions: [], invalid: [] })
  })

  it('reports absolute, parent traversal, repository metadata, and unterminated quoted mentions', () => {
    expect(parseTuiFileMentions('Read @/etc/passwd').invalid[0]?.reason).toContain('relative')
    expect(parseTuiFileMentions('Read @../secret.txt').invalid[0]?.reason).toContain('traverse')
    expect(parseTuiFileMentions('Read @.git/config').invalid[0]?.reason).toContain('.git')
    expect(parseTuiFileMentions('Read @"unfinished path').invalid[0]?.reason).toContain('closing quote')
  })
})

describe('WorkspaceFileAutocompleteProvider', () => {
  const entries: WorkspaceFileEntry[] = [
    { path: 'src/', isDirectory: true },
    { path: 'src/components/', isDirectory: true },
    { path: 'src/components/PrimaryButton.tsx', isDirectory: false },
    { path: 'docs/design notes.md', isDirectory: false }
  ]

  it('fuzzily completes files and delegates safe insertion to the TUI editor provider', async () => {
    const provider = new WorkspaceFileAutocompleteProvider([], '/work', {
      listFiles: vi.fn(async () => entries)
    })
    const input = 'Inspect @pbtn'
    const suggestions = await provider.getSuggestions(
      [input],
      0,
      input.length,
      { signal: new AbortController().signal }
    )

    expect(suggestions?.prefix).toBe('@pbtn')
    expect(suggestions?.items[0]).toMatchObject({
      value: '@src/components/PrimaryButton.tsx',
      label: 'PrimaryButton.tsx'
    })
    expect(provider.applyCompletion(
      [input],
      0,
      input.length,
      suggestions!.items[0]!,
      suggestions!.prefix
    )).toEqual({
      lines: ['Inspect @src/components/PrimaryButton.tsx '],
      cursorLine: 0,
      cursorCol: 42
    })
  })

  it('quotes paths with whitespace and returns direct children for directory navigation', async () => {
    const listFiles = vi.fn(async () => entries)
    const provider = new WorkspaceFileAutocompleteProvider([], '/work', { listFiles })
    const quotedInput = 'Read @design'
    const quoted = await provider.getSuggestions(
      [quotedInput],
      0,
      quotedInput.length,
      { signal: new AbortController().signal }
    )
    expect(quoted?.items[0]?.value).toBe('@"docs/design notes.md"')

    const directoryInput = 'Read @src/'
    const directory = await provider.getSuggestions(
      [directoryInput],
      0,
      directoryInput.length,
      { signal: new AbortController().signal }
    )
    expect(directory?.items.map((item) => item.value)).toEqual(['@src/components/'])
    expect(listFiles).toHaveBeenCalledTimes(1)
  })

  it('honors cancellation without returning stale suggestions', async () => {
    const provider = new WorkspaceFileAutocompleteProvider([], '/work', {
      listFiles: async (_workspace, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(entries), { once: true })
      })
    })
    const controller = new AbortController()
    const input = 'Read @src'
    const pending = provider.getSuggestions(
      [input],
      0,
      input.length,
      { signal: controller.signal }
    )
    controller.abort()
    await expect(pending).resolves.toBeNull()
  })
})

describe('walkWorkspaceFilesFallback', () => {
  it('includes hidden paths and empty directories but excludes .git metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-file-mention-index-'))
    try {
      await mkdir(join(root, '.hidden'), { recursive: true })
      await mkdir(join(root, '.git'), { recursive: true })
      await mkdir(join(root, 'empty-dir'), { recursive: true })
      await writeFile(join(root, '.hidden', 'config.ts'), 'export {}')
      await writeFile(join(root, '.git', 'config'), '[core]')

      const entries = await walkWorkspaceFilesFallback(root, new AbortController().signal)
      expect(entries).toEqual(expect.arrayContaining([
        { path: '.hidden/', isDirectory: true },
        { path: '.hidden/config.ts', isDirectory: false },
        { path: 'empty-dir/', isDirectory: true }
      ]))
      expect(entries.some((entry) => entry.path.includes('.git'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
