/**
 * Realtime dictation pipeline: capture raw microphone PCM through an
 * AudioWorklet, cut the stream into fixed-size windows, and hand each window
 * to the existing batch speech-to-text endpoint one at a time. Transcript
 * fragments therefore land in the composer while the user is still speaking,
 * instead of only after the recording stops.
 */

/** Audio duration packed into one streaming transcription request. */
export const VOICE_REALTIME_CHUNK_MS = 4_000

/** How often the recorder checks the accumulator for complete chunks. */
export const VOICE_REALTIME_FLUSH_INTERVAL_MS = 250

/** Minimum tail audio worth transcribing when a dictation stops. */
export const VOICE_REALTIME_MIN_TAIL_MS = 500

/** Sample rate shared with every transcription provider (16 kHz mono WAV). */
export const VOICE_TRANSCRIPTION_SAMPLE_RATE = 16_000

/**
 * RMS floor (16-bit PCM, full scale = 1.0) under which a chunk counts as
 * silence. Skipping silent windows avoids burning transcription quota and
 * prevents providers from hallucinating text for background noise.
 */
export const VOICE_SILENCE_RMS_THRESHOLD = 0.012

/** AudioWorklet processor name registered by the capture module source. */
export const PCM_CAPTURE_PROCESSOR_NAME = 'kun-pcm-capture'

const PCM_WORKLET_SOURCE = [
  'class KunPcmCaptureProcessor extends AudioWorkletProcessor {',
  '  process(inputs) {',
  '    const channel = inputs[0] && inputs[0][0]',
  '    if (channel && channel.length > 0) {',
  '      this.port.postMessage(new Float32Array(channel))',
  '    }',
  '    return true',
  '  }',
  '}',
  `registerProcessor('${PCM_CAPTURE_PROCESSOR_NAME}', KunPcmCaptureProcessor)`
].join('\n')

/**
 * Worklet modules must load from a URL; an inline Blob keeps the processor
 * self-contained so no extra bundle asset or server route is needed. Callers
 * should revoke the URL once `audioWorklet.addModule` settles.
 */
export function createPcmCaptureWorkletUrl(): string {
  return URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' }))
}

/**
 * Accumulates raw PCM frames pushed by the capture worklet and cuts them
 * into fixed-size windows in arrival order.
 */
export class PcmChunkAccumulator {
  private parts: Float32Array[] = []
  private frames = 0

  constructor(private readonly framesPerChunk: number) {
    if (framesPerChunk <= 0) throw new Error('framesPerChunk must be positive')
  }

  static forSourceRate(sourceRate: number, chunkMs: number = VOICE_REALTIME_CHUNK_MS): PcmChunkAccumulator {
    return new PcmChunkAccumulator(Math.max(1, Math.floor((sourceRate * chunkMs) / 1000)))
  }

  get pendingFrames(): number {
    return this.frames
  }

  push(frames: Float32Array): void {
    if (frames.length === 0) return
    this.parts.push(frames)
    this.frames += frames.length
  }

  /** Detach every complete chunk currently buffered, oldest first. */
  takeFullChunks(): Float32Array[] {
    const chunks: Float32Array[] = []
    while (this.frames >= this.framesPerChunk) {
      chunks.push(this.takeFrames(this.framesPerChunk))
    }
    return chunks
  }

  /** Detach everything that is left, used when the dictation stops. */
  takeRemainder(): Float32Array | null {
    if (this.frames === 0) return null
    return this.takeFrames(this.frames)
  }

  private takeFrames(count: number): Float32Array {
    const out = new Float32Array(count)
    let written = 0
    while (written < count) {
      const head = this.parts[0]
      const needed = count - written
      if (head.length <= needed) {
        out.set(head, written)
        written += head.length
        this.parts.shift()
      } else {
        out.set(head.subarray(0, needed), written)
        this.parts[0] = head.subarray(needed)
        written += needed
      }
    }
    this.frames -= count
    return out
  }
}

/**
 * Resample mono PCM to 16 kHz with linear interpolation. Speech transcription
 * does not need band-limited sinc filtering, and linear interpolation keeps
 * this dependency-free and fast enough for real-time slicing.
 */
export function resampleTo16k(samples: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === VOICE_TRANSCRIPTION_SAMPLE_RATE) return samples
  const ratio = sourceRate / VOICE_TRANSCRIPTION_SAMPLE_RATE
  const outLength = Math.floor(samples.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio
    const index = Math.floor(position)
    const fraction = position - index
    const a = samples[index]
    const b = samples[Math.min(index + 1, samples.length - 1)]
    out[i] = a + (b - a) * fraction
  }
  return out
}

export function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sumSquares = 0
  for (let i = 0; i < samples.length; i += 1) {
    sumSquares += samples[i] * samples[i]
  }
  return Math.sqrt(sumSquares / samples.length)
}

export function isSilentChunk(
  samples: Float32Array,
  threshold: number = VOICE_SILENCE_RMS_THRESHOLD
): boolean {
  return rmsLevel(samples) < threshold
}

/**
 * Runs transcription tasks strictly one at a time so partial transcripts are
 * inserted in spoken order even when providers answer at different speeds.
 * `abort()` skips every task that has not started yet; `drain()` still
 * resolves so callers can reset state after an abort.
 */
export class SerialTranscriptionQueue {
  private chain: Promise<void> = Promise.resolve()
  private aborted = false
  private pendingCount = 0

  get pending(): number {
    return this.pendingCount
  }

  enqueue(task: () => Promise<void>): void {
    if (this.aborted) return
    this.pendingCount += 1
    const run = async (): Promise<void> => {
      try {
        if (!this.aborted) await task()
      } catch {
        // Tasks report their own errors; the chain itself must keep moving.
      } finally {
        this.pendingCount -= 1
      }
    }
    this.chain = this.chain.then(run)
  }

  abort(): void {
    this.aborted = true
  }

  drain(): Promise<void> {
    return this.chain
  }
}
