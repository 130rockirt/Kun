export const GRAPH_NETWORK_PROVIDER_IDS = [
  'web',
  'imageGen',
  'speechGen',
  'musicGen',
  'videoGen',
  'computerUse'
] as const

export function graphBlockedProviderIds(input: {
  blockedMcpServers: readonly string[]
  networkAllowed: boolean
}): string[] {
  return [
    ...input.blockedMcpServers.map((serverId) => `mcp:${serverId}`),
    ...(input.networkAllowed ? [] : GRAPH_NETWORK_PROVIDER_IDS)
  ]
}

const SCOPED_WORKSPACE_TOOL_NAMES = new Set([
  'read',
  'ls',
  'find',
  'grep',
  'write',
  'edit',
  'read_artifact',
  'load_skill'
])

/**
 * Tools backed by an unconstrained process or whole-workspace index cannot
 * honor a narrow Graph assignment. Keep only adapters that cross the shared
 * path resolver/write guard plus Graph's identity-bound worker tools.
 */
export function graphPathScopedToolNames(
  tools: readonly string[],
  readScopes: readonly string[],
  writeScopes: readonly string[]
): string[] {
  if (readScopes.includes('.') && (writeScopes.length === 0 || writeScopes.includes('.'))) {
    return [...tools]
  }
  return tools.filter((tool) =>
    SCOPED_WORKSPACE_TOOL_NAMES.has(tool) ||
    tool.startsWith('graph_worker_'))
}
