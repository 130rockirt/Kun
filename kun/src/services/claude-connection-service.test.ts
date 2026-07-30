import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeConnectionService } from './claude-connection-service.js'

const roots: string[] = []
const previousBinary = process.env.KUN_CLAUDE_BINARY

afterEach(async () => {
  if (previousBinary === undefined) delete process.env.KUN_CLAUDE_BINARY
  else process.env.KUN_CLAUDE_BINARY = previousBinary
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ClaudeConnectionService', () => {
  it.skipIf(process.platform === 'win32')('detects an existing binary and captures setup-token securely', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-claude-service-'))
    roots.push(dataDir)
    const binary = join(dataDir, 'claude-fixture')
    await writeFile(binary, '#!/bin/sh\nprintf "login ready\\nsk-ant-oat-test-secret\\n"\n', { mode: 0o700 })
    await chmod(binary, 0o700)
    process.env.KUN_CLAUDE_BINARY = binary
    const service = new ClaudeConnectionService({ dataDir })

    await expect(service.status()).resolves.toMatchObject({ installed: true, path: binary })
    await expect(service.setupToken()).resolves.toBe('sk-ant-oat-test-secret')
  })
})
