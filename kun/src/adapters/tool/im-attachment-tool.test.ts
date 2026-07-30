import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { createSendImAttachmentLocalTool } from './im-attachment-tool.js'
import { LocalToolHost } from './local-tool-host.js'

function baseContext(workspace: string, imContext: boolean): ToolHostContext {
  return {
    threadId: 'thr_1',
    turnId: 'turn_1',
    workspace,
    imContext,
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    abortSignal: new AbortController().signal,
    awaitApproval: vi.fn(async () => 'allow' as const)
  }
}

describe('send_im_attachment tool', () => {
  it('keeps a stable tool catalog and returns attachment file metadata for IM turns', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kun-im-attachment-tool-'))
    const dir = join(workspaceRoot, 'out')
    const filePath = join(dir, 'hello.txt')
    await mkdir(dir, { recursive: true })
    await writeFile(filePath, 'hello')
    try {
      const host = new LocalToolHost({ tools: [createSendImAttachmentLocalTool()] })
      expect(createSendImAttachmentLocalTool()).toMatchObject({
        policy: 'on-request',
        toolKind: 'tool_call',
        requiresExplicitApproval: true
      })

      await expect(host.listTools(baseContext(workspaceRoot, true)))
        .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'send_im_attachment' })]))
      await expect(host.listTools(baseContext(workspaceRoot, false)))
        .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'send_im_attachment' })]))

      const context = baseContext(workspaceRoot, true)
      const result = await host.execute(
        {
          callId: 'call_attachment',
          toolName: 'send_im_attachment',
          arguments: { path: 'out/hello.txt' }
        },
        context
      )

      expect(context.awaitApproval).toHaveBeenCalledTimes(1)

      expect(result.item).toMatchObject({
        kind: 'tool_result',
        toolName: 'send_im_attachment',
        isError: false,
        output: {
          status: 'queued_for_im_attachment_delivery',
          files: [
            {
              relativePath: 'out/hello.txt',
              fileName: 'hello.txt',
              bytes: 5
            }
          ]
        }
      })
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rejects execution outside IM turns while keeping the schema advertised', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kun-im-attachment-tool-'))
    const filePath = join(workspaceRoot, 'hello.txt')
    await writeFile(filePath, 'hello')
    try {
      const host = new LocalToolHost({ tools: [createSendImAttachmentLocalTool()] })
      const result = await host.execute(
        {
          callId: 'call_attachment_non_im',
          toolName: 'send_im_attachment',
          arguments: { path: 'hello.txt' }
        },
        baseContext(workspaceRoot, false)
      )

      expect(result.item).toMatchObject({
        kind: 'tool_result',
        toolName: 'send_im_attachment',
        isError: true,
        output: { error: 'send_im_attachment is only available for IM turns' }
      })
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rejects files outside the IM workspace', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kun-im-attachment-tool-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'kun-im-attachment-outside-'))
    const outsidePath = join(outsideRoot, 'secret.txt')
    await writeFile(outsidePath, 'secret')
    try {
      const host = new LocalToolHost({ tools: [createSendImAttachmentLocalTool()] })
      const result = await host.execute(
        {
          callId: 'call_attachment_outside',
          toolName: 'send_im_attachment',
          arguments: { path: outsidePath }
        },
        baseContext(workspaceRoot, true)
      )

      expect(result.item).toMatchObject({
        kind: 'tool_result',
        toolName: 'send_im_attachment',
        isError: true,
        output: { error: expect.stringContaining('path escapes the workspace root') }
      })
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('requires an explicit approval in a restricted permission mode', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kun-im-attachment-tool-'))
    await writeFile(join(workspaceRoot, 'report.txt'), 'sensitive report')
    try {
      const host = new LocalToolHost({ tools: [createSendImAttachmentLocalTool()] })
      const context = baseContext(workspaceRoot, true)
      context.awaitApproval = vi.fn(async () => 'deny' as const)

      const result = await host.execute(
        {
          callId: 'call_attachment_denied',
          toolName: 'send_im_attachment',
          arguments: { path: 'report.txt' }
        },
        context
      )

      expect(context.awaitApproval).toHaveBeenCalledTimes(1)
      expect(result.item).toMatchObject({
        kind: 'tool_result',
        toolName: 'send_im_attachment',
        isError: true,
        output: { code: 'approval_denied' }
      })
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
