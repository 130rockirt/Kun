const STARTUP_ACTION_PROTOCOL = 'kun-startup-action:'
const MAX_FAILURE_MESSAGE_LENGTH = 1_200

export type StartupFailureAction = 'retry' | 'open-logs' | 'quit'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function sanitizeStartupFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1[redacted]@')
    .replace(/([?&](?:access_token|refresh_token|id_token|code|client_secret)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/("(?:access_token|refresh_token|id_token|client_secret|password)"\s*:\s*")[^"]+/gi, '$1[redacted]')
    .slice(0, MAX_FAILURE_MESSAGE_LENGTH)
}

export function parseStartupFailureAction(targetUrl: string): StartupFailureAction | null {
  if (!targetUrl.startsWith(STARTUP_ACTION_PROTOCOL)) return null
  const action = targetUrl.slice(STARTUP_ACTION_PROTOCOL.length).replace(/^\/+/, '')
  return action === 'retry' || action === 'open-logs' || action === 'quit'
    ? action
    : null
}

export function startupFailureHtml(message: string, logDir: string): string {
  const safeMessage = escapeHtml(message || 'Unknown startup error')
  const safeLogDir = escapeHtml(logDir || 'Log directory is unavailable')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kun startup recovery</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #111318; color: #f3f4f6; }
    main { max-width: 680px; margin: 0 auto; padding: 44px 40px; }
    h1 { margin: 0 0 14px; font-size: 27px; }
    p { color: #c5c9d3; line-height: 1.55; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 16px; border-radius: 10px; background: #1c2028; color: #ffcfcc; }
    .path { color: #aeb6c5; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 26px; }
    a { padding: 10px 16px; border-radius: 8px; color: #f8fafc; background: #303746; text-decoration: none; }
    a.primary { background: #5b5ce2; }
  </style>
</head>
<body>
  <main>
    <h1>Kun could not finish starting</h1>
    <p>The application is still running so you can inspect the failure or retry. The diagnostic detail is:</p>
    <pre>${safeMessage}</pre>
    <p>Log directory:</p>
    <div class="path">${safeLogDir}</div>
    <div class="actions">
      <a class="primary" href="${STARTUP_ACTION_PROTOCOL}retry">Retry Kun</a>
      <a href="${STARTUP_ACTION_PROTOCOL}open-logs">Open log folder</a>
      <a href="${STARTUP_ACTION_PROTOCOL}quit">Quit</a>
    </div>
  </main>
</body>
</html>`
}
