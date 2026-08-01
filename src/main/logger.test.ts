import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureLogger, logInfo } from './logger'

let logDir = ''

beforeEach(async () => {
  logDir = await mkdtemp(join(tmpdir(), 'kun-main-log-'))
  configureLogger({ dir: logDir, enabled: true, retentionDays: 7 })
})

afterEach(async () => {
  configureLogger({ dir: '', enabled: true, retentionDays: 7 })
  await rm(logDir, { recursive: true, force: true })
})

describe('main logger', () => {
  it('persists structured detail for informational diagnostics', async () => {
    logInfo('approval', 'Protected native approval dialog resolved.', {
      approvalRef: 'sha256:0123456789abcdef',
      response: 1
    })

    let contents = ''
    await vi.waitFor(async () => {
      const [entry] = await readdir(logDir)
      contents = await readFile(join(logDir, entry!), 'utf8')
      expect(contents).toContain('sha256:0123456789abcdef')
    })

    expect(contents).toContain('"response": 1')
  })
})
