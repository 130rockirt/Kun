import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import type { ModelClient, ModelRequest } from '../src/ports/model-client.js'
import { modelRequestContextText } from '../src/loop/model-request-context.js'
import { SkillRuntime } from '../src/skills/skill-runtime.js'
import { bootstrapThread, makeHarness } from './loop-test-harness.js'

describe('SkillRuntime', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kun-skills-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('loads manifests, legacy SKILL.md packages, and validation diagnostics', async () => {
    await writeSkill('review', {
      name: 'Review Skill',
      description: 'Review changes in the current workspace',
      version: '1.0.0',
      entry: 'REVIEW.md',
      triggers: { commands: ['/review'] }
    }, 'Review instructions')
    await mkdir(join(root, 'legacy'), { recursive: true })
    await writeFile(join(root, 'legacy', 'SKILL.md'), '# Legacy\n\nLegacy instructions', 'utf8')
    await mkdir(join(root, 'bad'), { recursive: true })
    await writeFile(join(root, 'bad', 'skill.json'), JSON.stringify({ id: 'bad' }), 'utf8')

    const runtime = await createRuntime()
    const diagnostics = runtime.diagnostics()

    expect(diagnostics.skills.map((skill) => skill.id).sort()).toEqual(['legacy', 'review-skill'])
    expect(diagnostics.skills.find((skill) => skill.id === 'review-skill')).toMatchObject({
      description: 'Review changes in the current workspace',
      version: '1.0.0'
    })
    expect(diagnostics.skills.find((skill) => skill.id === 'legacy')?.legacy).toBe(true)
    expect(diagnostics.validationErrors[0]?.message).toMatch(/expected string/i)
  })

  it('uses Chinese legacy frontmatter names for diagnostics without changing folder ids', async () => {
    const skillRoot = join(root, 'tdd')
    await mkdir(skillRoot, { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), [
      '---',
      'name: 测试驱动开发(TDD)',
      'description: 用测试先行推进实现。',
      '---',
      '',
      '# TDD',
      '',
      '先写失败测试，再实现。'
    ].join('\n'), 'utf8')

    const runtime = await createRuntime()
    const diagnostics = runtime.diagnostics()

    expect(diagnostics.skills).toContainEqual(expect.objectContaining({
      id: 'tdd',
      name: '测试驱动开发(TDD)',
      description: '用测试先行推进实现。',
      legacy: true
    }))
  })

  it('keeps skill.json manifests with Chinese names from collapsing to one id', async () => {
    await writeSkill('review-cn', {
      name: '代码审查',
      triggers: { commands: ['/review-cn'] }
    }, 'review instructions')
    await writeSkill('requirements-cn', {
      name: '需求分析',
      triggers: { commands: ['/requirements-cn'] }
    }, 'requirements instructions')

    const runtime = await createRuntime()
    const diagnostics = runtime.diagnostics()

    expect(diagnostics.skills.map((skill) => skill.id).sort()).toEqual(['代码审查', '需求分析'])
    expect(diagnostics.validationErrors).toEqual([])
  })

  it('discovers a skill package symlinked into a root (e.g. cc switch)', async (ctx) => {
    // cc switch keeps the real skill files in its own config dir and symlinks
    // the skill directory into the scanned root; the link must still load. (#320)
    const realDir = await mkdtemp(join(tmpdir(), 'kun-skill-real-'))
    try {
      await writeFile(join(realDir, 'skill.json'), JSON.stringify({
        id: 'linked',
        name: 'Linked',
        triggers: { commands: ['/linked'] }
      }), 'utf8')
      await writeFile(join(realDir, 'SKILL.md'), 'linked body', 'utf8')
      try {
        await symlink(realDir, join(root, 'linked'), 'dir')
      } catch {
        // Symlink creation can be unprivileged (e.g. Windows) — skip there.
        ctx.skip()
        return
      }

      const runtime = await createRuntime()

      expect(runtime.diagnostics().skills.map((skill) => skill.id)).toContain('linked')
      await expect(runtime.resolveTurn({ prompt: '/linked go', workspace: root }))
        .resolves.toMatchObject({ activeSkillIds: ['linked'] })
    } finally {
      await rm(realDir, { recursive: true, force: true })
    }
  })

  it('rejects manifest entry and asset paths that escape a skill package', async () => {
    const secret = join(root, 'outside-secret.md')
    await writeFile(secret, 'PRIVATE KEY MATERIAL', 'utf8')
    const escaped = join(root, 'escaped')
    const assetEscaped = join(root, 'asset-escaped')
    await mkdir(escaped, { recursive: true })
    await mkdir(assetEscaped, { recursive: true })
    await writeFile(join(escaped, 'skill.json'), JSON.stringify({
      id: 'escaped', name: 'Escaped', entry: '../outside-secret.md'
    }), 'utf8')
    await writeFile(join(assetEscaped, 'skill.json'), JSON.stringify({
      id: 'asset-escaped', name: 'Asset Escaped', assets: ['../outside-secret.md']
    }), 'utf8')
    await writeFile(join(assetEscaped, 'SKILL.md'), 'safe body', 'utf8')

    const runtime = await createRuntime()

    expect(runtime.diagnostics().skills.map((skill) => skill.id)).not.toContain('escaped')
    expect(runtime.diagnostics().skills.map((skill) => skill.id)).not.toContain('asset-escaped')
    expect(runtime.diagnostics().validationErrors.map((error) => error.message).join('\n')).toMatch(/escapes its root/)
  })

  it('rejects a skill entry symlinked outside its package', async (ctx) => {
    const outside = await mkdtemp(join(tmpdir(), 'kun-skill-secret-'))
    try {
      const secret = join(outside, 'secret.md')
      await writeFile(secret, 'PRIVATE KEY MATERIAL', 'utf8')
      const skillDir = join(root, 'linked-entry')
      await mkdir(skillDir, { recursive: true })
      await writeFile(join(skillDir, 'skill.json'), JSON.stringify({ id: 'linked-entry', name: 'Linked Entry' }), 'utf8')
      try {
        await symlink(secret, join(skillDir, 'SKILL.md'))
      } catch {
        ctx.skip()
        return
      }

      const runtime = await createRuntime()

      expect(runtime.diagnostics().skills.map((skill) => skill.id)).not.toContain('linked-entry')
      expect(runtime.diagnostics().validationErrors.map((error) => error.message).join('\n')).toMatch(/resolves outside its root/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects workspace-discovered skill packages symlinked outside the workspace', async (ctx) => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-skill-workspace-boundary-'))
    const external = await mkdtemp(join(tmpdir(), 'kun-skill-external-'))
    try {
      await writeSkillAt(external, 'outside', {
        id: 'outside', name: 'Outside', triggers: { commands: ['/outside'] }
      }, 'PRIVATE KEY MATERIAL')
      await mkdir(join(workspace, '.kun', 'skills'), { recursive: true })
      try {
        await symlink(join(external, 'outside'), join(workspace, '.kun', 'skills', 'outside'), 'dir')
      } catch {
        ctx.skip()
        return
      }
      const config = KunCapabilitiesConfig.parse({
        skills: { enabled: true, roots: [], workspaceRoots: [], legacySkillMd: true }
      })
      const runtime = await SkillRuntime.create(config.skills)

      const resolution = await runtime.resolveTurn({ prompt: '/outside run', workspace })

      expect(resolution.catalogInstruction).toBeUndefined()
      expect(resolution.activeSkillIds).toEqual([])
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(external, { recursive: true, force: true })
    }
  })

  it('rejects regular-expression prompt patterns instead of running them per turn', async () => {
    await writeSkill('redos', {
      id: 'redos',
      name: 'Redos',
      triggers: { promptPatterns: ['^(a+)+$'] }
    }, 'unsafe pattern')

    const runtime = await createRuntime()
    const resolution = await runtime.resolveTurn({ prompt: `${'a'.repeat(20_000)}!`, workspace: root })

    expect(runtime.diagnostics().skills.map((skill) => skill.id)).not.toContain('redos')
    expect(runtime.diagnostics().validationErrors.map((error) => error.message).join('\n')).toContain('promptPatterns must be literal text')
    expect(resolution.activeSkillIds).toEqual([])
  })

  it('rejects oversized skill entries before retaining them in the catalog cache', async () => {
    await writeSkill('oversized', {
      id: 'oversized', name: 'Oversized'
    }, 'x'.repeat(256 * 1024 + 1))

    const runtime = await createRuntime()

    expect(runtime.diagnostics().skills.map((skill) => skill.id)).not.toContain('oversized')
    expect(runtime.diagnostics().validationErrors.map((error) => error.message).join('\n')).toMatch(/exceeds 262144 byte limit/)
  })

  it('matches triggers deterministically and respects injection budgets', async () => {
    await writeSkill('big', {
      id: 'big',
      name: 'Big',
      priority: 10,
      triggers: { promptPatterns: ['typescript'] }
    }, 'x'.repeat(2_000))
    await writeSkill('small', {
      id: 'small',
      name: 'Small',
      triggers: { fileTypes: ['.ts'] }
    }, 'small instructions')
    const runtime = await createRuntime({ instructionBudgetBytes: 600 })

    const resolution = await runtime.resolveTurn({
      prompt: 'Please handle TypeScript in src/app.ts',
      workspace: root
    })

    expect(resolution.activations.map((activation) => activation.skillId)).toEqual(['big', 'small'])
    expect(resolution.activeSkillIds).toEqual(['small'])
    expect(resolution.instructions[0]).toContain('small instructions')
  })

  it('renders an always-on catalog of available skills with file paths', async () => {
    await writeSkill('alpha', {
      id: 'alpha',
      name: 'Alpha',
      description: 'Does alpha things',
      triggers: { commands: ['/alpha'] }
    }, 'alpha body')
    await writeSkill('beta', { id: 'beta', name: 'Beta' }, 'beta body')
    const runtime = await createRuntime()

    const catalog = runtime.catalogInstruction()
    expect(catalog).toBeDefined()
    expect(catalog).toContain('### Available skills')
    expect(catalog).toContain('- Alpha (alpha): Does alpha things (file:')
    expect(catalog).toContain('- Beta (beta) (file:')
    expect(catalog).toContain('### How to use skills')
  })

  it('scopes the dynamic skill catalog to the current workspace', async () => {
    const workspaceA = await mkdtemp(join(tmpdir(), 'kun-skill-workspace-a-'))
    const workspaceB = await mkdtemp(join(tmpdir(), 'kun-skill-workspace-b-'))
    try {
      const rootA = join(workspaceA, '.agents', 'skills')
      const rootB = join(workspaceB, '.agents', 'skills')
      await writeSkillAt(rootA, 'alpha', {
        id: 'alpha',
        name: 'Alpha',
        triggers: { commands: ['/alpha'] }
      }, 'alpha instructions')
      await writeSkillAt(rootB, 'beta', {
        id: 'beta',
        name: 'Beta',
        triggers: { commands: ['/beta'] }
      }, 'beta instructions')

      const config = KunCapabilitiesConfig.parse({
        skills: {
          enabled: true,
          roots: [rootA, rootB],
          workspaceRoots: [workspaceA, workspaceB],
          legacySkillMd: true
        }
      })
      const runtime = await SkillRuntime.create(config.skills)
      const workspaceAResolution = await runtime.resolveTurn({ prompt: '/alpha run', workspace: workspaceA })
      const workspaceBResolution = await runtime.resolveTurn({ prompt: '/beta run', workspace: workspaceB })

      expect(workspaceAResolution.catalogInstruction).toContain('Alpha')
      expect(workspaceAResolution.catalogInstruction).not.toContain('Beta')
      expect(workspaceAResolution.activeSkillIds).toEqual(['alpha'])
      expect(workspaceBResolution.catalogInstruction).toContain('Beta')
      expect(workspaceBResolution.catalogInstruction).not.toContain('Alpha')
      expect(workspaceBResolution.activeSkillIds).toEqual(['beta'])

      const disabledConfig = KunCapabilitiesConfig.parse({
        skills: {
          enabled: true,
          roots: [rootA],
          workspaceRoots: [workspaceA, workspaceB],
          legacySkillMd: true
        }
      })
      const disabledRuntime = await SkillRuntime.create(disabledConfig.skills)
      const disabledResolution = await disabledRuntime.resolveTurn({ prompt: '/beta run', workspace: workspaceB })
      expect(disabledResolution.catalogInstruction).toBeUndefined()
      expect(disabledResolution.activeSkillIds).toEqual([])
    } finally {
      await rm(workspaceA, { recursive: true, force: true })
      await rm(workspaceB, { recursive: true, force: true })
    }
  })

  it('discovers workspace-local Kun skills from .kun/skills', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-skill-workspace-kun-'))
    try {
      const skillRoot = join(workspace, '.kun', 'skills')
      await writeSkillAt(skillRoot, 'pm', {
        id: 'pm',
        name: 'Project Manager',
        triggers: { commands: ['/pm'] }
      }, 'PM instructions')

      const config = KunCapabilitiesConfig.parse({
        skills: {
          enabled: true,
          roots: [],
          workspaceRoots: [],
          legacySkillMd: true
        }
      })
      const runtime = await SkillRuntime.create(config.skills)
      const resolution = await runtime.resolveTurn({ prompt: '/pm plan the work', workspace })

      expect(resolution.catalogInstruction).toContain('Project Manager')
      expect(resolution.activeSkillIds).toEqual(['pm'])
      await expect(runtime.loadSkillById('pm', workspace)).resolves.toMatchObject({
        skillId: 'pm',
        name: 'Project Manager'
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('truncates the catalog when the byte budget is exceeded', async () => {
    await writeSkill('one', { id: 'one', name: 'One', description: 'd'.repeat(400) }, 'b')
    await writeSkill('two', { id: 'two', name: 'Two', description: 'd'.repeat(400) }, 'b')
    const runtime = await createRuntime({ catalogBudgetBytes: 1_300 })

    const catalog = runtime.catalogInstruction()
    expect(catalog).toContain('1 more skill')
    expect(catalog).toContain('omitted (catalog budget reached)')
  })

  it('returns no catalog when skills are disabled', async () => {
    const runtime = await SkillRuntime.create({ enabled: false, roots: [], workspaceRoots: [], globalRoots: [], disabledIds: [], legacySkillMd: true })
    expect(runtime.catalogInstruction()).toBeUndefined()
  })

  it('loads a skill on demand by id, accepting $/@/skill: prefixes', async () => {
    await writeSkill('gamma', {
      id: 'gamma',
      name: 'Gamma',
      description: 'Handles gamma',
      allowedTools: ['read']
    }, 'gamma full instructions')
    const runtime = await createRuntime()

    for (const ref of ['gamma', '$gamma', '@gamma', 'skill:gamma']) {
      const result = await runtime.loadSkillById(ref)
      expect('error' in result).toBe(false)
      if ('error' in result) continue
      expect(result.skillId).toBe('gamma')
      expect(result.instruction).toContain('gamma full instructions')
      expect(result.instruction).toContain('Allowed tools: read')
      expect(result.allowedTools).toEqual(['read'])
      expect(result.truncated).toBe(false)
    }
  })

  it('reports an error with available ids for an unknown skill', async () => {
    await writeSkill('known', { id: 'known', name: 'Known' }, 'body')
    const runtime = await createRuntime()

    const result = await runtime.loadSkillById('does-not-exist')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toContain('known')
  })

  it('excludes disabledIds from catalog, matching, load, and diagnostics', async () => {
    await writeSkill('gmail', {
      id: 'gmail',
      name: 'Gmail',
      triggers: { commands: ['/gmail'] }
    }, 'gmail body')
    await writeSkill('keeper', {
      id: 'keeper',
      name: 'Keeper',
      triggers: { commands: ['/keeper'] }
    }, 'keeper body')
    // Mixed-case / prefixed forms must still match the slugged discovered id.
    const runtime = await createRuntime({}, { disabledIds: ['Gmail', 'skill:nonexistent'] })

    // diagnostics + count
    expect(runtime.diagnostics().skills.map((skill) => skill.id)).toEqual(['keeper'])
    expect(runtime.count()).toBe(1)

    // global catalog
    expect(runtime.catalogInstruction()).not.toContain('Gmail')
    expect(runtime.catalogInstruction()).toContain('Keeper')

    // per-turn catalog + auto-match (command trigger)
    const resolution = await runtime.resolveTurn({ prompt: '/gmail send', workspace: root })
    expect(resolution.catalogInstruction).not.toContain('Gmail')
    expect(resolution.activeSkillIds).not.toContain('gmail')

    // load_skill
    const result = await runtime.loadSkillById('gmail')
    expect('error' in result).toBe(true)
  })

  it('excludes per-call blockedSkillIds from resolveTurn + load_skill without mutating siblings', async () => {
    await writeSkill('gmail', {
      id: 'gmail',
      name: 'Gmail',
      triggers: { commands: ['/gmail'] }
    }, 'gmail body')
    await writeSkill('keeper', {
      id: 'keeper',
      name: 'Keeper',
      triggers: { commands: ['/keeper'] }
    }, 'keeper body')
    const runtime = await createRuntime()

    // A child whose profile blocks gmail: hidden from the per-turn catalog and
    // auto-match. The `skill:`-prefixed + mixed-case form must still match the
    // slugged discovered id (mirrors load_skill's accepted forms).
    const blocked = await runtime.resolveTurn({ prompt: '/gmail send', workspace: root, blockedSkillIds: ['skill:Gmail'] })
    expect(blocked.catalogInstruction).not.toContain('Gmail')
    expect(blocked.catalogInstruction).toContain('Keeper')
    expect(blocked.activeSkillIds).not.toContain('gmail')
    // load_skill rejects the blocked id for that child.
    expect('error' in (await runtime.loadSkillById('gmail', root, ['gmail']))).toBe(true)

    // The shared runtime is NOT mutated: a sibling call with no deny-list still
    // sees gmail in the catalog, auto-activates it, and can load it.
    const sibling = await runtime.resolveTurn({ prompt: '/gmail send', workspace: root })
    expect(sibling.catalogInstruction).toContain('Gmail')
    expect(sibling.activeSkillIds).toContain('gmail')
    expect('error' in (await runtime.loadSkillById('gmail', root))).toBe(false)
  })

  it('truncates an oversized skill body to the instruction budget on load', async () => {
    await writeSkill('huge', { id: 'huge', name: 'Huge' }, 'z'.repeat(5_000))
    const runtime = await createRuntime({ instructionBudgetBytes: 1_000 })

    const result = await runtime.loadSkillById('huge')
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.truncated).toBe(true)
    expect(result.instruction).toContain('…(truncated)')
    expect(Buffer.byteLength(result.instruction, 'utf8')).toBeLessThanOrEqual(1_000)
  })

  it('injects allowed tool constraints and blocks omitted tools', async () => {
    await writeSkill('readonly', {
      id: 'readonly',
      name: 'Readonly',
      triggers: { commands: ['/readonly'] },
      allowedTools: ['read']
    }, 'Use read only')
    await writeSkill('mutating', {
      id: 'mutating',
      name: 'Mutating',
      triggers: { commands: ['/mutating'] },
      allowedTools: ['bash']
    }, 'Use bash')
    const runtime = await createRuntime()
    const resolution = await runtime.resolveTurn({
      prompt: '/readonly inspect',
      workspace: root
    })

    expect(resolution.allowedToolNames).toEqual(['read'])
    expect(runtime.diagnostics().lastInjection?.blockedToolNames).toEqual(['bash'])

    const readTool = LocalToolHost.defineTool({
      name: 'read',
      description: 'read',
      inputSchema: { type: 'object' },
      policy: 'auto',
      execute: async () => ({ output: { ok: true } })
    })
    const bashTool = LocalToolHost.defineTool({
      name: 'bash',
      description: 'bash',
      inputSchema: { type: 'object' },
      policy: 'auto',
      execute: async () => ({ output: { ok: true } })
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry([
        { id: 'builtin', kind: 'built-in', enabled: true, available: true, tools: [readTool, bashTool] }
      ])
    })
    const context = {
      threadId: 'thr',
      turnId: 'turn',
      workspace: root,
      approvalPolicy: 'auto' as const,
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow' as const,
      allowedToolNames: resolution.allowedToolNames
    }

    expect((await host.listTools(context)).map((tool) => tool.name)).toEqual(['read'])
    await expect(
      host.execute({ callId: 'call_1', toolName: 'bash', arguments: {} }, context)
    ).rejects.toThrow(/active tool policy/)
  })

  it('refreshes Skill roots without recreating the runtime', async () => {
    const runtime = await createRuntime()
    expect(runtime.count()).toBe(0)

    await writeSkill('new-skill', {
      id: 'new',
      name: 'New',
      triggers: { commands: ['/new'] }
    }, 'new instructions')
    await runtime.refresh()

    expect(runtime.count()).toBe(1)
    await expect(runtime.resolveTurn({ prompt: '/new run', workspace: root }))
      .resolves.toMatchObject({ activeSkillIds: ['new'] })
  })

  it('injects active Skills into AgentLoop context and turn metadata', async () => {
    await writeSkill('review', {
      id: 'review',
      name: 'Review',
      triggers: { promptPatterns: ['review'] },
      allowedTools: ['read']
    }, 'Always inspect the diff first.')
    const skillRuntime = await createRuntime()
    let seenRequest: ModelRequest | undefined
    const model: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream(request) {
        seenRequest = request
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const h = makeHarness(model, {
      skillRuntime,
      tools: [
        LocalToolHost.defineTool({
          name: 'read',
          description: 'read',
          inputSchema: { type: 'object' },
          policy: 'auto',
          execute: async () => ({ output: {} })
        }),
        LocalToolHost.defineTool({
          name: 'bash',
          description: 'bash',
          inputSchema: { type: 'object' },
          policy: 'auto',
          execute: async () => ({ output: {} })
        })
      ]
    })
    await bootstrapThread(h, { workspace: root, request: { prompt: 'please review this change' } })

    await h.loop.runTurn(h.threadId, h.turnId)

    expect(seenRequest ? modelRequestContextText(seenRequest) : '').toContain('Always inspect the diff first.')
    expect(seenRequest?.tools.map((tool) => tool.name)).toEqual(['read'])
    const turn = await h.turns.getTurn(h.threadId, h.turnId)
    expect(turn?.activeSkillIds).toEqual(['review'])
    expect(turn?.skillInjectionBytes).toBeGreaterThan(0)
  })

  async function createRuntime(
    options: Parameters<typeof SkillRuntime.create>[1] = {},
    skillsOverride: Record<string, unknown> = {}
  ) {
    const config = KunCapabilitiesConfig.parse({
      skills: {
        enabled: true,
        roots: [root],
        workspaceRoots: [],
        legacySkillMd: true,
        ...skillsOverride
      }
    })
    return SkillRuntime.create(config.skills, options)
  }

  async function writeSkill(
    folder: string,
    manifest: Record<string, unknown>,
    entry: string
  ): Promise<void> {
    await writeSkillAt(root, folder, manifest, entry)
  }

  async function writeSkillAt(
    parentRoot: string,
    folder: string,
    manifest: Record<string, unknown>,
    entry: string
  ): Promise<void> {
    const dir = join(parentRoot, folder)
    await mkdir(dir, { recursive: true })
    const entryName = typeof manifest.entry === 'string' ? manifest.entry : 'SKILL.md'
    await writeFile(join(dir, 'skill.json'), JSON.stringify(manifest), 'utf8')
    await writeFile(join(dir, entryName), entry, 'utf8')
  }
})
