import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CapabilityRegistry } from '../../src/adapters/tool/capability-registry.js'
import { createDesignCanvasTool } from '../../src/adapters/tool/design-canvas-tool.js'
import { LocalToolHost, buildDefaultLocalTools } from '../../src/adapters/tool/local-tool-host.js'
import { buildSkillToolProviders } from '../../src/adapters/tool/skill-tool-provider.js'
import { InMemoryEventBus } from '../../src/adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../../src/adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../../src/adapters/in-memory-thread-store.js'
import { createImmutablePrefix } from '../../src/cache/immutable-prefix.js'
import { KunCapabilitiesConfig } from '../../src/contracts/capabilities.js'
import { createChildAgentExecutor } from '../../src/delegation/child-agent-executor.js'
import { InstructionRuntime } from '../../src/instructions/instruction-runtime.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../../src/ports/model-client.js'
import { RuntimeEventRecorder } from '../../src/services/runtime-event-recorder.js'
import { SkillRuntime } from '../../src/skills/skill-runtime.js'
import { model } from '../support/child-agent-executor-fixtures.js'

describe('child agent executor', () => {
  it('runs a real child AgentLoop and returns assistant summary plus usage', async () => {
    const seen: ModelRequest[] = []
    const executor = createChildAgentExecutor({
      model: model([
        { kind: 'assistant_text_delta', text: 'child ' },
        { kind: 'assistant_text_delta', text: 'answer' },
        {
          kind: 'usage',
          usage: {
            promptTokens: 11,
            completionTokens: 3,
            totalTokens: 14,
            cacheHitTokens: 5,
            cacheMissTokens: 6,
            cacheHitRate: 5 / 11,
            cachedTokens: 5,
            turns: 1,
            costUsd: 0.001,
            cacheSavingsUsd: 0.0002
          }
        },
        { kind: 'completed', stopReason: 'stop' }
      ], seen),
      toolHost: new LocalToolHost({ registry: new CapabilityRegistry([]) }),
      prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
      defaultModel: 'child-test',
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    const result = await executor({
      childId: 'child_1',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      label: 'research',
      prompt: 'Research the issue',
      workspace: '/tmp/project',
      toolPolicy: 'inherit',
      signal: new AbortController().signal
    })

    expect(result.summary).toBe('child answer')
    expect(result).toMatchObject({ prefixReused: true, inheritedHistoryItems: 0 })
    expect(result.usage).toMatchObject({
      promptTokens: 11,
      completionTokens: 3,
      totalTokens: 14,
      cacheHitTokens: 5,
      cacheSavingsUsd: 0.0002,
      turns: 1
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      threadId: 'child_1',
      model: 'child-test',
      systemPrompt: 'child system',
      history: [
        expect.objectContaining({
          kind: 'user_message',
          text: 'Research the issue'
        })
      ]
    })
    expect(seen[0]?.tools).toEqual([])
  })

  it('injects AGENTS.md instructions into child AgentLoop requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-child-instructions-'))
    try {
      const home = join(root, 'home')
      const workspace = join(root, 'workspace')
      await mkdir(workspace, { recursive: true })
      await writeFile(join(workspace, 'AGENTS.md'), 'Child workspace rule.', 'utf8')
      const instructionRuntime = new InstructionRuntime(
        KunCapabilitiesConfig.parse({ instructions: { enabled: true } }).instructions,
        { homeDir: home }
      )
      const seen: ModelRequest[] = []
      const executor = createChildAgentExecutor({
        model: model([
          { kind: 'assistant_text_delta', text: 'ok' },
          { kind: 'completed', stopReason: 'stop' }
        ], seen),
        toolHost: new LocalToolHost({ registry: new CapabilityRegistry([]) }),
        prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
        defaultModel: 'child-test',
        instructionRuntime,
        nowIso: () => '2026-06-03T00:00:00.000Z'
      })

      await executor({
        childId: 'child_agents',
        parentThreadId: 'thr_parent',
        parentTurnId: 'turn_parent',
        prompt: 'Check project rules',
        workspace,
        toolPolicy: 'inherit',
        signal: new AbortController().signal
      })

      expect(seen[0]?.contextInstructions?.join('\n')).toContain('Child workspace rule.')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('omits the Kun base system prefix when omitBasePrompt is set', async () => {
    const seen: ModelRequest[] = []
    const basePrompt = 'KUN_BASE_SYSTEM_PROMPT_MARKER'
    const rolePrompt = 'ROLE_ONLY_SYSTEM_PROMPT'
    const executor = createChildAgentExecutor({
      model: model([
        { kind: 'assistant_text_delta', text: 'ok' },
        { kind: 'completed', stopReason: 'stop' }
      ], seen),
      toolHost: new LocalToolHost({ registry: new CapabilityRegistry([]) }),
      prefix: createImmutablePrefix({ systemPrompt: basePrompt }),
      defaultModel: 'child-test',
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    await executor({
      childId: 'child_omit_base',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'do the role work',
      workspace: '/tmp/project',
      systemPrompt: rolePrompt,
      omitBasePrompt: true,
      toolPolicy: 'readOnly',
      signal: new AbortController().signal
    })

    expect(seen[0]?.systemPrompt).toBe(rolePrompt)
    expect(seen[0]?.systemPrompt).not.toContain(basePrompt)
  })

  it('augments the Kun base system prefix when omitBasePrompt is unset', async () => {
    const seen: ModelRequest[] = []
    const basePrompt = 'KUN_BASE_SYSTEM_PROMPT_MARKER'
    const rolePrompt = 'ROLE_ONLY_SYSTEM_PROMPT'
    const executor = createChildAgentExecutor({
      model: model([
        { kind: 'assistant_text_delta', text: 'ok' },
        { kind: 'completed', stopReason: 'stop' }
      ], seen),
      toolHost: new LocalToolHost({ registry: new CapabilityRegistry([]) }),
      prefix: createImmutablePrefix({ systemPrompt: basePrompt }),
      defaultModel: 'child-test',
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    await executor({
      childId: 'child_augment_base',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'do the role work',
      workspace: '/tmp/project',
      systemPrompt: rolePrompt,
      toolPolicy: 'readOnly',
      signal: new AbortController().signal
    })

    expect(seen[0]?.systemPrompt).toBe(`${basePrompt}\n\n${rolePrompt}`)
  })

  it('runs a standalone profile without skill discovery or prompt activation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-child-skill-isolation-'))
    try {
      const skillDir = join(root, 'skills', 'hidden-workflow')
      await mkdir(skillDir, { recursive: true })
      await writeFile(join(skillDir, 'skill.json'), JSON.stringify({
        id: 'hidden-workflow',
        name: 'Hidden Workflow',
        triggers: { promptPatterns: ['activate hidden workflow'] }
      }), 'utf8')
      await writeFile(join(skillDir, 'SKILL.md'), 'HIDDEN SKILL INSTRUCTION', 'utf8')
      const capabilities = KunCapabilitiesConfig.parse({
        skills: { enabled: true, roots: [join(root, 'skills')], workspaceRoots: [], legacySkillMd: true }
      })
      const skillRuntime = await SkillRuntime.create(capabilities.skills)
      const seen: ModelRequest[] = []
      const executor = createChildAgentExecutor({
        model: model([
          { kind: 'assistant_text_delta', text: 'standalone result' },
          { kind: 'completed', stopReason: 'stop' }
        ], seen),
        toolHost: new LocalToolHost({ registry: new CapabilityRegistry(buildSkillToolProviders(skillRuntime)) }),
        prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
        defaultModel: 'child-test',
        skillRuntime
      })

      await executor({
        childId: 'child_standalone',
        parentThreadId: 'thr_parent',
        parentTurnId: 'turn_parent',
        prompt: 'activate hidden workflow',
        workspace: root,
        skillsEnabled: false,
        blockedTools: ['load_skill'],
        toolPolicy: 'inherit',
        signal: new AbortController().signal
      })

      expect(seen[0]?.contextInstructions?.join('\n') ?? '').not.toContain('HIDDEN SKILL INSTRUCTION')
      expect(seen[0]?.tools?.map((tool) => tool.name) ?? []).not.toContain('load_skill')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns bounded tool evidence when the contract requests it', async () => {
    let step = 0
    const evidenceModel: ModelClient = {
      provider: 'evidence-test',
      model: 'evidence-test',
      async *stream(): AsyncIterable<ModelStreamChunk> {
        step += 1
        if (step === 1) {
          yield {
            kind: 'tool_call_complete',
            callId: 'call_inspect',
            toolName: 'inspect',
            arguments: { path: 'src/index.ts' }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        yield { kind: 'assistant_text_delta', text: 'Inspection complete.' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const inspect = LocalToolHost.defineTool({
      name: 'inspect',
      description: 'Inspect a source file.',
      inputSchema: { type: 'object' },
      policy: 'auto',
      execute: async () => ({ output: { ok: true } })
    })
    const executor = createChildAgentExecutor({
      model: evidenceModel,
      toolHost: new LocalToolHost({ tools: [inspect] }),
      prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
      defaultModel: 'evidence-test',
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    const result = await executor({
      childId: 'child_evidence',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'Inspect the entry point',
      toolPolicy: 'inherit',
      returnFormat: 'evidence',
      signal: new AbortController().signal
    })

    expect(result.summary).toBe('Inspection complete.')
    expect(result.evidence).toEqual(['inspect src/index.ts: completed — {"ok":true}'])
  })

  it('fails the child run when the child loop cannot produce a completed turn', async () => {
    const executor = createChildAgentExecutor({
      model: model([{ kind: 'error', message: 'model failed', code: 'bad_model' }]),
      toolHost: new LocalToolHost({ registry: new CapabilityRegistry([]) }),
      prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
      defaultModel: 'child-test',
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    await expect(executor({
      childId: 'child_fail',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'Fail',
      toolPolicy: 'readOnly',
      signal: new AbortController().signal
    })).rejects.toThrow(/child agent failed|model failed/i)
  })

  it('restricts a read-only child to investigation tools and a preamble prompt', async () => {
    const seen: ModelRequest[] = []
    const registry = new CapabilityRegistry([{
      id: 'builtin',
      kind: 'built-in',
      enabled: true,
      available: true,
      tools: buildDefaultLocalTools()
    }])
    const executor = createChildAgentExecutor({
      model: model([
        { kind: 'assistant_text_delta', text: 'done' },
        { kind: 'completed', stopReason: 'stop' }
      ], seen),
      toolHost: new LocalToolHost({ registry }),
      prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
      defaultModel: 'child-test',
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    const result = await executor({
      childId: 'child_ro',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'Investigate the bug',
      promptPreamble: 'Read-only review.',
      toolPolicy: 'readOnly',
      signal: new AbortController().signal
    })

    const toolNames = (seen[0]?.tools ?? []).map((tool) => tool.name).sort()
    expect(toolNames).toEqual(['glob', 'grep', 'ls', 'read', 'repo_map'])
    expect(seen[0]?.history?.[0]).toMatchObject({
      kind: 'user_message',
      text: 'Read-only review.\n\nInvestigate the bug'
    })
    expect(result).toMatchObject({ prefixReused: true, inheritedHistoryItems: 0 })
  })

  it('does NOT fail the child when a tool call is rejected by its read-only policy', async () => {
    // The child (read-only) calls `bash`, which its policy denies. That is a
    // recoverable tool error (warning), not a fatal one: the loop hands the
    // model an error result, the model adapts and the turn completes. The
    // child run must report success, not "failed".
    const registry = new CapabilityRegistry([{
      id: 'builtin',
      kind: 'built-in',
      enabled: true,
      available: true,
      tools: buildDefaultLocalTools()
    }])
    let calls = 0
    const recoveringModel: ModelClient = {
      provider: 'child-test',
      model: 'child-test',
      async *stream(): AsyncIterable<ModelStreamChunk> {
        calls += 1
        if (calls === 1) {
          yield { kind: 'tool_call_complete', callId: 'call_bash', toolName: 'bash', arguments: { command: 'ls' } }
          yield { kind: 'completed', stopReason: 'tool_calls' }
        } else {
          yield { kind: 'assistant_text_delta', text: 'bash was denied, so here is my read-only summary' }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      }
    }
    const executor = createChildAgentExecutor({
      model: recoveringModel,
      toolHost: new LocalToolHost({ registry }),
      prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
      defaultModel: 'child-test',
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    const result = await executor({
      childId: 'child_rejected_tool',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'Investigate the project',
      toolPolicy: 'readOnly',
      signal: new AbortController().signal
    })

    expect(calls).toBe(2)
    expect(result.summary).toContain('read-only summary')
  })

  it('threads the input providerId onto the child ModelRequest for routing', async () => {
    const seen: ModelRequest[] = []
    const executor = createChildAgentExecutor({
      model: model([
        { kind: 'assistant_text_delta', text: 'ok' },
        { kind: 'completed', stopReason: 'stop' }
      ], seen),
      toolHost: new LocalToolHost({ registry: new CapabilityRegistry([]) }),
      prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
      defaultModel: 'child-test',
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    await executor({
      childId: 'child_provider',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'Route me',
      providerId: 'minimax',
      toolPolicy: 'inherit',
      signal: new AbortController().signal
    })

    expect(seen[0]?.providerId).toBe('minimax')
  })
})
