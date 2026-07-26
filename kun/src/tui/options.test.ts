import { describe, expect, it } from 'vitest'
import { parseTuiOptions } from './options.js'

describe('parseTuiOptions', () => {
  it('uses explicit flags above environment values', () => {
    const parsed = parseTuiOptions([
      '--url', 'http://127.0.0.1:19000/',
      '--runtime-token', 'flag-token',
      '--data-dir', '/tmp/kun-tui-data',
      '--workspace', '/tmp/project',
      '--thread', 'thr_1',
      '--continue',
      '--model', 'model-a',
      '--approval-policy', 'on-request',
      '--sandbox-mode', 'workspace-write'
    ], {
      KUN_TUI_URL: 'http://127.0.0.1:18899',
      KUN_RUNTIME_TOKEN: 'env-token'
    }, () => '/tmp/cwd')

    expect(parsed).toMatchObject({
      ok: true,
      options: {
        url: 'http://127.0.0.1:19000',
        runtimeToken: 'flag-token',
        dataDir: '/tmp/kun-tui-data',
        dataDirSource: 'argument',
        workspace: '/tmp/project',
        threadId: 'thr_1',
        continueLatest: true,
        model: 'model-a',
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write'
      }
    })
  })

  it('tracks whether the data dir may be replaced by the GUI-configured default', () => {
    expect(parseTuiOptions([], {}, () => '/tmp')).toMatchObject({
      ok: true,
      options: { dataDirSource: 'default' }
    })
    expect(parseTuiOptions([], { KUN_DATA_DIR: '/tmp/from-env' }, () => '/tmp')).toMatchObject({
      ok: true,
      options: { dataDir: '/tmp/from-env', dataDirSource: 'environment' }
    })
  })

  it('rejects unknown and invalid options', () => {
    expect(parseTuiOptions(['--wat'], {}, () => '/tmp')).toEqual({
      ok: false,
      message: 'unknown option: --wat'
    })
    expect(parseTuiOptions(['--approval-policy', 'unsafe'], {}, () => '/tmp')).toEqual({
      ok: false,
      message: 'invalid approval policy: unsafe'
    })
  })
})
