import {
  KUN_OPEN_CONNECTOR_INSTANCE_PROOF_KEY_ENV,
  KUN_OPEN_CONNECTOR_RUNTIME_TOKEN_ENV
} from './open-connector-sidecar'

let runtimeToken = ''
let instanceProofKey = ''

/** Keep connector credentials in Electron-main memory and inject them only into Kun. */
export function setOpenConnectorKunRuntimeToken(value: string): void {
  runtimeToken = value.trim()
}

export function setOpenConnectorKunInstanceProofKey(value: string): void {
  instanceProofKey = value.trim()
}

export function openConnectorKunEnvironment(): NodeJS.ProcessEnv {
  return {
    ...(runtimeToken ? { [KUN_OPEN_CONNECTOR_RUNTIME_TOKEN_ENV]: runtimeToken } : {}),
    ...(instanceProofKey ? { [KUN_OPEN_CONNECTOR_INSTANCE_PROOF_KEY_ENV]: instanceProofKey } : {})
  }
}

export function clearOpenConnectorKunEnvironmentForTest(): void {
  runtimeToken = ''
  instanceProofKey = ''
}
