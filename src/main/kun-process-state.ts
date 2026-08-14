import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendManagedLogLine } from './logger'
import { KunProcessController } from './runtime/kun-process-controller'

export const execFileAsync = promisify(execFile)
export const KUN_STOP_GRACE_MS = 5_000
export const KUN_STOP_FORCE_MS = 1_000
export const STDERR_TAIL_MAX_CHARS = 32_768
export const MAX_TCP_PORT = 65_535

export type KunLogStream = 'stdout' | 'stderr' | 'lifecycle'
export type KunChildLogCapture = {
  captureStdout: (chunk: Buffer | string) => void
  captureStderr: (chunk: Buffer | string) => void
  logLifecycle: (message: string) => void
  close: () => Promise<void>
}

export const processController = new KunProcessController<KunChildLogCapture>()

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function appendTail(current: string, nextChunk: string, maxChars = STDERR_TAIL_MAX_CHARS): string {
  const combined = `${current}${nextChunk}`
  return combined.length > maxChars ? combined.slice(-maxChars) : combined
}

export function formatKunLogLine(
  stream: KunLogStream,
  pid: number | undefined,
  message: string
): string {
  const stamp = new Date().toISOString()
  const pidLabel = typeof pid === 'number' ? `kun pid=${pid}` : 'kun'
  return `[${stamp}] [${stream.toUpperCase()}] [${pidLabel}] ${message}\n`
}

export function normalizeCapturedChunk(chunk: Buffer | string): string {
  return String(chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function createKunChildLogCapture(pid: number | undefined): KunChildLogCapture {
  let stdoutRemainder = ''
  let stderrRemainder = ''
  let closed = false
  let pending = Promise.resolve()

  const writeLine = (stream: KunLogStream, message: string): void => {
    pending = pending
      .then(() => appendManagedLogLine('kun', formatKunLogLine(stream, pid, message)))
      .catch(() => undefined)
  }

  const captureChunk = (
    stream: 'stdout' | 'stderr',
    chunk: Buffer | string
  ): void => {
    if (closed) return
    const text = normalizeCapturedChunk(chunk)
    const buffered = `${stream === 'stdout' ? stdoutRemainder : stderrRemainder}${text}`
    const parts = buffered.split('\n')
    const remainder = parts.pop() ?? ''
    if (stream === 'stdout') {
      stdoutRemainder = remainder
    } else {
      stderrRemainder = remainder
    }
    for (const part of parts) {
      writeLine(stream, part)
    }
  }

  return {
    captureStdout(chunk) {
      captureChunk('stdout', chunk)
    },
    captureStderr(chunk) {
      captureChunk('stderr', chunk)
    },
    logLifecycle(message) {
      if (closed) return
      writeLine('lifecycle', message)
    },
    async close() {
      if (closed) {
        await pending
        return
      }
      closed = true
      if (stdoutRemainder) {
        writeLine('stdout', stdoutRemainder)
        stdoutRemainder = ''
      }
      if (stderrRemainder) {
        writeLine('stderr', stderrRemainder)
        stderrRemainder = ''
      }
      await pending
    }
  }
}
