import { z } from 'zod'
import { readJsonBody } from '../read-json-body.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import type { ServerRuntime } from './server-runtime.js'
import { ERRORS } from './runtime-error.js'

const LocalCapabilityId = z.enum(['attachments', 'memory'])
const CapabilityUpdate = z.object({ enabled: z.boolean() }).strict()

export async function setLocalRuntimeCapability(
  runtime: ServerRuntime,
  capabilityId: string,
  request: Request
): Promise<JsonResponse | Response> {
  if (!runtime.setLocalCapabilityEnabled) {
    return ERRORS.unavailable('local capability configuration is unavailable')
  }
  const id = LocalCapabilityId.safeParse(capabilityId)
  if (!id.success) return ERRORS.validation('unsupported local capability', id.error.issues)
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = CapabilityUpdate.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid capability update', parsed.error.issues)
  const result = await runtime.setLocalCapabilityEnabled(id.data, parsed.data.enabled)
  if (!result.ok) return ERRORS.conflict(result.message)
  return jsonResponse({ id: id.data, enabled: parsed.data.enabled })
}
