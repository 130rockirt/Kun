import { describe, expect, it } from 'vitest'
import { parsePastedFilePaths } from './pasted-paths.js'

describe('parsePastedFilePaths', () => {
  it('accepts quoted, escaped, relative, file URL, and multi-file path pastes', () => {
    expect(parsePastedFilePaths("'/tmp/a b.png'", '/work', '/home/me')).toEqual(['/tmp/a b.png'])
    expect(parsePastedFilePaths('/tmp/a\\ b.png', '/work', '/home/me')).toEqual(['/tmp/a b.png'])
    expect(parsePastedFilePaths('./shot.png', '/work', '/home/me')).toEqual(['/work/shot.png'])
    expect(parsePastedFilePaths('~/shot.png', '/work', '/home/me')).toEqual(['/home/me/shot.png'])
    expect(parsePastedFilePaths('file:///tmp/a%20b.png', '/work', '/home/me')).toEqual(['/tmp/a b.png'])
    expect(parsePastedFilePaths('/tmp/a.png\u0000/tmp/b.png', '/work', '/home/me')).toEqual([
      '/tmp/a.png',
      '/tmp/b.png'
    ])
  })

  it('does not reinterpret prose, commands, URLs, or mixed clipboard text as files', () => {
    expect(parsePastedFilePaths('please inspect /tmp/a.png', '/work', '/home/me')).toEqual([])
    expect(parsePastedFilePaths('cat /tmp/a.png', '/work', '/home/me')).toEqual([])
    expect(parsePastedFilePaths('https://example.com/a.png', '/work', '/home/me')).toEqual([])
    expect(parsePastedFilePaths('/tmp/a.png\nordinary text', '/work', '/home/me')).toEqual([])
  })
})
