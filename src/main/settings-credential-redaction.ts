import {
  getKunRuntimeSettings,
  type AppSettingsPatch,
  type AppSettingsV1
} from '../shared/app-settings'

/**
 * Renderer settings projections intentionally redact provider secrets to `''`
 * (`settings:get` / shared-connection projection). Those empty strings must not
 * be treated as "user cleared the API key" during `settings:set`, or Main's
 * legacy credential migration will `forgetSources` and wipe OAuth/API bindings.
 *
 * Intentional disconnects go through the protected Registry credential DELETE
 * path and do not rely on redacted empty apiKey patches.
 *
 * Read `prev.provider` directly (not via normalize helpers) so per-provider
 * hydrated secrets are not collapsed onto the legacy top-level apiKey field.
 */
export function preserveRedactedProviderCredentials(
  prev: AppSettingsV1,
  partial: AppSettingsPatch
): AppSettingsPatch {
  let next = partial
  const previousProviders = Array.isArray(prev.provider?.providers) ? prev.provider.providers : []
  const previousTopLevelApiKey =
    typeof prev.provider?.apiKey === 'string' ? prev.provider.apiKey : ''
  const previousById = new Map(
    previousProviders.map((provider) => [provider.id, provider])
  )

  if (Array.isArray(partial.provider?.providers)) {
    const providers = partial.provider.providers.map((provider) => {
      if (!provider || typeof provider.id !== 'string') return provider
      const previous = previousById.get(provider.id)
      if (!previous?.apiKey.trim()) return provider
      if (typeof provider.apiKey !== 'string') return provider
      if (provider.apiKey.trim()) return provider
      return { ...provider, apiKey: previous.apiKey }
    })
    const topLevelApiKey =
      typeof partial.provider.apiKey === 'string' &&
      !partial.provider.apiKey.trim() &&
      previousTopLevelApiKey.trim()
        ? previousTopLevelApiKey
        : partial.provider.apiKey
    next = {
      ...next,
      provider: {
        ...partial.provider,
        ...(topLevelApiKey !== undefined ? { apiKey: topLevelApiKey } : {}),
        providers
      }
    }
  } else if (
    typeof partial.provider?.apiKey === 'string' &&
    !partial.provider.apiKey.trim() &&
    previousTopLevelApiKey.trim()
  ) {
    next = {
      ...next,
      provider: {
        ...partial.provider,
        apiKey: previousTopLevelApiKey
      }
    }
  }

  const incomingKun = next.agents?.kun
  const previousKunApiKey = getKunRuntimeSettings(prev).apiKey
  if (
    incomingKun &&
    typeof incomingKun.apiKey === 'string' &&
    !incomingKun.apiKey.trim() &&
    previousKunApiKey.trim()
  ) {
    next = {
      ...next,
      agents: {
        ...next.agents,
        kun: {
          ...incomingKun,
          apiKey: previousKunApiKey
        }
      }
    }
  }

  return next
}
