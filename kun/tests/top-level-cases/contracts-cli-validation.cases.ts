import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ApprovalPolicySchema,
  DEFAULT_APPROVAL_POLICY,
  CreateThreadRequest,
  ThreadGoalSchema,
  ThreadTodoListSchema,
  SetThreadGoalRequest,
  SetThreadTodosRequest,
  RuntimeEvent,
  StartTurnRequest,
  UsageSnapshotSchema,
  AttachmentUploadRequest,
  MemoryRecord,
  KunErrorBody,
  KunCapabilitiesConfig,
  RuntimeCapabilityManifest,
  DEFAULT_TOOL_OUTPUT_MAX_BYTES,
  DEFAULT_TOOL_OUTPUT_MAX_LINES,
  buildRuntimeCapabilityManifest,
  emptyUsageSnapshot,
  type RuntimeEvent as RuntimeEventType
} from '../../src/contracts/index.js'
import {
  modelCapabilitiesForModel,
  modelContextProfilesFromConfig
} from '../../src/loop/model-context-profile.js'
import {
  parseServeOptionsSafe,
  parseServeOptions,
  validateServeOptions,
  SERVE_USAGE,
  ServeExitCode
} from '../../src/cli/serve.js'

describe('cli', () => {
  it('fails loudly for unsupported context compaction scorer overrides', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kun-config-'))
    try {
      const configPath = join(dir, 'kun.config.json')
      await writeFile(configPath, JSON.stringify({
        serve: {
          dataDir: join(dir, 'data')
        },
        contextCompaction: {
          summaryMode: 'heuristic',
          summaryScorer: 'custom'
        }
      }), 'utf8')

      expect(() => parseServeOptions(['--config', configPath]))
        .toThrow(/summaryScorer/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('normalizes capability config to disabled defaults', () => {
    const config = KunCapabilitiesConfig.parse({})
    expect(config.mcp.enabled).toBe(false)
    expect(config.mcp.search.enabled).toBe(false)
    expect(config.mcp.search.mode).toBe('auto')
    expect(config.web.enabled).toBe(false)
    expect(config.skills.enabled).toBe(false)
    expect(config.subagents.useExistingAgents).toBe(true)
    expect(config.subagents.maxParallel).toBe(256)
    expect(config.attachments.allowedMimeTypes).toContain('image/png')
    expect(config.attachments.textFallbackMaxBase64Bytes).toBe(512 * 1024)
    expect(config.attachments.textFallbackMaxImageDimension).toBe(1280)
    expect(config.attachments.textFallbackPreferredMimeType).toBe('image/webp')
    expect(config.memory.scopes).toEqual(['user', 'workspace', 'project'])
    expect(config.imageGen.enabled).toBe(false)
    expect(config.imageGen.timeoutMs).toBe(180_000)
    expect(config.imageGen.maxReferenceImages).toBe(4)
  })

  it('ignores legacy subagent step-limit config fields', () => {
    const config = KunCapabilitiesConfig.parse({
      subagents: {
        enabled: true,
        maxParallel: 2,
        maxChildRuns: 4,
        defaultStepLimit: 99
      }
    })

    expect(config.subagents).toMatchObject({
      enabled: true,
      useExistingAgents: true,
      maxParallel: 2,
      maxChildRuns: 4
    })
    expect('defaultStepLimit' in config.subagents).toBe(false)
  })

  it('parses subagent profiles and defaults the tool policy to inherit', () => {
    const config = KunCapabilitiesConfig.parse({
      subagents: {
        enabled: true,
        maxParallel: 3,
        maxChildRuns: 10,
        defaultProfile: 'reviewer',
        profiles: {
          reviewer: {
            model: 'deepseek-v4-pro',
            providerId: 'deepseek',
            promptPreamble: 'Review for bugs.',
            toolPolicy: 'readOnly'
          },
          fixer: { toolPolicy: 'inherit' },
          helper: {}
        }
      }
    })
    // Default subagent policy follows the main agent (inherit), not read-only.
    expect(config.subagents.defaultToolPolicy).toBe('inherit')
    expect(config.subagents.defaultProfile).toBe('reviewer')
    // Explicit per-profile policy still wins over the inherit default.
    expect(config.subagents.profiles.reviewer).toMatchObject({ model: 'deepseek-v4-pro', toolPolicy: 'readOnly' })
    expect(config.subagents.profiles.fixer.toolPolicy).toBe('inherit')
    // Profiles default toolPolicy to inherit when omitted.
    expect(config.subagents.profiles.helper.toolPolicy).toBe('inherit')
  })

  it('rejects a defaultProfile that is not defined in profiles', () => {
    expect(() => KunCapabilitiesConfig.parse({
      subagents: { enabled: true, maxParallel: 1, maxChildRuns: 1, defaultProfile: 'ghost' }
    })).toThrow(/defaultProfile/)
    for (const inheritedName of ['constructor', 'toString', '__proto__']) {
      expect(KunCapabilitiesConfig.safeParse({
        subagents: { enabled: true, maxParallel: 1, maxChildRuns: 1, defaultProfile: inheritedName }
      }).success).toBe(false)
    }
  })

  it('surfaces subagent profiles and policy in the runtime capability manifest', () => {
    const manifest = buildRuntimeCapabilityManifest({
      model: modelCapabilitiesForModel('deepseek-chat'),
      config: KunCapabilitiesConfig.parse({
        subagents: {
          enabled: true,
          useExistingAgents: false,
          maxParallel: 2,
          maxChildRuns: 6,
          defaultProfile: 'reviewer',
          profiles: {
            reviewer: {
              model: 'deepseek-v4-pro',
              providerId: 'deepseek',
              toolPolicy: 'readOnly'
            }
          }
        }
      }),
      subagents: { available: true }
    })
    expect(manifest.subagents).toMatchObject({
      useExistingAgents: false,
      maxParallel: 2,
      maxChildRuns: 6,
      defaultToolPolicy: 'inherit',
      defaultProfile: 'reviewer',
      profiles: [{ name: 'reviewer', model: 'deepseek-v4-pro', toolPolicy: 'readOnly' }]
    })
  })

  it('resolves model capability fields from configured profiles', () => {
    const profiles = modelContextProfilesFromConfig({
      models: {
        profiles: {
          'vision-model': {
            contextWindowTokens: 128_000,
            contextCompaction: {
              softRatio: 0.7,
              hardRatio: 0.8
            },
            inputModalities: ['text', 'image'],
            supportsToolCalling: false,
            messageParts: ['text', 'image_url']
          }
        }
      }
    })
    const model = modelCapabilitiesForModel('vision-model', profiles)

    expect(model.contextWindowTokens).toBe(128_000)
    expect(model.inputModalities).toEqual(['text', 'image'])
    expect(model.supportsToolCalling).toBe(false)
    expect(model.messageParts).toEqual(['text', 'image_url'])
  })

  it('keeps legacy contextCompaction model profiles as a compatibility path', () => {
    const profiles = modelContextProfilesFromConfig({
      contextCompaction: {
        modelProfiles: {
          'legacy-model': {
            contextWindowTokens: 64_000,
            softThreshold: 48_000,
            hardThreshold: 56_000
          }
        }
      }
    })
    const model = modelCapabilitiesForModel('legacy-model', profiles)
    const legacy = profiles.find((profile) => profile.canonicalModel === 'legacy-model')

    expect(model.contextWindowTokens).toBe(64_000)
    expect(legacy?.softThreshold).toBe(48_000)
    expect(legacy?.hardThreshold).toBe(56_000)
  })

  it('uses 75%/85% of the window as the built-in DeepSeek v4 compaction thresholds', () => {
    // Compaction must trigger with headroom to spare. Triggering at
    // 98%/99% left no room for a large turn to land before the window was
    // exceeded, so the built-in ratios are 0.75 / 0.85 of the 1M window.
    const profile = modelContextProfilesFromConfig()
      .find((candidate) => candidate.canonicalModel === 'deepseek-v4-pro')

    expect(profile?.contextWindowTokens).toBe(1_000_000)
    expect(profile?.softThreshold).toBe(750_000)
    expect(profile?.hardThreshold).toBe(850_000)
  })

  it('keeps built-in DeepSeek v4 models text-only', () => {
    for (const modelId of ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat'] as const) {
      const model = modelCapabilitiesForModel(modelId)
      expect(model.inputModalities).toEqual(['text'])
      expect(model.messageParts).toEqual(['text'])
    }
  })

  it('builds runtime capability manifests with unavailable reasons', () => {
    const manifest = RuntimeCapabilityManifest.parse(buildRuntimeCapabilityManifest({
      model: modelCapabilitiesForModel('deepseek-chat')
    }))
    expect(manifest.contractVersion).toBe(1)
    expect(manifest.model.inputModalities).toContain('text')
    expect(manifest.mcp.available).toBe(false)
    expect(manifest.mcp.reason).toMatch(/disabled/)
    expect(manifest.mcp.search.enabled).toBe(false)
    expect(manifest.mcp.search.active).toBe(false)
    expect(manifest.attachments.textFallbackMaxBase64Bytes).toBe(512 * 1024)
    expect(manifest.attachments.textFallbackMaxImageDimension).toBe(1280)
    expect(manifest.attachments.textFallbackPreferredMimeType).toBe('image/webp')
    expect(manifest.imageGen.available).toBe(false)
    expect(manifest.imageGen.supportsReferenceEdit).toBe(false)
    expect(manifest.imageGen.reason).toMatch(/disabled/)

    const enabledButMissingProvider = buildRuntimeCapabilityManifest({
      model: modelCapabilitiesForModel('deepseek-chat'),
      config: KunCapabilitiesConfig.parse({
        web: { enabled: true, fetchEnabled: true, searchEnabled: true, provider: 'test' }
      })
    })
    expect(enabledButMissingProvider.web.enabled).toBe(true)
    expect(enabledButMissingProvider.web.available).toBe(false)
    expect(enabledButMissingProvider.web.reason).toMatch(/no web providers/)
  })

  it('loads config.json from the data dir when present', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-data-'))
    try {
      await writeFile(join(dataDir, 'config.json'), JSON.stringify({
        serve: {
          baseUrl: 'https://example.invalid/v1',
          model: 'deepseek-v4-flash',
          retry: {
            maxAttempts: 3,
            initialDelayMs: 1000,
            httpStatusCodes: [429]
          }
        },
        contextCompaction: {
          defaultSoftThreshold: 12_345,
          defaultHardThreshold: 23_456
        }
      }), 'utf8')

      const parsed = parseServeOptions(['--data-dir', dataDir])

      expect(parsed.configPath).toBe(join(dataDir, 'config.json'))
      expect(parsed.dataDir).toBe(dataDir)
      expect(parsed.baseUrl).toBe('https://example.invalid/v1')
      expect(parsed.model).toBe('deepseek-v4-flash')
      expect(parsed.retry).toEqual({
        maxAttempts: 3,
        initialDelayMs: 1000,
        httpStatusCodes: [429]
      })
      expect(parsed.approvalPolicy).toBe(DEFAULT_APPROVAL_POLICY)
      expect(parsed.contextCompaction?.defaultHardThreshold).toBe(23_456)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('returns a structured error when data-dir is missing', () => {
    const result = parseServeOptionsSafe([
      '--host',
      '127.0.0.1',
      '--port',
      '18899'
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(ServeExitCode.config)
    }
  })

  it('validates pre-constructed options', () => {
    const parsed = validateServeOptions({
      host: '127.0.0.1',
      port: 18899,
      dataDir: '/srv/ca',
      runtimeToken: '',
      model: 'deepseek-chat',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      insecure: false
    })
    expect(parsed.port).toBe(18899)
    expect(parsed.storage.backend).toBe('hybrid')
    expect(parsed.capabilities.mcp.enabled).toBe(false)
  })

  it('exposes a usage string', () => {
    expect(SERVE_USAGE).toContain('kun serve')
  })

  it('surfaces zod issues for invalid configurations', () => {
    const result = parseServeOptionsSafe([
      '--port=abc',
      '--data-dir=/srv/ca'
    ])
    expect(result.ok).toBe(false)
  })

  it('flags unknown enum values through the schema', () => {
    const result = ApprovalPolicySchema.safeParse('mystery')
    expect(result.success).toBe(false)
  })
})
