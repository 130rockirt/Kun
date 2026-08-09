import { describe, expect, it } from 'vitest'
import {
  APP_LOCALES,
  applyKunRuntimePatch,
  kunSettingsEnvelope,
  kunSettingsPatch,
  DEFAULT_KUN_DATA_DIR,
  DEFAULT_KUN_MODEL,
  DEFAULT_KUN_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_LOG_RETENTION_DAYS,
  DEFAULT_CURSOR_SPOTLIGHT_COLOR,
  DEFAULT_GIT_BRANCH_PREFIX,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_SANDBOX_MODE,
  DEFAULT_WEIXIN_BRIDGE_RPC_URL,
  DEFAULT_SCHEDULE_INTERNAL_PORT,
  DEFAULT_TOOL_OUTPUT_MAX_BYTES,
  DEFAULT_TOOL_OUTPUT_MAX_LINES,
  buildClawRuntimePrompt,
  defaultClawSettings,
  defaultModelProviderSettings,
  mergeKunRuntimeSettings,
  mergeScheduleSettings,
  defaultKunRuntimeSettings,
  defaultScheduleSettings,
  defaultWorkflowSettings,
  defaultTerminalSettings,
  defaultWriteSelectionAssistSettings,
  defaultDesignSettings,
  normalizeDesignSettings,
  defaultWriteSettings,
  getModelProviderPreset,
  defaultKeyboardShortcuts,
  modelProviderPresetProfile,
  mergeAppBehaviorSettings,
  mergeWriteSettings,
  normalizeWriteSettings,
  normalizeWriteAgentPresets,
  isKunRuntimeInsecure,
  migrateLegacyAppSettings,
  normalizeAppSettings,
  KUN_RUNTIME_TUNING_DEFAULTS_VERSION,
  normalizeChatContentMaxWidth,
  normalizeComposerSendKey,
  isComposerSendHotkey,
  normalizeGitBranchPrefix,
  applyGitBranchPrefix,
  parseClawUserPromptForDisplay,
  inferModelEndpointFormatFromUrl,
  kunToolPermissionModeFromSettings,
  kunToolPermissionModeSettings,
  normalizeScheduleSettings,
  resolveKunRuntimeSettings,
  resolveWriteInlineCompletionApiKey,
  resolveWriteInlineCompletionBaseUrl,
  resolveWriteInlineCompletionModel,
  type AppSettingsV1,
  type ClawImChannelV1,
  type ClawImProvider
} from './app-settings'

function settings(): AppSettingsV1 {
  return {
    version: 1,
    locale: 'en',
    theme: 'system',
    uiFontScale: 0.82,
    chatContentMaxWidthPx: 896,
    composerSendKey: 'enter',
    provider: defaultModelProviderSettings(),
    agents: {
      kun: defaultKunRuntimeSettings()
    },
    workspaceRoot: '/tmp/workspace',
    conversationWorkspaceRoot: '~/Documents/Kun',
    log: { enabled: false, retentionDays: 7 },
    checkpointCleanup: { createEnabled: false, enabled: false, intervalDays: 3 },
    notifications: { turnComplete: true },
    appBehavior: { openAtLogin: false, startMinimized: false, closeToTray: false },
    keyboardShortcuts: defaultKeyboardShortcuts(),
    write: defaultWriteSettings(),
    claw: defaultClawSettings(),
    schedule: defaultScheduleSettings(),
    workflow: defaultWorkflowSettings(),
    design: defaultDesignSettings(),
    terminal: defaultTerminalSettings(),
    guiUpdate: { channel: 'stable' },
    codePromptPrefix: '',
    disabledSkillIds: []
  }
}

describe('application locale settings', () => {
  it.each(APP_LOCALES)('preserves the supported %s locale', (locale) => {
    expect(normalizeAppSettings({ ...settings(), locale }).locale).toBe(locale)
  })

  it('falls back to English for an unsupported persisted locale', () => {
    const input = { ...settings(), locale: 'fr' } as unknown as AppSettingsV1
    expect(normalizeAppSettings(input).locale).toBe('en')
  })
})

describe('design workspace settings', () => {
  it('migrates a legacy default workspace into the Design workspace list', () => {
    expect(normalizeDesignSettings({ defaultWorkspaceRoot: ' /tmp/design/ ' })).toMatchObject({
      defaultWorkspaceRoot: '/tmp/design',
      workspaces: ['/tmp/design'],
      activeWorkspaceRoot: '/tmp/design'
    })
  })

  it('deduplicates workspace roots and keeps a valid selected workspace', () => {
    expect(normalizeDesignSettings({
      defaultWorkspaceRoot: '/tmp/default/',
      workspaces: ['/tmp/default', '/tmp/mobile/', '/tmp/mobile'],
      activeWorkspaceRoot: '/tmp/mobile/'
    })).toMatchObject({
      defaultWorkspaceRoot: '/tmp/default',
      workspaces: ['/tmp/default', '/tmp/mobile'],
      activeWorkspaceRoot: '/tmp/mobile'
    })
  })
})

describe('notification settings', () => {
  it('migrates legacy completion settings to main-agent on and subagent off', () => {
    const normalized = normalizeAppSettings({
      ...settings(),
      notifications: { turnComplete: false }
    })

    expect(normalized.notifications).toEqual({
      turnComplete: false,
      mainAgentTurnComplete: true,
      subagentTurnComplete: false
    })
  })

  it('preserves explicit source-specific completion preferences', () => {
    const normalized = normalizeAppSettings({
      ...settings(),
      notifications: {
        turnComplete: true,
        mainAgentTurnComplete: false,
        subagentTurnComplete: true
      }
    })

    expect(normalized.notifications).toEqual({
      turnComplete: true,
      mainAgentTurnComplete: false,
      subagentTurnComplete: true
    })
  })
})

describe('initial setup completion', () => {
  it('defaults a new keyless configuration to incomplete', () => {
    expect(normalizeAppSettings(settings()).initialSetupCompleted).toBe(false)
  })

  it('keeps explicitly completed keyless configurations complete', () => {
    expect(normalizeAppSettings({
      ...settings(),
      initialSetupCompleted: true
    }).initialSetupCompleted).toBe(true)
  })

  it('migrates an existing configured API provider to complete', () => {
    const current = settings()
    const normalized = normalizeAppSettings({
      ...current,
      provider: {
        ...current.provider,
        apiKey: 'sk-existing'
      }
    })
    expect(normalized.initialSetupCompleted).toBe(true)
  })

  it('migrates an existing keyless subscription provider to complete', () => {
    const current = settings()
    const preset = getModelProviderPreset('gemini-cli-subscription')
    if (!preset) throw new Error('Gemini CLI subscription preset is missing')
    const subscription = modelProviderPresetProfile(preset, '')
    const normalized = normalizeAppSettings({
      ...current,
      provider: {
        ...current.provider,
        providers: [...current.provider.providers, subscription]
      },
      agents: {
        kun: {
          ...current.agents.kun,
          providerId: subscription.id,
          model: subscription.models[0]
        }
      }
    })

    expect(normalized.initialSetupCompleted).toBe(true)
  })
})

describe('chat content max width', () => {
  it('defaults invalid values to 896px', () => {
    expect(normalizeChatContentMaxWidth(undefined)).toBe(896)
    expect(normalizeChatContentMaxWidth('bad')).toBe(896)
  })

  it('clamps and rounds to 8px steps', () => {
    expect(normalizeChatContentMaxWidth(500)).toBe(640)
    expect(normalizeChatContentMaxWidth(896)).toBe(896)
    expect(normalizeChatContentMaxWidth(1300)).toBe(1200)
    expect(normalizeChatContentMaxWidth(905)).toBe(904)
  })
})

describe('git branch prefix', () => {
  it('normalizes separators and applies the default prefix once', () => {
    expect(normalizeGitBranchPrefix(' feature ')).toBe('feature/')
    expect(normalizeGitBranchPrefix('team\\')).toBe('team/')
    expect(normalizeGitBranchPrefix(undefined)).toBe(DEFAULT_GIT_BRANCH_PREFIX)
    expect(applyGitBranchPrefix('fix/workspace', 'codex/')).toBe('codex/fix/workspace')
    expect(applyGitBranchPrefix('codex/fix/workspace', 'codex/')).toBe('codex/fix/workspace')
  })

  it('allows branch prefixes to be disabled', () => {
    expect(normalizeGitBranchPrefix('')).toBe('')
    expect(applyGitBranchPrefix('fix/workspace', '')).toBe('fix/workspace')
  })
})

describe('model endpoint format inference', () => {
  it('treats /completions custom endpoints as Chat Completions-shaped', () => {
    expect(inferModelEndpointFormatFromUrl('https://api.example.com/custom/completions')).toBe('chat_completions')
    expect(inferModelEndpointFormatFromUrl('https://api.example.com/custom/completions?api-version=2026-01-01')).toBe(
      'chat_completions'
    )
  })
})

function clawChannel(provider: ClawImProvider, label: string, name = label): ClawImChannelV1 {
  const now = '2026-06-01T00:00:00.000Z'
  return {
    id: `${provider}-${label}`,
    provider,
    label,
    enabled: true,
    model: 'auto',
    threadId: '',
    workspaceRoot: '',
    agentProfile: {
      name,
      description: '',
      identity: '',
      personality: '',
      userContext: '',
      replyRules: ''
    },
    conversations: [],
    createdAt: now,
    updatedAt: now
  }
}
