import { describe, expect, it } from 'vitest'
import {
  CODEX_CLI_VERSION,
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_VERSION,
  codexCliRequestHeaders,
  geminiCliRequestHeaders,
  grokCliMediaHeaders,
  grokCliProxyHeaders
} from './provider-cli-identity.js'

describe('provider-cli-identity', () => {
  it('builds Codex CLI headers with the pinned CLI version and no Kun branding', () => {
    const headers = codexCliRequestHeaders({ accountId: 'acct_1', sessionId: 'sess_1' })
    expect(headers['User-Agent']).toContain(`codex_cli_rs/${CODEX_CLI_VERSION}`)
    expect(headers.originator).toBe('codex_cli_rs')
    expect(JSON.stringify(headers)).not.toMatch(/deepseekgui|kun/i)
  })

  it('builds Gemini CLI headers with the known-working Code Assist identity', () => {
    expect(geminiCliRequestHeaders({ purpose: 'api' })).toEqual({
      'user-agent': 'google-gemini-cli',
      'x-goog-api-client': 'gl-node/kun gemini-cli-api'
    })
    expect(geminiCliRequestHeaders({ purpose: 'audio' })).toEqual({
      'user-agent': 'google-gemini-cli',
      'x-goog-api-client': 'gl-node/kun gemini-cli-audio'
    })
  })

  it('builds Grok Build CLI headers with grok-shell identity', () => {
    expect(grokCliProxyHeaders()).toMatchObject({
      'X-XAI-Token-Auth': 'xai-grok-cli',
      'x-grok-client-version': GROK_CLI_VERSION,
      'x-grok-client-mode': 'interactive'
    })
    expect(grokCliMediaHeaders()).toEqual({
      'User-Agent': `xai-grok-build/${GROK_CLI_VERSION}`,
      'x-grok-client-version': GROK_CLI_VERSION,
      'x-grok-client-identifier': GROK_CLI_CLIENT_IDENTIFIER
    })
    expect(GROK_CLI_CLIENT_IDENTIFIER).toBe('grok-shell')
  })
})
