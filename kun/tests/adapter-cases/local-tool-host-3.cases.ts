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
