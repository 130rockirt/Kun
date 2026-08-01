import {
  type OpenConnectorDesktopSettingsPatchV1,
  type OpenConnectorDesktopSettingsV1
} from './app-settings-types'
import { DEFAULT_OPEN_CONNECTOR_PORT } from './open-connector'

export function defaultOpenConnectorDesktopSettings(): OpenConnectorDesktopSettingsV1 {
  return {
    enabled: false,
    port: DEFAULT_OPEN_CONNECTOR_PORT
  }
}

export function normalizeOpenConnectorDesktopSettings(
  input?: OpenConnectorDesktopSettingsPatchV1
): OpenConnectorDesktopSettingsV1 {
  const parsedPort = typeof input?.port === 'number' ? input.port : Number(input?.port)
  return {
    enabled: input?.enabled === true,
    port: Number.isInteger(parsedPort) && parsedPort >= 10_000 && parsedPort <= 65_535
      ? parsedPort
      : DEFAULT_OPEN_CONNECTOR_PORT
  }
}

export function mergeOpenConnectorDesktopSettings(
  current: OpenConnectorDesktopSettingsV1 | undefined,
  patch?: OpenConnectorDesktopSettingsPatchV1
): OpenConnectorDesktopSettingsV1 {
  return normalizeOpenConnectorDesktopSettings({ ...(current ?? {}), ...(patch ?? {}) })
}
