import navigationProviders from './settings/navigation-providers.json'
import providerMediaMcp from './settings/provider-media-mcp.json'
import mcpMigration from './settings/mcp-migration.json'
import migrationSystem from './settings/migration-system.json'

const settings = {
  ...navigationProviders,
  ...providerMediaMcp,
  ...mcpMigration,
  ...migrationSystem,
}

export default settings
