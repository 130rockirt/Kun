import { link, mkdtemp, mkdir, open, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LocalToolHost, echoTool, userInputTool } from './local-tool-host.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { InMemoryArtifactStore } from '../../artifacts/artifact-store.js'
import { createEditLocalTool, createWriteLocalTool } from './builtin-file-tools.js'
import { resolveWorkspacePath, withToolBoundary } from './builtin-tool-utils.js'

describe('LocalToolHost approval policy', () => {
  it('asks before auto tools when approval policy is always', async () => {
    const host = new LocalToolHost({ tools: [echoTool] })
    const awaitApproval = vi.fn(async () => 'allow' as const)
    const result = await host.execute(
      {
        callId: 'call_1',
        toolName: 'echo',
        arguments: { text: 'hello' }
      },
      {
        threadId: 'thread_1',
        turnId: 'turn_1',
        workspace: '/tmp/workspace',
        approvalPolicy: 'always',
        sandboxMode: 'danger-full-access',
        abortSignal: new AbortController().signal,
        awaitApproval
      } satisfies ToolHostContext
    )

    expect(awaitApproval).toHaveBeenCalledTimes(1)
    expect(result.approved).toBe(false)
  })

  it('returns a model-visible error tool result when approval is denied', async () => {
    const host = new LocalToolHost({ tools: [echoTool] })
    const result = await host.execute(
      { callId: 'call_denied', toolName: 'echo', arguments: { text: 'hello' } },
      {
        threadId: 'thread_1',
        turnId: 'turn_1',
        workspace: '/tmp/workspace',
        approvalPolicy: 'always',
        sandboxMode: 'danger-full-access',
        abortSignal: new AbortController().signal,
        awaitApproval: async () => ({
          decision: 'deny' as const,
          reason: 'Command is not expected here'
        })
      } satisfies ToolHostContext
    )

    expect(result.item).toMatchObject({
      kind: 'tool_result',
      callId: 'call_denied',
      isError: true,
      output: {
        code: 'approval_denied',
        approvalId: expect.stringMatching(/^appr_[a-f0-9]{32}$/),
        reason: 'Command is not expected here'
      }
    })
  })

  it('uses fresh approval ids when providers reuse call ids', async () => {
    const host = new LocalToolHost({ tools: [echoTool] })
    const approvalIds: string[] = []
    const execute = (threadId: string, turnId: string) => host.execute(
      { callId: 'shared_call_id', toolName: 'echo', arguments: { text: 'blocked' } },
      {
        threadId,
        turnId,
        workspace: '/tmp/workspace',
        approvalPolicy: 'always' as const,
        sandboxMode: 'danger-full-access' as const,
        abortSignal: new AbortController().signal,
        awaitApproval: async (approval) => {
          approvalIds.push(approval.id)
          return 'deny' as const
        }
      }
    )

    await Promise.all([
      execute('thread_a', 'turn_a'),
      execute('thread_b', 'turn_b'),
      execute('thread_a', 'turn_a')
    ])
    expect(approvalIds).toHaveLength(3)
    expect(new Set(approvalIds).size).toBe(3)
  })

  it('offloads oversized successful tool output to the artifact store', async () => {
    const artifactStore = new InMemoryArtifactStore()
    const host = new LocalToolHost({ tools: [LocalToolHost.defineTool({
      name: 'large_output',
      description: 'returns a large payload',
      inputSchema: { type: 'object' },
      execute: async () => ({ output: 'x'.repeat(140 * 1024) })
    })] })
    const result = await host.execute(
      { callId: 'call_large', toolName: 'large_output', arguments: {} },
      {
        threadId: 'thread_1',
        turnId: 'turn_1',
        workspace: '/tmp/workspace',
        approvalPolicy: 'auto',
        sandboxMode: 'danger-full-access',
        artifactStore,
        abortSignal: new AbortController().signal,
        awaitApproval: vi.fn(async () => 'allow' as const)
      }
    )
    expect(result.item).toMatchObject({
      kind: 'tool_result',
      output: { artifactId: expect.stringMatching(/^art_/), truncated: true }
    })
    if (result.item.kind !== 'tool_result') throw new Error('expected tool result')
    const artifactId = String((result.item.output as Record<string, unknown>).artifactId)
    expect(await artifactStore.get(artifactId)).toHaveLength(140 * 1024)
  })

  it('runs workspace file-change tools without approval when policy is auto', async () => {
    const awaitApproval = vi.fn(async () => 'allow' as const)
    const host = new LocalToolHost({ tools: [LocalToolHost.defineTool({
      name: 'touch_workspace_file',
      description: 'simulates a workspace file change',
      inputSchema: { type: 'object' },
      toolKind: 'file_change',
      policy: 'on-request',
      execute: async () => ({ output: { ok: true } })
    })] })

    const result = await host.execute(
      { callId: 'call_write', toolName: 'touch_workspace_file', arguments: {} },
      {
        threadId: 'thread_1',
        turnId: 'turn_1',
        workspace: '/tmp/workspace',
        approvalPolicy: 'auto',
        sandboxMode: 'workspace-write',
        abortSignal: new AbortController().signal,
        awaitApproval
      }
    )

    expect(awaitApproval).not.toHaveBeenCalled()
    expect(result.approved).toBe(true)
    expect(result.item).toMatchObject({
      kind: 'tool_result',
      toolName: 'touch_workspace_file',
      output: { ok: true }
    })
  })

  it('writes one exact external target after a per-call approval without mutating the turn context', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kun-external-write-'))
    const workspace = join(parent, 'workspace')
    const externalDirectory = join(parent, 'external')
    const target = join(externalDirectory, 'approved.txt')
    try {
      await Promise.all([mkdir(workspace), mkdir(externalDirectory)])
      await writeFile(target, 'original')
      const physicalTarget = await realpath(target)
      const awaitApproval = vi.fn(async () => 'allow' as const)
      const context = {
        threadId: 'thread_external_write',
        turnId: 'turn_external_write',
        workspace,
        approvalPolicy: 'auto',
        sandboxMode: 'workspace-write',
        abortSignal: new AbortController().signal,
        awaitApproval
      } satisfies ToolHostContext
      const host = new LocalToolHost({ tools: [createWriteLocalTool()] })

      const result = await host.execute(
        {
          callId: 'call_external_write',
          toolName: 'write',
          arguments: { path: target, content: 'approved' }
        },
        context
      )

      expect(awaitApproval).toHaveBeenCalledOnce()
      expect(awaitApproval).toHaveBeenCalledWith(expect.objectContaining({
        summary: expect.stringContaining(physicalTarget)
      }))
      expect(result.item).toMatchObject({ isError: false })
      expect(context).not.toHaveProperty('approvedExternalWriteTargets')
      await expect(readFile(target, 'utf8')).resolves.toBe('approved')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('rejects an existing external hard-link alias before approval', async (testContext) => {
    const parent = await mkdtemp(join(tmpdir(), 'kun-external-hardlink-existing-'))
    const workspace = join(parent, 'workspace')
    const target = join(parent, 'target.txt')
    const alias = join(parent, 'alias.txt')
    const awaitApproval = vi.fn(async () => 'allow' as const)
    try {
      await mkdir(workspace)
      await writeFile(target, 'original')
      try {
        await link(target, alias)
      } catch {
        testContext.skip()
        return
      }
      const host = new LocalToolHost({ tools: [createWriteLocalTool()] })
      const result = await host.execute(
        {
          callId: 'call_external_hardlink_existing',
          toolName: 'write',
          arguments: { path: target, content: 'must not be written' }
        },
        {
          threadId: 'thread_external_hardlink_existing',
          turnId: 'turn_external_hardlink_existing',
          workspace,
          approvalPolicy: 'auto',
          sandboxMode: 'workspace-write',
          abortSignal: new AbortController().signal,
          awaitApproval
        }
      )

      expect(awaitApproval).not.toHaveBeenCalled()
      expect(result.item).toMatchObject({
        isError: true,
        output: { error: expect.stringContaining('exactly one hard link') }
      })
      await expect(readFile(target, 'utf8')).resolves.toBe('original')
      await expect(readFile(alias, 'utf8')).resolves.toBe('original')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('rejects a hard-link alias added after approval but before open', async (testContext) => {
    const parent = await mkdtemp(join(tmpdir(), 'kun-external-hardlink-race-'))
    const workspace = join(parent, 'workspace')
    const target = join(parent, 'target.txt')
    const alias = join(parent, 'alias.txt')
    let hardlinkError: unknown
    try {
      await mkdir(workspace)
      await writeFile(target, 'original')
      const openExternal = vi.fn(async (path: string, flags: number) => {
        try {
          await link(target, alias)
        } catch (error) {
          hardlinkError = error
          throw error
        }
        return open(path, flags)
      })
      const host = new LocalToolHost({ tools: [createWriteLocalTool({
        operations: { openExternal }
      })] })
      const result = await host.execute(
        {
          callId: 'call_external_hardlink_race',
          toolName: 'write',
          arguments: { path: target, content: 'must not be written' }
        },
        {
          threadId: 'thread_external_hardlink_race',
          turnId: 'turn_external_hardlink_race',
          workspace,
          approvalPolicy: 'auto',
          sandboxMode: 'workspace-write',
          abortSignal: new AbortController().signal,
          awaitApproval: vi.fn(async () => 'allow' as const)
        }
      )

      if (hardlinkError) {
        testContext.skip()
        return
      }
      expect(openExternal).toHaveBeenCalledOnce()
      expect(result.item).toMatchObject({
        isError: true,
        output: { error: expect.stringContaining('exactly one hard link') }
      })
      await expect(readFile(target, 'utf8')).resolves.toBe('original')
      await expect(readFile(alias, 'utf8')).resolves.toBe('original')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('does not expand an external grant to a sibling or an enforced workspace boundary', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kun-external-exact-'))
    const workspace = join(parent, 'workspace')
    const approvedTarget = join(parent, 'approved.txt')
    const siblingTarget = join(parent, 'sibling.txt')
    try {
      await mkdir(workspace)
      await writeFile(approvedTarget, 'existing')
      const physicalParent = await realpath(parent)
      const physicalApprovedTarget = join(physicalParent, 'approved.txt')
      const execute = vi.fn(async (_args: Record<string, unknown>, context: ToolHostContext) => {
        await expect(resolveWorkspacePath(approvedTarget, context)).resolves.toMatchObject({
          absolutePath: physicalApprovedTarget
        })
        await expect(resolveWorkspacePath(siblingTarget, context)).rejects.toThrow(/escapes the workspace root/)
        await expect(resolveWorkspacePath(approvedTarget, context, {
          enforceWorkspaceBoundary: true
        })).rejects.toThrow(/escapes the workspace root/)
        return { output: { ok: true } }
      })
      const host = new LocalToolHost({ tools: [LocalToolHost.defineTool({
        name: 'exact_external_write',
        description: 'exercise exact external grants',
        inputSchema: { type: 'object' },
        toolKind: 'file_change',
        policy: 'auto',
        externalWritePathArguments: ['path'],
        execute
      })] })

      const result = await host.execute(
        {
          callId: 'call_exact_external_write',
          toolName: 'exact_external_write',
          arguments: { path: approvedTarget }
        },
        {
          threadId: 'thread_exact_external_write',
          turnId: 'turn_exact_external_write',
          workspace,
          approvalPolicy: 'auto',
          sandboxMode: 'workspace-write',
          abortSignal: new AbortController().signal,
          awaitApproval: vi.fn(async () => 'allow' as const)
        }
      )

      expect(execute).toHaveBeenCalledOnce()
      expect(result.item).toMatchObject({ output: { ok: true } })
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('does not request approval or write when the workspace root is missing', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kun-external-missing-workspace-'))
    const target = join(parent, 'outside.txt')
    const awaitApproval = vi.fn(async () => 'allow' as const)
    try {
      const host = new LocalToolHost({ tools: [createWriteLocalTool()] })
      const result = await host.execute(
        {
          callId: 'call_missing_workspace',
          toolName: 'write',
          arguments: { path: target, content: 'must not be written' }
        },
        {
          threadId: 'thread_missing_workspace',
          turnId: 'turn_missing_workspace',
          workspace: join(parent, 'missing-workspace'),
          approvalPolicy: 'auto',
          sandboxMode: 'workspace-write',
          abortSignal: new AbortController().signal,
          awaitApproval
        }
      )

      expect(awaitApproval).not.toHaveBeenCalled()
      expect(result.item).toMatchObject({
        isError: true,
        output: {
          code: 'sandbox_write_blocked',
          error: expect.stringContaining('workspace root does not exist')
        }
      })
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('does not execute an external write when the per-call approval is denied', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kun-external-denied-'))
    const workspace = join(parent, 'workspace')
    const target = join(parent, 'denied.txt')
    try {
      await mkdir(workspace)
      await writeFile(target, 'original')
      const host = new LocalToolHost({ tools: [createWriteLocalTool()] })
      const result = await host.execute(
        {
          callId: 'call_external_denied',
          toolName: 'write',
          arguments: { path: target, content: 'must not be written' }
        },
        {
          threadId: 'thread_external_denied',
          turnId: 'turn_external_denied',
          workspace,
          approvalPolicy: 'auto',
          sandboxMode: 'workspace-write',
          abortSignal: new AbortController().signal,
          awaitApproval: vi.fn(async () => ({ decision: 'deny' as const, reason: 'not this path' }))
        }
      )

      expect(result.item).toMatchObject({
        isError: true,
        output: { code: 'approval_denied', reason: 'not this path' }
      })
      await expect(readFile(target, 'utf8')).resolves.toBe('original')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('fails closed without prompting when an external write would create a file', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kun-external-create-blocked-'))
    const workspace = join(parent, 'workspace')
    const target = join(parent, 'new-file.txt')
    const awaitApproval = vi.fn(async () => 'allow' as const)
    try {
      await mkdir(workspace)
      const host = new LocalToolHost({ tools: [createWriteLocalTool()] })
      const result = await host.execute(
        {
          callId: 'call_external_create_blocked',
          toolName: 'write',
          arguments: { path: target, content: 'must not be created' }
        },
        {
          threadId: 'thread_external_create_blocked',
          turnId: 'turn_external_create_blocked',
          workspace,
          approvalPolicy: 'auto',
          sandboxMode: 'workspace-write',
          abortSignal: new AbortController().signal,
          awaitApproval
        }
      )

      expect(awaitApproval).not.toHaveBeenCalled()
      expect(result.item).toMatchObject({
        isError: true,
        output: { error: expect.stringContaining('requires an existing regular file') }
      })
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('rejects a parent-directory swap after write validation without touching the redirected file', async (testContext) => {
    const parent = await mkdtemp(join(tmpdir(), 'kun-external-write-race-'))
    const workspace = join(parent, 'workspace')
    const approvedDirectory = join(parent, 'approved')
    const displacedDirectory = join(parent, 'displaced')
    const protectedDirectory = join(parent, 'protected')
    const target = join(approvedDirectory, 'target.txt')
    const protectedTarget = join(protectedDirectory, 'target.txt')
    let symlinkError: unknown
    try {
      await Promise.all([mkdir(workspace), mkdir(approvedDirectory), mkdir(protectedDirectory)])
      await Promise.all([writeFile(target, 'approved-original'), writeFile(protectedTarget, 'protected')])
      const openExternal = vi.fn(async (path: string, flags: number) => {
        await rename(approvedDirectory, displacedDirectory)
        try {
          await symlink(
            protectedDirectory,
            approvedDirectory,
            process.platform === 'win32' ? 'junction' : 'dir'
          )
        } catch (error) {
          symlinkError = error
          throw error
        }
        return open(path, flags)
      })
      const host = new LocalToolHost({ tools: [createWriteLocalTool({
        operations: { openExternal }
      })] })

      const result = await host.execute(
        {
          callId: 'call_external_write_race',
          toolName: 'write',
          arguments: { path: target, content: 'overwrite' }
        },
        {
          threadId: 'thread_external_write_race',
          turnId: 'turn_external_write_race',
          workspace,
          approvalPolicy: 'auto',
          sandboxMode: 'workspace-write',
          abortSignal: new AbortController().signal,
          awaitApproval: vi.fn(async () => 'allow' as const)
        }
      )

      if (symlinkError) {
        testContext.skip()
        return
      }
      expect(openExternal).toHaveBeenCalledOnce()
      expect(result.item).toMatchObject({
        isError: true,
        output: { error: expect.stringContaining('approved external file changed before execution') }
      })
      await expect(readFile(protectedTarget, 'utf8')).resolves.toBe('protected')
      await expect(readFile(join(displacedDirectory, 'target.txt'), 'utf8')).resolves.toBe('approved-original')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('rejects edit when the parent is swapped after open but before identity verification', async (testContext) => {
    const parent = await mkdtemp(join(tmpdir(), 'kun-external-edit-race-'))
    const workspace = join(parent, 'workspace')
    const approvedDirectory = join(parent, 'approved')
    const displacedDirectory = join(parent, 'displaced')
    const protectedDirectory = join(parent, 'protected')
    const target = join(approvedDirectory, 'target.txt')
    const protectedTarget = join(protectedDirectory, 'target.txt')
    let symlinkError: unknown
    try {
      await Promise.all([mkdir(workspace), mkdir(approvedDirectory), mkdir(protectedDirectory)])
      await Promise.all([writeFile(target, 'alpha'), writeFile(protectedTarget, 'alpha')])
      const openExternal = vi.fn(async (path: string, flags: number) => {
        const handle = await open(path, flags)
        await rename(approvedDirectory, displacedDirectory)
        try {
          await symlink(
            protectedDirectory,
            approvedDirectory,
            process.platform === 'win32' ? 'junction' : 'dir'
          )
        } catch (error) {
          symlinkError = error
          await handle.close()
          throw error
        }
        return handle
      })
      const host = new LocalToolHost({ tools: [createEditLocalTool({
        operations: { openExternal }
      })] })

      const result = await host.execute(
        {
          callId: 'call_external_edit_race',
          toolName: 'edit',
          arguments: { path: target, oldText: 'alpha', newText: 'changed' }
        },
        {
          threadId: 'thread_external_edit_race',
          turnId: 'turn_external_edit_race',
          workspace,
          approvalPolicy: 'auto',
          sandboxMode: 'workspace-write',
          abortSignal: new AbortController().signal,
          awaitApproval: vi.fn(async () => 'allow' as const)
        }
      )

      if (symlinkError) {
        testContext.skip()
        return
      }
      expect(openExternal).toHaveBeenCalledOnce()
      expect(result.item).toMatchObject({
        isError: true,
        output: { error: expect.stringContaining('approved external file parent changed before execution') }
      })
      await expect(readFile(protectedTarget, 'utf8')).resolves.toBe('alpha')
      await expect(readFile(join(displacedDirectory, 'target.txt'), 'utf8')).resolves.toBe('alpha')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('preserves read-before-edit enforcement for approved external files', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kun-external-edit-read-guard-'))
    const workspace = join(parent, 'workspace')
    const target = join(parent, 'external.txt')
    const awaitApproval = vi.fn(async () => 'allow' as const)
    try {
      await mkdir(workspace)
      await writeFile(target, 'alpha')
      const host = new LocalToolHost({ tools: [createEditLocalTool()], readTracker: true })
      const result = await host.execute(
        {
          callId: 'call_external_edit_read_guard',
          toolName: 'edit',
          arguments: { path: target, oldText: 'alpha', newText: 'changed' }
        },
        {
          threadId: 'thread_external_edit_read_guard',
          turnId: 'turn_external_edit_read_guard',
          workspace,
          approvalPolicy: 'auto',
          sandboxMode: 'workspace-write',
          abortSignal: new AbortController().signal,
          awaitApproval
        }
      )

      expect(awaitApproval).not.toHaveBeenCalled()
      expect(result.item).toMatchObject({
        isError: true,
        output: { code: 'read_before_edit_required' }
      })
      await expect(readFile(target, 'utf8')).resolves.toBe('alpha')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('edits an existing external file through the verified handle', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kun-external-edit-handle-'))
    const workspace = join(parent, 'workspace')
    const target = join(parent, 'external.txt')
    try {
      await mkdir(workspace)
      await writeFile(target, 'alpha beta')
      const host = new LocalToolHost({ tools: [createEditLocalTool()] })
      const result = await host.execute(
        {
          callId: 'call_external_edit_handle',
          toolName: 'edit',
          arguments: { path: target, oldText: 'alpha', newText: 'changed' }
        },
        {
          threadId: 'thread_external_edit_handle',
          turnId: 'turn_external_edit_handle',
          workspace,
          approvalPolicy: 'auto',
          sandboxMode: 'workspace-write',
          abortSignal: new AbortController().signal,
          awaitApproval: vi.fn(async () => 'allow' as const)
        }
      )

      expect(result.item).toMatchObject({ isError: false })
      await expect(readFile(target, 'utf8')).resolves.toBe('changed beta')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('rejects an approved target redirected by a symlink before execution', async (testContext) => {
    const parent = await mkdtemp(join(tmpdir(), 'kun-external-symlink-'))
    const workspace = join(parent, 'workspace')
    const approvedDirectory = join(parent, 'approved')
    const protectedDirectory = join(parent, 'protected')
    const target = join(approvedDirectory, 'target.txt')
    const protectedTarget = join(protectedDirectory, 'target.txt')
    let symlinkError: unknown
    try {
      await Promise.all([
        mkdir(workspace),
        mkdir(approvedDirectory),
        mkdir(protectedDirectory)
      ])
      await Promise.all([
        writeFile(target, 'original'),
        writeFile(protectedTarget, 'must survive')
      ])
      const host = new LocalToolHost({ tools: [createWriteLocalTool()] })
      const result = await host.execute(
        {
          callId: 'call_external_symlink_swap',
          toolName: 'write',
          arguments: { path: target, content: 'overwrite' }
        },
        {
          threadId: 'thread_external_symlink_swap',
          turnId: 'turn_external_symlink_swap',
          workspace,
          approvalPolicy: 'auto',
          sandboxMode: 'workspace-write',
          abortSignal: new AbortController().signal,
          awaitApproval: async () => {
            await rm(approvedDirectory, { recursive: true, force: true })
            try {
              await symlink(
                protectedDirectory,
                approvedDirectory,
                process.platform === 'win32' ? 'junction' : 'dir'
              )
            } catch (error) {
              symlinkError = error
              return 'deny'
            }
            return 'allow'
          }
        }
      )

      if (symlinkError) {
        testContext.skip()
        return
      }
      expect(result.item).toMatchObject({
        isError: true,
        output: { error: expect.stringContaining('path escapes the workspace root') }
      })
      await expect(readFile(protectedTarget, 'utf8')).resolves.toBe('must survive')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('strips caller-supplied external grants before tool execution', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kun-external-forged-'))
    const workspace = join(parent, 'workspace')
    const target = join(parent, 'forged.txt')
    try {
      await mkdir(workspace)
      const host = new LocalToolHost({ tools: [LocalToolHost.defineTool({
        name: 'ungranted_write',
        description: 'must not inherit an external grant',
        inputSchema: { type: 'object' },
        toolKind: 'file_change',
        policy: 'auto',
        execute: async (_args, context) => withToolBoundary(async () => {
          await resolveWorkspacePath(target, context)
          return { output: { ok: true } }
        })
      })] })

      const result = await host.execute(
        { callId: 'call_forged_external_grant', toolName: 'ungranted_write', arguments: {} },
        {
          threadId: 'thread_forged_external_grant',
          turnId: 'turn_forged_external_grant',
          workspace,
          approvalPolicy: 'auto',
          sandboxMode: 'workspace-write',
          approvedExternalWriteTargets: [{
            path: target,
            device: 1n,
            inode: 1n,
            parentDevice: 1n,
            parentInode: 1n
          }],
          abortSignal: new AbortController().signal,
          awaitApproval: vi.fn(async () => 'allow' as const)
        }
      )

      expect(result.item).toMatchObject({
        isError: true,
        output: { error: expect.stringContaining('path escapes the workspace root') }
      })
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('keeps user input tools advertised without a GUI gate but rejects execution', async () => {
    const host = new LocalToolHost({ tools: [echoTool, userInputTool] })
    const context = {
      threadId: 'thread_1',
      turnId: 'turn_1',
      workspace: '/tmp/workspace',
      approvalPolicy: 'auto',
      sandboxMode: 'workspace-write',
      abortSignal: new AbortController().signal,
      awaitApproval: vi.fn(async () => 'allow' as const)
    } satisfies ToolHostContext

    await expect(host.listTools(context)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'user_input' })])
    )
    const result = await host.execute(
      {
        callId: 'call_input',
        toolName: 'user_input',
        arguments: { question: 'Continue?' }
      },
      context
    )

    expect(result.item).toMatchObject({
      kind: 'tool_result',
      toolName: 'user_input',
      isError: true,
      output: { error: 'GUI user input is not available in this runtime context' }
    })
  })

  it('normalizes structured multi-select user input questions', async () => {
    const host = new LocalToolHost({ tools: [userInputTool] })
    const captured: Parameters<NonNullable<ToolHostContext['awaitUserInput']>>[0][] = []
    const context = {
      threadId: 'thread_1',
      turnId: 'turn_1',
      workspace: '/tmp/workspace',
      approvalPolicy: 'auto',
      sandboxMode: 'workspace-write',
      abortSignal: new AbortController().signal,
      awaitApproval: vi.fn(async () => 'allow' as const),
      awaitUserInput: vi.fn(async (input) => {
        captured.push(input)
        return { status: 'submitted' as const, answers: [] }
      })
    } satisfies ToolHostContext

    await host.execute(
      {
        callId: 'call_input_multi',
        toolName: 'user_input',
        arguments: {
          questions: [
            {
              id: 'requirements',
              question: 'Pick requirements',
              options: ['Keep ratio', 'App icon', 'Redesign outline'],
              selectionMode: 'multiple',
              minSelections: 4,
              maxSelections: 2
            }
          ]
        }
      },
      context
    )

    expect(captured[0]?.questions).toEqual([
      {
        header: 'Question 1',
        id: 'requirements',
        question: 'Pick requirements',
        options: [
          { label: 'Keep ratio', description: '' },
          { label: 'App icon', description: '' },
          { label: 'Redesign outline', description: '' }
        ],
        selectionMode: 'multiple',
        minSelections: 2,
        maxSelections: 2
      }
    ])
  })
})
