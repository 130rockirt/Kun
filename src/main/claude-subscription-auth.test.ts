import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  claudeSubscriptionStatus,
  probeClaudeSubscription,
  resolveBundledClaudeBinary,
  runClaudeSubscriptionLogin,
  validateClaudeSubscriptionToken
} from './claude-subscription-auth'

function fakeChild(): EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}

describe('validateClaudeSubscriptionToken', () => {
  test('accepts only a complete setup-token value', () => {
    expect(validateClaudeSubscriptionToken('  sk-ant-oat01-AbC123_xyz-DEF  ')).toEqual({
      ok: true,
      token: 'sk-ant-oat01-AbC123_xyz-DEF'
    })
    for (const invalid of [
      '',
      'Bearer sk-ant-oat01-token',
      'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-token',
      '"sk-ant-oat01-token"',
      'sk-ant-api03-console',
      'sk-ant-oat01-token suffix'
    ]) {
      expect(validateClaudeSubscriptionToken(invalid)).toEqual({
        ok: false,
        message: 'invalid-token-format'
      })
    }
  })
})

describe('claudeSubscriptionStatus', () => {
  test('trusts structured CLI status even without a credentials file', async () => {
    const child = fakeChild()
    const promise = claudeSubscriptionStatus({
      credentialsPath: join(tmpdir(), 'kun-claude-status-missing'),
      spawnFn: (() => child) as never
    })
    child.stdout.emit('data', Buffer.from(JSON.stringify({
      loggedIn: true,
      email: 'must-not-leak@example.test',
      subscriptionType: 'pro'
    })))
    child.emit('exit', 0)
    expect(await promise).toEqual({ loggedIn: true, source: 'cli' })
  })

  test('uses the credential file only as a compatibility fallback', async () => {
    const root = join(tmpdir(), `kun-claude-status-${process.pid}-${Date.now()}`)
    const credentialsPath = join(root, '.credentials.json')
    mkdirSync(root, { recursive: true })
    writeFileSync(credentialsPath, '{}')
    try {
      const child = fakeChild()
      const promise = claudeSubscriptionStatus({
        credentialsPath,
        spawnFn: (() => child) as never
      })
      child.stderr.emit('data', Buffer.from('unknown command auth status'))
      child.emit('exit', 1)
      expect(await promise).toEqual({
        loggedIn: true,
        source: 'credentials-file',
        message: 'cli-status-unavailable'
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('bounds a hung status command and returns a diagnostic code', async () => {
    const child = fakeChild()
    await expect(claudeSubscriptionStatus({
      credentialsPath: join(tmpdir(), 'kun-claude-status-timeout-missing'),
      spawnFn: (() => child) as never,
      timeoutMs: 5
    })).resolves.toEqual({
      loggedIn: false,
      source: 'none',
      message: 'status-timeout'
    })
    expect(child.kill).toHaveBeenCalled()
  })
})

describe('runClaudeSubscriptionLogin', () => {
  test('completes from status polling and kills a still-open login helper', async () => {
    const child = fakeChild()
    let checks = 0
    const promise = runClaudeSubscriptionLogin({
      binaryPath: '/bundled/claude',
      spawnFn: (() => child) as never,
      pollIntervalMs: 1,
      timeoutMs: 100,
      status: async () => ({
        loggedIn: ++checks >= 3,
        source: checks >= 3 ? 'cli' : 'none'
      })
    })
    await expect(promise).resolves.toEqual({ ok: true, mode: 'ambient' })
    expect(child.kill).toHaveBeenCalled()
  })

  test('does not spawn when ambient login already exists', async () => {
    const spawnFn = vi.fn()
    await expect(runClaudeSubscriptionLogin({
      spawnFn: spawnFn as never,
      status: async () => ({ loggedIn: true, source: 'cli' })
    })).resolves.toEqual({ ok: true, mode: 'ambient' })
    expect(spawnFn).not.toHaveBeenCalled()
  })

  test('redacts token-like output when login exits unauthenticated', async () => {
    const child = fakeChild()
    const promise = runClaudeSubscriptionLogin({
      spawnFn: (() => child) as never,
      status: async () => ({ loggedIn: false, source: 'none' })
    })
    await Promise.resolve()
    child.stderr.emit('data', Buffer.from('rejected sk-ant-oat01-secret-value'))
    child.emit('exit', 1)
    const result = await promise
    expect(result).toEqual({ ok: false, message: 'rejected <redacted>' })
  })

  test('times out and stops the helper', async () => {
    const child = fakeChild()
    await expect(runClaudeSubscriptionLogin({
      spawnFn: (() => child) as never,
      status: async () => ({ loggedIn: false, source: 'none' }),
      pollIntervalMs: 1,
      timeoutMs: 5
    })).resolves.toEqual({ ok: false, message: 'timeout' })
    expect(child.kill).toHaveBeenCalled()
  })
})

describe('probeClaudeSubscription', () => {
  test('rejects malformed tokens without spawning Claude', async () => {
    const spawnFn = vi.fn()
    await expect(probeClaudeSubscription({
      token: 'Bearer sk-ant-oat01-secret',
      spawnFn: spawnFn as never
    })).resolves.toEqual({ ok: false, message: 'invalid-token-format' })
    expect(spawnFn).not.toHaveBeenCalled()
  })

  test('makes a bounded real no-tools request with the OAuth token', async () => {
    const child = fakeChild()
    const seen: { args?: string[]; envToken?: string } = {}
    const promise = probeClaudeSubscription({
      token: 'sk-ant-oat01-valid-token',
      binaryPath: '/bundled/claude',
      spawnFn: ((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        seen.args = args
        seen.envToken = options.env?.CLAUDE_CODE_OAUTH_TOKEN
        return child
      }) as never,
      now: (() => {
        let value = 100
        return () => (value += 25)
      })()
    })
    child.stdout.emit('data', Buffer.from('{"result":"KUN_AUTH_OK"}'))
    child.emit('exit', 0)
    expect(await promise).toEqual({ ok: true, latencyMs: 25 })
    expect(seen.args).toEqual(expect.arrayContaining([
      '-p',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--tools',
      ''
    ]))
    expect(seen.envToken).toBe('sk-ant-oat01-valid-token')
  })

  test('returns a redacted upstream authentication failure', async () => {
    const child = fakeChild()
    const token = 'sk-ant-oat01-rejected-token'
    const promise = probeClaudeSubscription({
      token,
      spawnFn: (() => child) as never
    })
    child.stderr.emit('data', Buffer.from(`Failed to authenticate: Invalid Bearer ${token}`))
    child.emit('exit', 1)
    const result = await promise
    expect(result).toEqual({
      ok: false,
      message: 'Failed to authenticate: Invalid Bearer <redacted>'
    })
    expect(JSON.stringify(result)).not.toContain(token)
  })
})

describe('resolveBundledClaudeBinary', () => {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null
  const plat =
    process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : null

  test.runIf(arch && plat)('finds the per-platform bundled binary; undefined when absent', () => {
    const bin = plat === 'win32' ? 'claude.exe' : 'claude'
    const root = join(tmpdir(), `kun-sub-bin-${process.pid}`)
    const dir = join(root, 'node_modules', `@anthropic-ai/claude-agent-sdk-${plat}-${arch}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, bin), '')
    try {
      expect(resolveBundledClaudeBinary([root])).toBe(join(dir, bin))
      expect(resolveBundledClaudeBinary([join(tmpdir(), 'kun-sub-none')])).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
