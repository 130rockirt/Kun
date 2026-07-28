export type DataMigrationFeatureEnvironment = {
  KUN_DATA_MIGRATION_ENABLED?: string
}

/**
 * Data migration remains an internal dogfood capability until the packaged-app
 * cross-platform, security, and recovery gates are complete. Packaged public
 * builds do not inherit release-runner environment variables, so absence of an
 * explicit opt-in must keep new exports/imports disabled.
 *
 * Internal or diagnostic launches can set the override to `1`. Disabling new
 * operations does not hide interrupted-operation recovery.
 */
export function resolveDataMigrationFeatureEnabled(
  environment: DataMigrationFeatureEnvironment = {
    KUN_DATA_MIGRATION_ENABLED: process.env.KUN_DATA_MIGRATION_ENABLED
  }
): boolean {
  return environment.KUN_DATA_MIGRATION_ENABLED === '1'
}
