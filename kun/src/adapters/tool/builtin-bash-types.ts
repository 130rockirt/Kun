import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { OutputAccumulator } from './output-accumulator.js'
import type { BackgroundShellOutputWriter } from '../../services/background-shell-output.js'

export type BackgroundSessionLimits = {
  maxRunningSessions: number
  maxRunningSessionsPerThread: number
  maxTimeoutSeconds: number
}

export type BashSessionStatus = 'running' | 'completed' | 'stopped' | 'failed'

export type BashSession = {
  id: string
  threadId?: string
  turnId?: string
  command: string
  cwd: string
  shell: string
  child: ChildProcessWithoutNullStreams
  output: OutputAccumulator
  outputMaxBytes: number
  startedAt: string
  finishedAt?: string
  exitCode: number | null
  status: BashSessionStatus
  error?: string
  stopRequested: boolean
  finalized: boolean
  finalization?: Promise<void>
  settlement?: Promise<void>
  stopCleanup?: Promise<void>
  detached: boolean
  exitWaiters: Set<() => void>
  outputWriter?: BackgroundShellOutputWriter
}

export type BashPayload = {
  command: string
  cwd: string
  shell: string
  exit_code: number | null
  output: string
  full_output_path?: string | null
  truncation?: null | {
    total_lines: number
    output_lines: number
    total_bytes: number
    output_bytes: number
    truncated_by: string | null
    last_line_partial: boolean
  }
  session_id?: string
  status?: BashSessionStatus
  started_at?: string
  finished_at?: string
  pid?: number
  partial?: boolean
  stop_sent?: boolean
  error?: string
  output_file?: string
  liveness?: true
  elapsed_seconds?: number
  last_output_age_seconds?: number
}
