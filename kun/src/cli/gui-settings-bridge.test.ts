import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildRuntimeCapabilityManifest } from '../contracts/capabilities.js'
import { publishRuntimeDiscovery } from '../server/runtime-discovery.js'
import {
  hasUnpublishedGuiRuntime,
  modelConnectionSnapshotFromGuiSettings,
  projectModelSelectionToGuiSettings,
  readGuiSharedSettings,
  resolveLegacyGuiRuntime,
  syncGuiProviderCatalogToConfig
} from './gui-settings-bridge.js'

describe('GUI settings bridge', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('discovers the GUI data dir and strips credential fields from the parsed catalog', async () => {
    const fixture = await createFixture()
    const settings = await readGuiSharedSettings({
      env: { KUN_GUI_SETTINGS_PATH: fixture.settingsPath },
      platform: 'darwin',
      homeDir: fixture.home
    })

    expect(settings).toMatchObject({
      dataDir: fixture.dataDir,
      defaultProviderId: 'codex',
      defaultModel: 'gpt-5.6-luna',
      defaultApprovalPolicy: 'auto',
      defaultSandboxMode: 'danger-full-access',
      defaultApprovalReviewer: 'agent'
    })
    expect(settings?.providers.map((provider) => provider.id)).toEqual(['deepseek', 'codex', 'kimi-code'])
    expect(settings?.providers[1]).not.toHaveProperty('apiKey')
    expect(settings?.providers[1]?.modelProfiles?.['gpt-5.6-luna']?.reasoning).toEqual({
      supportedEfforts: ['low', 'high'],
      defaultEffort: 'low',
      requestProtocol: 'openai-responses'
    })
  })

  it('keeps the current GUI profile authoritative when it contains a newer provider transport', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kun-gui-settings-forward-compatible-'))
    roots.push(home)
    const supportDir = join(home, 'Library', 'Application Support', 'Kun')
    const currentPath = join(supportDir, 'kun-settings.json')
    const stalePath = join(supportDir, 'deepseek-gui-settings.json')
    const dataDir = join(home, '.deepseekgui', 'kun')
    await mkdir(supportDir, { recursive: true })
    await writeFile(currentPath, JSON.stringify({
      provider: {
        providers: [
          {
            id: 'deepseek', name: 'DeepSeek', apiKey: 'current-secret',
            baseUrl: 'https://api.deepseek.com', endpointFormat: 'chat_completions',
            models: ['deepseek-v4-pro']
          },
          {
            id: 'gemini-subscription', name: 'Gemini subscription', apiKey: 'oauth-json',
            kind: 'gemini-code-assist', baseUrl: 'https://cloudcode-pa.googleapis.com',
            endpointFormat: 'custom_endpoint', models: ['gemini-3.1-pro-preview']
          },
          {
            id: 'future-provider', name: 'Future provider', apiKey: 'future-secret',
            kind: 'transport-from-the-future', baseUrl: 'https://future.invalid',
            endpointFormat: 'chat_completions', models: ['future-model']
          }
        ]
      },
      agents: {
        kun: {
          dataDir, providerId: 'gemini-subscription', model: 'gemini-3.1-pro-preview',
          port: 18899, runtimeToken: 'current-runtime-token'
        }
      }
    }), 'utf8')
    await writeFile(stalePath, JSON.stringify({
      provider: {
        providers: [{
          id: 'deepseek', name: 'DeepSeek', apiKey: 'stale-secret',
          baseUrl: 'https://api.deepseek.com', endpointFormat: 'chat_completions',
          models: ['deepseek-v4-pro']
        }]
      },
      agents: {
        kun: {
          dataDir: join(home, '.kun', 'data'), providerId: 'deepseek', model: 'deepseek-v4-pro',
          port: 7878, runtimeToken: 'stale-runtime-token'
        }
      }
    }), 'utf8')

    const settings = await readGuiSharedSettings({
      env: {},
      platform: 'darwin',
      homeDir: home
    })

    expect(settings).toMatchObject({
      settingsPath: currentPath,
      dataDir,
      defaultProviderId: 'gemini-subscription',
      defaultModel: 'gemini-3.1-pro-preview'
    })
    expect(settings?.providers.map((provider) => [provider.id, provider.kind])).toEqual([
      ['deepseek', 'http'],
      ['gemini-subscription', 'gemini-code-assist']
    ])
    expect(JSON.stringify(settings)).not.toContain('current-secret')
    expect(JSON.stringify(settings)).not.toContain('oauth-json')
    expect(JSON.stringify(settings)).not.toContain('future-secret')

    const snapshot = modelConnectionSnapshotFromGuiSettings(settings!)
    expect(snapshot.providers.map((provider) => [provider.id, provider.kind])).toEqual([
      ['deepseek', 'http'],
      ['gemini-subscription', 'gemini-code-assist']
    ])
    const result = await syncGuiProviderCatalogToConfig(dataDir, settings!)
    expect(result?.config.serve.providers?.['gemini-subscription']).toMatchObject({
      kind: 'gemini-code-assist',
      models: ['gemini-3.1-pro-preview']
    })
  })

  it('atomically projects every GUI model catalog without copying secrets', async () => {
    const fixture = await createFixture()
    const settings = await readGuiSharedSettings({
      env: { KUN_GUI_SETTINGS_PATH: fixture.settingsPath },
      platform: 'darwin',
      homeDir: fixture.home
    })
    expect(settings).not.toBeNull()

    const result = await syncGuiProviderCatalogToConfig(fixture.dataDir, settings!)
    expect(result?.changed).toBe(true)
    const configPath = join(fixture.dataDir, 'config.json')
    const text = await readFile(configPath, 'utf8')
    const config = JSON.parse(text)
    expect(text).not.toContain('gui-secret')
    expect(config.serve).toMatchObject({
      credentialSourceId: 'settings:provider:codex',
      model: 'gpt-5.6-luna',
      approvalPolicy: 'auto',
      sandboxMode: 'danger-full-access',
      approvalReviewer: 'agent'
    })
    expect(config.serve.providers.deepseek.models).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash'])
    expect(config.serve.providers.codex.models).toEqual(['gpt-5.6-luna', 'gpt-5.6-sol'])
    expect(config.serve.providers['kimi-code'].models).toEqual(['kimi-for-coding', 'kimi-for-coding-highspeed'])
    expect(config.serve.providers.codex.modelCapabilities['gpt-5.6-luna'].reasoning).toEqual({
      supportedEfforts: ['low', 'high'],
      defaultEffort: 'low',
      requestProtocol: 'openai-responses'
    })
    expect(config.serve.providers.codex.apiKey).toBe('')
    expect(config.serve.providers.codex.credentialSourceId).toBe('settings:provider:codex')
    expect(config.capabilities.futureGuiCapability).toEqual({ enabled: true, protocol: 'future-v2' })
    if (process.platform !== 'win32') {
      expect((await stat(configPath)).mode & 0o777).toBe(0o600)
    }
    expect(result?.applyRequest.serve?.providers?.codex?.models).toEqual(['gpt-5.6-luna', 'gpt-5.6-sol'])
    expect(result?.applyRequest.serve).toMatchObject({
      approvalPolicy: 'auto',
      sandboxMode: 'danger-full-access',
      approvalReviewer: 'agent'
    })
    expect(result?.applyRequest.modelSelection).toEqual({
      providerId: 'codex',
      model: 'gpt-5.6-luna'
    })
    expect(result?.applyRequest.models?.profiles?.['gpt-5.6-luna']?.reasoning).toEqual({
      supportedEfforts: ['low', 'high'],
      defaultEffort: 'low',
      requestProtocol: 'openai-responses'
    })
  })

  it('preserves canonical permission defaults when legacy GUI settings omit them', async () => {
    const fixture = await createFixture()
    const rawSettings = JSON.parse(await readFile(fixture.settingsPath, 'utf8'))
    delete rawSettings.agents.kun.approvalPolicy
    delete rawSettings.agents.kun.sandboxMode
    delete rawSettings.agents.kun.approvalReviewer
    await writeFile(fixture.settingsPath, JSON.stringify(rawSettings), 'utf8')

    const configPath = join(fixture.dataDir, 'config.json')
    const rawConfig = JSON.parse(await readFile(configPath, 'utf8'))
    rawConfig.serve.approvalPolicy = 'never'
    rawConfig.serve.sandboxMode = 'read-only'
    await writeFile(configPath, JSON.stringify(rawConfig), 'utf8')

    const settings = await readGuiSharedSettings({
      env: { KUN_GUI_SETTINGS_PATH: fixture.settingsPath },
      platform: 'darwin',
      homeDir: fixture.home
    })
    expect(settings).not.toHaveProperty('defaultApprovalPolicy')
    expect(settings).not.toHaveProperty('defaultSandboxMode')
    expect(settings).not.toHaveProperty('defaultApprovalReviewer')

    const result = await syncGuiProviderCatalogToConfig(fixture.dataDir, settings!)
    expect(result?.config.serve).toMatchObject({
      approvalPolicy: 'never',
      sandboxMode: 'read-only'
    })
    expect(result?.applyRequest.serve).toMatchObject({
      approvalPolicy: 'never',
      sandboxMode: 'read-only'
    })
  })

  it('projects only the shared default back to GUI settings and preserves secrets and unrelated fields', async () => {
    const fixture = await createFixture()
    const settings = await readGuiSharedSettings({
      env: { KUN_GUI_SETTINGS_PATH: fixture.settingsPath },
      platform: 'darwin',
      homeDir: fixture.home
    })
    const projected = await projectModelSelectionToGuiSettings(settings!, {
      defaultProviderId: 'kimi-code',
      defaultModel: 'kimi-for-coding-highspeed'
    })
    const raw = JSON.parse(await readFile(fixture.settingsPath, 'utf8'))

    expect(projected).toMatchObject({
      defaultProviderId: 'kimi-code',
      defaultModel: 'kimi-for-coding-highspeed'
    })
    expect(raw.agents.kun).toMatchObject({
      providerId: 'kimi-code',
      model: 'kimi-for-coding-highspeed',
      runtimeToken: 'legacy-runtime-secret'
    })
    expect(raw.provider.providers.find((provider: { id: string }) => provider.id === 'codex')?.apiKey)
      .toBe('gui-secret-codex')
  })

  it('does not import GUI metadata into an unrelated explicit data dir', async () => {
    const fixture = await createFixture()
    const settings = await readGuiSharedSettings({
      env: { KUN_GUI_SETTINGS_PATH: fixture.settingsPath },
      platform: 'darwin',
      homeDir: fixture.home
    })
    const unrelated = join(fixture.home, '.kun', 'other')
    expect(await syncGuiProviderCatalogToConfig(unrelated, settings!)).toBeNull()
    await expect(stat(join(unrelated, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('detects an older GUI runtime before a second writer starts in the same data dir', async () => {
    const fixture = await createFixture()
    const settings = await readGuiSharedSettings({
      env: { KUN_GUI_SETTINGS_PATH: fixture.settingsPath },
      platform: 'darwin',
      homeDir: fixture.home
    })
    const fetchImpl = async () => new Response(JSON.stringify({ dataDir: fixture.dataDir }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
    expect(await hasUnpublishedGuiRuntime(settings!, fetchImpl as typeof fetch)).toBe(true)
  })

  it('does not let stale discovery hide an older GUI-private writer', async () => {
    const fixture = await createFixture()
    const settings = await readGuiSharedSettings({
      env: { KUN_GUI_SETTINGS_PATH: fixture.settingsPath },
      platform: 'darwin',
      homeDir: fixture.home
    })
    await publishRuntimeDiscovery(fixture.dataDir, {
      instanceId: 'stale-shared',
      pid: process.pid,
      startedAt: '2026-07-20T00:00:00.000Z',
      host: '127.0.0.1',
      port: 19998,
      baseUrl: 'http://127.0.0.1:19998',
      runtimeToken: 'stale-token',
      insecure: false
    })
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes(':19998/')) return new Response('', { status: 404 })
      return Response.json({ dataDir: fixture.dataDir })
    }) as unknown as typeof fetch

    expect(await hasUnpublishedGuiRuntime(settings!, fetchImpl)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('normalizes and attaches to a verified legacy GUI runtime without exposing credentials', async () => {
    const fixture = await createFixture()
    const settings = await readGuiSharedSettings({
      env: { KUN_GUI_SETTINGS_PATH: fixture.settingsPath },
      platform: 'darwin',
      homeDir: fixture.home
    })
    const fetchImpl = vi.fn(async () => Response.json({
      host: '127.0.0.1',
      port: 19999,
      dataDir: fixture.dataDir,
      model: 'gpt-5.6-luna',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      startedAt: '2026-07-23T00:00:00.000Z',
      pid: process.pid,
      capabilities: buildRuntimeCapabilityManifest({
        model: {
          id: 'gpt-5.6-luna', inputModalities: ['text'], outputModalities: ['text'],
          supportsToolCalling: true, messageParts: ['text']
        }
      })
    })) as unknown as typeof fetch

    const connection = await resolveLegacyGuiRuntime(settings!, fetchImpl)
    expect(connection).toMatchObject({
      baseUrl: 'http://127.0.0.1:19999',
      runtimeToken: 'legacy-runtime-secret',
      runtimeInfo: { instanceId: `legacy-gui:${process.pid}`, serviceVersion: 'legacy-gui', launchMode: 'gui' }
    })
    expect(new Headers((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.headers).get('authorization'))
      .toBe('Bearer legacy-runtime-secret')

    const snapshot = modelConnectionSnapshotFromGuiSettings(settings!)
    expect(snapshot).toMatchObject({
      defaultProviderId: 'codex',
      defaultAccountId: 'account:codex',
      defaultModel: 'gpt-5.6-luna'
    })
    expect(snapshot.providers.map((provider) => [provider.id, provider.models.length])).toEqual([
      ['deepseek', 2], ['codex', 2], ['kimi-code', 2]
    ])
    expect(snapshot.providers.find((provider) => provider.id === 'codex')
      ?.modelCapabilities?.['gpt-5.6-luna']?.reasoning).toEqual({
        supportedEfforts: ['low', 'high'],
        defaultEffort: 'low',
        requestProtocol: 'openai-responses'
      })
    expect(JSON.stringify(snapshot)).not.toContain('legacy-runtime-secret')
    expect(JSON.stringify(snapshot)).not.toContain('gui-secret')
  })

  it('projects audited GLM reasoning capabilities into legacy GUI catalogs', () => {
    const snapshot = modelConnectionSnapshotFromGuiSettings({
      settingsPath: '/tmp/kun-settings.json',
      dataDir: '/tmp/kun-data',
      defaultProviderId: 'opencode-go',
      defaultModel: 'glm-5.2',
      legacyRuntimePort: 18899,
      legacyRuntimeToken: 'must-not-be-projected',
      providers: [{
        id: 'opencode-go',
        name: 'OpenCode Go',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        endpointFormat: 'chat_completions',
        kind: 'http',
        models: ['glm-5.2', 'custom-model'],
        modelProfiles: {
          'glm-5.2': {
            inputModalities: ['text'],
            outputModalities: ['text'],
            supportsToolCalling: true,
            messageParts: ['text'],
            reasoning: {
              supportedEfforts: ['auto'],
              defaultEffort: 'auto',
              requestProtocol: 'none'
            }
          }
        }
      }]
    })

    expect(snapshot.providers[0]?.modelCapabilities?.['glm-5.2']?.reasoning).toEqual({
      supportedEfforts: ['off', 'high', 'max'],
      defaultEffort: 'max',
      requestProtocol: 'glm-chat-completions'
    })
    expect(snapshot.providers[0]?.modelCapabilities?.['custom-model']?.reasoning).toBeUndefined()
    expect(JSON.stringify(snapshot)).not.toContain('must-not-be-projected')
  })

  it('projects audited Codex reasoning when an older GUI profile omitted it', () => {
    const snapshot = modelConnectionSnapshotFromGuiSettings({
      settingsPath: '/tmp/kun-settings.json',
      dataDir: '/tmp/kun-data',
      defaultProviderId: 'codex',
      defaultModel: 'gpt-5.6-luna',
      legacyRuntimePort: 18899,
      legacyRuntimeToken: '',
      providers: [{
        id: 'codex',
        name: 'ChatGPT subscription',
        baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
        endpointFormat: 'custom_endpoint',
        kind: 'http',
        models: ['gpt-5.6-luna']
      }]
    })

    expect(snapshot.providers[0]?.modelCapabilities?.['gpt-5.6-luna']?.reasoning).toEqual({
      supportedEfforts: ['low', 'medium', 'high', 'max'],
      defaultEffort: 'high',
      requestProtocol: 'openai-responses'
    })
  })

  it.each([
    ['kimi-code', 'k3', 'https://api.kimi.com/coding/v1', 'openai-chat-completions'],
    ['grok-subscription', 'grok-4.5', 'https://cli-chat-proxy.grok.com/v1', 'openai-responses'],
    ['claude-subscription', 'claude-sonnet-4-6', 'https://api.anthropic.com', 'anthropic-thinking'],
    ['aliyun', 'qwq-plus', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-chat-completions'],
    ['volcengine-coding-plan', 'doubao-seed-1-6-250615', 'https://ark.cn-beijing.volces.com/api/coding/v3', 'thinking-toggle-chat-completions'],
    ['zenmux', 'openai/gpt-5.4', 'https://zenmux.ai/api/v1', 'openai-chat-completions']
  ])('repairs an older %s/%s GUI catalog with its real protocol', (
    providerId,
    model,
    baseUrl,
    requestProtocol
  ) => {
    const snapshot = modelConnectionSnapshotFromGuiSettings({
      settingsPath: '/tmp/kun-settings.json',
      dataDir: '/tmp/kun-data',
      defaultProviderId: providerId,
      defaultModel: model,
      legacyRuntimePort: 18899,
      legacyRuntimeToken: '',
      providers: [{
        id: providerId,
        name: providerId,
        baseUrl,
        endpointFormat: providerId === 'grok-subscription' ? 'responses' : 'chat_completions',
        kind: providerId === 'claude-subscription' ? 'agent-sdk' : 'http',
        models: [model]
      }]
    })

    expect(snapshot.providers[0]?.modelCapabilities?.[model]?.reasoning?.requestProtocol)
      .toBe(requestProtocol)
  })

  it('upgrades the obsolete Kimi K3 Responses profile to its chat protocol', () => {
    const snapshot = modelConnectionSnapshotFromGuiSettings({
      settingsPath: '/tmp/kun-settings.json',
      dataDir: '/tmp/kun-data',
      defaultProviderId: 'kimi-code',
      defaultModel: 'k3',
      legacyRuntimePort: 18899,
      legacyRuntimeToken: '',
      providers: [{
        id: 'kimi-code',
        name: 'Kimi Code',
        baseUrl: 'https://api.kimi.com/coding/v1',
        endpointFormat: 'chat_completions',
        kind: 'http',
        models: ['k3'],
        modelProfiles: {
          k3: {
            inputModalities: ['text', 'image'],
            outputModalities: ['text'],
            supportsToolCalling: true,
            messageParts: ['text', 'image_url'],
            reasoning: {
              supportedEfforts: ['off', 'low', 'medium', 'high', 'max'],
              defaultEffort: 'high',
              requestProtocol: 'openai-responses'
            }
          }
        }
      }]
    })

    expect(snapshot.providers[0]?.modelCapabilities?.k3?.reasoning).toEqual({
      supportedEfforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
      requestProtocol: 'openai-chat-completions'
    })
  })

  async function createFixture(): Promise<{
    home: string
    dataDir: string
    settingsPath: string
  }> {
    const home = await mkdtemp(join(tmpdir(), 'kun-gui-settings-bridge-'))
    roots.push(home)
    const dataDir = join(home, '.deepseekgui', 'kun')
    const settingsPath = join(home, 'Library', 'Application Support', 'Kun', 'kun-settings.json')
    await mkdir(join(dataDir, 'extensions'), { recursive: true })
    await mkdir(join(settingsPath, '..'), { recursive: true })
    await writeFile(settingsPath, JSON.stringify({
      provider: {
        providers: [
          {
            id: 'deepseek', name: 'DeepSeek', apiKey: 'gui-secret-deepseek',
            baseUrl: 'https://api.deepseek.com', endpointFormat: 'chat_completions',
            models: ['deepseek-v4-pro', 'deepseek-v4-flash']
          },
          {
            id: 'codex', name: 'ChatGPT subscription', apiKey: 'gui-secret-codex',
            baseUrl: 'https://chatgpt.com/backend-api/codex/responses', endpointFormat: 'custom_endpoint',
            models: ['gpt-5.6-luna', 'gpt-5.6-sol'],
            modelProfiles: {
              'gpt-5.6-luna': {
                contextWindowTokens: 372000,
                inputModalities: ['text', 'image'],
                outputModalities: ['text'],
                supportsToolCalling: true,
                messageParts: ['text', 'image_url'],
                reasoning: {
                  supportedEfforts: ['low', 'high'],
                  defaultEffort: 'low',
                  requestProtocol: 'openai-responses'
                },
                responsesMode: 'lite'
              }
            }
          },
          {
            id: 'kimi-code', name: 'Kimi Code', apiKey: 'gui-secret-kimi',
            baseUrl: 'https://api.kimi.com/coding/v1', endpointFormat: 'chat_completions',
            models: ['kimi-for-coding', 'kimi-for-coding-highspeed']
          }
        ]
      },
      agents: {
        kun: {
          dataDir, providerId: 'codex', model: 'gpt-5.6-luna',
          port: 19999, runtimeToken: 'legacy-runtime-secret',
          approvalPolicy: 'auto', sandboxMode: 'danger-full-access',
          approvalReviewer: 'agent'
        }
      }
    }), 'utf8')
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({
      serve: {
        apiKey: '',
        baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
        endpointFormat: 'custom_endpoint',
        credentialSourceId: 'settings:provider:codex',
        model: 'gpt-5.6-luna',
        providers: {
          deepseek: {
            apiKey: '', credentialSourceId: 'settings:provider:deepseek',
            baseUrl: 'https://api.deepseek.com', endpointFormat: 'chat_completions'
          },
          codex: {
            apiKey: '', credentialSourceId: 'settings:provider:codex',
            baseUrl: 'https://chatgpt.com/backend-api/codex/responses', endpointFormat: 'custom_endpoint'
          },
          'kimi-code': {
            apiKey: '', credentialSourceId: 'settings:provider:kimi-code',
            baseUrl: 'https://api.kimi.com/coding/v1', endpointFormat: 'chat_completions'
          }
        }
      },
      capabilities: {
        futureGuiCapability: { enabled: true, protocol: 'future-v2' }
      }
    }), 'utf8')
    return { home, dataDir, settingsPath }
  }
})
