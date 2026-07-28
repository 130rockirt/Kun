import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import './local-tool-host.js'
import { createFindLocalTool, createGlobLocalTool, createGrepLocalTool } from './builtin-search-tools.js'

describe('grep input bounds', () => {
  it('skips oversized files in the in-process scan fallback', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-grep-bound-'))
    try {
      await writeFile(join(workspace, 'large.txt'), 'needle here\n', 'utf8')
      const tool = createGrepLocalTool({
        rgExecutableCandidates: [],
        maxFileBytes: 8,
        maxTotalBytes: 16
      })

      const result = await tool.execute(
        { pattern: 'needle', path: '.' },
        {
          workspace,
          threadId: 'thr_grep_bound',
          turnId: 'turn_grep_bound',
          approvalPolicy: 'auto',
          sandboxMode: 'workspace-write',
          abortSignal: new AbortController().signal,
          awaitApproval: async () => 'deny'
        }
      )

      expect(result.isError).toBeUndefined()
      expect(result.output).toMatchObject({
        backend: 'scan',
        matches: [],
        skipped_large_files: 1,
        scan_byte_limit_reached: false
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

describe('source search pages', () => {
  const context = (workspace: string) => ({ workspace, threadId: 'thr', turnId: 'turn', approvalPolicy: 'auto' as const, sandboxMode: 'workspace-write' as const, sourceResultBudgetTokens: 32, abortSignal: new AbortController().signal, awaitApproval: async () => 'allow' as const })

  it('advertises glob while retaining find as an executable hidden alias', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-glob-page-'))
    try {
      await Promise.all(['a.ts', 'b.ts', 'c.ts'].map((name) => writeFile(join(workspace, name), name)))
      const glob = createGlobLocalTool({ fdExecutableCandidates: [], rgExecutableCandidates: [] })
      const find = createFindLocalTool()
      expect(glob.shouldAdvertise?.(context(workspace))).not.toBe(false)
      expect(find.modelAdvertised).toBe(false)
      const first = await glob.execute({ pattern: '*.ts', limit: 1 }, context(workspace))
      const out = first.output as Record<string, unknown>
      expect(out).toMatchObject({ has_more: true, next_cursor: expect.any(String) })
      const second = await glob.execute({ pattern: '*.ts', limit: 1, cursor: out.next_cursor }, context(workspace))
      expect((second.output as Record<string, unknown>).matches).not.toEqual(out.matches)
      await expect(find.execute({ pattern: '*.ts', limit: 1 }, context(workspace))).resolves.toBeDefined()
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('does not apply the former default file-size skip to grep fallback', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-grep-large-'))
    try {
      await writeFile(join(workspace, 'large.txt'), `needle ${'x'.repeat(64)}`)
      const result = await createGrepLocalTool({ rgExecutableCandidates: [] }).execute({ pattern: 'needle' }, context(workspace))
      expect(result.output).toMatchObject({ matches: [expect.objectContaining({ line: 1 })], skipped_large_files: 0 })
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })
})
