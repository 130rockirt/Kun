import { z } from 'zod'
import { readJsonBody } from '../read-json-body.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import type { ServerRuntime } from './server-runtime.js'
import { ERRORS } from './runtime-error.js'

export async function listSkills(runtime: ServerRuntime, request?: Request): Promise<JsonResponse> {
  const workspace = request ? new URL(request.url).searchParams.get('workspace') ?? undefined : undefined
  const diagnostics = runtime.skills
    ? await runtime.skills(workspace)
    : {
        enabled: false,
        roots: [],
        skills: [],
        validationErrors: [],
        lastActivations: []
      }
  return jsonResponse({
    enabled: diagnostics.enabled,
    roots: diagnostics.roots,
    skills: diagnostics.skills,
    validationErrors: diagnostics.validationErrors
  })
}

export async function refreshSkills(runtime: ServerRuntime): Promise<JsonResponse> {
  if (!runtime.refreshSkills) {
    return jsonResponse({ refreshed: false, message: 'skill refresh is unavailable' }, 503)
  }
  await runtime.refreshSkills()
  return jsonResponse({ refreshed: true })
}

export async function setSkillsEnabled(
  runtime: ServerRuntime,
  request: Request
): Promise<JsonResponse | Response> {
  if (!runtime.setSkillsEnabled) return ERRORS.unavailable('skill configuration is unavailable')
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid skill configuration', parsed.error.issues)
  const result = await runtime.setSkillsEnabled(parsed.data.enabled)
  if (!result.ok) return ERRORS.conflict(result.message)
  return jsonResponse({ enabled: parsed.data.enabled })
}
