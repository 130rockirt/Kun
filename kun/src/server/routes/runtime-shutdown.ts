import { z } from 'zod'
import { isLoopbackHost } from '../loopback-host.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import type { ServerRuntime } from './server-runtime.js'
import { ERRORS } from './runtime-error.js'

const ShutdownRequest = z.object({ instanceId: z.string().min(1).max(256) }).strict()

export async function shutdownRuntime(
  runtime: ServerRuntime,
  request: Request
): Promise<JsonResponse> {
  const remoteAddress = request.headers.get('x-kun-remote-address') ?? ''
  if (!isLoopbackAddress(remoteAddress)) return ERRORS.forbidden()
  const parsed = ShutdownRequest.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return ERRORS.validation('invalid runtime shutdown request', parsed.error.issues)
  if (!runtime.requestShutdown) return ERRORS.conflict('runtime shutdown is unavailable')
  const accepted = await runtime.requestShutdown(parsed.data.instanceId)
  if (!accepted) return ERRORS.conflict('runtime instance changed; refresh discovery and retry')
  return jsonResponse({ accepted: true, instanceId: parsed.data.instanceId })
}

function isLoopbackAddress(value: string): boolean {
  const normalized = value.replace(/^::ffff:/u, '').replace(/^\[|\]$/gu, '')
  return isLoopbackHost(normalized)
}
