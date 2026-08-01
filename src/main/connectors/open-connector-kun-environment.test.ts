import { afterEach, describe, expect, it } from 'vitest'
import {
  KUN_OPEN_CONNECTOR_INSTANCE_PROOF_KEY_ENV,
  KUN_OPEN_CONNECTOR_RUNTIME_TOKEN_ENV
} from './open-connector-sidecar'
import {
  clearOpenConnectorKunEnvironmentForTest,
  openConnectorKunEnvironment,
  setOpenConnectorKunInstanceProofKey,
  setOpenConnectorKunRuntimeToken
} from './open-connector-kun-environment'

afterEach(() => clearOpenConnectorKunEnvironmentForTest())

describe('OpenConnector Kun child environment', () => {
  it('keeps host-owned connector credentials out of process.env and returns only the Kun injection', () => {
    const originalRuntimeToken = process.env[KUN_OPEN_CONNECTOR_RUNTIME_TOKEN_ENV]
    const originalProofKey = process.env[KUN_OPEN_CONNECTOR_INSTANCE_PROOF_KEY_ENV]
    setOpenConnectorKunRuntimeToken('runtime-secret')
    setOpenConnectorKunInstanceProofKey('proof-secret')

    expect(process.env[KUN_OPEN_CONNECTOR_RUNTIME_TOKEN_ENV]).toBe(originalRuntimeToken)
    expect(process.env[KUN_OPEN_CONNECTOR_INSTANCE_PROOF_KEY_ENV]).toBe(originalProofKey)
    expect(openConnectorKunEnvironment()).toEqual({
      [KUN_OPEN_CONNECTOR_RUNTIME_TOKEN_ENV]: 'runtime-secret',
      [KUN_OPEN_CONNECTOR_INSTANCE_PROOF_KEY_ENV]: 'proof-secret'
    })
  })
})
