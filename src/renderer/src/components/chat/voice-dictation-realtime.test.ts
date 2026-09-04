import { describe, expect, it } from 'vitest'
import {
  isSilentChunk,
  PcmChunkAccumulator,
  resampleTo16k,
  rmsLevel,
  SerialTranscriptionQueue,
  VOICE_REALTIME_CHUNK_MS,
  VOICE_SILENCE_RMS_THRESHOLD,
  VOICE_TRANSCRIPTION_SAMPLE_RATE
} from './voice-dictation-realtime'

function constantFrames(length: number, value: number): Float32Array {
  return new Float32Array(length).fill(value)
}

describe('PcmChunkAccumulator', () => {
  it('cuts full chunks in arrival order across push boundaries', () => {
    const accumulator = new PcmChunkAccumulator(4)
    accumulator.push(new Float32Array([1, 2, 3]))
    accumulator.push(new Float32Array([4, 5, 6, 7]))
    accumulator.push(new Float32Array([8, 9]))

    const chunks = accumulator.takeFullChunks()
    expect(chunks).toHaveLength(2)
    expect(Array.from(chunks[0])).toEqual([1, 2, 3, 4])
    expect(Array.from(chunks[1])).toEqual([5, 6, 7, 8])
    expect(accumulator.pendingFrames).toBe(1)
    expect(Array.from(accumulator.takeRemainder() ?? [])).toEqual([9])
    expect(accumulator.pendingFrames).toBe(0)
    expect(accumulator.takeRemainder()).toBeNull()
  })

  it('sizes chunks from the audio context sample rate', () => {
    const accumulator = PcmChunkAccumulator.forSourceRate(48_000)
    accumulator.push(constantFrames(48_000 * (VOICE_REALTIME_CHUNK_MS / 1000) - 1, 0.5))
    expect(accumulator.takeFullChunks()).toHaveLength(0)
    accumulator.push(constantFrames(2, 0.5))
    expect(accumulator.takeFullChunks()).toHaveLength(1)
    expect(accumulator.pendingFrames).toBe(1)
  })

  it('rejects a non-positive chunk size', () => {
    expect(() => new PcmChunkAccumulator(0)).toThrow()
  })
})

describe('resampleTo16k', () => {
  it('returns the input unchanged when already at 16 kHz', () => {
    const samples = new Float32Array([0.1, -0.2, 0.3])
    expect(resampleTo16k(samples, VOICE_TRANSCRIPTION_SAMPLE_RATE)).toBe(samples)
  })

  it('halves the frame count for 32 kHz input', () => {
    // ratio 2: decimation keeps even indices 0, 2, 4, 6.
    const samples = new Float32Array([0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5])
    const out = resampleTo16k(samples, 32_000)
    expect(out).toHaveLength(4)
    expect(Array.from(out)).toEqual([0, 1, 0, -1])
  })

  it('downsamples 48 kHz audio to one third of the frames', () => {
    const samples = constantFrames(4_800, 0.25)
    const out = resampleTo16k(samples, 48_000)
    expect(out).toHaveLength(1_600)
    expect(out[0]).toBeCloseTo(0.25)
    expect(out[out.length - 1]).toBeCloseTo(0.25)
  })

  it('interpolates between neighbouring samples', () => {
    // ratio 1.5: floor(4 / 1.5) = 2 output frames at positions 0 and 1.5.
    const out = resampleTo16k(new Float32Array([0, 1, 2, 3]), 24_000)
    expect(out).toHaveLength(2)
    expect(Array.from(out)).toEqual([0, 1.5])
  })
})

describe('silence gating', () => {
  it('measures RMS of a constant signal', () => {
    expect(rmsLevel(constantFrames(100, 0.5))).toBeCloseTo(0.5)
    expect(rmsLevel(new Float32Array(0))).toBe(0)
  })

  it('flags quiet chunks as silent and keeps speech-level chunks', () => {
    expect(isSilentChunk(constantFrames(1_000, VOICE_SILENCE_RMS_THRESHOLD / 2))).toBe(true)
    expect(isSilentChunk(constantFrames(1_000, VOICE_SILENCE_RMS_THRESHOLD * 4))).toBe(false)
  })
})

describe('SerialTranscriptionQueue', () => {
  it('runs tasks one at a time in enqueue order', async () => {
    const queue = new SerialTranscriptionQueue()
    const order: string[] = []
    let running = 0
    let maxRunning = 0
    const task = (label: string, delayMs: number) => async (): Promise<void> => {
      running += 1
      maxRunning = Math.max(maxRunning, running)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      order.push(label)
      running -= 1
    }
    // The later task answers faster; the queue must still keep spoken order.
    queue.enqueue(task('first', 30))
    queue.enqueue(task('second', 1))
    await queue.drain()
    expect(order).toEqual(['first', 'second'])
    expect(maxRunning).toBe(1)
    expect(queue.pending).toBe(0)
  })

  it('keeps the chain alive when a task throws', async () => {
    const queue = new SerialTranscriptionQueue()
    const order: string[] = []
    queue.enqueue(async () => {
      order.push('boom')
      throw new Error('provider down')
    })
    queue.enqueue(async () => {
      order.push('after')
    })
    await queue.drain()
    expect(order).toEqual(['boom', 'after'])
    expect(queue.pending).toBe(0)
  })

  it('skips tasks enqueued before an abort but still resolves drain', async () => {
    const queue = new SerialTranscriptionQueue()
    const order: string[] = []
    queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('slow')
      queue.abort()
    })
    queue.enqueue(async () => {
      order.push('skipped')
    })
    await queue.drain()
    expect(order).toEqual(['slow'])
    queue.enqueue(async () => {
      order.push('ignored')
    })
    await queue.drain()
    expect(order).toEqual(['slow'])
  })
})
