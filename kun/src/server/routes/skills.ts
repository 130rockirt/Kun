import { jsonResponse, type JsonResponse } from '../response.js'
import type { ServerRuntime } from './server-runtime.js'

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
