import { describeSqliteAbiMismatch } from './hybrid-thread-support.js'

export class HybridMemoryDegradedState {
  private reason: string | undefined

  fail(action: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const abi = describeSqliteAbiMismatch(message)
    this.reason = sanitize(`${action}: ${message}${abi ? ` (${abi})` : ''}`)
    console.warn(`[kun] memory index ${this.reason}; using canonical filesystem fallback`)
  }

  recover(): void {
    if (this.reason) console.warn('[kun] memory index recovered; leaving filesystem fallback')
    this.reason = undefined
  }

  degradedReason(): string | undefined {
    return this.reason
  }
}

function sanitize(value: string): string {
  return value
    .replace(/(api[_-]?key|token|secret|password)\s*[=:]\s*\S+/giu, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 512)
}
