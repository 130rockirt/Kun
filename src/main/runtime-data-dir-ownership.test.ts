import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RUNTIME_DATA_DIR_OWNER_FILE } from '../../kun/src/server/runtime-data-dir-lease.js'
import {
  activeKunRuntimePidsForDataDir,
  commandUsesKunDataDir
} from './runtime-data-dir-ownership'

const tempRoots: string[] = []

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

describe('Runtime data directory ownership detection', () => {
  it('recognizes managed and standalone Kun serve commands using the legacy directory', () => {
    expect(commandUsesKunDataDir(
      '/Applications/Kun.app/Contents/MacOS/Kun /app/serve-entry.js serve --data-dir /Users/zoe/.deepseekgui/kun',
      '/Users/zoe/.deepseekgui/kun',
      'darwin'
    )).toBe(true)
    expect(commandUsesKunDataDir(
      'kun serve --data-dir C:\\Users\\Zoë\\.DEEPSEEKGUI\\KUN',
      'c:\\users\\zoë\\.deepseekgui\\kun',
      'win32'
    )).toBe(true)
    expect(commandUsesKunDataDir(
      'node "/opt/custom runtime.js" --data-dir="/Users/zoe/Library Data/.deepseekgui/kun"',
      '/Users/zoe/Library Data/.deepseekgui/kun',
      'darwin'
    )).toBe(true)
    expect(commandUsesKunDataDir(
      'node unrelated.js /Users/zoe/.deepseekgui/kun',
      '/Users/zoe/.deepseekgui/kun',
      'darwin'
    )).toBe(false)
    expect(commandUsesKunDataDir(
      'kun serve --data-dir /Users/zoe/.deepseekgui/kun-other',
      '/Users/zoe/.deepseekgui/kun',
      'darwin'
    )).toBe(false)
    expect(commandUsesKunDataDir(
      'kun serve --dataDir /Users/zoe/.deepseekgui/kun/',
      '/Users/zoe/.deepseekgui/kun',
      'darwin'
    )).toBe(true)
    expect(commandUsesKunDataDir(
      'KUN_DATA_DIR=/Users/zoe/.deepseekgui/kun kun serve',
      '/Users/zoe/.deepseekgui/kun',
      'darwin'
    )).toBe(true)
    expect(commandUsesKunDataDir(
      'kun serve --data-dir ../.deepseekgui/kun',
      '/home/zoe/.deepseekgui/kun',
      'linux',
      { cwd: '/home/zoe/workspace' }
    )).toBe(true)
  })

  it('recognizes environment and explicit config data-directory sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-runtime-owner-'))
    tempRoots.push(root)
    const legacy = join(root, '.deepseekgui', 'kun')
    const configPath = join(root, 'kun-config.json')
    await mkdir(legacy, { recursive: true })
    await writeFile(configPath, JSON.stringify({ serve: { dataDir: legacy } }), 'utf8')

    expect(commandUsesKunDataDir(
      'kun serve',
      legacy,
      process.platform,
      { environment: { KUN_DATA_DIR: legacy } }
    )).toBe(true)
    expect(commandUsesKunDataDir(
      `kun serve --config "${configPath}"`,
      legacy,
      process.platform
    )).toBe(true)

    await writeFile(configPath, '{broken', 'utf8')
    expect(() => commandUsesKunDataDir(
      `kun serve --config "${configPath}"`,
      legacy,
      process.platform
    )).toThrow(/could not inspect Kun Runtime config/)
  })

  it('returns only other Kun Runtime processes using the selected directory', () => {
    const ownPid = process.pid
    expect(activeKunRuntimePidsForDataDir('/home/zoe/.deepseekgui/kun', {
      platform: 'linux',
      processCommands: () => [
        {
          pid: ownPid,
          command: 'kun serve --data-dir /home/zoe/.deepseekgui/kun'
        },
        {
          pid: 4242,
          command: 'node /opt/kun/serve-entry.js serve --data-dir /home/zoe/.deepseekgui/kun'
        },
        {
          pid: 4343,
          command: 'kun serve --data-dir /home/other/.kun/data'
        }
      ]
    })).toEqual([4242])
  })

  it('detects a live Runtime lease even when its environment is not visible', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-runtime-owner-'))
    tempRoots.push(dataDir)
    await writeFile(
      join(dataDir, RUNTIME_DATA_DIR_OWNER_FILE),
      JSON.stringify({
        schemaVersion: 1,
        pid: 5151,
        token: 'runtime-token',
        startedAt: '2026-07-26T00:00:00.000Z'
      }),
      'utf8'
    )

    expect(activeKunRuntimePidsForDataDir(dataDir, {
      platform: process.platform,
      processCommands: () => [],
      processIsAlive: (pid) => pid === 5151
    })).toEqual([5151])
  })

  it('fails closed when process ownership cannot be inventoried', () => {
    expect(() => activeKunRuntimePidsForDataDir('/home/zoe/.deepseekgui/kun', {
      platform: 'linux',
      processCommands: () => {
        throw new Error('process inventory denied')
      }
    })).toThrow(/process inventory denied/)
  })
})
