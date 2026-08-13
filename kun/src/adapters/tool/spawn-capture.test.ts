import { describe, expect, it } from 'vitest'
import { spawnCapture } from './builtin-tool-utils.js'

describe('spawnCapture output bounds', () => {
  it('caps combined stdout and stderr and terminates the producer', async () => {
    const result = await spawnCapture(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(1024 * 1024)); process.stderr.write('y'.repeat(1024 * 1024))"],
      { cwd: process.cwd(), maxOutputBytes: 4096 }
    )

    expect(result.outputTruncated).toBe(true)
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(4096)
  })

  it('terminates a helper when its configured timeout expires', async () => {
    const result = await spawnCapture(
      process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 3_000)'],
      { cwd: process.cwd(), timeoutMs: 100 }
    )

    expect(result.timedOut).toBe(true)
  })
})
