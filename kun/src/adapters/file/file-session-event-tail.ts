import { createHash } from 'node:crypto'
import { open, writeFile } from 'node:fs/promises'

const SCAN_CHUNK_BYTES = 64 * 1024
const EVIDENCE_SAMPLE_BYTES = 16 * 1024

export type EventTailRepairResult = {
  repaired: boolean
  truncatedBytes: number
}

export async function ensureEventTailReady(input: {
  verified: Set<string>
  threadId: string
  path: string
  evidencePath: string
}): Promise<void> {
  if (input.verified.has(input.threadId)) return
  await repairIncompleteEventTail(input)
}

/**
 * Remove an unterminated final JSONL record before the next append. Readers
 * already treat these bytes as an uncommitted crash tail; leaving them in place
 * would concatenate the next valid event into one malformed line.
 */
export async function repairIncompleteEventTail(input: {
  path: string
  evidencePath: string
}): Promise<EventTailRepairResult> {
  let handle
  try {
    handle = await open(input.path, 'r+')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { repaired: false, truncatedBytes: 0 }
    throw error
  }
  try {
    const info = await handle.stat()
    if (info.size === 0) return { repaired: false, truncatedBytes: 0 }
    const finalByte = Buffer.allocUnsafe(1)
    await handle.read(finalByte, 0, 1, info.size - 1)
    if (finalByte[0] === 0x0a) return { repaired: false, truncatedBytes: 0 }

    let cursor = info.size
    let truncateAt = 0
    while (cursor > 0) {
      const start = Math.max(0, cursor - SCAN_CHUNK_BYTES)
      const chunk = Buffer.allocUnsafe(cursor - start)
      await handle.read(chunk, 0, chunk.length, start)
      const newline = chunk.lastIndexOf(0x0a)
      if (newline >= 0) {
        truncateAt = start + newline + 1
        break
      }
      cursor = start
    }

    const truncatedBytes = info.size - truncateAt
    const sampleLength = Math.min(truncatedBytes, EVIDENCE_SAMPLE_BYTES)
    const sample = Buffer.alloc(sampleLength)
    if (sampleLength > 0) await handle.read(sample, 0, sampleLength, truncateAt)
    await writeFile(input.evidencePath, `${JSON.stringify({
      repairedAt: new Date().toISOString(),
      truncatedBytes,
      sha256: createHash('sha256').update(sample).digest('hex'),
      sampleBase64: sample.toString('base64'),
      sampleTruncated: truncatedBytes > sampleLength
    })}\n`, { encoding: 'utf8', mode: 0o600 })
    await handle.truncate(truncateAt)
    await handle.sync()
    return { repaired: true, truncatedBytes }
  } finally {
    await handle.close()
  }
}
