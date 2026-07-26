import { describe, expect, it } from 'vitest'
import { buildHarness } from '../../tests/http-server-test-harness.js'

const TUI_RUNTIME_ROUTES = [
  ['GET', '/v1/runtime/info'],
  ['POST', '/v1/runtime/config/apply'],
  ['GET', '/v1/runtime/tools'],
  ['GET', '/v1/skills?workspace=%2Ftmp%2Fproject'],
  ['GET', '/v1/delegation/diagnostics?parent_thread_id=thr_1'],
  ['GET', '/v1/background-shells?thread_id=thr_1'],
  ['GET', '/v1/model-connections'],
  ['GET', '/v1/model-connections/events?since_revision=1'],
  ['POST', '/v1/model-connections/connect'],
  ['PATCH', '/v1/model-connections/provider-a'],
  ['PUT', '/v1/model-connections/provider-a/credential'],
  ['DELETE', '/v1/model-connections/provider-a?expected_revision=1'],
  ['POST', '/v1/model-connections/provider-a/probe'],
  ['POST', '/v1/model-connections/select'],
  ['POST', '/v1/model-connections/oauth/start'],
  ['GET', '/v1/model-connections/oauth/oauth_1'],
  ['POST', '/v1/model-connections/oauth/oauth_1/submit'],
  ['DELETE', '/v1/model-connections/oauth/oauth_1'],
  ['GET', '/v1/model-connections/claude/sdk'],
  ['POST', '/v1/model-connections/claude/sdk/install'],
  ['GET', '/v1/threads?limit=200'],
  ['POST', '/v1/threads'],
  ['GET', '/v1/threads/thr_1'],
  ['PATCH', '/v1/threads/thr_1'],
  ['DELETE', '/v1/threads/thr_1'],
  ['POST', '/v1/threads/thr_1/fork'],
  ['GET', '/v1/threads/thr_1/goal'],
  ['POST', '/v1/threads/thr_1/goal'],
  ['DELETE', '/v1/threads/thr_1/goal'],
  ['GET', '/v1/threads/thr_1/todos'],
  ['POST', '/v1/threads/thr_1/turns'],
  ['POST', '/v1/threads/thr_1/turns/turn_1/steer'],
  ['POST', '/v1/threads/thr_1/turns/turn_1/interrupt'],
  ['POST', '/v1/threads/thr_1/compact'],
  ['GET', '/v1/threads/thr_1/events?since_seq=1'],
  ['POST', '/v1/approvals/approval_1'],
  ['POST', '/v1/user-inputs/input_1'],
  ['GET', '/v1/usage?group_by=thread']
] as const

describe('TUI client/runtime route contract', () => {
  it('keeps every HTTP/SSE operation used by TUI commands registered by the runtime', () => {
    const router = buildHarness().router
    for (const [method, path] of TUI_RUNTIME_ROUTES) {
      expect(router.match(method, path.split('?')[0]!), `${method} ${path}`).toBeDefined()
    }
  })
})
