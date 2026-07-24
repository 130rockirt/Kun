import { describe, expect, it } from 'vitest'
import { decodeWorkspaceTextPreview } from './workspace-files'

describe('workspace text preview decoding', () => {
  it('decodes UTF-8 and strips its BOM', () => {
    expect(decodeWorkspaceTextPreview(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('hello 世界', 'utf8')
    ]))).toBe('hello 世界')
  })

  it('decodes UTF-16 little-endian and big-endian BOM files', () => {
    const source = '工作表 A1'
    const littleEndian = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(source, 'utf16le')
    ])
    const bigEndianBody = Buffer.from(source, 'utf16le')
    for (let index = 0; index + 1 < bigEndianBody.length; index += 2) {
      const first = bigEndianBody[index]
      bigEndianBody[index] = bigEndianBody[index + 1]
      bigEndianBody[index + 1] = first
    }
    const bigEndian = Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndianBody])

    expect(decodeWorkspaceTextPreview(littleEndian)).toBe(source)
    expect(decodeWorkspaceTextPreview(bigEndian)).toBe(source)
  })

  it('keeps unknown NUL-containing binary files out of the text preview path', () => {
    expect(decodeWorkspaceTextPreview(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1]))).toBeNull()
  })
})
