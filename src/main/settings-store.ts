import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { atomicWriteFile } from '../../kun/src/adapters/file/atomic-write.js'
import {
  SETTINGS_FILE_NAME,
  settingsReadCandidates
} from './settings-file-paths'
import {
  applyKunRuntimePatch,
  DEFAULT_GUI_UPDATE_CHANNEL,
  DEFAULT_CHECKPOINT_CLEANUP_ENABLED,
  DEFAULT_CHECKPOINT_CLEANUP_INTERVAL_DAYS,
  DEFAULT_GIT_CHECKPOINT_CREATE_ENABLED,
  DEFAULT_CURSOR_SPOTLIGHT_COLOR,
  DEFAULT_GIT_BRANCH_PREFIX,
  DEFAULT_LOG_RETENTION_DAYS,
  DEFAULT_WRITE_WORKSPACE_ROOT,
  DEFAULT_WRITE_WELCOME_FILE_NAME,
  defaultClawSettings,
  defaultKunRuntimeSettings,
  defaultModelProviderSettings,
  defaultDesignSettings,
  defaultScheduleSettings,
  defaultWorkflowSettings,
  getKunRuntimeSettings,
  kunRuntimeTuningDefaultsMigrationNeeded,
  mergeModelProviderSettings,
  defaultWriteSettings,
  mergeClawSettings,
  mergeAppBehaviorSettings,
  mergeDesignSettings,
  mergeScheduleSettings,
  mergeWorkflowSettings,
  mergeWriteSettings,
  defaultTerminalSettings,
  mergeTerminalSettings,
  DEFAULT_CHAT_CONTENT_MAX_WIDTH_PX,
  DEFAULT_COMPOSER_SEND_KEY,
  DEFAULT_UI_FONT_SCALE,
  normalizeAppBehaviorSettings,
  normalizeCheckpointCleanupSettings,
  normalizeGitBranchPrefix,
  normalizeKeyboardShortcuts,
  normalizeAppSettings,
  type AppSettingsPatch,
  type AppSettingsV1,
  type ClawImChannelV1,
  type ClawImConversationV1,
  type KunRuntimeTuningSettingsV1
} from '../shared/app-settings'

export type { AppSettingsV1 }

export type SettingsCredentialMigrationResult = {
  runtimeSettings: AppSettingsV1
  persistedSettings: AppSettingsV1
  sourceIdsToCommit: string[]
  removedPlaintext: boolean
  rollback: () => Promise<void>
  commit: () => Promise<void>
}

export type SettingsCredentialMigration = {
  prepare: (
    settings: AppSettingsV1,
    options?: {
      replaceCommitted?: boolean
      previousSettings?: AppSettingsV1
    }
  ) => Promise<SettingsCredentialMigrationResult>
  /**
   * Repairs an already-migrated OAuth source whose protected value was
   * previously flattened to an access token. Implementations must only use
   * the backup as a recovery candidate and must not restore cleared sources.
   */
  repairRefreshableCredentialsFromBackup?: (
    settings: AppSettingsV1,
    backupSettings: AppSettingsV1
  ) => Promise<string[]>
}

export type SettingsDocumentBackend = {
  read(): Promise<{ revision: number; value: string | null }>
  write(expectedRevision: number, value: string): Promise<{ revision: number; value: string }>
}

type JsonSettingsStoreOptions = {
  credentialMigration?: SettingsCredentialMigration
  /**
   * Fail closed when Runtime migration prevents access to protected credential
   * storage. Existing plaintext compatibility settings may still be read, but
   * they must never be copied or rewritten by an ordinary settings save.
   */
  rejectPlaintextCredentials?: boolean
  /** Manager-owned CAS backend used by both production and DV profiles. */
  documentBackend?: SettingsDocumentBackend
}

// 数据默认根目录从 ~/.deepseekgui 升级为 ~/.kun。老安装的既有目录由
// legacy-data-migration.ts 在启动期搬迁并留兼容链接;settings 里存的旧
// 绝对路径也在那里按迁移结果重写,这里只负责“新值”。
const DEFAULT_WORKSPACE_ROOT = join(homedir(), '.kun', 'default_workspace')
// 对话会话不绑定项目文件夹,每个新会话在此目录下自动创建时间戳子目录作为工作目录。
// macOS/Windows 用系统 Documents 文件夹;Linux 没有 Documents 约定,改用 XDG 风格目录。
const DEFAULT_CONVERSATION_WORKSPACE_ROOT_ABSOLUTE =
  process.platform === 'linux'
    ? join(homedir(), '.local', 'share', 'Kun', 'conversations')
    : join(homedir(), 'Documents', 'Kun')
const DEFAULT_CLAW_CHANNELS_ROOT = join(homedir(), '.kun', 'claw')
const DEFAULT_WRITE_WORKSPACE_ROOT_ABSOLUTE = expandHomePath(DEFAULT_WRITE_WORKSPACE_ROOT)
const WELCOME_MARKDOWN = `# Welcome to Write

This is your default writing workspace.

- Create Markdown drafts from the sidebar.
- Select text in the editor and ask the writing assistant about it.
- Switch between source, live, split, and preview modes from the top bar.
`

export function expandHomePath(raw: string | null | undefined): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return ''
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homedir(), value.slice(2))
  }
  return value
}

function normalizeWorkspaceRoot(raw: string | null | undefined): string {
  return expandHomePath(raw) || DEFAULT_WORKSPACE_ROOT
}

function normalizeWriteWorkspaceRoot(raw: string | null | undefined): string {
  return expandHomePath(raw) || DEFAULT_WRITE_WORKSPACE_ROOT_ABSOLUTE
}

function normalizeConversationWorkspaceRoot(raw: string | null | undefined): string {
  return expandHomePath(raw) || DEFAULT_CONVERSATION_WORKSPACE_ROOT_ABSOLUTE
}

function sanitizePathSegment(raw: string | null | undefined, fallback: string): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  const sanitized = value
    .replace(/[\\/]/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized || fallback
}

function defaultClawChannelWorkspaceRoot(channel: ClawImChannelV1): string {
  const credential = channel.platformCredential
  const domain = credential?.kind === 'feishu'
    ? credential.domain
    : credential?.kind === 'weixin'
      ? 'weixin'
      : channel.provider
  const credentialId = credential?.kind === 'feishu'
    ? credential.appId
    : credential?.kind === 'weixin'
      ? credential.accountId
      : ''
  const workspaceId = sanitizePathSegment(credentialId || channel.id, 'channel')
  return join(DEFAULT_CLAW_CHANNELS_ROOT, channel.provider, domain, workspaceId)
}

function normalizeClawChannelWorkspaceRoot(channel: ClawImChannelV1): string {
  return expandHomePath(channel.workspaceRoot) || defaultClawChannelWorkspaceRoot(channel)
}

function sanitizeConversationWorkspaceSegment(conversation: ClawImConversationV1): string {
  return sanitizePathSegment(
    conversation.remoteThreadId || conversation.chatId,
    conversation.id || 'conversation'
  )
}

function defaultClawConversationWorkspaceRoot(
  channel: ClawImChannelV1,
  conversation: ClawImConversationV1
): string {
  return join(normalizeClawChannelWorkspaceRoot(channel), 'conversations', sanitizeConversationWorkspaceSegment(conversation))
}

function normalizeClawConversationWorkspaceRoot(
  channel: ClawImChannelV1,
  conversation: ClawImConversationV1
): string {
  return expandHomePath(conversation.workspaceRoot) || defaultClawConversationWorkspaceRoot(channel, conversation)
}

function normalizeStoredSettings(settings: AppSettingsV1): AppSettingsV1 {
  const normalized = normalizeAppSettings(settings)
  const writeDefaultRoot = normalizeWriteWorkspaceRoot(normalized.write.defaultWorkspaceRoot)
  const writeActiveRoot = normalizeWriteWorkspaceRoot(normalized.write.activeWorkspaceRoot || writeDefaultRoot)
  const writeWorkspaces = [...new Set(
    [writeDefaultRoot, writeActiveRoot, ...normalized.write.workspaces.map(normalizeWriteWorkspaceRoot)]
      .filter(Boolean)
  )]
  return {
    ...normalized,
    workspaceRoot: normalizeWorkspaceRoot(normalized.workspaceRoot),
    conversationWorkspaceRoot: normalizeConversationWorkspaceRoot(normalized.conversationWorkspaceRoot),
    write: {
      ...normalized.write,
      defaultWorkspaceRoot: writeDefaultRoot,
      activeWorkspaceRoot: writeWorkspaces.includes(writeActiveRoot) ? writeActiveRoot : writeDefaultRoot,
      workspaces: writeWorkspaces.length > 0 ? writeWorkspaces : [writeDefaultRoot]
    },
    claw: {
      ...normalized.claw,
      channels: normalized.claw.channels.map((channel) => ({
        ...channel,
        workspaceRoot: normalizeClawChannelWorkspaceRoot(channel),
        conversations: channel.conversations.map((conversation) => ({
          ...conversation,
          workspaceRoot: normalizeClawConversationWorkspaceRoot(channel, conversation)
        }))
      }))
    }
  }
}

function serializeSettingsForDisk(settings: AppSettingsV1): string {
  return JSON.stringify(normalizeStoredSettings(settings), null, 2)
}

async function ensureManagedWorkspaceRootsExist(settings: AppSettingsV1): Promise<void> {
  await mkdir(DEFAULT_WORKSPACE_ROOT, { recursive: true })
  await mkdir(DEFAULT_WRITE_WORKSPACE_ROOT_ABSOLUTE, { recursive: true })
  await mkdir(DEFAULT_CONVERSATION_WORKSPACE_ROOT_ABSOLUTE, { recursive: true })

  const welcomePath = join(DEFAULT_WRITE_WORKSPACE_ROOT_ABSOLUTE, DEFAULT_WRITE_WELCOME_FILE_NAME)
  try {
    await writeFile(welcomePath, WELCOME_MARKDOWN, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }

  for (const channel of settings.claw.channels) {
    const managedChannelRoot = defaultClawChannelWorkspaceRoot(channel)
    if (normalizeClawChannelWorkspaceRoot(channel) !== managedChannelRoot) continue
    await mkdir(managedChannelRoot, { recursive: true })
    for (const conversation of channel.conversations) {
      const managedConversationRoot = defaultClawConversationWorkspaceRoot(channel, conversation)
      if (normalizeClawConversationWorkspaceRoot(channel, conversation) === managedConversationRoot) {
        await mkdir(managedConversationRoot, { recursive: true })
      }
    }
  }
}

const defaultSettings = (): AppSettingsV1 => ({
  version: 1,
  initialSetupCompleted: false,
  locale: 'en',
  theme: 'system',
  uiFontScale: DEFAULT_UI_FONT_SCALE,
  chatContentMaxWidthPx: DEFAULT_CHAT_CONTENT_MAX_WIDTH_PX,
  composerSendKey: DEFAULT_COMPOSER_SEND_KEY,
  cursorSpotlight: true,
  cursorSpotlightColor: DEFAULT_CURSOR_SPOTLIGHT_COLOR,
  provider: defaultModelProviderSettings(),
  agents: {
    kun: defaultKunRuntimeSettings()
  },
  workspaceRoot: DEFAULT_WORKSPACE_ROOT,
  conversationWorkspaceRoot: DEFAULT_CONVERSATION_WORKSPACE_ROOT_ABSOLUTE,
  log: {
    enabled: true,
    retentionDays: DEFAULT_LOG_RETENTION_DAYS
  },
  checkpointCleanup: {
    createEnabled: DEFAULT_GIT_CHECKPOINT_CREATE_ENABLED,
    enabled: DEFAULT_CHECKPOINT_CLEANUP_ENABLED,
    intervalDays: DEFAULT_CHECKPOINT_CLEANUP_INTERVAL_DAYS
  },
  gitBranchPrefix: DEFAULT_GIT_BRANCH_PREFIX,
  notifications: {
    turnComplete: true,
    mainAgentTurnComplete: true,
    subagentTurnComplete: false
  },
  appBehavior: normalizeAppBehaviorSettings(),
  keyboardShortcuts: normalizeKeyboardShortcuts(),
  guiUpdate: {
    channel: DEFAULT_GUI_UPDATE_CHANNEL
  },
  codePromptPrefix: '',
  disabledSkillIds: [],
  write: defaultWriteSettings(),
  claw: defaultClawSettings(),
  schedule: defaultScheduleSettings(),
  workflow: defaultWorkflowSettings(),
  design: defaultDesignSettings(),
  terminal: defaultTerminalSettings()
})

function buildMergedSettings(parsed: Partial<AppSettingsV1>): AppSettingsV1 {
  // normalizeAppSettings owns the legacy predicate. Calling the legacy
  // migrator unconditionally here rebuilt every current provider object and
  // silently discarded newer extensions such as routePools/localGateway.
  return normalizeAppSettings(parsed as AppSettingsV1)
}

function hasLegacyProviderPlaintext(settings: AppSettingsV1): boolean {
  const provider = settings.provider
  if (provider.apiKey.trim()) return true
  if (provider.providers.some((entry) => entry.apiKey.trim())) return true
  return getKunRuntimeSettings(settings).apiKey.trim().length > 0
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function storedKunRuntimeTuning(
  settings: Record<string, unknown>
): Partial<KunRuntimeTuningSettingsV1> | undefined {
  const agents = isRecord(settings.agents) ? settings.agents : undefined
  const kun = agents && isRecord(agents.kun) ? agents.kun : undefined
  const runtimeTuning = kun && isRecord(kun.runtimeTuning) ? kun.runtimeTuning : undefined
  return runtimeTuning as Partial<KunRuntimeTuningSettingsV1> | undefined
}

async function loadDefaultSettings(): Promise<AppSettingsV1> {
  const defaults = normalizeStoredSettings(defaultSettings())
  await ensureManagedWorkspaceRootsExist(defaults)
  return defaults
}

async function writeInvalidSettingsBackup(path: string, raw: string): Promise<string | null> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(
    dirname(path),
    `${basename(path, '.json')}.invalid-${stamp}.json`
  )
  try {
    await writeFile(backupPath, raw, 'utf8')
    return backupPath
  } catch {
    return null
  }
}

async function writeLegacyCredentialSettingsBackup(path: string, raw: string): Promise<string | null> {
  const backupPath = legacyCredentialSettingsBackupPath(path)
  try {
    await writeFile(backupPath, raw, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await chmod(backupPath, 0o600).catch(() => undefined)
    return backupPath
  } catch (error) {
    if (isErrnoException(error) && error.code === 'EEXIST') {
      try {
        const metadata = await lstat(backupPath)
        if (!metadata.isFile() || metadata.isSymbolicLink()) return null
        await chmod(backupPath, 0o600)
        return backupPath
      } catch {
        return null
      }
    }
    return null
  }
}

function legacyCredentialSettingsBackupPath(path: string): string {
  return join(dirname(path), `${basename(path, '.json')}.pre-extension-credential-migration.json`)
}

async function readLegacyCredentialSettingsBackup(path: string): Promise<AppSettingsV1 | null> {
  const backupPath = legacyCredentialSettingsBackupPath(path)
  try {
    const metadata = await lstat(backupPath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null
    const parsed = JSON.parse(await readFile(backupPath, 'utf8')) as unknown
    if (!isRecord(parsed)) return null
    return normalizeStoredSettings(buildMergedSettings(parsed as Partial<AppSettingsV1>))
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null
    console.warn('[kun-gui] Pre-migration credential backup could not be read for OAuth recovery.', {
      message: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

async function replaceInvalidSettingsWithDefaults(
  store: JsonSettingsStore,
  sourcePath: string,
  raw: string,
  reason: string
): Promise<AppSettingsV1> {
  const backupPath = await writeInvalidSettingsBackup(sourcePath, raw)
  const defaults = await loadDefaultSettings()
  await store.save(defaults)
  if (backupPath) {
    console.warn(
      `[kun-gui] Invalid settings were replaced with defaults (${reason}). Backup: ${backupPath}`
    )
  } else {
    console.warn(
      `[kun-gui] Invalid settings were replaced with defaults (${reason}). Backup could not be written for ${sourcePath}.`
    )
  }
  return defaults
}

async function readSettingsFileWithCompatibility(
  currentPath: string
): Promise<{ raw: string, sourcePath: string } | null> {
  for (const candidatePath of settingsReadCandidates(dirname(currentPath))) {
    try {
      return {
        raw: await readFile(candidatePath, 'utf8'),
        sourcePath: candidatePath
      }
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') continue
      throw error
    }
  }

  return null
}

export class JsonSettingsStore {
  private path: string
  private cache: AppSettingsV1 | null = null
  private documentRevision: number | undefined

  constructor(
    userDataPath: string,
    private readonly options: JsonSettingsStoreOptions = {}
  ) {
    this.path = join(userDataPath, SETTINGS_FILE_NAME)
  }

  async load(): Promise<AppSettingsV1> {
    const document = this.options.documentBackend
      ? await this.options.documentBackend.read()
      : undefined
    if (this.cache && (!document || document.revision === this.documentRevision)) return this.cache
    if (document) {
      this.cache = null
      this.documentRevision = document.revision
    }

    let raw = ''
    let sourcePath = this.path
    try {
      const loaded = document
        ? (document.value === null ? null : { raw: document.value, sourcePath: this.path })
        : await readSettingsFileWithCompatibility(this.path)
      if (!loaded) {
        this.cache = await loadDefaultSettings()
        return this.cache
      }
      raw = loaded.raw
      sourcePath = loaded.sourcePath
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to read settings file ${sourcePath}: ${message}`, { cause: error })
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      if (error instanceof SyntaxError) {
        return replaceInvalidSettingsWithDefaults(this, sourcePath, raw, 'invalid JSON')
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to parse settings file ${sourcePath}: ${message}`, { cause: error })
    }

    if (!isRecord(parsed)) {
      return replaceInvalidSettingsWithDefaults(this, sourcePath, raw, 'top-level value is not an object')
    }

    const persistRuntimeTuningDefaultsMigration = (() => {
      const runtimeTuning = storedKunRuntimeTuning(parsed)
      return runtimeTuning !== undefined &&
        kunRuntimeTuningDefaultsMigrationNeeded(runtimeTuning)
    })()
    const normalized = normalizeStoredSettings(buildMergedSettings(parsed as Partial<AppSettingsV1>))
    await ensureManagedWorkspaceRootsExist(normalized)
    const prepared = normalized
    await this.repairRefreshableCredentialsFromBackup(prepared, sourcePath)
    if (this.options.credentialMigration && hasLegacyProviderPlaintext(prepared)) {
      const backupPath = await writeLegacyCredentialSettingsBackup(sourcePath, raw)
      if (!backupPath) {
        throw new Error(
          'Legacy credential migration was blocked because a protected settings backup could not be written'
        )
      }
    }
    const migration = await this.prepareCredentialMigration(prepared, false)
    if (migration === undefined) {
      this.cache = prepared
      if (sourcePath !== this.path || persistRuntimeTuningDefaultsMigration) {
        if (this.rejectsPlaintextCredentials(prepared)) {
          console.warn(
            '[kun-gui] Settings compatibility rewrite deferred because protected credential storage is unavailable.'
          )
        } else {
          await this.save(prepared)
        }
      }
      return this.cache
    }
    if (migration === null) {
      this.cache = prepared
      return this.cache
    }

    const shouldPersist =
      sourcePath !== this.path ||
      migration.removedPlaintext ||
      persistRuntimeTuningDefaultsMigration
    if (shouldPersist) {
      try {
        await this.persistSettings(migration.persistedSettings)
      } catch (error) {
        await migration.rollback().catch(() => undefined)
        throw new Error(
          'Legacy credential migration could not commit secret-free settings',
          { cause: error }
        )
      }
    }
    await migration.commit().catch((error) => {
      console.warn('[kun-gui] Legacy credential migration commit marker is pending recovery.', {
        message: error instanceof Error ? error.message : String(error)
      })
    })
    this.cache = migration.runtimeSettings
    return this.cache
  }

  async save(data: AppSettingsV1): Promise<void> {
    const normalized = normalizeStoredSettings(data)
    await ensureManagedWorkspaceRootsExist(normalized)
    const prepared = normalized
    if (this.rejectsPlaintextCredentials(prepared)) {
      throw new Error(
        'Protected credential storage is unavailable while Kun Runtime data migration is blocked; settings containing plaintext credentials were not written'
      )
    }
    if (this.options.credentialMigration && hasLegacyProviderPlaintext(prepared)) {
      const currentRaw = this.options.documentBackend
        ? (await this.options.documentBackend.read()).value ?? serializeSettingsForDisk(prepared)
        : await readFile(this.path, 'utf8').catch((error) => {
            if (isErrnoException(error) && error.code === 'ENOENT') return serializeSettingsForDisk(prepared)
            throw error
          })
      const backupPath = await writeLegacyCredentialSettingsBackup(this.path, currentRaw)
      if (!backupPath) {
        throw new Error('Failed to create the pre-migration settings backup; ordinary settings were not changed')
      }
    }
    const migration = await this.prepareCredentialMigration(prepared, true)
    if (migration === undefined) {
      await this.persistSettings(prepared)
      this.cache = prepared
      return
    }
    if (migration === null) throw new Error('Legacy credential migration is unavailable')
    try {
      await this.persistSettings(migration.persistedSettings)
    } catch (error) {
      await migration.rollback().catch(() => undefined)
      throw error
    }
    await migration.commit().catch((error) => {
      console.warn('[kun-gui] Legacy credential migration commit marker is pending recovery.', {
        message: error instanceof Error ? error.message : String(error)
      })
    })
    this.cache = migration.runtimeSettings
  }

  async patch(partial: AppSettingsPatch): Promise<AppSettingsV1> {
    const cur = await this.load()
    const { agents: agentsPatch, provider: providerPatch, ...restPatch } = partial
    const next = normalizeStoredSettings({
      ...applyKunRuntimePatch(cur, agentsPatch?.kun),
      ...restPatch,
      provider: mergeModelProviderSettings(cur.provider, providerPatch),
      log: { ...cur.log, ...(partial.log ?? {}) },
      checkpointCleanup: normalizeCheckpointCleanupSettings({
        ...cur.checkpointCleanup,
        ...(partial.checkpointCleanup ?? {})
      }),
      notifications: { ...cur.notifications, ...(partial.notifications ?? {}) },
      appBehavior: mergeAppBehaviorSettings(cur.appBehavior, partial.appBehavior),
      keyboardShortcuts: normalizeKeyboardShortcuts({
        bindings: {
          ...cur.keyboardShortcuts.bindings,
          ...(partial.keyboardShortcuts?.bindings ?? {})
        }
      }),
      write: mergeWriteSettings(cur.write, partial.write),
      claw: mergeClawSettings(cur.claw, partial.claw),
      schedule: mergeScheduleSettings(cur.schedule, partial.schedule),
      workflow: mergeWorkflowSettings(cur.workflow, partial.workflow),
      design: mergeDesignSettings(cur.design, partial.design),
      terminal: mergeTerminalSettings(cur.terminal, partial.terminal),
      guiUpdate: { ...cur.guiUpdate, ...(partial.guiUpdate ?? {}) }
    })
    await this.save(next)
    return this.cache ?? next
  }

  private async prepareCredentialMigration(
    settings: AppSettingsV1,
    replaceCommitted: boolean
  ): Promise<SettingsCredentialMigrationResult | null | undefined> {
    if (!this.options.credentialMigration) return undefined
    try {
      return await this.options.credentialMigration.prepare(settings, {
        replaceCommitted,
        ...(replaceCommitted && this.cache ? { previousSettings: this.cache } : {})
      })
    } catch (error) {
      if (replaceCommitted) throw error
      if (hasLegacyProviderPlaintext(settings)) {
        throw new Error(
          'Legacy provider credentials could not be moved to protected storage',
          { cause: error }
        )
      }
      console.warn('[kun-gui] Legacy credential migration is unavailable; retaining compatibility settings.', {
        message: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  }

  private async repairRefreshableCredentialsFromBackup(
    settings: AppSettingsV1,
    sourcePath: string
  ): Promise<void> {
    const credentialMigration = this.options.credentialMigration
    const repair = credentialMigration?.repairRefreshableCredentialsFromBackup
    if (!repair || hasLegacyProviderPlaintext(settings)) return
    const backup = await readLegacyCredentialSettingsBackup(sourcePath)
    if (!backup) return
    try {
      const repairedSourceIds = await repair.call(credentialMigration, settings, backup)
      if (repairedSourceIds.length > 0) {
        console.info('[kun-gui] Recovered refreshable OAuth credentials from the protected migration backup.', {
          sourceIds: repairedSourceIds
        })
      }
    } catch (error) {
      console.warn('[kun-gui] Refreshable OAuth credential recovery was skipped.', {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private rejectsPlaintextCredentials(settings: AppSettingsV1): boolean {
    return this.options.rejectPlaintextCredentials === true &&
      !this.options.credentialMigration &&
      hasLegacyProviderPlaintext(settings)
  }

  private async persistSettings(settings: AppSettingsV1): Promise<void> {
    const serialized = serializeSettingsForDisk(settings)
    if (this.options.documentBackend) {
      const revision = this.documentRevision ?? (await this.options.documentBackend.read()).revision
      const committed = await this.options.documentBackend.write(revision, serialized)
      this.documentRevision = committed.revision
      return
    }
    await mkdir(dirname(this.path), { recursive: true })
    await atomicWriteFile(this.path, serialized)
  }
}

export function getRuntimeBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

export function devServerHintUrl(isPackaged = false): string | undefined {
  return isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
}
