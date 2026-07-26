import { describe, expect, it } from 'vitest'
import {
  assertManagedKunDataDirIsCurrent,
  canonicalCurrentKunDataDir,
  canonicalLegacyKunDataDir,
  classifyCanonicalKunDataDir
} from './kun-data-dir-paths'

describe('canonical Kun data directory paths', () => {
  it('classifies POSIX absolute and tilde spellings without changing custom paths', () => {
    const homeDir = '/Users/zoë'
    expect(classifyCanonicalKunDataDir('~/.deepseekgui/kun', { homeDir, platform: 'darwin' })).toBe('legacy')
    expect(classifyCanonicalKunDataDir('/Users/zoë/.deepseekgui/kun/', { homeDir, platform: 'darwin' })).toBe('legacy')
    expect(classifyCanonicalKunDataDir('~/.kun/data', { homeDir, platform: 'linux' })).toBe('current')
    expect(classifyCanonicalKunDataDir('/mnt/kun-profile', { homeDir, platform: 'linux' })).toBe('custom')
  })

  it('classifies Windows paths case-insensitively across separator variants', () => {
    const homeDir = 'C:\\Users\\Zoë'
    expect(classifyCanonicalKunDataDir(
      'c:/users/zoë/.DEEPSEEKGUI/KUN/',
      { homeDir, platform: 'win32' }
    )).toBe('legacy')
    expect(classifyCanonicalKunDataDir(
      '~\\.KUN\\DATA\\',
      { homeDir, platform: 'win32' }
    )).toBe('current')
    expect(canonicalLegacyKunDataDir(homeDir, 'win32')).toBe('C:\\Users\\Zoë\\.deepseekgui\\kun')
    expect(canonicalCurrentKunDataDir(homeDir, 'win32')).toBe('C:\\Users\\Zoë\\.kun\\data')
  })

  it('blocks only the canonical legacy directory at the managed write boundary', () => {
    expect(() => assertManagedKunDataDirIsCurrent(
      '/home/zoe/.deepseekgui/kun',
      { homeDir: '/home/zoe', platform: 'linux' }
    )).toThrow(/migration is required/)
    expect(() => assertManagedKunDataDirIsCurrent(
      '/srv/custom-kun',
      { homeDir: '/home/zoe', platform: 'linux' }
    )).not.toThrow()
  })
})
