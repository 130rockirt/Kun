import { RuntimeInfoResponse } from '../../contracts/runtime-info.js'
import { redactSecrets } from '../../config/secret-redaction.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import type { ServerRuntime } from './server-runtime.js'

export function runtimeInfoJsonResponse(runtime: ServerRuntime): JsonResponse {
  const response = jsonResponse(RuntimeInfoResponse.parse(runtime.info()))
  const activeTurnCount = runtime.activeTurnCount?.()
  if (
    typeof activeTurnCount === 'number' &&
    Number.isSafeInteger(activeTurnCount) &&
    activeTurnCount >= 0
  ) {
    response.headers['x-kun-active-turn-count'] = String(activeTurnCount)
  }
  return response
}

export async function runtimeToolDiagnosticsJsonResponse(runtime: ServerRuntime): Promise<JsonResponse> {
  return jsonResponse(redactSecrets(await (runtime.toolDiagnostics?.() ?? {
    providers: [],
    mcpServers: [],
    mcpOAuth: [],
    webProviders: [],
    skills: {
      enabled: false,
      roots: [],
      skills: [],
      validationErrors: [],
      lastActivations: []
    },
    attachments: {
      enabled: false,
      rootDir: '',
      count: 0,
      totalBytes: 0
    },
    memory: {
      enabled: false,
      rootDir: '',
      activeCount: 0,
      tombstoneCount: 0,
      lastInjectedIds: []
    }
  })))
}
