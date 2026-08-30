export const KUN_MANAGED_GITHUB_MCP_MARKER = 'kun:github' as const
export const KUN_MANAGED_GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/readonly' as const
export const KUN_GITHUB_PAT_ENV_VAR = 'GITHUB_PAT_TOKEN' as const

/**
 * Recognize only the host-authored GitHub connector. Matching the official URL
 * alone is intentionally insufficient: users may configure that same endpoint
 * with their own headers, scopes, or availability policy.
 */
export function isKunManagedGitHubMcpServer(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const server = value as Record<string, unknown>
  const headers = server.headers
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return false
  const headerRecord = headers as Record<string, unknown>
  return server.managedBy === KUN_MANAGED_GITHUB_MCP_MARKER &&
    server.transport === 'streamable-http' &&
    server.url === KUN_MANAGED_GITHUB_MCP_URL &&
    headerRecord['X-MCP-Readonly'] === 'true'
}
