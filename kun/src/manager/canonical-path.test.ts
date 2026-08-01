import { describe, expect, it } from 'vitest'
import { sameCanonicalPath } from './canonical-path.js'

describe('sameCanonicalPath', () => {
  it('accepts equivalent Windows paths with mixed separators and casing', () => {
    expect(sameCanonicalPath(
      'C:\\Users\\Administrator/.kun/data',
      'c:/users/administrator/.kun/data\\',
      'win32'
    )).toBe(true)
  })

  it('accepts equivalent extended-length Windows paths', () => {
    expect(sameCanonicalPath(
      '\\\\?\\C:\\Users\\Administrator\\.kun\\data',
      'C:\\Users\\Administrator\\.kun\\data',
      'win32'
    )).toBe(true)
  })

  it('rejects different Windows directories', () => {
    expect(sameCanonicalPath(
      'C:\\Users\\Administrator\\.kun\\data',
      'C:\\Users\\Administrator\\.kun\\other-data',
      'win32'
    )).toBe(false)
  })

  it('keeps POSIX path comparison case-sensitive', () => {
    expect(sameCanonicalPath('/home/kun/data', '/home/Kun/data', 'linux')).toBe(false)
  })
})
