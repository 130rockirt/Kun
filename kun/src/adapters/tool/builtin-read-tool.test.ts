import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import './local-tool-host.js'
import { createReadLocalTool } from './builtin-read-tool.js'
import { FAST_CONTEXT_READ_MAX_FILE_BYTES, FAST_CONTEXT_SEARCH_MAX_OUTPUT_BYTES } from './builtin-tool-types.js'

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

  it('clamps only Fast Context reads to 200 lines', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-read-fast-context-'))
    try {
      await writeFile(join(workspace, 'lines.txt'), Array.from({ length: 260 }, (_, index) => `line ${index + 1}`).join('\n'))
      const tool = createReadLocalTool()
      const ordinary = await tool.execute(
        { path: 'lines.txt', limit: 250 },
        { workspace, threadId: 'ordinary', turnId: 'ordinary', approvalPolicy: 'auto', sandboxMode: 'workspace-write', abortSignal: new AbortController().signal, awaitApproval: async () => 'allow' }
      )
      const bounded = await tool.execute(
        { path: 'lines.txt', limit: 250 },
        { workspace, threadId: 'fast', turnId: 'fast', approvalPolicy: 'auto', sandboxMode: 'workspace-write', fastContext: true, abortSignal: new AbortController().signal, awaitApproval: async () => 'allow' }
      )
      expect(ordinary.output).toMatchObject({ end_line: 250, next_offset: 251 })
      expect(bounded.output).toMatchObject({ end_line: 200, next_offset: 201, truncation_by: 'requested_limit' })
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })
})

describe('Fast Context read safety boundaries', () => {
  const context = (workspace: string, fastContext = true, sourceResultBudgetTokens?: number) => ({
    workspace,
    threadId: 'fast_context_read',
    turnId: 'fast_context_read',
    approvalPolicy: 'auto' as const,
    sandboxMode: 'workspace-write' as const,
    ...(fastContext ? { fastContext: true } : {}),
    ...(sourceResultBudgetTokens === undefined ? {} : { sourceResultBudgetTokens }),
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow' as const
  })

  it('rejects a large Fast Context file before readFile or a full line traversal', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-read-fast-size-'))
    try {
      await writeFile(join(workspace, 'large.txt'), Buffer.alloc(FAST_CONTEXT_READ_MAX_FILE_BYTES + 1, 'x'))
      const readFile = vi.fn()
      const result = await createReadLocalTool({ operations: { readFile } }).execute(
        { path: 'large.txt' },
        context(workspace)
      )

      expect(result.isError).toBe(true)
      expect(result.output).toMatchObject({
        code: 'fast_context_file_too_large',
        max_file_bytes: FAST_CONTEXT_READ_MAX_FILE_BYTES,
        fast_context: true
      })
      expect(readFile).not.toHaveBeenCalled()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('does not read Fast Context excluded directories', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-read-fast-excluded-'))
    try {
      const file = join(workspace, 'node_modules', 'pkg', 'index.ts')
      await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true })
      await writeFile(file, 'secret')
      const readFile = vi.fn()
      const result = await createReadLocalTool({ operations: { readFile } }).execute(
        { path: 'node_modules/pkg/index.ts' },
        context(workspace)
      )

      expect(result.isError).toBe(true)
      expect(result.output).toMatchObject({ code: 'fast_context_path_excluded', fast_context: true })
      expect(readFile).not.toHaveBeenCalled()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('returns image metadata without base64 while preserving ordinary image reads', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-read-fast-image-'))
    try {
      const png = Buffer.alloc(24)
      png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      png.writeUInt32BE(20, 16)
      png.writeUInt32BE(10, 20)
      await writeFile(join(workspace, 'image.png'), png)
      const tool = createReadLocalTool({ autoResizeImages: false })

      const fast = await tool.execute({ path: 'image.png' }, context(workspace))
      const regular = await tool.execute({ path: 'image.png' }, context(workspace, false))
      expect(fast.output).toMatchObject({
        kind: 'image',
        mime_type: 'image/png',
        data_omitted: true,
        fast_context: true
      })
      expect(fast.output as Record<string, unknown>).not.toHaveProperty('data_base64')
      expect(regular.output as Record<string, unknown>).toHaveProperty('data_base64')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('rejects binary Fast Context reads without returning binary data', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-read-fast-binary-'))
    try {
      await writeFile(join(workspace, 'payload.bin'), Buffer.from([0x61, 0, 0x62]))
      const result = await createReadLocalTool().execute({ path: 'payload.bin' }, context(workspace))

      expect(result.isError).toBe(true)
      expect(result.output).toMatchObject({ code: 'fast_context_binary_omitted', fast_context: true })
      expect(result.output as Record<string, unknown>).not.toHaveProperty('data_base64')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('caps Fast Context text output below the shared 512 KiB result budget', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-read-fast-output-'))
    try {
      const line = '\\\\"'.repeat(8_192)
      await writeFile(join(workspace, 'escaped.txt'), Array.from({ length: 12 }, () => line).join('\n'))
      const result = await createReadLocalTool().execute(
        { path: 'escaped.txt', limit: 200 },
        context(workspace, true, 1_000_000)
      )
      const output = result.output as Record<string, unknown>

      expect(output).toMatchObject({ fast_context: true, truncated: true, has_more: true })
      expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThanOrEqual(FAST_CONTEXT_SEARCH_MAX_OUTPUT_BYTES)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
