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
  it('uses full access for a genuinely new serve profile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kun-fresh-serve-'))
    try {
      expect(parseServeOptions(['--data-dir', dir])).toMatchObject({
        approvalPolicy: 'auto',
        sandboxMode: 'danger-full-access',
        approvalReviewer: 'user'
      })
      expect(validateServeOptions({ dataDir: dir })).toMatchObject({
        approvalPolicy: 'auto',
        sandboxMode: 'danger-full-access',
        approvalReviewer: 'user'
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps compatibility defaults for an existing config that predates permission fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kun-legacy-serve-'))
    try {
      const configPath = join(dir, 'config.json')
      await writeFile(configPath, JSON.stringify({
        serve: { dataDir: join(dir, 'data'), model: 'legacy-model' }
      }), 'utf8')
      expect(parseServeOptions(['--config', configPath])).toMatchObject({
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        approvalReviewer: 'user'
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('parses serve options with the canonical flags', () => {
    const parsed = parseServeOptions([
      '--host',
      '127.0.0.1',
      '--port',
      '18787',
      '--data-dir',
      '/tmp/ca',
      '--runtime-token',
      'abc',
      '--model',
      'deepseek-chat',
      '--approval-policy',
      'auto',
      '--sandbox-mode',
      'workspace-write',
      '--approval-reviewer',
      'agent',
      '--token-economy',
      '--insecure'
    ])
    expect(parsed.host).toBe('127.0.0.1')
    expect(parsed.port).toBe(18787)
    expect(parsed.tokenEconomyMode).toBe(true)
    expect(parsed.approvalReviewer).toBe('agent')
    expect(parsed.tokenEconomy?.enabled).toBe(true)
    expect(parsed.toolOutputLimits).toEqual({
      maxLines: DEFAULT_TOOL_OUTPUT_MAX_LINES,
      maxBytes: DEFAULT_TOOL_OUTPUT_MAX_BYTES
    })
    expect(parsed.insecure).toBe(true)
  })

  it('rejects insecure serve on a non-loopback host', () => {
    expect(() => parseServeOptions([
      '--data-dir', '/tmp/kun',
      '--host', '0.0.0.0',
      '--insecure'
    ])).toThrow(/loopback host/)
    expect(() => parseServeOptions([
      '--data-dir', '/tmp/kun',
      '--host', '127.evil.example',
      '--insecure'
    ])).toThrow(/loopback host/)
    expect(() => parseServeOptions([
      '--data-dir', '/tmp/kun',
      '--host', 'localhost',
      '--insecure'
    ])).toThrow(/loopback host/)
  })

  it('parses flags in --key=value form', () => {
    const parsed = parseServeOptions([
      '--host=0.0.0.0',
      '--port=19090',
      '--data-dir=/srv/ca',
      '--storage-backend=file'
    ])
    expect(parsed.host).toBe('0.0.0.0')
    expect(parsed.port).toBe(19090)
    expect(parsed.dataDir).toBe('/srv/ca')
    expect(parsed.storage.backend).toBe('file')
  })

  it('accepts the product-owned bundled extension directory from CLI or environment', () => {
    expect(parseServeOptions([
      '--data-dir=/srv/ca',
      '--bundled-extensions-dir=/opt/kun/bundled-extensions'
    ]).bundledExtensionsDir).toBe('/opt/kun/bundled-extensions')
    expect(parseServeOptions(['--data-dir=/srv/ca'], {
      KUN_BUNDLED_EXTENSIONS_DIR: '/Applications/Kun/resources/bundled-extensions'
    }).bundledExtensionsDir).toBe('/Applications/Kun/resources/bundled-extensions')
  })

  it('enables sanitized observability from env and output flag', () => {
    const parsed = parseServeOptions([
      '--data-dir=/srv/ca',
      '--observability-output=otel/spans.jsonl'
    ], {
      KUN_OBSERVABILITY: '1'
    })
    expect(parsed.observability).toEqual({
      enabled: true,
      outputPath: 'otel/spans.jsonl',
      includeSensitiveContent: false
    })
  })

  it('enables the OTLP HTTP JSON exporter from standard environment variables', () => {
    const parsed = parseServeOptions(['--data-dir=/srv/ca'], {
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example/otel',
      OTEL_EXPORTER_OTLP_HEADERS: 'api-key=hello%20world',
      OTEL_EXPORTER_OTLP_TIMEOUT: '2500'
    })
    expect(parsed.observability).toEqual({
      enabled: true,
      exporter: 'otlp-http-json',
      endpoint: 'https://collector.example/otel/v1/traces',
      headers: { 'api-key': 'hello world' },
      timeoutMs: 2500,
      includeSensitiveContent: false
    })
  })

  it('treats empty trace-specific OTLP variables as unset and falls back to common values', () => {
    const parsed = parseServeOptions(['--data-dir=/srv/ca'], {
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: ' ',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example/otel',
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: '   ',
      OTEL_EXPORTER_OTLP_HEADERS: 'api-key=common',
      OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '',
      OTEL_EXPORTER_OTLP_TIMEOUT: '3000'
    })

    expect(parsed.observability).toEqual({
      enabled: true,
      exporter: 'otlp-http-json',
      endpoint: 'https://collector.example/otel/v1/traces',
      headers: { 'api-key': 'common' },
      timeoutMs: 3000,
      includeSensitiveContent: false
    })
  })

  it('rejects non-HTTP observability endpoints', () => {
    const base = parseServeOptions(['--data-dir=/srv/ca'])

    expect(() => validateServeOptions({
      ...base,
      observability: {
        enabled: true,
        exporter: 'otlp-http-json',
        endpoint: 'file:///tmp/traces'
      }
    })).toThrow()
    expect(validateServeOptions({
      ...base,
      observability: {
        enabled: true,
        exporter: 'otlp-http-json',
        endpoint: 'https://collector.example/v1/traces'
      }
    }).observability?.endpoint).toBe('https://collector.example/v1/traces')
  })

  it('applies CLI and standard OTLP environment precedence over config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kun-observability-config-'))
    try {
      const configPath = join(dir, 'kun.config.json')
      await writeFile(configPath, JSON.stringify({
        serve: {
          dataDir: join(dir, 'data'),
          observability: {
            enabled: false,
            exporter: 'jsonl',
            endpoint: 'https://config.example/v1/traces'
          }
        }
      }))
      const env = {
        OTEL_TRACES_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://env.example/otel'
      }

      const standard = parseServeOptions(['--config', configPath], env)
      expect(standard.observability).toMatchObject({
        enabled: true,
        exporter: 'otlp-http-json',
        endpoint: 'https://env.example/otel/v1/traces'
      })

      const cli = parseServeOptions([
        '--config', configPath,
        '--observability',
        '--observability-exporter=jsonl'
      ], env)
      expect(cli.observability).toMatchObject({ enabled: true, exporter: 'jsonl' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('loads serve and context compaction settings from an explicit config file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kun-config-'))
    try {
      const configPath = join(dir, 'kun.config.json')
      await writeFile(configPath, JSON.stringify({
        serve: {
          host: '0.0.0.0',
          port: 17777,
          dataDir: join(dir, 'data'),
          model: 'deepseek-v4-flash',
          approvalPolicy: 'auto',
          approvalReviewer: 'agent',
          tokenEconomy: {
            enabled: true,
            compressToolDescriptions: false,
            compressToolResults: true,
            conciseResponses: false,
            historyHygiene: {
              maxToolResultLines: 120,
              maxToolResultBytes: 16384,
              maxToolResultTokens: 4000,
              maxToolArgumentStringBytes: 4096,
              maxToolArgumentStringTokens: 1000,
              maxArrayItems: 40
            }
          },
          toolOutputLimits: {
            maxLines: 30000,
            maxBytes: 1048576
          },
          storage: {
            backend: 'hybrid',
            sqlitePath: join(dir, 'data', 'index.sqlite3')
          }
        },
        contextCompaction: {
          defaultSoftThreshold: 32_000,
          defaultHardThreshold: 48_000,
          summaryMode: 'model',
          summaryTimeoutMs: 15_000,
          summaryMaxTokens: 1_200,
          summaryInputMaxBytes: 98_304
        },
        models: {
          profiles: {
            'custom-1m': {
              aliases: ['vendor/custom-1m'],
              contextWindowTokens: 1_000_000,
              contextCompaction: {
                softRatio: 0.7,
                hardRatio: 0.85
              },
              inputModalities: ['text', 'image'],
              outputModalities: ['text'],
              supportsToolCalling: false,
              messageParts: ['text', 'image_url']
            }
          }
        },
        runtime: {
          toolStorm: {
            enabled: true
          },
          toolArgumentRepair: {
            maxStringBytes: 4096
          }
        },
        capabilities: {
          web: {
            enabled: true,
            fetchEnabled: true,
            searchEnabled: false,
            provider: 'test'
          },
          skills: {
            enabled: true,
            roots: ['/tmp/skills']
          }
        }
      }), 'utf8')

      const parsed = parseServeOptions([
        '--config',
        configPath,
        '--model',
        'deepseek-v4-pro'
      ], {
        KUN_PORT: '19091'
      })

      expect(parsed.configPath).toBe(configPath)
      expect(parsed.host).toBe('0.0.0.0')
      expect(parsed.port).toBe(19091)
      expect(parsed.model).toBe('deepseek-v4-pro')
      expect(parsed.approvalPolicy).toBe('auto')
      expect(parsed.approvalReviewer).toBe('agent')
      expect(parsed.tokenEconomyMode).toBe(true)
      expect(parsed.tokenEconomy).toMatchObject({
        enabled: true,
        compressToolDescriptions: false,
        compressToolResults: true,
        conciseResponses: false,
        historyHygiene: {
          maxToolResultLines: 120,
          maxToolResultBytes: 16384,
          maxToolResultTokens: 4000,
          maxToolArgumentStringBytes: 4096,
          maxToolArgumentStringTokens: 1000,
          maxArrayItems: 40
        }
      })
      expect(parsed.toolOutputLimits).toEqual({
        maxLines: 30000,
        maxBytes: 1048576
      })
      expect(parsed.storage).toEqual({
        backend: 'hybrid',
        sqlitePath: join(dir, 'data', 'index.sqlite3')
      })
      expect(parsed.contextCompaction?.defaultSoftThreshold).toBe(32_000)
      expect(parsed.contextCompaction?.summaryMode).toBe('model')
      expect(parsed.contextCompaction?.summaryTimeoutMs).toBe(15_000)
      expect(parsed.contextCompaction?.summaryMaxTokens).toBe(1_200)
      expect(parsed.contextCompaction?.summaryInputMaxBytes).toBe(98_304)
      expect(parsed.models?.profiles?.['custom-1m']?.contextCompaction?.softRatio).toBe(0.7)
      expect(parsed.models?.profiles?.['custom-1m']?.inputModalities).toEqual(['text', 'image'])
      expect(parsed.runtime?.toolStorm?.enabled).toBe(true)
      expect(parsed.runtime?.toolArgumentRepair?.maxStringBytes).toBe(4096)
      expect(parsed.capabilities.web.enabled).toBe(true)
      expect(parsed.capabilities.web.fetchEnabled).toBe(true)
      expect(parsed.capabilities.skills.roots).toEqual(['/tmp/skills'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
