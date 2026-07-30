import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { createDesignCanvasTool } from '../src/adapters/tool/design-canvas-tool.js'
import { LocalToolHost, buildDefaultLocalTools } from '../src/adapters/tool/local-tool-host.js'
import { buildSkillToolProviders } from '../src/adapters/tool/skill-tool-provider.js'
import { InMemoryEventBus } from '../src/adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../src/adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../src/adapters/in-memory-thread-store.js'
import { createImmutablePrefix } from '../src/cache/immutable-prefix.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { createChildAgentExecutor } from '../src/delegation/child-agent-executor.js'
import { InstructionRuntime } from '../src/instructions/instruction-runtime.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../src/ports/model-client.js'
import { RuntimeEventRecorder } from '../src/services/runtime-event-recorder.js'
import { SkillRuntime } from '../src/skills/skill-runtime.js'

function model(chunks: ModelStreamChunk[], seen: ModelRequest[] = []): ModelClient {
  return {
    provider: 'child-test',
    model: 'child-test',
    async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
      seen.push(request)
      for (const chunk of chunks) yield chunk
    }
  }
}

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

  it('persists the child as a hidden side thread when shared stores are supplied', async () => {
    const eventBus = new InMemoryEventBus()
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })
    const executor = createChildAgentExecutor({
      model: model([
        { kind: 'assistant_text_delta', text: 'child answer' },
        { kind: 'completed', stopReason: 'stop' }
      ]),
      toolHost: new LocalToolHost({ registry: new CapabilityRegistry([]) }),
      prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
      defaultModel: 'child-test',
      nowIso: () => '2026-06-03T00:00:00.000Z',
      sessionStore,
      threadStore,
      events
    })

    await executor({
      childId: 'child_persisted',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      profile: 'explore',
      prompt: 'Investigate',
      toolPolicy: 'readOnly',
      signal: new AbortController().signal
    })

    // The child thread is queryable from the shared store, flagged `side` and
    // linked to its parent so the GUI can load it but the sidebar hides it.
    const persisted = await threadStore.get('child_persisted')
    expect(persisted).not.toBeNull()
    expect(persisted?.relation).toBe('side')
    expect(persisted?.parentThreadId).toBe('thr_parent')
    expect(persisted?.title).toContain('explore')

    // The child's transcript persists too (loadable for the read-only viewer).
    const items = await sessionStore.loadItems('child_persisted')
    expect(items.some((item) => item.kind === 'assistant_text')).toBe(true)
  })

  it('uses the delegated security snapshot instead of broader executor defaults', async () => {
    const eventBus = new InMemoryEventBus()
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })
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
        { kind: 'assistant_text_delta', text: 'child answer' },
        { kind: 'completed', stopReason: 'stop' }
      ], seen),
      toolHost: new LocalToolHost({ registry }),
      prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
      defaultModel: 'child-test',
      // These emulate permissive process-wide settings. A delegated child
      // must use the parent-turn snapshot below instead.
      approvalPolicy: 'auto',
      sandboxMode: 'danger-full-access',
      nowIso: () => '2026-06-03T00:00:00.000Z',
      sessionStore,
      threadStore,
      events
    })

    await executor({
      childId: 'child_security_snapshot',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'Inspect only',
      toolPolicy: 'inherit',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      security: {
        sandboxRoot: '/tmp/project',
        allowedToolNames: ['read'],
        memoryEnabled: false
      },
      signal: new AbortController().signal
    })

    const child = await threadStore.get('child_security_snapshot')
    expect(child).toMatchObject({
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write'
    })
    const toolNames = (seen[0]?.tools ?? []).map((tool) => tool.name)
    expect(toolNames).toEqual(['read'])
  })

  it('gives an inherit child the parent agent full tool set (no forced read-only allowlist)', async () => {
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

    await executor({
      childId: 'child_inherit',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'Do the work',
      toolPolicy: 'inherit',
      signal: new AbortController().signal
    })

    const toolNames = (seen[0]?.tools ?? []).map((tool) => tool.name)
    // The child sees write/shell tools (not just the read-only investigation
    // set) because inherit applies no forced allow-list.
    expect(toolNames).toContain('read')
    expect(toolNames.length).toBeGreaterThan(4)
    const restricted = new Set(['read', 'grep', 'find', 'ls'])
    expect(toolNames.some((name) => !restricted.has(name))).toBe(true)
  })

  it('advertises design_canvas to a guiDesignCanvas child turn', async () => {
    const seen: ModelRequest[] = []
    const registry = new CapabilityRegistry([{
      id: 'design-canvas',
      kind: 'gui',
      enabled: true,
      available: true,
      tools: [createDesignCanvasTool()]
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

    await executor({
      childId: 'child_canvas',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'Add a screen',
      toolPolicy: 'inherit',
      guiDesignCanvas: true,
      signal: new AbortController().signal
    })

    const toolNames = (seen[0]?.tools ?? []).map((tool) => tool.name)
    expect(toolNames).toContain('design_canvas')
  })

  it('intersects allowedTools with the read-only policy instead of widening it', async () => {
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

    await executor({
      childId: 'child_tools',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'Investigate',
      // readOnly would allow read/grep/find/ls; the explicit list narrows it.
      toolPolicy: 'readOnly',
      allowedTools: ['read', 'grep', 'bash'],
      signal: new AbortController().signal
    })

    const toolNames = (seen[0]?.tools ?? []).map((tool) => tool.name).sort()
    expect(toolNames).toEqual(['grep', 'read'])
  })

  it('drops blocked built-in tools (blockedTools) from an inherit child', async () => {
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

    await executor({
      childId: 'child_blocked_tools',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'Do the work',
      toolPolicy: 'inherit',
      blockedTools: ['bash', 'write'],
      signal: new AbortController().signal
    })

    const toolNames = (seen[0]?.tools ?? []).map((tool) => tool.name)
    expect(toolNames).toContain('read')
    expect(toolNames).not.toContain('bash')
    expect(toolNames).not.toContain('write')
  })

  it('maps blockedMcpServers to mcp:<serverId> and hides that server tools from the child', async () => {
    const seen: ModelRequest[] = []
    const mcpTool = LocalToolHost.defineTool({
      name: 'mcp_github_create_issue',
      description: 'create issue',
      inputSchema: { type: 'object' },
      policy: 'auto',
      execute: async () => ({ output: { ok: true } })
    })
    const registry = new CapabilityRegistry([
      { id: 'builtin', kind: 'built-in', enabled: true, available: true, tools: buildDefaultLocalTools() },
      { id: 'mcp:github', kind: 'mcp', enabled: true, available: true, tools: [mcpTool] }
    ])
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

    await executor({
      childId: 'child_blocked_mcp',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'Do the work',
      toolPolicy: 'inherit',
      blockedMcpServers: ['github'],
      signal: new AbortController().signal
    })

    const toolNames = (seen[0]?.tools ?? []).map((tool) => tool.name)
    expect(toolNames).toContain('read')
    expect(toolNames).not.toContain('mcp_github_create_issue')
  })

  it('augments the base system prompt with the agent systemPrompt', async () => {
    const seen: ModelRequest[] = []
    const executor = createChildAgentExecutor({
      model: model([
        { kind: 'assistant_text_delta', text: 'ok' },
        { kind: 'completed', stopReason: 'stop' }
      ], seen),
      toolHost: new LocalToolHost({ registry: new CapabilityRegistry([]) }),
      prefix: createImmutablePrefix({ systemPrompt: 'BASE PROMPT' }),
      defaultModel: 'child-test',
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    const result = await executor({
      childId: 'child_sys',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'Task',
      systemPrompt: 'You are a careful reviewer.',
      toolPolicy: 'inherit',
      signal: new AbortController().signal
    })

    expect(seen[0]?.systemPrompt).toBe('BASE PROMPT\n\nYou are a careful reviewer.')
    expect(result.prefixReused).toBe(false)
  })

  it('persists the child as a hidden side thread on the shared stores when provided', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })
    const executor = createChildAgentExecutor({
      model: model([
        { kind: 'assistant_text_delta', text: 'persisted answer' },
        { kind: 'completed', stopReason: 'stop' }
      ]),
      toolHost: new LocalToolHost({ registry: new CapabilityRegistry([]) }),
      prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
      defaultModel: 'child-test',
      sessionStore,
      threadStore,
      events,
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    await executor({
      childId: 'child_persist',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      profile: 'explore',
      prompt: 'Investigate',
      toolPolicy: 'readOnly',
      signal: new AbortController().signal
    })

    // The child thread is persisted as a `side` branch of the parent. The
    // `side` relation is what the thread store / ThreadService.list filter on
    // to keep it out of the default (sidebar) list while leaving it loadable.
    const thread = await threadStore.get('child_persist')
    expect(thread).toMatchObject({ relation: 'side', parentThreadId: 'thr_parent' })

    // The full session must live on the thread RECORD's turns/items — that is
    // what `GET /threads/:id` (getThreadDetail → selectThread) reads to render
    // the child's conversation when the user drills into it.
    const recordItems = (thread?.turns ?? []).flatMap((turn) => turn.items)
    const recordAssistantText = recordItems
      .filter((item): item is Extract<typeof item, { kind: 'assistant_text' }> => item.kind === 'assistant_text')
      .map((item) => item.text)
      .join('')
    expect(recordAssistantText).toContain('persisted answer')
  })
})
