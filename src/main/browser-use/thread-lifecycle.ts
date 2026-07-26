export type BrowserUseThreadCleanup = {
  threadId: string
  reason: 'thread-archived' | 'thread-deleted'
}

export function browserUseCleanupForRuntimeRequest(input: {
  path: string
  method?: string
  body?: string
}): BrowserUseThreadCleanup | undefined {
  let pathname: string
  try {
    pathname = new URL(input.path, 'http://127.0.0.1').pathname
  } catch {
    return undefined
  }
  const match = /^\/v1\/threads\/([^/]+)$/.exec(pathname)
  if (!match?.[1]) return undefined
  let threadId: string
  try {
    threadId = decodeURIComponent(match[1]).trim()
  } catch {
    return undefined
  }
  const hasControlCharacter = Array.from(threadId).some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })
  if (!threadId || threadId.length > 256 || hasControlCharacter) {
    return undefined
  }
  const method = (input.method ?? 'GET').toUpperCase()
  if (method === 'DELETE') return { threadId, reason: 'thread-deleted' }
  if (method !== 'PATCH' || !input.body) return undefined
  try {
    const body = JSON.parse(input.body) as unknown
    if (
      body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      (body as { status?: unknown }).status === 'archived'
    ) {
      return { threadId, reason: 'thread-archived' }
    }
  } catch {
    return undefined
  }
  return undefined
}
