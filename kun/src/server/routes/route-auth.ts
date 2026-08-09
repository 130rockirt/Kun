import { isAuthorized } from '../auth.js'
import type { ServerRuntime } from './server-runtime.js'

export function authorize(request: Request, runtime: ServerRuntime): boolean {
  return isAuthorized(request.headers, runtime.runtimeToken, runtime.insecure)
}
