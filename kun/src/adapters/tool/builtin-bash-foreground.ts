import { mkdir } from 'node:fs/promises'
import { OutputAccumulator } from './output-accumulator.js'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from './truncate.js'
import type { TextSlice } from './builtin-tool-types.js'
import { createShellCommandRunner, type ShellCommandRunner, waitForSpawnExit } from './builtin-tool-utils.js'
import { bashProcessTreeIsAlive, terminateBashProcessTree } from './builtin-bash-session-state.js'

export class BashTimeoutError extends Error {
  constructor(readonly timeoutSeconds: number) {
    super(`command timed out after ${timeoutSeconds} seconds`)
    this.name = 'BashTimeoutError'
  }
}


export async function bashExecute(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutSeconds: number,
  outputLimits: { maxLines: number; maxBytes: number },
  livenessIntervalMs: number,
  onUpdate?: (update: { output: unknown; isError?: boolean }) => Promise<void> | void,
  execOperation?: (
    command: string,
    cwd: string,
    options: { signal: AbortSignal; timeoutSeconds: number; onData?: (data: Buffer) => void }
  ) => Promise<{ exitCode: number | null; shell?: string }>,
  shellRunner: ShellCommandRunner = createShellCommandRunner()
): Promise<{
  output: string
  exitCode: number | null
  shell: string
  truncated: TextSlice
  fullOutputPath?: string
}> {
  await mkdir(cwd, { recursive: true })
  let resultShell = shellRunner.runtime.name
  const started = execOperation
    ? null
    : signal.aborted
      ? null
      : await shellRunner.spawn(command, {
          cwd,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
  const child = started?.child ?? null
  if (started) resultShell = started.runtime.name
  if (!execOperation && signal.aborted) {
    if (child) await terminateBashProcessTree(child)
    throw new Error('command aborted')
  }
  let timedOut = false
  let settled = false
  let termination: Promise<void> | undefined
  const output = new OutputAccumulator({
    maxLines: outputLimits.maxLines,
    maxBytes: outputLimits.maxBytes,
    tempFilePrefix: 'kun-bash'
  })
  const startedAtMs = Date.now()
  let lastOutputAtMs: number | undefined
  let updateDirty = false
  let livenessDirty = false
  let updateTimer: NodeJS.Timeout | undefined
  let livenessTimer: NodeJS.Timeout | undefined
  let lastUpdateAt = 0
  let updateInFlight: Promise<void> | undefined
  let updateFailure: unknown
  const handleData = (chunk: Buffer) => {
    lastOutputAtMs = Date.now()
    output.append(chunk)
    armLiveness()
    scheduleUpdate()
  }
  const flushUpdate = async () => {
    if (!onUpdate || (!updateDirty && !livenessDirty)) return
    const liveness = livenessDirty
    updateDirty = false
    livenessDirty = false
    const now = Date.now()
    lastUpdateAt = now
    const snapshot = output.snapshot({ persistIfTruncated: true })
    await onUpdate({
      output: {
        command,
        cwd,
        shell: resultShell,
        exit_code: null,
        output: snapshot.content,
        full_output_path: snapshot.fullOutputPath ?? null,
        truncation: snapshot.truncation.truncated
          ? {
              total_lines: snapshot.truncation.totalLines,
              output_lines: snapshot.truncation.outputLines,
              total_bytes: snapshot.truncation.totalBytes,
              output_bytes: snapshot.truncation.outputBytes,
              truncated_by: snapshot.truncation.truncatedBy ?? null,
              last_line_partial: snapshot.truncation.lastLinePartial === true
            }
          : null,
        partial: true,
        ...(liveness
          ? {
              liveness: true as const,
              elapsed_seconds: Math.max(0, Math.floor((now - startedAtMs) / 1000)),
              last_output_age_seconds: Math.max(
                0,
                Math.floor((now - (lastOutputAtMs ?? startedAtMs)) / 1000)
              )
            }
          : {})
      }
    })
  }
  const emitUpdate = () => {
    if (updateInFlight) return
    const flush = flushUpdate()
    updateInFlight = flush
    void flush
      .catch((error) => {
        updateFailure ??= error
      })
      .finally(() => {
        if (updateInFlight === flush) updateInFlight = undefined
        if ((updateDirty || livenessDirty) && !settled) scheduleUpdate(livenessDirty)
      })
  }
  const scheduleUpdate = (liveness = false) => {
    if (!onUpdate) return
    if (liveness) livenessDirty = true
    else updateDirty = true
    const delay = liveness ? 0 : 100 - (Date.now() - lastUpdateAt)
    if (delay <= 0) {
      emitUpdate()
      return
    }
    if (updateTimer) return
    updateTimer = setTimeout(() => {
      updateTimer = undefined
      emitUpdate()
    }, delay)
    updateTimer.unref?.()
  }
  const normalizedLivenessIntervalMs = Math.max(1, Math.floor(livenessIntervalMs))
  const armLiveness = () => {
    if (!onUpdate || settled) return
    if (livenessTimer) clearTimeout(livenessTimer)
    livenessTimer = setTimeout(() => {
      livenessTimer = undefined
      if (settled) return
      scheduleUpdate(true)
      armLiveness()
    }, normalizedLivenessIntervalMs)
    livenessTimer.unref?.()
  }
  const drainUpdates = async () => {
    if (updateTimer) {
      clearTimeout(updateTimer)
      updateTimer = undefined
    }
    while (updateInFlight || updateDirty || livenessDirty) {
      if (!updateInFlight) emitUpdate()
      await updateInFlight?.catch(() => undefined)
    }
    if (updateFailure) throw updateFailure
  }
  const requestStop = (): Promise<void> | undefined => {
    if (!child) return undefined
    termination ??= terminateBashProcessTree(child)
    return termination
  }
  const operationTimeout = new AbortController()
  const timer = setTimeout(() => {
    timedOut = true
    operationTimeout.abort(new BashTimeoutError(timeoutSeconds))
    void requestStop()
  }, timeoutSeconds * 1000)
  timer.unref?.()
  const onAbort = () => {
    void requestStop()
  }
  if (child) {
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  }
  // ToolExecutionService persists this one running snapshot, then publishes
  // changed liveness/output snapshots transiently under the same item id.
  scheduleUpdate()
  armLiveness()

  let exitCode: number | null = null
  let executionError: unknown
  try {
    if (execOperation) {
      const operationSignal = AbortSignal.any([signal, operationTimeout.signal])
      const result = await execOperation(command, cwd, {
        signal: operationSignal,
        timeoutSeconds,
        onData: handleData
      })
      exitCode = result.exitCode
      resultShell = result.shell ?? resultShell
    } else {
      if (!child) throw new Error('shell process failed to start')
      child.stdout?.on('data', (chunk: Buffer | string) => {
        handleData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      child.stderr?.on('data', (chunk: Buffer | string) => {
        handleData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      exitCode = await waitForSpawnExit(child)
    }
  } catch (error) {
    executionError = error
  } finally {
    settled = true
    clearTimeout(timer)
    if (livenessTimer) clearTimeout(livenessTimer)
    signal.removeEventListener('abort', onAbort)
  }

  if (executionError && child && bashProcessTreeIsAlive(child)) {
    await requestStop()
  }

  try {
    await termination
    if (signal.aborted) throw new Error('command aborted')
    if (timedOut) throw new BashTimeoutError(timeoutSeconds)
    if (executionError) throw executionError

    output.finish()
    await drainUpdates()
    const snapshot = output.snapshot({ persistIfTruncated: true })
    const truncated: TextSlice = {
      text: snapshot.content,
      truncated: snapshot.truncation.truncated,
      totalLines: snapshot.truncation.totalLines,
      shownLines: snapshot.truncation.outputLines,
      totalBytes: snapshot.truncation.totalBytes,
      shownBytes: snapshot.truncation.outputBytes,
      firstLineExceedsLimit: snapshot.truncation.firstLineExceedsLimit,
      truncatedBy: snapshot.truncation.truncatedBy ?? undefined,
      lastLinePartial: snapshot.truncation.lastLinePartial
    }
    return {
      output: snapshot.content,
      exitCode,
      shell: resultShell,
      truncated,
      fullOutputPath: snapshot.fullOutputPath
    }
  } finally {
    output.finish()
    await output.closeTempFile()
  }
}

export function createOutputAccumulator(
  outputLimits: { maxLines: number; maxBytes: number } = {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES
  },
  options: { persistFullOutput?: boolean } = {}
): OutputAccumulator {
  return new OutputAccumulator({
    maxLines: outputLimits.maxLines,
    maxBytes: outputLimits.maxBytes,
    tempFilePrefix: 'kun-bash',
    ...options
  })
}
