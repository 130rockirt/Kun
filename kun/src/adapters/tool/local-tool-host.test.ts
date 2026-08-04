import { link, mkdtemp, mkdir, open, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LocalToolHost, echoTool, userInputTool } from './local-tool-host.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { InMemoryArtifactStore } from '../../artifacts/artifact-store.js'
import { createEditLocalTool, createWriteLocalTool } from './builtin-file-tools.js'
import { createReadLocalTool } from './builtin-read-tool.js'
import { resolveWorkspacePath, withToolBoundary } from './builtin-tool-utils.js'
import { CapabilityRegistry } from './capability-registry.js'

describe('LocalToolHost approval policy', () => {
  it('pins tool registries and hooks for the lifetime of a running turn', async () => {
    const tool = (name: string) => LocalToolHost.defineTool({
      name,
      description: name,
      inputSchema: { type: 'object' },
      policy: 'auto',
      execute: async () => ({ output: name })
    })
    const oldTool = tool('old_tool')
    const newTool = tool('new_tool')
    const host = new LocalToolHost({ tools: [oldTool] })
    const context = (turnId: string): ToolHostContext => ({
      threadId: 'thread_1',
      turnId,
      workspace: '/tmp/workspace',
      approvalPolicy: 'auto',
      sandboxMode: 'danger-full-access',
      abortSignal: new AbortController().signal,
      awaitApproval: vi.fn(async () => 'allow' as const)
    })

    expect((await host.listTools(context('turn_old'))).map((entry) => entry.name)).toEqual(['old_tool'])
    host.replaceRuntimeComponents({
      registry: CapabilityRegistry.fromLocalTools([newTool])
    })
    const oldResult = await host.execute(
      { callId: 'call_old', toolName: 'old_tool', arguments: {} },
      context('turn_old')
    )
    expect(oldResult.item).toMatchObject({ kind: 'tool_result', output: 'old_tool' })
    expect((await host.listTools(context('turn_new'))).map((entry) => entry.name)).toEqual(['new_tool'])
    await expect(host.execute(
      { callId: 'call_missing', toolName: 'old_tool', arguments: {} },
      context('turn_new')
    )).rejects.toThrow(/unknown tool/i)
  })

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

  it.each(['gui', 'tui'] as const)(
    'uses the shared workspace-write command approval policy for %s',
    async (clientSurface) => {
      const execute = vi.fn(async () => ({ output: { ok: true } }))
      const command = LocalToolHost.defineTool({
        name: 'bash',
        description: 'Run a test host command',
        inputSchema: { type: 'object' },
        policy: 'auto',
        toolKind: 'command_execution',
        execute
      })
      const host = new LocalToolHost({ tools: [command] })
      const awaitApproval = vi.fn(async () => 'allow' as const)
      const context = {
        threadId: 'thread_1',
        turnId: `turn_${clientSurface}`,
        workspace: '/tmp/workspace',
        approvalPolicy: 'auto',
        sandboxMode: 'workspace-write',
        clientSurface,
        abortSignal: new AbortController().signal,
        awaitApproval
      } satisfies ToolHostContext

      expect((await host.listTools(context)).map((tool) => tool.name)).toEqual(['bash'])
      const result = await host.execute(
        { callId: `call_${clientSurface}`, toolName: 'bash', arguments: { command: 'pwd' } },
        context
      )

      expect(awaitApproval).toHaveBeenCalledOnce()
      expect(execute).toHaveBeenCalledOnce()
      expect(result.item).toMatchObject({ kind: 'tool_result', output: { ok: true } })
    }
  )

  it('enforces an explicit runtime approval even for an otherwise automatic tool', async () => {
    const execute = vi.fn(async () => ({ output: { ok: true } }))
    const host = new LocalToolHost({
      tools: [LocalToolHost.defineTool({
        name: 'provider_managed_explicit',
        description: 'automatic tool with an additional explicit runtime gate',
        inputSchema: { type: 'object' },
        policy: 'auto',
        requiresExplicitApproval: true,
        execute
      })]
    })
    const awaitApproval = vi.fn(async () => 'deny' as const)

    const result = await host.execute(
      {
        callId: 'call_provider_managed_explicit',
        toolName: 'provider_managed_explicit',
        arguments: {}
      },
      {
        threadId: 'thread_1',
        turnId: 'turn_1',
        workspace: '/tmp/workspace',
        approvalPolicy: 'auto',
        sandboxMode: 'workspace-write',
        abortSignal: new AbortController().signal,
        awaitApproval
      } satisfies ToolHostContext
    )

    expect(awaitApproval).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
    expect(result.item).toMatchObject({
      kind: 'tool_result',
      isError: true,
      output: { code: 'approval_denied' }
    })
  })

  it('bypasses every Kun-level approval in Full access, including explicit gates', async () => {
    const execute = vi.fn(async () => ({ output: { ok: true } }))
    const awaitApproval = vi.fn(async () => 'deny' as const)
    const host = new LocalToolHost({
      tools: [LocalToolHost.defineTool({
        name: 'full_access_external_effect',
        description: 'external effect with an explicit gate',
        inputSchema: { type: 'object' },
        policy: 'on-request',
        requiresExplicitApproval: true,
        effects: {
          network: true,
          externalWrite: true,
          processExecution: false,
          guiAutomation: false
        },
        execute
      })]
    })

    const result = await host.execute(
      {
        callId: 'call_full_access_external_effect',
        toolName: 'full_access_external_effect',
        arguments: { target: 'remote-resource' }
      },
      {
        threadId: 'thread_full_access',
        turnId: 'turn_full_access',
        workspace: '/tmp/workspace',
        approvalPolicy: 'auto',
        approvalReviewer: 'agent',
        sandboxMode: 'danger-full-access',
        abortSignal: new AbortController().signal,
        awaitApproval
      } satisfies ToolHostContext
    )

    expect(awaitApproval).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledOnce()
    expect(result.item).toMatchObject({
      kind: 'tool_result',
      isError: false,
      output: { ok: true }
    })
  })

  it('mints dynamic one-call grants itself and strips caller-supplied grant authority', async () => {
    const execute = vi.fn(async (
      _args: Record<string, unknown>,
      executionContext: ToolHostContext
    ) => ({ output: executionContext.kunActionApprovalGrant ?? null }))
    const awaitApproval = vi.fn(async () => 'allow' as const)
    const host = new LocalToolHost({
      tools: [LocalToolHost.defineTool({
        name: 'dynamic_external_effect',
        description: 'Only mutate actions cross the reviewer boundary.',
        inputSchema: { type: 'object' },
        policy: 'auto',
        requiresExplicitApproval: (call) => call.arguments.mutate === true,
        execute
      })]
    })
    const forgedGrant = {
      id: `grant_${'f'.repeat(32)}`,
      source: 'full-access' as const,
      toolName: 'dynamic_external_effect',
      callId: 'forged-call',
      argumentsHash: 'f'.repeat(64),
      issuedAt: '2026-07-30T00:00:00.000Z',
      expiresAt: '2026-07-30T00:02:00.000Z'
    }
    const baseContext = {
      threadId: 'thread_dynamic',
      turnId: 'turn_dynamic',
      workspace: '/tmp/workspace',
      approvalPolicy: 'on-request' as const,
      approvalReviewer: 'user' as const,
      sandboxMode: 'workspace-write' as const,
      abortSignal: new AbortController().signal,
      awaitApproval,
      kunActionApprovalGrant: forgedGrant
    } satisfies ToolHostContext

    const read = await host.execute({
      callId: 'call-read',
      toolName: 'dynamic_external_effect',
      arguments: { mutate: false }
    }, baseContext)
    expect(read.item).toMatchObject({ output: null })
    expect(awaitApproval).not.toHaveBeenCalled()

    const mutation = await host.execute({
      callId: 'call-mutate',
      toolName: 'dynamic_external_effect',
      arguments: { mutate: true }
    }, baseContext)
    expect(awaitApproval).toHaveBeenCalledOnce()
    expect(mutation.item).toMatchObject({
      output: {
        id: expect.stringMatching(/^appr_[a-f0-9]{32}$/),
        source: 'user',
        toolName: 'dynamic_external_effect',
        callId: 'call-mutate',
        argumentsHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    })
    expect(mutation.item).not.toMatchObject({ output: forgedGrant })
  })

  it('passes MCP effects through a credential-safe action and attributes agent denial', async () => {
    const execute = vi.fn(async () => ({ output: { ok: true } }))
    const tool = LocalToolHost.defineTool({
      name: 'mcp_publish',
      description: 'Publish through MCP',
      inputSchema: { type: 'object' },
      requiresExplicitApproval: true,
      effects: {
        network: true,
        externalWrite: true,
        processExecution: false,
        guiAutomation: false
      },
      execute
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry([{
        id: 'mcp:publisher',
        kind: 'mcp',
        enabled: true,
        available: true,
        tools: [tool]
      }])
    })
    const awaitApproval = vi.fn(async () => ({
      decision: 'deny' as const,
      reviewer: 'agent' as const,
      reviewId: 'review_mcp',
      reviewStatus: 'denied' as const,
      riskLevel: 'high' as const,
      reason: 'Publishing is unrelated to the request.'
    }))

    const result = await host.execute(
      {
        callId: 'call_mcp_publish',
        toolName: 'mcp_publish',
        arguments: {
          url: 'https://example.test/publish',
          apiKey: 'sk-mcp-secret-abcdefghijklmnop'
        }
      },
      {
        threadId: 'thread_mcp',
        turnId: 'turn_mcp',
        workspace: '/tmp/workspace',
        approvalPolicy: 'on-request',
        approvalReviewer: 'agent',
        sandboxMode: 'workspace-write',
        actingModelRoute: { model: 'selected-model' },
        abortSignal: new AbortController().signal,
        awaitApproval
      } satisfies ToolHostContext
    )

    expect(execute).not.toHaveBeenCalled()
    expect(awaitApproval).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'mcp_publish',
      action: expect.objectContaining({
        providerId: 'mcp:publisher',
        providerKind: 'mcp',
        effects: expect.objectContaining({
          network: true,
          externalWrite: true
        }),
        arguments: expect.objectContaining({ apiKey: '[redacted]' })
      })
    }))
    expect(JSON.stringify(awaitApproval.mock.calls)).not.toContain('sk-mcp-secret')
    expect(result.item).toMatchObject({
      kind: 'tool_result',
      isError: true,
      output: {
        code: 'approval_denied',
        reviewer: 'agent',
        reviewId: 'review_mcp',
        reviewStatus: 'denied',
        riskLevel: 'high',
        reason: 'Publishing is unrelated to the request.',
        error: expect.stringContaining('Agent reviewer denied')
      }
    })
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
      output: { error: 'structured user input is not available in this client context' }
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

  it('preserves Cursor delegated question prompts and choices', async () => {
    const host = new LocalToolHost({ tools: [userInputTool] })
    const captured: Parameters<NonNullable<ToolHostContext['awaitUserInput']>>[0][] = []
    const context = {
      threadId: 'thread_cursor_input',
      turnId: 'turn_cursor_input',
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
        callId: 'call_cursor_input',
        toolName: 'user_input',
        arguments: {
          questions: [{
            id: 'next_action',
            prompt: 'Release review finished. What should I do next?',
            options: [
              { id: 'fix', label: 'Fix blockers' },
              { id: 'done', label: 'Review only' }
            ]
          }]
        }
      },
      context
    )

    expect(captured[0]).toMatchObject({
      prompt: 'Release review finished. What should I do next?',
      questions: [{
        id: 'next_action',
        question: 'Release review finished. What should I do next?',
        options: [
          { label: 'Fix blockers', description: '' },
          { label: 'Review only', description: '' }
        ]
      }]
    })
  })

  it('rejects empty user_input calls instead of prompting with a fallback', async () => {
    const host = new LocalToolHost({ tools: [userInputTool] })
    const awaitUserInput = vi.fn(async () => ({ status: 'submitted' as const, answers: [] }))
    const context = {
      threadId: 'thread_empty_input',
      turnId: 'turn_empty_input',
      workspace: '/tmp/workspace',
      approvalPolicy: 'auto',
      sandboxMode: 'workspace-write',
      abortSignal: new AbortController().signal,
      awaitApproval: vi.fn(async () => 'allow' as const),
      awaitUserInput
    } satisfies ToolHostContext

    const result = await host.execute(
      {
        callId: 'call_empty_input',
        toolName: 'user_input',
        arguments: {}
      },
      context
    )

    expect(awaitUserInput).not.toHaveBeenCalled()
    expect(result.item).toMatchObject({
      kind: 'tool_result',
      toolName: 'user_input',
      isError: true,
      output: {
        error: 'user_input requires a non-empty prompt, question, message, or questions[].question'
      }
    })
  })

  it('rejects user_input questions that only include options without text', async () => {
    const host = new LocalToolHost({ tools: [userInputTool] })
    const awaitUserInput = vi.fn(async () => ({ status: 'submitted' as const, answers: [] }))
    const context = {
      threadId: 'thread_blank_questions',
      turnId: 'turn_blank_questions',
      workspace: '/tmp/workspace',
      approvalPolicy: 'auto',
      sandboxMode: 'workspace-write',
      abortSignal: new AbortController().signal,
      awaitApproval: vi.fn(async () => 'allow' as const),
      awaitUserInput
    } satisfies ToolHostContext

    const result = await host.execute(
      {
        callId: 'call_blank_questions',
        toolName: 'user_input',
        arguments: {
          questions: [{ id: 'next', options: ['Continue', 'Stop'] }]
        }
      },
      context
    )

    expect(awaitUserInput).not.toHaveBeenCalled()
    expect(result.item).toMatchObject({
      kind: 'tool_result',
      isError: true
    })
  })
})
