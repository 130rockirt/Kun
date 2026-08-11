import { stat } from 'node:fs/promises'
import { posix } from 'node:path'
import * as yauzl from 'yauzl'
import type { PptxGeometryParts } from './ppt-geometry-qa-ooxml.js'

const MAX_PPTX_BYTES = 500 * 1024 * 1024
const MAX_XML_BYTES = 8 * 1024 * 1024
const MAX_MEDIA_HEADER_BYTES = 1024 * 1024
const MAX_TOTAL_MEDIA_HEADER_BYTES = 64 * 1024 * 1024

export async function readPptxGeometryParts(path: string): Promise<PptxGeometryParts> {
  const info = await stat(path)
  if (!info.isFile() || info.size <= 0 || info.size > MAX_PPTX_BYTES) {
    throw new Error(`PPTX geometry source has an invalid size: ${info.size}`)
  }
  const xml = new Map<string, string>()
  const media = new Map<string, Uint8Array>()
  let retainedMediaBytes = 0
  let archive: yauzl.ZipFile | undefined
  try {
    archive = await yauzl.openPromise(path, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
      autoClose: false
    })
    for await (const entry of archive.eachEntry()) {
      const isXml = entry.fileName === '[Content_Types].xml' ||
        entry.fileName === 'ppt/presentation.xml' ||
        entry.fileName === 'ppt/_rels/presentation.xml.rels' ||
        /^ppt\/slides\/(?:_rels\/slide\d+\.xml\.rels|slide\d+\.xml)$/.test(entry.fileName)
      const isMedia = /^ppt\/media\/[^/]+$/.test(entry.fileName)
      if (!isXml && !isMedia) continue
      if (isXml && entry.uncompressedSize > MAX_XML_BYTES) {
        throw new Error(`OOXML part is unexpectedly large: ${entry.fileName}`)
      }
      if (isXml) {
        xml.set(entry.fileName, (await readZipEntry(archive, entry)).toString('utf8'))
        continue
      }
      if (retainedMediaBytes >= MAX_TOTAL_MEDIA_HEADER_BYTES) continue
      const bytes = await readZipEntryPrefix(archive, entry, Math.min(
        MAX_MEDIA_HEADER_BYTES,
        MAX_TOTAL_MEDIA_HEADER_BYTES - retainedMediaBytes
      ))
      retainedMediaBytes += bytes.length
      media.set(entry.fileName, bytes)
    }
  } finally {
    archive?.close()
  }
  const presentationXml = xml.get('ppt/presentation.xml')
  if (!presentationXml) throw new Error('PPTX geometry source has no ppt/presentation.xml')
  const slides = [...xml.entries()]
    .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .map(([slidePath, slideXml]) => ({
      path: slidePath,
      xml: slideXml,
      relationshipsXml: xml.get(slideRelationshipsPath(slidePath))
    }))
  if (slides.length === 0) throw new Error('PPTX geometry source contains no slides')
  return {
    packageBytes: info.size,
    contentTypesXml: xml.get('[Content_Types].xml'),
    presentationXml,
    presentationRelationshipsXml: xml.get('ppt/_rels/presentation.xml.rels'),
    slides,
    media
  }
}

async function readZipEntry(archive: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  const stream = await archive.openReadStreamPromise(entry)
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function readZipEntryPrefix(
  archive: yauzl.ZipFile,
  entry: yauzl.Entry,
  limit: number
): Promise<Buffer> {
  const stream = await archive.openReadStreamPromise(entry)
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk)
    const retained = buffer.subarray(0, Math.max(0, limit - bytes))
    if (retained.length > 0) chunks.push(retained)
    bytes += retained.length
    if (bytes >= limit) break
  }
  return Buffer.concat(chunks)
}

function slideRelationshipsPath(slidePath: string): string {
  return posix.join(posix.dirname(slidePath), '_rels', `${posix.basename(slidePath)}.rels`)
}
