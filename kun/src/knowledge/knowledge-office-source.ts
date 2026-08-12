import { open, readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import * as yauzl from 'yauzl'
import type { KnowledgeSourceFile, KnowledgeSourceFormat } from './knowledge-types.js'

export const KNOWLEDGE_OFFICE_EXTENSIONS = new Set([
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'
])
export const MAX_KNOWLEDGE_OFFICE_FILE_BYTES = 10 * 1024 * 1024

type OfficeFormat = Extract<
  KnowledgeSourceFormat,
  'doc' | 'docx' | 'xls' | 'xlsx' | 'ppt' | 'pptx'
>

const OOXML_CONTENT_TYPES: Record<Extract<OfficeFormat, 'docx' | 'xlsx' | 'pptx'>, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
}
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const MAX_ARCHIVE_ENTRIES = 10_000
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 128 * 1024 * 1024
const MAX_CONTENT_TYPES_BYTES = 2 * 1024 * 1024

export function officeKnowledgeFormat(path: string): OfficeFormat | null {
  const extension = extname(path).toLowerCase()
  return KNOWLEDGE_OFFICE_EXTENSIONS.has(extension)
    ? extension.slice(1) as OfficeFormat
    : null
}

export function isTemporaryOfficeSource(name: string): boolean {
  return name.startsWith('~$') || name.toLocaleLowerCase().endsWith('.tmp')
}

export async function validateOfficeSourceHeader(file: KnowledgeSourceFile): Promise<void> {
  const format = officeKnowledgeFormat(file.relativePath)
  if (!format) return
  if (file.size <= 0 || file.size > MAX_KNOWLEDGE_OFFICE_FILE_BYTES) {
    throw new Error('Office source exceeds the 10 MiB knowledge limit or is empty')
  }
  const handle = await open(file.absolutePath, 'r')
  try {
    const header = Buffer.alloc(8)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    const expected = ['docx', 'xlsx', 'pptx'].includes(format) ? ZIP_MAGIC : OLE_MAGIC
    if (bytesRead < expected.length || !header.subarray(0, expected.length).equals(expected)) {
      throw new Error(`Office source content does not match .${format}`)
    }
  } finally {
    await handle.close()
  }
}

export async function validateModernOfficeArchive(
  path: string,
  format: Extract<OfficeFormat, 'docx' | 'xlsx' | 'pptx'>
): Promise<void> {
  const contentTypes = await inspectArchive(path)
  const declaredTypes = declaredContentTypes(contentTypes)
  if (!declaredTypes.includes(OOXML_CONTENT_TYPES[format])) {
    throw new Error(`OOXML package is not a valid ${format.toUpperCase()} document`)
  }
  if (declaredTypes.some((type) => /vbaProject|macroEnabled\.main\+xml/i.test(type))) {
    throw new Error('Macro-enabled Office packages are not supported by knowledge indexing')
  }
}

function declaredContentTypes(xml: string): string[] {
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, '')
  return Array.from(
    withoutComments.matchAll(/<(?:Override|Default)\b[^>]*\bContentType\s*=\s*["']([^"']+)["'][^>]*>/gi),
    (match) => match[1]!
  )
}

async function inspectArchive(path: string): Promise<string> {
  return new Promise<string>((resolveArchive, rejectArchive) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        rejectArchive(openError ?? new Error('Could not open OOXML package'))
        return
      }
      let entries = 0
      let uncompressedBytes = 0
      let contentTypes = ''
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        zip.close()
        rejectArchive(error)
      }
      zip.on('error', fail)
      zip.on('entry', (entry) => {
        entries += 1
        uncompressedBytes += entry.uncompressedSize
        if (entries > MAX_ARCHIVE_ENTRIES || uncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
          fail(new Error('Office archive exceeds safe extraction limits'))
          return
        }
        if (entry.fileName !== '[Content_Types].xml') {
          zip.readEntry()
          return
        }
        if (entry.uncompressedSize > MAX_CONTENT_TYPES_BYTES) {
          fail(new Error('Office content-types metadata is oversized'))
          return
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error('Could not read Office content types'))
            return
          }
          const chunks: Buffer[] = []
          let size = 0
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_CONTENT_TYPES_BYTES) {
              stream.destroy(new Error('Office content-types metadata is oversized'))
              return
            }
            chunks.push(chunk)
          })
          stream.once('error', fail)
          stream.once('end', () => {
            contentTypes = Buffer.concat(chunks).toString('utf8')
            zip.readEntry()
          })
        })
      })
      zip.once('end', () => {
        if (settled) return
        settled = true
        if (!contentTypes) {
          rejectArchive(new Error('Office package has no [Content_Types].xml'))
          return
        }
        resolveArchive(contentTypes)
      })
      zip.readEntry()
    })
  })
}

export async function readOfficeBytes(file: KnowledgeSourceFile): Promise<Uint8Array> {
  const bytes = await readFile(file.absolutePath)
  if (bytes.byteLength !== file.size) throw new Error('Office source changed during extraction')
  return new Uint8Array(bytes)
}
