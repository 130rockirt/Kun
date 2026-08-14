import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { InstructionRuntime } from '../src/instructions/instruction-runtime.js'
import type { ModelClient, ModelRequest } from '../src/ports/model-client.js'
import { modelRequestContextText } from '../src/loop/model-request-context.js'
import { bootstrapThread, makeHarness } from './loop-test-harness.js'

describe('InstructionRuntime', () => {
  let root = ''
  let home = ''
  let workspace = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kun-instructions-'))
    home = join(root, 'home')
    workspace = join(root, 'workspace')
    await mkdir(home, { recursive: true })
    await mkdir(workspace, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('loads global then workspace AGENTS.md and ignores Codex files', async () => {
    await writeAgents(join(home, '.kun'), 'Global rule.')
    await writeAgents(workspace, 'Workspace rule.')
    await writeAgents(join(workspace, '.codex'), 'Codex rule must not load.')

    const runtime = createRuntime()
    const resolution = await runtime.resolveTurn({ workspace })

    expect(resolution.sources.map((source) => source.scope)).toEqual(['global', 'workspace'])
    expect(resolution.instruction).toContain('Global rule.')
    expect(resolution.instruction).toContain('Workspace rule.')
    expect(resolution.instruction).not.toContain('Codex rule must not load.')
    expect((resolution.instruction ?? '').indexOf('Global rule.')).toBeLessThan(
      (resolution.instruction ?? '').indexOf('Workspace rule.')
    )
    expect(runtime.diagnostics().lastInjection?.sources).toHaveLength(2)
  })

  it('silently skips missing files', async () => {
    const runtime = createRuntime()

    const resolution = await runtime.resolveTurn({ workspace })

    expect(resolution.sources).toEqual([])
    expect(resolution.instruction).toBeUndefined()
    expect(runtime.diagnostics().readErrors).toEqual([])
  })

  it('refreshes cached content when the file changes', async () => {
    await writeAgents(workspace, 'First rule.')
    const runtime = createRuntime()

    const first = await runtime.resolveTurn({ workspace })
    await writeAgents(workspace, 'Second rule with a different size.')
    const second = await runtime.resolveTurn({ workspace })

    expect(first.instruction).toContain('First rule.')
    expect(second.instruction).toContain('Second rule with a different size.')
    expect(second.instruction).not.toContain('First rule.')
  })

  it('records read errors for invalid AGENTS.md paths', async () => {
    await mkdir(join(workspace, 'AGENTS.md'), { recursive: true })
    const runtime = createRuntime()

    const resolution = await runtime.resolveTurn({ workspace })

    expect(resolution.sources).toEqual([])
    expect(runtime.diagnostics().readErrors[0]).toMatchObject({
      path: join(workspace, 'AGENTS.md'),
      message: 'AGENTS.md is not a file'
    })
  })

  it('refuses a workspace AGENTS.md symlink to an external file', async () => {
    const secretPath = join(root, 'outside-secret.txt')
    await writeFile(secretPath, 'PRIVATE KEY MATERIAL', 'utf8')
    await symlink(secretPath, join(workspace, 'AGENTS.md'))
    const runtime = createRuntime()

    const resolution = await runtime.resolveTurn({ workspace })

    expect(resolution.instruction).toBeUndefined()
    expect(resolution.sources).toEqual([])
    expect(runtime.diagnostics().readErrors).toContainEqual({
      path: join(workspace, 'AGENTS.md'),
      message: 'workspace AGENTS.md must not be a symbolic link'
    })
  })

  it('truncates files and respects the total instruction budget', async () => {
    await writeAgents(join(home, '.kun'), 'g'.repeat(128))
    await writeAgents(workspace, 'w'.repeat(128))
    const config = KunCapabilitiesConfig.parse({
      instructions: { enabled: true, maxFileBytes: 32, maxTotalBytes: 800 }
    }).instructions
    const runtime = new InstructionRuntime(config, { homeDir: home })

    const resolution = await runtime.resolveTurn({ workspace })

    expect(resolution.sources.some((source) => source.truncated)).toBe(true)
    expect(resolution.injectedBytes).toBeLessThanOrEqual(800)
    expect(resolution.instruction).toContain('AGENTS.md truncated')
  })

  it('can be disabled by config', async () => {
    await writeAgents(workspace, 'Workspace rule.')
    const config = KunCapabilitiesConfig.parse({
      instructions: { enabled: false }
    }).instructions
    const runtime = new InstructionRuntime(config, { homeDir: home })

    const resolution = await runtime.resolveTurn({ workspace })

    expect(resolution.sources).toEqual([])
    expect(resolution.instruction).toBeUndefined()
    expect(runtime.diagnostics().enabled).toBe(false)
  })

  it('injects AGENTS.md into AgentLoop context and turn metadata without changing the stable prefix', async () => {
    await writeAgents(join(home, '.kun'), 'Global agent rule.')
    await writeAgents(workspace, 'Workspace agent rule.')
    const instructionRuntime = createRuntime()
    let seenRequest: ModelRequest | undefined
    const model: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream(request) {
        seenRequest = request
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const h = makeHarness(model, { instructionRuntime })
    const prefixFingerprint = h.prefix.fingerprint
    await bootstrapThread(h, { workspace, request: { prompt: 'hello' } })

    await h.loop.runTurn(h.threadId, h.turnId)

    const instructions = seenRequest ? modelRequestContextText(seenRequest) : ''
    expect(instructions).toContain('Global agent rule.')
    expect(instructions).toContain('Workspace agent rule.')
    expect(seenRequest?.systemPrompt).toBe(h.prefix.systemPrompt)
    expect(h.prefix.fingerprint).toBe(prefixFingerprint)
    const turn = await h.turns.getTurn(h.threadId, h.turnId)
    expect(turn?.injectedInstructionSources.map((source) => source.scope)).toEqual(['global', 'workspace'])
    expect(turn?.instructionInjectionBytes).toBeGreaterThan(0)
  })

  function createRuntime(): InstructionRuntime {
    const config = KunCapabilitiesConfig.parse({
      instructions: { enabled: true }
    }).instructions
    return new InstructionRuntime(config, { homeDir: home })
  }
})

async function writeAgents(dir: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'AGENTS.md'), text, 'utf8')
}
