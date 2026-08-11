export type PptGeometryImageDimensions = {
  width: number
  height: number
}

export function detectPptImageDimensions(
  bytes: Uint8Array,
  path = ''
): PptGeometryImageDimensions | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return pngDimensions(buffer) ??
    jpegDimensions(buffer) ??
    gifDimensions(buffer) ??
    webpDimensions(buffer) ??
    bmpDimensions(buffer) ??
    (path.toLowerCase().endsWith('.svg') ? svgDimensions(buffer) : undefined)
}

function valid(width: number, height: number): PptGeometryImageDimensions | undefined {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : undefined
}

function pngDimensions(buffer: Buffer): PptGeometryImageDimensions | undefined {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return undefined
  }
  return valid(buffer.readUInt32BE(16), buffer.readUInt32BE(20))
}

function jpegDimensions(buffer: Buffer): PptGeometryImageDimensions | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2
  while (offset + 4 <= buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1
    if (offset >= buffer.length) break
    const marker = buffer[offset]
    offset += 1
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > buffer.length) break
    const length = buffer.readUInt16BE(offset)
    if (length < 2 || offset + length > buffer.length) break
    if (startOfFrame.has(marker) && length >= 7) {
      return valid(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3))
    }
    offset += length
  }
  return undefined
}

function gifDimensions(buffer: Buffer): PptGeometryImageDimensions | undefined {
  if (buffer.length < 10 || !['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return undefined
  return valid(buffer.readUInt16LE(6), buffer.readUInt16LE(8))
}

function bmpDimensions(buffer: Buffer): PptGeometryImageDimensions | undefined {
  if (buffer.length < 26 || buffer.subarray(0, 2).toString('ascii') !== 'BM') return undefined
  return valid(Math.abs(buffer.readInt32LE(18)), Math.abs(buffer.readInt32LE(22)))
}

function webpDimensions(buffer: Buffer): PptGeometryImageDimensions | undefined {
  if (buffer.length < 30 || buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    buffer.subarray(8, 12).toString('ascii') !== 'WEBP') return undefined
  const kind = buffer.subarray(12, 16).toString('ascii')
  if (kind === 'VP8X') {
    return valid(1 + buffer.readUIntLE(24, 3), 1 + buffer.readUIntLE(27, 3))
  }
  if (kind === 'VP8 ' && buffer.length >= 30 &&
    buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return valid(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff)
  }
  if (kind === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21)
    return valid((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
  }
  return undefined
}

function svgDimensions(buffer: Buffer): PptGeometryImageDimensions | undefined {
  const source = buffer.subarray(0, Math.min(buffer.length, 128 * 1024)).toString('utf8')
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) return undefined
  const open = source.match(/<svg\b[^>]*>/i)?.[0]
  if (!open) return undefined
  const width = svgLength(open, 'width')
  const height = svgLength(open, 'height')
  if (width !== undefined && height !== undefined) return valid(width, height)
  const viewBox = open.match(/\bviewBox\s*=\s*["']\s*[-+\d.e]+[ ,]+[-+\d.e]+[ ,]+([-+\d.e]+)[ ,]+([-+\d.e]+)\s*["']/i)
  return viewBox ? valid(Number(viewBox[1]), Number(viewBox[2])) : undefined
}

function svgLength(open: string, attribute: string): number | undefined {
  const match = open.match(new RegExp(`\\b${attribute}\\s*=\\s*["']\\s*([-+\\d.e]+)(?:px)?\\s*["']`, 'i'))
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : undefined
}
