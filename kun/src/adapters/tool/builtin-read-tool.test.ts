import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import './local-tool-host.js'
import { createReadLocalTool } from './builtin-read-tool.js'

describe('read input bounds', () => {
  it('rejects an oversized file before calling readFile', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-read-bound-'))
    try {
      await writeFile(join(workspace, 'large.txt'), '0123456789', 'utf8')
      const readFile = vi.fn()
      const tool = createReadLocalTool({
        maxFileBytes: 8,
        operations: { readFile }
      })

      const result = await tool.execute(
        { path: 'large.txt' },
        {
          workspace,
          threadId: 'thr_read_bound',
          turnId: 'turn_read_bound',
          approvalPolicy: 'auto',
          sandboxMode: 'workspace-write',
          abortSignal: new AbortController().signal,
          awaitApproval: async () => 'deny'
        }
      )

      expect(result.isError).toBe(true)
      expect(result.output).toMatchObject({
        code: 'file_too_large',
        byte_size: 10,
        max_file_bytes: 8
      })
      expect(readFile).not.toHaveBeenCalled()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

describe('read source pages', () => {
  it('returns a contiguous budgeted page with a continuation revision', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-read-page-'))
    try {
      await writeFile(join(workspace, 'large.txt'), Array.from({ length: 20 }, (_, i) => `${i + 1}:${'x'.repeat(80)}`).join('\n'))
      const result = await createReadLocalTool().execute(
        { path: 'large.txt' },
        { workspace, threadId: 'thr', turnId: 'turn', approvalPolicy: 'auto', sandboxMode: 'workspace-write', sourceResultBudgetTokens: 8, abortSignal: new AbortController().signal, awaitApproval: async () => 'allow' }
      )
      expect(result.output).toMatchObject({ start_line: 1, has_more: true, truncated: true, next_offset: expect.any(Number), revision: expect.any(String) })
      const output = result.output as Record<string, unknown>
      expect(String(output.content)).toContain('1:')
      expect(String(output.content)).not.toContain('20:')
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('rejects a continuation after the file revision changes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-read-revision-'))
    try {
      const path = join(workspace, 'file.txt')
      await writeFile(path, 'one\ntwo')
      const tool = createReadLocalTool()
      const first = await tool.execute({ path: 'file.txt' }, { workspace, threadId: 'thr', turnId: 'turn', approvalPolicy: 'auto', sandboxMode: 'workspace-write', abortSignal: new AbortController().signal, awaitApproval: async () => 'allow' })
      const revision = (first.output as Record<string, unknown>).revision as string
      await writeFile(path, 'one\ntwo\nthree')
      const next = await tool.execute({ path: 'file.txt', offset: 2, expected_revision: revision }, { workspace, threadId: 'thr', turnId: 'turn', approvalPolicy: 'auto', sandboxMode: 'workspace-write', abortSignal: new AbortController().signal, awaitApproval: async () => 'allow' })
      expect(next.isError).toBe(true)
      expect(next.output).toMatchObject({ code: 'file_revision_mismatch' })
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })
})
