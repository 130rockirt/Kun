const CLAUDE_OAUTH_TOKEN_PATTERN = /^sk-ant-oat[\w-]+$/

export type ClaudeTokenValidation =
  | { ok: true; token: string }
  | { ok: false; message: 'invalid-token-format' }

/** Accept only the complete setup-token value, never surrounding shell syntax. */
export function validateClaudeSubscriptionToken(raw: string): ClaudeTokenValidation {
  const token = raw.trim()
  if (token && CLAUDE_OAUTH_TOKEN_PATTERN.test(token)) return { ok: true, token }
  return { ok: false, message: 'invalid-token-format' }
}
