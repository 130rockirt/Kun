import {
  KUN_GITHUB_PAT_ENV_VAR,
  KUN_MANAGED_GITHUB_MCP_MARKER,
  KUN_MANAGED_GITHUB_MCP_URL,
  isKunManagedGitHubMcpServer
} from '../../kun/src/contracts/builtin-mcp'

export const BUILTIN_GITHUB_MCP_SERVER_ID = 'github'
export const BUILTIN_GITHUB_MCP_URL = KUN_MANAGED_GITHUB_MCP_URL
export const BUILTIN_GITHUB_MCP_MANAGED_BY = KUN_MANAGED_GITHUB_MCP_MARKER
export const GITHUB_MCP_PAT_ENV_VAR = KUN_GITHUB_PAT_ENV_VAR
export const BUILTIN_GITHUB_MCP_TOOLSETS = [
  'context',
  'repos',
  'issues',
  'pull_requests',
  'users'
] as const

/**
 * Raw descriptor names reviewed as read-only for the official GitHub MCP
 * server. Kun deliberately does not trust remote MCP annotations as an
 * authorization signal, so new upstream tools stay out of Plan mode until
 * this host-authored list is reviewed and updated.
 */
export const BUILTIN_GITHUB_MCP_PLAN_READ_ONLY_TOOLS = [
  'get_me',
  'get_team_members',
  'get_teams',
  'get_commit',
  'get_file_contents',
  'get_latest_release',
  'get_release_by_tag',
  'get_tag',
  'list_branches',
  'list_commits',
  'list_releases',
  'list_repository_collaborators',
  'list_tags',
  'search_code',
  'search_commits',
  'search_repositories',
  'get_label',
  'issue_read',
  'list_issue_fields',
  'list_issue_types',
  'list_issues',
  'search_issues',
  'list_pull_requests',
  'pull_request_read',
  'search_pull_requests',
  'search_users'
] as const

export type BuiltinGitHubMcpServerConfig = {
  enabled: true
  managedBy: typeof BUILTIN_GITHUB_MCP_MANAGED_BY
  transport: 'streamable-http'
  url: string
  headers: Record<string, string>
  trustScope: 'user'
  planModeReadOnlyTools: string[]
  timeoutMs: number
}

/**
 * Build the system-managed GitHub MCP entry without materializing its PAT.
 * Kun resolves the environment reference or GitHub CLI credential only in
 * memory, so config files and renderer diagnostics never receive the token.
 */
export function buildBuiltinGitHubMcpServer(): BuiltinGitHubMcpServerConfig {
  return {
    enabled: true,
    managedBy: BUILTIN_GITHUB_MCP_MANAGED_BY,
    transport: 'streamable-http',
    url: BUILTIN_GITHUB_MCP_URL,
    headers: {
      Authorization: `Bearer \${${GITHUB_MCP_PAT_ENV_VAR}}`,
      'X-MCP-Toolsets': BUILTIN_GITHUB_MCP_TOOLSETS.join(','),
      'X-MCP-Readonly': 'true'
    },
    trustScope: 'user',
    planModeReadOnlyTools: [...BUILTIN_GITHUB_MCP_PLAN_READ_ONLY_TOOLS],
    timeoutMs: 30_000
  }
}

export function isBuiltinGitHubMcpServer(value: unknown): boolean {
  return isKunManagedGitHubMcpServer(value)
}
