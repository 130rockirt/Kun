import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const DEFAULT_POLL_MS = 50
const DEFAULT_TIMEOUT_MS = 120_000

type CheckpointGateStatus = {
  version: 1
  checkpointId: string
  status: 'pending' | 'ready' | 'failed'
}

/**
 * Wait for the desktop process to finish a concurrently-started Git snapshot.
 * A failed or timed-out snapshot preserves the historical best-effort behavior:
 * tools may continue, but no rollback id is attached to the turn.
 */
export async function waitForWorkspaceCheckpoint(
  dataDir: string,
  checkpointRequestId: string,
  signal: AbortSignal,
  options: { pollMs?: number; timeoutMs?: number } = {}
): Promise<string | null> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const name = Buffer.from(checkpointRequestId, 'utf8').toString('base64url') || 'empty'
  const path = join(resolve(dataDir), 'git-checkpoint-gates', `${name}.json`)

  while (!signal.aborted && Date.now() < deadline) {
    const status = await readStatus(path)
    if (status?.checkpointId === checkpointRequestId) {
      if (status.status === 'ready') return checkpointRequestId
      if (status.status === 'failed') return null
    }
    await abortableDelay(pollMs, signal)
  }
  if (signal.aborted) throw new Error('checkpoint wait aborted')
  return null
}

async function readStatus(path: string): Promise<CheckpointGateStatus | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<CheckpointGateStatus>
    if (
      parsed.version === 1 &&
      typeof parsed.checkpointId === 'string' &&
      (parsed.status === 'pending' || parsed.status === 'ready' || parsed.status === 'failed')
    ) return parsed as CheckpointGateStatus
  } catch {
    // The main process may be between file writes. Retry until terminal/timeout.
  }
  return null
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolveDelay) => {
    const timer = setTimeout(finish, Math.max(1, ms))
    const onAbort = (): void => finish()
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolveDelay()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
