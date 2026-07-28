import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  createSecretEncryptor,
  defaultSecretCommandRunner,
  hasPersistedSecretKeyMaterial
} from '../../kun/src/security/secret-store.js'
import { ExtensionCredentialStore } from '../../kun/src/services/extension-credential-store.js'
import { LegacyProviderCredentialMigrationService } from '../../kun/src/services/legacy-provider-credential-migration.js'
import { ExtensionProviderAccountStore } from '../../kun/src/services/extension-provider-account-store.js'
import { parseStoredCodexOAuthCredentials } from '../../kun/src/services/codex-oauth-credential-refresher.js'
import { parseStoredGrokOAuthCredentials } from '../../kun/src/services/grok-oauth-credential-refresher.js'
import {
  DEFAULT_MODEL_PROVIDER_ID,
  getKunRuntimeSettings,
  getModelProviderSettings,
  type AppSettingsV1,
  type ModelProviderProfileV1
} from '../shared/app-settings'
import { assertManagedKunDataDirIsCurrent } from './kun-data-dir-paths'

export const LEGACY_PROVIDER_SOURCE_PREFIX = 'settings:provider:'
export const LEGACY_RUNTIME_OVERRIDE_SOURCE_ID = 'settings:runtime:override'

export type PreparedLegacyProviderSettingsMigration = {
  /** Ephemeral compatibility projection used by existing in-process callers. */
  runtimeSettings: AppSettingsV1
  /** Secret-free projection that is safe to write to ordinary settings. */
  persistedSettings: AppSettingsV1
  sourceIdsToCommit: string[]
  removedPlaintext: boolean
  rollback: () => Promise<void>
  commit: () => Promise<void>
}

type MigrationRuntime = {
  service: LegacyProviderCredentialMigrationService
}

type MigrationRuntimeFactory = (dataDir: string) => Promise<MigrationRuntime>

/**
 * Bridges the GUI's legacy settings shape to Kun's protected account store.
 * It intentionally leaves existing synchronous settings consumers on an
 * ephemeral compatibility projection for one release cycle; disk writes use
 * only the secret-free projection and durable account-reference bindings.
 */
export class LegacyProviderSettingsMigrationCoordinator {
  private readonly runtimes = new Map<string, Promise<MigrationRuntime>>()

  constructor(private readonly runtimeFactory: MigrationRuntimeFactory = createMigrationRuntime) {}

  async prepare(
    settings: AppSettingsV1,
    options: { replaceCommitted?: boolean } = {}
  ): Promise<PreparedLegacyProviderSettingsMigration> {
    const dataDir = resolveSettingsDataDir(settings)
    assertManagedKunDataDirIsCurrent(dataDir)
    const { service } = await this.runtime(dataDir)
    // Save path only: an empty apiKey means the caller intentionally cleared
    // credentials (disconnect / revoke). Drop the secure binding so hydrate
    // cannot resurrect the previous secret. Load path keeps empty plaintext
    // + existing bindings so restart still restores logged-in sessions.
    if (options.replaceCommitted === true) {
      await service.forgetSources(collectClearedLegacyCredentialSourceIds(settings))
    }
    const sources = collectLegacyCredentialSources(settings)
    const migrations = await service.migrate(sources, {
      replaceCommitted: options.replaceCommitted === true
    })
    const migratedSourceIds = new Set(migrations.map((entry) => entry.sourceId))
    const persistedSettings = stripMigratedPlaintext(settings, migratedSourceIds)
    const bindings = await service.listBindings()
    const sourceIdsToCommit = new Set(migrations.map((entry) => entry.sourceId))

    for (const binding of bindings) {
      if (binding.phase !== 'secure-committed') continue
      if (isRecognizedSettingsSource(binding.sourceId)) sourceIdsToCommit.add(binding.sourceId)
    }

    const runtimeSettings = await hydrateSettingsFromBindings(persistedSettings, service)
    const sourceIds = [...sourceIdsToCommit].sort()
    return {
      runtimeSettings,
      persistedSettings,
      sourceIdsToCommit: sourceIds,
      removedPlaintext: migrations.some((entry) => entry.removePlaintext),
      rollback: () => service.rollbackPending(sourceIds),
      commit: () => service.markSettingsCommitted(sourceIds)
    }
  }

  /**
   * Older Registry seeding could persist only an OAuth access token back into
   * a settings-owned protected source. Recover the complete refreshable value
   * from the one-time pre-migration backup, but only when the source still
   * exists and its protected static value is either that OAuth access token or
   * a rotated OpenAI token for the same issuer and ChatGPT account. A cleared
   * source or an unrelated replacement API key is never resurrected.
   */
  async repairRefreshableCredentialsFromBackup(
    settings: AppSettingsV1,
    backupSettings: AppSettingsV1
  ): Promise<string[]> {
    const dataDir = resolveSettingsDataDir(settings)
    assertManagedKunDataDirIsCurrent(dataDir)
    const { service } = await this.runtime(dataDir)
    const bindings = new Set((await service.listBindings()).map((entry) => entry.sourceId))
    const repaired: string[] = []

    for (const source of collectRefreshableOAuthRecoverySources(settings, backupSettings)) {
      if (!bindings.has(source.sourceId)) continue
      const current = await service.resolveApiKey(source.sourceId, {
        includeUnavailable: true
      }).catch(() => null)
      if (!current) continue
      if (isRefreshableOAuthCredential(current.apiKey)) continue
      if (!staticCredentialMatchesRefreshableBackup(current.apiKey, source.apiKey)) continue

      const migrations = await service.migrate([source], { replaceCommitted: true })
      if (!migrations.some((entry) => entry.sourceId === source.sourceId)) continue
      await service.markSettingsCommitted([source.sourceId])
      repaired.push(source.sourceId)
    }

    return repaired.sort()
  }

  private runtime(dataDir: string): Promise<MigrationRuntime> {
    let pending = this.runtimes.get(dataDir)
    if (!pending) {
      pending = this.runtimeFactory(dataDir)
      this.runtimes.set(dataDir, pending)
      void pending.catch(() => {
        if (this.runtimes.get(dataDir) === pending) this.runtimes.delete(dataDir)
      })
    }
    return pending
  }

  invalidateRuntime(dataDir: string): void {
    this.runtimes.delete(dataDir)
  }
}

export function legacyProviderCredentialSourceId(providerId: string): string {
  return `${LEGACY_PROVIDER_SOURCE_PREFIX}${providerId.trim()}`
}

function collectLegacyCredentialSources(settings: AppSettingsV1) {
  const providerSettings = getModelProviderSettings(settings)
  const runtime = getKunRuntimeSettings(settings)
  const sources = providerSettings.providers
    .filter((provider) => provider.apiKey.trim())
    .map((provider) => ({
      sourceId: legacyProviderCredentialSourceId(provider.id),
      providerId: provider.id,
      providerName: provider.name,
      label: `${provider.name} legacy provider credential`,
      apiKey: provider.apiKey,
      ...(preferredProviderModel(provider, runtime.model) ? {
        modelId: preferredProviderModel(provider, runtime.model)
      } : {})
    }))

  if (runtime.apiKey.trim()) {
    const providerId = runtime.providerId.trim() || providerSettings.providers[0]?.id || DEFAULT_MODEL_PROVIDER_ID
    const provider = providerSettings.providers.find((entry) => entry.id === providerId)
    sources.push({
      sourceId: LEGACY_RUNTIME_OVERRIDE_SOURCE_ID,
      providerId,
      providerName: provider?.name ?? providerId,
      label: 'Kun legacy runtime override',
      apiKey: runtime.apiKey,
      ...(runtime.model.trim() ? { modelId: runtime.model.trim() } : {})
    })
  }
  return sources
}

function collectRefreshableOAuthRecoverySources(
  settings: AppSettingsV1,
  backupSettings: AppSettingsV1
) {
  const currentProviders = new Map(
    getModelProviderSettings(settings).providers.map((provider) => [provider.id, provider])
  )
  const runtime = getKunRuntimeSettings(settings)
  return getModelProviderSettings(backupSettings).providers.flatMap((backupProvider) => {
    const current = currentProviders.get(backupProvider.id)
    if (!current || !isRefreshableOAuthCredential(backupProvider.apiKey)) return []
    return [{
      sourceId: legacyProviderCredentialSourceId(current.id),
      providerId: current.id,
      providerName: current.name,
      label: `${current.name} recovered OAuth credential`,
      apiKey: backupProvider.apiKey,
      ...(preferredProviderModel(current, runtime.model) ? {
        modelId: preferredProviderModel(current, runtime.model)
      } : {})
    }]
  })
}

function isRefreshableOAuthCredential(rawApiKey: string): boolean {
  return parseStoredCodexOAuthCredentials(rawApiKey) !== null ||
    parseStoredGrokOAuthCredentials(rawApiKey) !== null
}

function staticCredentialMatchesRefreshableBackup(
  staticApiKey: string,
  rawBackup: string
): boolean {
  const value = staticApiKey.trim()
  const codex = parseStoredCodexOAuthCredentials(rawBackup)
  if (codex) {
    if (value === codex.accessToken) return true
    const claims = parseJwtClaims(value)
    return claims?.iss === 'https://auth.openai.com' &&
      codexAccountIdFromClaims(claims) === codex.accountId
  }
  const grok = parseStoredGrokOAuthCredentials(rawBackup)
  return grok !== null && value === grok.accessToken
}

function parseJwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function codexAccountIdFromClaims(claims: Record<string, unknown>): string {
  if (typeof claims.chatgpt_account_id === 'string') return claims.chatgpt_account_id
  const auth = claims['https://api.openai.com/auth']
  if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id
    if (typeof accountId === 'string') return accountId
  }
  if (Array.isArray(claims.organizations)) {
    const organization = claims.organizations[0]
    if (organization && typeof organization === 'object' && !Array.isArray(organization)) {
      const accountId = (organization as Record<string, unknown>).id
      if (typeof accountId === 'string') return accountId
    }
  }
  return ''
}

/** Source ids whose plaintext is empty and should be forgotten on save. */
function collectClearedLegacyCredentialSourceIds(settings: AppSettingsV1): string[] {
  const providerSettings = getModelProviderSettings(settings)
  const runtime = getKunRuntimeSettings(settings)
  const sourceIds = providerSettings.providers
    .filter((provider) => !provider.apiKey.trim())
    .map((provider) => legacyProviderCredentialSourceId(provider.id))
  if (!runtime.apiKey.trim()) sourceIds.push(LEGACY_RUNTIME_OVERRIDE_SOURCE_ID)
  return sourceIds
}

function stripMigratedPlaintext(
  settings: AppSettingsV1,
  migratedSourceIds: ReadonlySet<string>
): AppSettingsV1 {
  const provider = getModelProviderSettings(settings)
  const providers = provider.providers.map((entry) => migratedSourceIds.has(legacyProviderCredentialSourceId(entry.id))
    ? { ...entry, apiKey: '' }
    : entry)
  const defaultProvider = providers.find((entry) => entry.id === DEFAULT_MODEL_PROVIDER_ID) ?? providers[0]
  const runtime = getKunRuntimeSettings(settings)
  return {
    ...settings,
    provider: {
      ...provider,
      apiKey: migratedSourceIds.has(legacyProviderCredentialSourceId(DEFAULT_MODEL_PROVIDER_ID))
        ? ''
        : defaultProvider?.apiKey ?? provider.apiKey,
      providers
    },
    agents: {
      ...settings.agents,
      kun: migratedSourceIds.has(LEGACY_RUNTIME_OVERRIDE_SOURCE_ID)
        ? { ...runtime, apiKey: '' }
        : runtime
    }
  }
}

async function hydrateSettingsFromBindings(
  settings: AppSettingsV1,
  service: LegacyProviderCredentialMigrationService
): Promise<AppSettingsV1> {
  const provider = getModelProviderSettings(settings)
  const providers: ModelProviderProfileV1[] = []
  for (const entry of provider.providers) {
    const resolved = await resolveLegacyApiKey(
      service,
      legacyProviderCredentialSourceId(entry.id)
    )
    providers.push(resolved ? { ...entry, apiKey: resolved.apiKey } : entry)
  }
  const defaultProvider = providers.find((entry) => entry.id === DEFAULT_MODEL_PROVIDER_ID) ?? providers[0]
  const runtime = getKunRuntimeSettings(settings)
  const runtimeOverride = await resolveLegacyApiKey(service, LEGACY_RUNTIME_OVERRIDE_SOURCE_ID)
  return {
    ...settings,
    provider: {
      ...provider,
      apiKey: defaultProvider?.apiKey ?? '',
      providers
    },
    agents: {
      ...settings.agents,
      kun: runtimeOverride ? { ...runtime, apiKey: runtimeOverride.apiKey } : runtime
    }
  }
}

async function resolveLegacyApiKey(
  service: LegacyProviderCredentialMigrationService,
  sourceId: string
): Promise<Awaited<ReturnType<LegacyProviderCredentialMigrationService['resolveApiKey']>>> {
  try {
    return await service.resolveApiKey(sourceId)
  } catch (error) {
    // Credential records can outlive the key that encrypted them after an OS
    // keychain reset, profile restore, or copied data directory. One unreadable
    // legacy record must not make settings:set fail for a different provider:
    // keep that profile unhydrated so the user can replace its key explicitly.
    console.warn('[kun-gui] Legacy provider credential could not be restored; the saved profile will require a new key.', {
      sourceId,
      message: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

function preferredProviderModel(provider: ModelProviderProfileV1, runtimeModel: string): string | undefined {
  const selected = runtimeModel.trim()
  if (selected && provider.models.includes(selected)) return selected
  return provider.models.find((model) => model.trim())?.trim()
}

function isRecognizedSettingsSource(sourceId: string): boolean {
  return sourceId === LEGACY_RUNTIME_OVERRIDE_SOURCE_ID || sourceId.startsWith(LEGACY_PROVIDER_SOURCE_PREFIX)
}

export function resolveSettingsDataDir(settings: AppSettingsV1): string {
  const value = getKunRuntimeSettings(settings).dataDir.trim()
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homedir(), value.slice(2).replace(/\\/g, '/'))
  }
  return value
}

async function createMigrationRuntime(dataDir: string): Promise<MigrationRuntime> {
  const keyProvider = await createSecretEncryptor({
    keyFilePath: join(dataDir, 'secret.key'),
    run: defaultSecretCommandRunner,
    canBootstrapKeyFileFallback: async () => !(await hasPersistedSecretKeyMaterial(dataDir))
  })
  const accounts = new ExtensionProviderAccountStore({ dataDir })
  const credentials = new ExtensionCredentialStore({
    dataDir,
    profileId: 'default',
    keyProvider
  })
  return {
    service: new LegacyProviderCredentialMigrationService({
      dataDir,
      accounts,
      credentials
    })
  }
}
