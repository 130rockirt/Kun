export function normalizeDiagnosticReport(result: unknown): unknown[] | null {
  if (Array.isArray(result)) return result
  if (!result || typeof result !== 'object') return null
  const report = result as Record<string, unknown>
  if (Array.isArray(report.items)) return report.items
  return null
}

export function collectWorkspaceDiagnostics(result: unknown, uri: string): unknown[] {
  if (!result || typeof result !== 'object') return []
  const report = result as Record<string, unknown>
  const items = Array.isArray(report.items) ? report.items : []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    if (entry.uri !== uri) continue
    const diagnostics = normalizeDiagnosticReport(entry.value)
    if (diagnostics) return diagnostics
  }
  return []
}
