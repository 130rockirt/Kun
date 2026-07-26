import { describe, expect, it } from 'vitest'
import {
  activeKunRuntimePidsForDataDir,
  commandUsesKunDataDir
} from './runtime-data-dir-ownership'

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

  it('fails closed when process ownership cannot be inventoried', () => {
    expect(() => activeKunRuntimePidsForDataDir('/home/zoe/.deepseekgui/kun', {
      platform: 'linux',
      processCommands: () => {
        throw new Error('process inventory denied')
      }
    })).toThrow(/process inventory denied/)
  })
})
