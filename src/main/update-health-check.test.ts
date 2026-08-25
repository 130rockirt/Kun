import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '0.2.0' } }))
vi.mock('./main-app-context', () => ({ mainState: {} }))
vi.mock('./main-runtime-health', () => ({ probeRuntimeApi: vi.fn() }))
vi.mock('./main-ready', () => ({ startMainApp: vi.fn() }))

let readUpdateHealthRequest: typeof import('./update-health-check').readUpdateHealthRequest

beforeAll(async () => {
  ;({ readUpdateHealthRequest } = await import('./update-health-check'))
})

describe('update health request', () => {
  it('parses a complete tokenized request', () => {
    expect(readUpdateHealthRequest([
      'Kun.exe',
      '--kun-update-health-check=C:\\Temp\\health.json',
      '--kun-update-health-token=token-123',
      '--kun-update-target=C:\\Program Files\\Kun'
    ])).toEqual({
      resultPath: 'C:\\Temp\\health.json',
      token: 'token-123',
      target: 'C:\\Program Files\\Kun'
    })
  })

  it('returns null outside update health mode', () => {
    expect(readUpdateHealthRequest(['Kun.exe'])).toBeNull()
  })

  it('rejects an incomplete health request', () => {
    expect(() => readUpdateHealthRequest([
      'Kun.exe',
      '--kun-update-health-check=C:\\Temp\\health.json'
    ])).toThrow('incomplete')
  })
})
