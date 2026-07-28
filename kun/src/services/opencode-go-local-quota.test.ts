import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  buildOpenCodeGoLocalQuota,
  readOpenCodeGoLocalQuota,
  resolveOpenCodeGoDatabasePath
} from './opencode-go-local-quota.js'

describe('OpenCode Go local quota', () => {
  it('calculates CodexBar-compatible rolling, weekly, and anchored monthly windows', () => {
    const result = buildOpenCodeGoLocalQuota([
      { createdMs: Date.parse('2026-03-06T12:00:00.000Z'), cost: 3 },
      { createdMs: Date.parse('2026-03-05T12:00:00.000Z'), cost: 6 },
      { createdMs: Date.parse('2026-02-25T10:00:00.000Z'), cost: 2 }
    ], new Date('2026-03-06T16:00:00.000Z'))

    expect(result.summary).toBe('Local estimate · $12 / $30 / $60 plan limits')
    expect(result.metrics).toEqual([
      {
        id: 'five-hour',
        label: '5-hour usage',
        unit: 'USD',
        used: 3,
        limit: 12,
        remaining: 9,
        usedPercent: 25,
        resetsAt: '2026-03-06T17:00:00.000Z'
      },
      {
        id: 'weekly',
        label: 'Weekly usage',
        unit: 'USD',
        used: 9,
        limit: 30,
        remaining: 21,
        usedPercent: 30,
        resetsAt: '2026-03-09T00:00:00.000Z'
      },
      {
        id: 'monthly',
        label: 'Monthly usage',
        unit: 'USD',
        used: 11,
        limit: 60,
        remaining: 49,
        usedPercent: 18.3,
        resetsAt: '2026-03-25T10:00:00.000Z'
      }
    ])
  })

  it('resolves Linux, XDG, and Windows database paths', () => {
    expect(resolveOpenCodeGoDatabasePath({
      platform: 'linux',
      environment: {},
      homeDirectory: '/home/kun'
    })).toBe('/home/kun/.local/share/opencode/opencode.db')
    expect(resolveOpenCodeGoDatabasePath({
      platform: 'linux',
      environment: { XDG_DATA_HOME: '/data/kun' },
      homeDirectory: '/home/kun'
    })).toBe('/data/kun/opencode/opencode.db')
    expect(resolveOpenCodeGoDatabasePath({
      platform: 'win32',
      environment: { USERPROFILE: 'C:\\Users\\Kun' },
      homeDirectory: 'C:\\Users\\Kun'
    })).toBe('C:\\Users\\Kun\\.local\\share\\opencode\\opencode.db')
  })

  it('returns no quota when OpenCode Go has not created local usage history', async () => {
    await expect(readOpenCodeGoLocalQuota({
      databasePath: join(tmpdir(), 'missing-kun-opencode-go', 'opencode.db')
    })).resolves.toBeUndefined()
  })

  it('prefers step-finish costs so message totals are not counted twice', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kun-opencode-go-'))
    const databasePath = join(directory, 'opencode.db')
    const database = new Database(databasePath)
    try {
      database.exec(`
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          time_created INTEGER
        );
        CREATE TABLE part (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL,
          data TEXT NOT NULL,
          time_created INTEGER
        );
      `)
      const createdMs = Date.parse('2026-03-06T12:00:00.000Z')
      database.prepare(
        'INSERT INTO message (id, data, time_created) VALUES (?, ?, ?)'
      ).run('message-1', JSON.stringify({
        providerID: 'opencode-go',
        role: 'assistant',
        cost: 9,
        time: { created: createdMs }
      }), createdMs)
      database.prepare(
        'INSERT INTO part (id, message_id, data, time_created) VALUES (?, ?, ?, ?)'
      ).run('part-1', 'message-1', JSON.stringify({
        type: 'step-finish',
        cost: 3,
        time: { created: createdMs }
      }), createdMs)
    } finally {
      database.close()
    }

    try {
      const result = await readOpenCodeGoLocalQuota({
        databasePath,
        now: new Date('2026-03-06T16:00:00.000Z')
      })
      expect(result?.metrics[0]).toMatchObject({
        id: 'five-hour',
        used: 3,
        usedPercent: 25
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
