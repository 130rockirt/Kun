import { REDACTED_SECRET, redactSecretText } from '../../config/secret-redaction.js'

const MAX_RETRY_FAILURE_SUMMARY_LENGTH = 1_024

/**
 * Makes a provider's transient failure safe to persist in a retry event and
 * display in the GUI. The original response body stays in the provider trace;
 * this deliberately keeps only a compact diagnostic for the conversation.
 */
export function summarizeModelRetryFailure(
  value: string | undefined,
  knownSecrets: readonly string[] = []
): string | undefined {
  if (!value?.trim()) return undefined
  let summary = value
  for (const secret of knownSecrets) {
    const normalized = secret.trim()
    if (normalized) summary = summary.split(normalized).join(REDACTED_SECRET)
  }
  return redactSecretText(summary)
    .replace(/\b(?:sk|rk|api)[_-][A-Za-z0-9._-]{12,}\b/gi, REDACTED_SECRET)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED_SECRET)
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
      '$1[redacted]@'
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RETRY_FAILURE_SUMMARY_LENGTH) || undefined
}
