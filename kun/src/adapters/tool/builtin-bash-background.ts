import { mkdir } from 'node:fs/promises'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { BackgroundShellOutputWriter } from '../../services/background-shell-output.js'
import type { BashLocalToolOptions } from './builtin-tool-types.js'
import { createShellCommandRunner, type ShellCommandRunner } from './builtin-tool-utils.js'
import {
  bashSessions,
  finalizeSessionOutput,
  nextSessionId,
  recordFromBackgroundSession,
  reserveBackgroundSession,
  sessionPayload,
  settleSession,
  stopSession,
  terminateBashProcessTree,
  waitForSessionExitOrDelay
} from './builtin-bash-session-state.js'
import { STOP_GRACE_MS, STOP_WAIT_MS } from './builtin-bash-session-state.js'
import { createOutputAccumulator } from './builtin-bash-foreground.js'
import type { BackgroundSessionLimits, BashPayload, BashSession, BashSessionStatus } from './builtin-bash-types.js'

export async function startBackgroundBashSession(
  input: {
    command: string
    cwd: string
    threadId: string
    turnId: string
    signal: AbortSignal
    timeoutSeconds: number
    detached: boolean
    dataDir?: string
    outputLimits: { maxLines: number; maxBytes: number }
    backgroundLimits: BackgroundSessionLimits
  },
  hooks: BashLocalToolOptions['backgroundShell'],
  onUpdate?: (update: { output: unknown; isError?: boolean }) => Promise<void> | void,
  shellRunner: ShellCommandRunner = createShellCommandRunner()
): Promise<{ payload: BashPayload; isError?: boolean }> {
  if (!input.dataDir?.trim()) {
    throw new Error('background shell sessions require runtime dataDir')
  }
  await mkdir(input.cwd, { recursive: true })
  const releaseReservation = reserveBackgroundSession(input.threadId, input.backgroundLimits)
  let shellRuntime = shellRunner.runtime
  let child: ChildProcessWithoutNullStreams | undefined
  let sessionId = ''
  let outputWriter: BackgroundShellOutputWriter | undefined
  try {
    sessionId = nextSessionId()
    outputWriter = new BackgroundShellOutputWriter(input.dataDir, input.threadId, sessionId)
    await outputWriter.open()
    // Open the bounded log before spawning so a storage failure cannot leave
    // an untracked detached child behind. The runner waits only for the spawn
    // handshake so it can retry pre-spawn failures safely.
    const started = await shellRunner.spawn(input.command, {
      cwd: input.cwd,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    shellRuntime = started.runtime
    child = started.child as ChildProcessWithoutNullStreams
  } catch (error) {
    releaseReservation()
    if (child) await terminateBashProcessTree(child)
    if (outputWriter) await outputWriter.close().catch(() => undefined)
    throw error
  }
  releaseReservation()
  if (!child || !outputWriter) throw new Error('background shell process failed to start')
  const session: BashSession = {
    id: sessionId,
    threadId: input.threadId,
    turnId: input.turnId,
    command: input.command,
    cwd: input.cwd,
    shell: shellRuntime.name,
    child,
    // BackgroundShellOutputWriter is the sole durable output path here and
    // caps storage at 10 MiB. Do not also let OutputAccumulator create an
    // unbounded /tmp full-output file after the preview truncates.
    output: createOutputAccumulator(input.outputLimits, { persistFullOutput: false }),
    outputMaxBytes: input.outputLimits.maxBytes,
    outputWriter,
    startedAt: new Date().toISOString(),
    exitCode: null,
    status: 'running',
    stopRequested: false,
    finalized: false,
    detached: input.detached,
    exitWaiters: new Set()
  }
  bashSessions.set(session.id, session)
  // A fast child may exit while start-hook I/O is still in progress. Every
  // later lifecycle notification waits for this promise so a terminal record
  // cannot be observed before its corresponding start record.
  const startedNotification = (async () => {
    if (!hooks) return
    await hooks.onSessionStarted?.(await recordFromBackgroundSession(session, input.detached))
  })()
  const startedNotificationSettled = startedNotification.catch(() => undefined)

  let updateNotificationDirty = false
  let updateNotificationInFlight: Promise<void> | undefined
  const flushUpdatedNotification = (): void => {
    if (!hooks?.onSessionUpdated || updateNotificationInFlight) return
    const flush = (async () => {
      await startedNotificationSettled
      while (updateNotificationDirty) {
        updateNotificationDirty = false
        await hooks.onSessionUpdated?.(await recordFromBackgroundSession(session, input.detached))
      }
    })()
    updateNotificationInFlight = flush
    void flush
      .catch(() => undefined)
      .finally(() => {
        if (updateNotificationInFlight === flush) updateNotificationInFlight = undefined
        if (updateNotificationDirty) flushUpdatedNotification()
      })
  }
  const notifyUpdated = (): void => {
    if (!hooks?.onSessionUpdated) return
    updateNotificationDirty = true
    flushUpdatedNotification()
  }
  const notifySettled = async () => {
    await startedNotificationSettled
    if (!hooks) return
    await hooks.onSessionSettled?.(await recordFromBackgroundSession(session, input.detached))
  }

  let updateDirty = false
  let updateTimer: NodeJS.Timeout | undefined
  let lastUpdateAt = 0
  let liveUpdates = true
  let liveToolUpdates = true
  let updateInFlight: Promise<void> | undefined
  const flushUpdate = async () => {
    if (!liveUpdates || (!onUpdate && !hooks?.onSessionUpdated) || !updateDirty) return
    updateDirty = false
    lastUpdateAt = Date.now()
    const payload = await sessionPayload(session)
    if (liveToolUpdates && onUpdate) {
      await onUpdate({ output: payload })
    }
    // Do not enqueue a stale "running" update after the process has reached
    // a terminal state and its completion notification is being published.
    if (liveUpdates) notifyUpdated()
  }
  const emitUpdate = (): void => {
    if (updateInFlight) return
    const flush = flushUpdate()
    updateInFlight = flush
    void flush
      .catch(() => undefined)
      .finally(() => {
        if (updateInFlight === flush) updateInFlight = undefined
        if (updateDirty && liveUpdates) scheduleUpdate()
      })
  }
  const scheduleUpdate = () => {
    if (!liveUpdates || (!onUpdate && !hooks?.onSessionUpdated)) return
    updateDirty = true
    const delay = 100 - (Date.now() - lastUpdateAt)
    if (delay <= 0) {
      emitUpdate()
      return
    }
    if (updateTimer) return
    updateTimer = setTimeout(() => {
      updateTimer = undefined
      emitUpdate()
    }, delay)
  }
  const handleData = (chunk: Buffer | string) => {
    if (session.finalized) return
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    session.output.append(buffer)
    session.outputWriter?.append(buffer)
    scheduleUpdate()
  }
  child.stdout.on('data', handleData)
  child.stderr.on('data', handleData)
  let timeoutTimer: NodeJS.Timeout | undefined
  const clearSessionTimeout = () => {
    if (!timeoutTimer) return
    clearTimeout(timeoutTimer)
    timeoutTimer = undefined
  }
  const settleAndNotify = (
    status: Exclude<BashSessionStatus, 'running'>,
    exitCode: number | null,
    error?: string
  ): Promise<void> => {
    clearSessionTimeout()
    if (!settleSession(session, status, exitCode, error)) {
      return session.settlement ?? Promise.resolve()
    }
    const settlement = (async () => {
      liveUpdates = false
      if (updateTimer) {
        clearTimeout(updateTimer)
        updateTimer = undefined
      }
      try {
        await finalizeSessionOutput(session)
      } catch {
        // The session status is still terminal and must be published even if its
        // optional output file cannot be closed cleanly.
      }
      await notifySettled()
    })()
    session.settlement = settlement
    return settlement
  }
  child.once('error', (error) => {
    void settleAndNotify('failed', null, error.message).catch(() => undefined)
  })
  child.once('exit', (code) => {
    void settleAndNotify(session.stopRequested ? 'stopped' : 'completed', code).catch(() => undefined)
  })
  // A trivial command can exit between the runner's spawn handshake and the
  // lifecycle listeners above. ChildProcess retains its terminal state even
  // when the one-shot event was emitted before these listeners were attached.
  if (child.exitCode !== null || child.signalCode !== null) {
    void settleAndNotify(
      session.stopRequested ? 'stopped' : 'completed',
      child.exitCode
    ).catch(() => undefined)
  }
  if (input.detached) {
    timeoutTimer = setTimeout(() => {
      timeoutTimer = undefined
      if (session.status !== 'running') return
      void stopSession(session)
    }, input.timeoutSeconds * 1000)
    timeoutTimer.unref?.()
    // The child can settle synchronously between the immediate exit check and
    // timer installation. Do not retain a detached 24-hour timer in that race.
    if (session.status !== 'running') clearSessionTimeout()
  }

  const initialPayload = await sessionPayload(session)
  try {
    await startedNotification
  } catch (error) {
    // Session admission is transactional: a caller never received this id, so
    // a rejected start hook must not leave an unreachable process or record.
    await stopSession(session)
    await waitForSessionExitOrDelay(session, STOP_WAIT_MS - STOP_GRACE_MS)
    if (session.status === 'running') {
      await settleAndNotify(
        'failed',
        null,
        'background shell start notification failed'
      ).catch(() => undefined)
    }
    await session.settlement?.catch(() => undefined)
    if (!session.finalized) await finalizeSessionOutput(session).catch(() => undefined)
    clearSessionTimeout()
    bashSessions.delete(session.id)
    throw error
  }

  if (input.detached) {
    // The bash tool call is complete once the detached session has been
    // handed off. Keep lifecycle hooks live for the background-shell API, but
    // prevent later process output from updating the completed tool_result.
    liveToolUpdates = false
    await updateInFlight?.catch(() => undefined)
    return { payload: initialPayload }
  }

  throw new Error('startBackgroundBashSession requires detached=true')
}
