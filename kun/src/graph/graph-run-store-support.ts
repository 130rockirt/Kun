import { createHash } from 'node:crypto'
import type { GraphRunStatus } from '../contracts/graph.js'
import type { GraphStoreDiagnostic } from './graph-run-store.js'

export function checksumJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function isTerminalRunStatus(status: GraphRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export function diagnosticForStoreError(runId: string, error: unknown): GraphStoreDiagnostic {
  const message = error instanceof Error ? error.message : String(error)
  return {
    runId,
    code: /artifact/i.test(message)
      ? 'missing_artifact'
      : /journal|checksum|sequence/i.test(message)
        ? 'corrupt_journal'
        : 'invalid_state',
    message: message.slice(0, 2_048),
    retryable: /snapshot|artifact|missing/i.test(message)
  }
}
