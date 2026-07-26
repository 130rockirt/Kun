import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_CHECKPOINT_CLEANUP_ENABLED,
  DEFAULT_CHECKPOINT_CLEANUP_INTERVAL_DAYS,
  DEFAULT_GIT_CHECKPOINT_CREATE_ENABLED,
  defaultKunRuntimeSettings,
  defaultModelProviderSettings
} from '../shared/app-settings'
import { DEFAULT_GUI_UPDATE_CHANNEL } from '../shared/gui-update'
import { JsonSettingsStore } from './settings-store'

type SettingsStoreModule = typeof import('./settings-store')

async function withMockedHome<T>(
  homeDir: string,
  run: (settingsStore: SettingsStoreModule) => Promise<T>
): Promise<T> {
  vi.resetModules()
  vi.doMock('node:os', () => ({ homedir: () => homeDir }))
  try {
    return await run(await import('./settings-store'))
  } finally {
    vi.doUnmock('node:os')
    vi.resetModules()
  }
}

describe('JsonSettingsStore', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults GUI updates to the stable channel for new settings', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))

    const store = new JsonSettingsStore(userDataDir)
    const loaded = await store.load()

    expect(loaded.guiUpdate.channel).toBe(DEFAULT_GUI_UPDATE_CHANNEL)
    expect(loaded.agents.kun.approvalPolicy).toBe(DEFAULT_APPROVAL_POLICY)
    expect(loaded.checkpointCleanup.intervalDays).toBe(DEFAULT_CHECKPOINT_CLEANUP_INTERVAL_DAYS)
    // Checkpoint cleanup is enabled by default to keep stale checkpoints from accumulating.
    expect(loaded.checkpointCleanup.enabled).toBe(DEFAULT_CHECKPOINT_CLEANUP_ENABLED)
    expect(loaded.checkpointCleanup.createEnabled).toBe(DEFAULT_GIT_CHECKPOINT_CREATE_ENABLED)
    expect(loaded.appBehavior).toEqual({
      openAtLogin: false,
      startMinimized: false,
      closeAction: 'ask',
      closeToTray: false
    })
  })

  it('patches and normalizes checkpoint cleanup settings', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))

    const store = new JsonSettingsStore(userDataDir)
    const patched = await store.patch({ checkpointCleanup: { intervalDays: 5 } })
    expect(patched.checkpointCleanup.intervalDays).toBe(5)

    const clamped = await store.patch({
      checkpointCleanup: { intervalDays: 99 as unknown as typeof patched.checkpointCleanup.intervalDays }
    })
    expect(clamped.checkpointCleanup.intervalDays).toBe(10)
  })

  it('creates the app-managed default workspaces and welcome file', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const homeDir = await mkdtemp(join(tmpdir(), 'ds-gui-home-'))

    await withMockedHome(homeDir, async ({ JsonSettingsStore: Store }) => {
      const store = new Store(userDataDir)
      const loaded = await store.load()

      expect(loaded.write.defaultWorkspaceRoot).toContain('.kun')
      expect(loaded.write.workspaces).toContain(loaded.write.defaultWorkspaceRoot)
      expect(loaded.write.inlineCompletion.enabled).toBe(true)
      expect(loaded.write.inlineCompletion.retrievalEnabled).toBe(true)
      expect(loaded.write.inlineCompletion.longCompletionEnabled).toBe(true)
      expect(loaded.provider.baseUrl).toBe('https://api.deepseek.com')
      expect(loaded.write.inlineCompletion.apiKey).toBe('')
      expect(loaded.write.inlineCompletion.baseUrl).toBe('')
      expect(loaded.write.inlineCompletion.inheritModel).toBe(true)
      expect(loaded.write.inlineCompletion.model).toBe('deepseek-v4-flash')
      expect(loaded.write.inlineCompletion.longMaxTokens).toBe(256)
      expect((await stat(loaded.workspaceRoot)).isDirectory()).toBe(true)
      expect((await stat(loaded.write.defaultWorkspaceRoot)).isDirectory()).toBe(true)
      expect((await stat(loaded.conversationWorkspaceRoot)).isDirectory()).toBe(true)
      expect(await readFile(join(loaded.write.defaultWorkspaceRoot, 'welcome.md'), 'utf8'))
        .toContain('Welcome to Write')
    })
  })

  it('preserves the pro write completion model', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))

    await writeFile(
      join(userDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({
        version: 1,
        write: {
          inlineCompletion: {
            model: 'deepseek-v4-pro'
          }
        }
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir)
    const loaded = await store.load()

    expect(loaded.write.inlineCompletion.inheritModel).toBe(false)
    expect(loaded.write.inlineCompletion.model).toBe('deepseek-v4-pro')
  })

  it('preserves disabled Skill IDs when settings are reloaded', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))

    await writeFile(
      join(userDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({
        version: 1,
        disabledSkillIds: ['test-skill-08', '/skill:test-skill-09', '']
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir)
    const loaded = await store.load()

    expect(loaded.disabledSkillIds).toEqual(['test-skill-08', 'test-skill-09'])
  })

  it('treats legacy flash defaults as inherited until the user explicitly overrides them', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))

    await writeFile(
      join(userDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({
        version: 1,
        write: {
          inlineCompletion: {
            model: 'deepseek-v4-flash'
          }
        }
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir)
    const loaded = await store.load()

    expect(loaded.write.inlineCompletion.inheritModel).toBe(true)
    expect(loaded.write.inlineCompletion.model).toBe('deepseek-v4-flash')
  })

  it('migrates legacy deepseek.autoStart=false into Kun', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const workspaceRoot = join(userDataDir, 'workspace')
    await mkdir(workspaceRoot, { recursive: true })

    await writeFile(
      join(userDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({
        version: 1,
        workspaceRoot,
        deepseek: {
          autoStart: false
        }
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir)
    const loaded = await store.load()

    expect(loaded.agents.kun.autoStart).toBe(false)
  })

  it('migrates existing Kun credentials into General provider settings', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))

    await writeFile(
      join(userDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({
        version: 1,
        agents: {
          kun: {
            apiKey: 'sk-existing',
            baseUrl: 'https://runtime.example/v1'
          }
        }
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir)
    const loaded = await store.load()

    expect(loaded.provider.apiKey).toBe('sk-existing')
    expect(loaded.provider.baseUrl).toBe('https://runtime.example/v1')
    expect(loaded.agents.kun.apiKey).toBe('')
    expect(loaded.agents.kun.baseUrl).toBe('')
  })

  it('keeps custom model providers when migrated settings are reloaded', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const settingsPath = join(userDataDir, 'deepseek-gui-settings.json')
    const provider = defaultModelProviderSettings()

    await writeFile(
      settingsPath,
      JSON.stringify({
        version: 1,
        agentProvider: 'deepseek-runtime',
        provider: {
          apiKey: 'sk-default',
          baseUrl: 'https://api.deepseek.com',
          providers: [
            ...provider.providers,
            {
              id: 'custom-provider-2',
              name: 'Custom Provider',
              apiKey: 'sk-custom',
              baseUrl: 'https://custom.example/v1',
              endpointFormat: 'messages',
              models: ['custom-model']
            }
          ]
        },
        agents: {
          kun: {
            ...defaultKunRuntimeSettings(),
            providerId: 'custom-provider-2',
            model: 'custom-model'
          }
        }
      }),
      'utf8'
    )

    const firstStore = new JsonSettingsStore(userDataDir)
    const firstLoaded = await firstStore.load()

    expect(firstLoaded.provider.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'custom-provider-2',
          apiKey: 'sk-custom',
          baseUrl: 'https://custom.example/v1',
          endpointFormat: 'messages',
          models: ['custom-model']
        })
      ])
    )
    expect(firstLoaded.agents.kun.providerId).toBe('custom-provider-2')
    await firstStore.save(firstLoaded)

    const secondStore = new JsonSettingsStore(userDataDir)
    const secondLoaded = await secondStore.load()

    expect(secondLoaded.provider.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'custom-provider-2',
          apiKey: 'sk-custom',
          baseUrl: 'https://custom.example/v1',
          endpointFormat: 'messages',
          models: ['custom-model']
        })
      ])
    )
    expect(secondLoaded.agents.kun.providerId).toBe('custom-provider-2')
  })

  it('preserves route pools, local gateway state, and account sources across restart and unrelated patches', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-routes-'))
    const initialStore = new JsonSettingsStore(userDataDir)
    const initial = await initialStore.load()
    const provider = {
      id: 'kimi-code',
      name: 'Kimi Code',
      presetSource: { presetId: 'kimi-code', mode: 'api' as const },
      apiKey: 'sk-kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
      endpointFormat: 'chat_completions' as const,
      models: ['kimi-for-coding'],
      modelProfiles: {}
    }
    const routePool = {
      id: 'kimi-route',
      name: 'Kimi Route',
      modelId: 'kimi-auto',
      enabled: true,
      strategy: 'priority' as const,
      targets: [{ id: 'kimi-primary', providerId: provider.id, modelId: provider.models[0], enabled: true, weight: 1 }],
      failurePolicy: { failoverHttpStatusCodes: [429, 503], failoverOnNetworkError: true, failoverOnTimeout: true, failoverOnAuthError: true },
      healthPolicy: { failureThreshold: 3, cooldownMs: 60_000, halfOpenMaxAttempts: 1 }
    }

    await initialStore.save({
      ...initial,
      provider: {
        ...initial.provider,
        providers: [...initial.provider.providers, provider],
        routePools: [routePool],
        localGateway: { enabled: true, name: 'Team Relay' }
      }
    })

    const restarted = new JsonSettingsStore(userDataDir)
    const loaded = await restarted.load()
    expect(loaded.provider.routePools).toEqual([routePool])
    expect(loaded.provider.localGateway).toEqual({ enabled: true, name: 'Team Relay' })
    expect(loaded.provider.providers.find((item) => item.id === provider.id)?.presetSource)
      .toEqual(provider.presetSource)

    await restarted.patch({ theme: 'dark' })
    const afterUnrelatedPatch = await new JsonSettingsStore(userDataDir).load()
    expect(afterUnrelatedPatch.provider.routePools).toEqual([routePool])
    expect(afterUnrelatedPatch.provider.localGateway).toEqual({ enabled: true, name: 'Team Relay' })
  })

  it('preserves current routing extensions while migrating mixed legacy settings', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-routes-legacy-'))
    const provider = {
      id: 'kimi-code',
      name: 'Kimi Code',
      presetSource: { presetId: 'kimi-code', mode: 'api' },
      apiKey: 'sk-kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
      endpointFormat: 'chat_completions',
      models: ['kimi-for-coding'],
      modelProfiles: {}
    }
    const routePool = {
      id: 'mixed-route', name: 'Mixed Route', modelId: 'mixed-auto', enabled: true, strategy: 'priority',
      targets: [{ id: 'mixed-target', providerId: provider.id, modelId: provider.models[0], enabled: true, weight: 1 }],
      failurePolicy: { failoverHttpStatusCodes: [429], failoverOnNetworkError: true, failoverOnTimeout: true, failoverOnAuthError: true },
      healthPolicy: { failureThreshold: 3, cooldownMs: 60_000, halfOpenMaxAttempts: 1 }
    }
    await writeFile(join(userDataDir, 'deepseek-gui-settings.json'), JSON.stringify({
      version: 1,
      agentProvider: 'deepseek-runtime',
      deepseek: { autoStart: false },
      provider: {
        providers: [provider],
        routePools: [routePool],
        localGateway: { enabled: true, name: 'Legacy Relay' }
      }
    }), 'utf8')

    const loaded = await new JsonSettingsStore(userDataDir).load()
    expect(loaded.agents.kun.autoStart).toBe(false)
    expect(loaded.provider.routePools).toEqual([routePool])
    expect(loaded.provider.localGateway).toEqual({ enabled: true, name: 'Legacy Relay' })
    expect(loaded.provider.providers.find((item) => item.id === provider.id)?.presetSource)
      .toEqual(provider.presetSource)
  })

  it('loads settings from the legacy lowercase userData directory and writes them into the current path', async () => {
    const supportRoot = await mkdtemp(join(tmpdir(), 'ds-gui-settings-compat-'))
    const legacyUserDataDir = join(supportRoot, 'deepseek-gui')
    const currentUserDataDir = join(supportRoot, 'Kun')
    const currentSettingsPath = join(currentUserDataDir, 'kun-settings.json')

    await mkdir(legacyUserDataDir, { recursive: true })
    await writeFile(
      join(legacyUserDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({
        version: 1,
        provider: {
          apiKey: 'sk-legacy-provider'
        }
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(currentUserDataDir)
    const loaded = await store.load()

    expect(loaded.provider.apiKey).toBe('sk-legacy-provider')
    expect(await readFile(currentSettingsPath, 'utf8')).toContain('sk-legacy-provider')
  })

  it('preserves a missing configured code workspace without creating it', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const homeDir = await mkdtemp(join(tmpdir(), 'ds-gui-home-'))
    const workspaceRoot = join(userDataDir, 'missing-workspace')
    const writeWorkspaceRoot = join(userDataDir, 'missing-write-workspace')
    const conversationWorkspaceRoot = join(userDataDir, 'missing-conversation-workspace')
    const clawChannelWorkspaceRoot = join(userDataDir, 'missing-claw-channel')
    const clawConversationWorkspaceRoot = join(userDataDir, 'missing-claw-conversation')

    await writeFile(
      join(userDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({
        version: 1,
        workspaceRoot,
        conversationWorkspaceRoot,
        write: {
          defaultWorkspaceRoot: writeWorkspaceRoot,
          activeWorkspaceRoot: writeWorkspaceRoot,
          workspaces: [writeWorkspaceRoot]
        },
        claw: {
          channels: [{
            id: 'channel-1',
            provider: 'feishu',
            workspaceRoot: clawChannelWorkspaceRoot,
            conversations: [{
              id: 'conversation-1',
              chatId: 'chat-1',
              latestMessageId: 'message-1',
              workspaceRoot: clawConversationWorkspaceRoot
            }]
          }]
        }
      }),
      'utf8'
    )

    await withMockedHome(homeDir, async ({ JsonSettingsStore: Store }) => {
      const store = new Store(userDataDir)
      const loaded = await store.load()

      expect(loaded.workspaceRoot).toBe(workspaceRoot)
      expect(loaded.write.defaultWorkspaceRoot).toBe(writeWorkspaceRoot)
      expect(loaded.conversationWorkspaceRoot).toBe(conversationWorkspaceRoot)
      expect(loaded.claw.channels[0]?.workspaceRoot).toBe(clawChannelWorkspaceRoot)
      expect(loaded.claw.channels[0]?.conversations[0]?.workspaceRoot).toBe(clawConversationWorkspaceRoot)
      await expect(stat(workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(writeWorkspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(conversationWorkspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(clawChannelWorkspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(clawConversationWorkspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await stat(join(homeDir, '.kun', 'default_workspace'))).isDirectory()).toBe(true)
      expect((await stat(join(homeDir, '.kun', 'write_workspace'))).isDirectory()).toBe(true)
    })
  })

  it('does not replace an unavailable configured workspace on load', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const blockedParent = join(userDataDir, 'disconnected-drive')
    const unavailableWorkspaceRoot = join(blockedParent, 'project')
    const settingsPath = join(userDataDir, 'kun-settings.json')

    await writeFile(blockedParent, 'not a directory', 'utf8')
    await writeFile(
      settingsPath,
      JSON.stringify({
        version: 1,
        workspaceRoot: unavailableWorkspaceRoot
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir)
    const loaded = await store.load()

    const persisted = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
    expect(loaded.workspaceRoot).toBe(unavailableWorkspaceRoot)
    expect(persisted.workspaceRoot).toBe(unavailableWorkspaceRoot)
  })

  it('does not hide app-managed default workspace creation failures', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const homeRoot = await mkdtemp(join(tmpdir(), 'ds-gui-home-parent-'))
    const homeDir = join(homeRoot, 'home-is-a-file')

    await writeFile(homeDir, 'not a directory', 'utf8')

    await withMockedHome(homeDir, async ({ JsonSettingsStore: Store }) => {
      const store = new Store(userDataDir)
      await expect(store.load()).rejects.toThrow(/ENOTDIR|not a directory|mkdir/i)
    })
  })

  it('migrates legacy deepseek-runtime agentProvider to Kun', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))

    await writeFile(
      join(userDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({
        version: 1,
        agentProvider: 'deepseek-runtime',
        deepseek: { port: 18787 }
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir)
    const loaded = await store.load()

    expect(loaded.agents.kun.port).toBe(18787)
  })

  it('backs up invalid JSON and replaces it with defaults', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const settingsPath = join(userDataDir, 'deepseek-gui-settings.json')
    await writeFile(settingsPath, '{ invalid json', 'utf8')

    const store = new JsonSettingsStore(userDataDir)
    const loaded = await store.load()
    const files = await readdir(userDataDir)
    const backupName = files.find((file) => file.startsWith('deepseek-gui-settings.invalid-'))

    expect(loaded.workspaceRoot.length).toBeGreaterThan(0)
    expect(backupName).toBeTruthy()
    expect(await readFile(join(userDataDir, backupName ?? ''), 'utf8')).toBe('{ invalid json')
    // 兜底默认值写进新文件名;旧文件保留原状(已经另有 invalid 备份)。
    const replaced = await readFile(join(userDataDir, 'kun-settings.json'), 'utf8')
    expect(() => JSON.parse(replaced)).not.toThrow()
  })

  it('backs up non-object settings JSON and replaces it with defaults', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const settingsPath = join(userDataDir, 'kun-settings.json')
    await writeFile(settingsPath, 'null', 'utf8')

    const store = new JsonSettingsStore(userDataDir)
    const loaded = await store.load()
    const files = await readdir(userDataDir)
    const backupName = files.find((file) => file.startsWith('kun-settings.invalid-'))

    expect(loaded.workspaceRoot.length).toBeGreaterThan(0)
    expect(backupName).toBeTruthy()
    expect(await readFile(join(userDataDir, backupName ?? ''), 'utf8')).toBe('null')
    const replaced = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
    expect(replaced.version).toBe(1)
  })

  it('ignores null entries in persisted Claw channels and schedule tasks', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))

    await writeFile(
      join(userDataDir, 'kun-settings.json'),
      JSON.stringify({
        version: 1,
        claw: {
          channels: [null]
        },
        schedule: {
          tasks: [null]
        }
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir)
    const loaded = await store.load()

    expect(loaded.claw.channels).toEqual([])
    expect(loaded.schedule.tasks).toEqual([])
  })

  it('loads the legacy file name inside the current userData dir and re-saves it under the new name', async () => {
    // userData 整目录迁移后的常见形态:目录已经叫 Kun,里面还是旧文件名。
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    await writeFile(
      join(userDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({ version: 1, provider: { apiKey: 'sk-migrated' } }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir)
    const loaded = await store.load()

    expect(loaded.provider.apiKey).toBe('sk-migrated')
    const rewritten = await readFile(join(userDataDir, 'kun-settings.json'), 'utf8')
    expect(rewritten).toContain('sk-migrated')
    // 旧文件保留,回滚老版本时仍可读。
    expect(await readFile(join(userDataDir, 'deepseek-gui-settings.json'), 'utf8')).toContain('sk-migrated')
  })

  it('persists the versioned stream idle timeout migration for existing users', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const settingsPath = join(userDataDir, 'kun-settings.json')
    await writeFile(
      settingsPath,
      JSON.stringify({
        version: 1,
        agents: {
          kun: {
            runtimeTuning: {
              maxConcurrentTurns: 256,
              maxWallTimeMs: 86_400_000,
              streamIdleTimeoutMs: 45_000
            }
          }
        }
      }),
      'utf8'
    )

    const loaded = await new JsonSettingsStore(userDataDir).load()
    expect(loaded.agents.kun.runtimeTuning).toMatchObject({
      defaultsVersion: 1,
      streamIdleTimeoutMs: 450_000
    })

    const persisted = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      agents: { kun: { runtimeTuning: { defaultsVersion: number; streamIdleTimeoutMs: number } } }
    }
    expect(persisted.agents.kun.runtimeTuning).toMatchObject({
      defaultsVersion: 1,
      streamIdleTimeoutMs: 450_000
    })

    const reloaded = await new JsonSettingsStore(userDataDir).load()
    expect(reloaded.agents.kun.runtimeTuning).toMatchObject({
      defaultsVersion: 1,
      streamIdleTimeoutMs: 450_000
    })
  })

  it('throws for non-recoverable read errors', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const settingsPath = join(userDataDir, 'deepseek-gui-settings.json')
    await mkdir(settingsPath, { recursive: true })

    const store = new JsonSettingsStore(userDataDir)

    await expect(store.load()).rejects.toThrow(/Failed to read settings file/)
  })

  it('merges Kun settings patches', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const store = new JsonSettingsStore(userDataDir)
    await store.load()

    const saved = await store.patch({
      agents: {
        kun: {
          model: 'deepseek-reasoner',
          approvalPolicy: 'on-request'
        }
      }
    })

    expect(saved.agents.kun.model).toBe('deepseek-reasoner')
    expect(saved.agents.kun.approvalPolicy).toBe('on-request')
  })

  it('merges desktop behavior patches without keeping invalid startup state', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const store = new JsonSettingsStore(userDataDir)
    await store.load()

    const enabled = await store.patch({
      appBehavior: {
        openAtLogin: true,
        startMinimized: true,
        closeAction: 'tray'
      }
    })
    const disabled = await store.patch({
      appBehavior: {
        openAtLogin: false,
        closeToTray: false
      }
    })

    expect(enabled.appBehavior).toEqual({
      openAtLogin: true,
      startMinimized: true,
      closeAction: 'tray',
      closeToTray: true
    })
    expect(disabled.appBehavior).toEqual({
      openAtLogin: false,
      startMinimized: false,
      closeAction: 'quit',
      closeToTray: false
    })
  })

  it('omits agentProvider when writing normalized settings to disk', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const settingsPath = join(userDataDir, 'kun-settings.json')
    const store = new JsonSettingsStore(userDataDir)
    await store.load()
    await store.patch({
      agents: {
        kun: {
          model: 'deepseek-chat'
        }
      }
    })

    const persisted = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>

    expect('agentProvider' in persisted).toBe(false)
    expect(persisted.agents).toEqual(
      expect.objectContaining({
        kun: expect.objectContaining({ model: 'deepseek-chat' })
      })
    )
  })

  it('folds legacy Claw thread ids into the single Kun mapping', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))

    await writeFile(
      join(userDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({
        version: 1,
        claw: {
          channels: [
            {
              id: 'channel-1',
              provider: 'feishu',
              label: 'Feishu Agent',
              threadId: 'thr_codewhale',
              agentThreadIds: { reasonix: '2026-06-01T01:00:00.000Z' },
              conversations: [
                {
                  id: 'conversation-1',
                  chatId: 'chat-1',
                  latestMessageId: 'message-1',
                  localThreadId: 'thr_conversation_codewhale',
                  agentThreadIds: { reasonix: '2026-06-01T02:00:00.000Z' }
                }
              ]
            }
          ]
        }
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir)
    const loaded = await store.load()
    const channel = loaded.claw.channels[0]
    const conversation = channel?.conversations[0]

    expect(channel?.threadId).toBe('thr_codewhale')
    expect(conversation?.localThreadId).toBe('thr_conversation_codewhale')
  })

  it('seeds Reasonix-only Claw conversations into the canonical thread id', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))

    await writeFile(
      join(userDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({
        version: 1,
        claw: {
          channels: [
            {
              id: 'channel-1',
              provider: 'feishu',
              label: 'Feishu Agent',
              agentThreadIds: { reasonix: 'reasonix-channel' },
              conversations: [
                {
                  id: 'conversation-1',
                  chatId: 'chat-1',
                  latestMessageId: 'message-1',
                  localThreadId: '',
                  agentThreadIds: { reasonix: 'reasonix-conversation' }
                }
              ]
            }
          ]
        }
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir)
    const loaded = await store.load()
    const channel = loaded.claw.channels[0]
    const conversation = channel?.conversations[0]

    expect(channel?.threadId).toBe('reasonix-channel')
    expect(conversation?.localThreadId).toBe('reasonix-conversation')
  })

  it('saves settings atomically (no .tmp file left on success)', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-atomic-'))

    try {
      const store = new JsonSettingsStore(userDataDir)
      const loaded = await store.load()
      await store.save(loaded)

      // Final file is present and non-empty.
      const finalContents = await readFile(
        join(userDataDir, 'kun-settings.json'),
        'utf8'
      )
      expect(finalContents.length).toBeGreaterThan(0)

      // No .tmp leftover from the atomic write.
      const entries = await readdir(userDataDir)
      expect(entries.filter((entry) => entry.includes('.tmp'))).toEqual([])
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  })
})
