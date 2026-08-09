import { link, mkdtemp, mkdir, open, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { LocalToolHost, echoTool, userInputTool } from '../../src/adapters/tool/local-tool-host.js'

import type { ToolCallLike, ToolHostContext } from '../../src/ports/tool-host.js'

import { InMemoryArtifactStore } from '../../src/artifacts/artifact-store.js'

import { createEditLocalTool, createWriteLocalTool } from '../../src/adapters/tool/builtin-file-tools.js'

import { createReadLocalTool } from '../../src/adapters/tool/builtin-read-tool.js'

import { resolveWorkspacePath, withToolBoundary } from '../../src/adapters/tool/builtin-tool-utils.js'

import { CapabilityRegistry } from '../../src/adapters/tool/capability-registry.js'

import type { HookInvocation } from '../../src/hooks/hook-engine.js'

import type { ApprovalRequest } from '../../src/domain/approval.js'

describe('LocalToolHost approval policy', () => {

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
        action: expect.objectContaining({
          targets: expect.arrayContaining([
            expect.objectContaining({ value: physicalTarget })
          ])
        })
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
    if (process.platform === 'win32') {
      testContext.skip()
      return
    }
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
        output: {
          code: 'read_before_edit_required',
          guidance: expect.stringContaining('fetch the current disk contents'),
          next_action: {
            tool: 'read',
            arguments: { path: target }
          },
          retry_tool: 'edit'
        }
      })
      await expect(readFile(target, 'utf8')).resolves.toBe('alpha')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

it('recovers from an external mutation with a fresh runtime-identified read', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-edit-read-recovery-'))
    const target = join(workspace, 'file.ts')
    const context: ToolHostContext = {
      threadId: 'thread_edit_read_recovery',
      turnId: 'turn_edit_read_recovery',
      workspace,
      approvalPolicy: 'auto',
      sandboxMode: 'workspace-write',
      abortSignal: new AbortController().signal,
      awaitApproval: vi.fn(async () => 'allow' as const)
    }
    try {
      await writeFile(target, 'const value = "before"')
      const host = new LocalToolHost({
        tools: [createReadLocalTool(), createEditLocalTool()],
        readTracker: true
      })

      const firstRead = await host.execute(
        { callId: 'call_tool_1', toolName: 'read', arguments: { path: 'file.ts' } },
        context
      )
      expect(firstRead.item).toMatchObject({
        id: 'item_call_tool_1',
        output: { content: 'const value = "before"' }
      })

      // Simulate a shell or other process mutating the file behind the tracked read.
      await writeFile(target, 'const value = "after-shell"')

      const blockedEdit = await host.execute(
        {
          callId: 'call_tool_2',
          toolName: 'edit',
          arguments: {
            path: 'file.ts',
            oldText: 'const value = "after-shell"',
            newText: 'const value = "fixed"'
          }
        },
        context
      )
      expect(blockedEdit.item).toMatchObject({
        isError: true,
        output: {
          code: 'read_before_edit_required',
          next_action: { tool: 'read', arguments: { path: 'file.ts' } }
        }
      })

      const freshRead = await host.execute(
        { callId: 'call_tool_3', toolName: 'read', arguments: { path: 'file.ts' } },
        context
      )
      expect(freshRead.item).toMatchObject({
        id: 'item_call_tool_3',
        output: { content: 'const value = "after-shell"' }
      })
      expect(freshRead.item.id).not.toBe(firstRead.item.id)

      const successfulEdit = await host.execute(
        {
          callId: 'call_tool_4',
          toolName: 'edit',
          arguments: {
            path: 'file.ts',
            oldText: 'const value = "after-shell"',
            newText: 'const value = "fixed"'
          }
        },
        context
      )
      expect(successfulEdit.item).toMatchObject({
        id: 'item_call_tool_4',
        isError: false
      })
      await expect(readFile(target, 'utf8')).resolves.toBe('const value = "fixed"')
    } finally {
      await rm(workspace, { recursive: true, force: true })
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

})
