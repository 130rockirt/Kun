import { createHash } from 'node:crypto'
import { z } from 'zod'
import { RuntimeFlavorSchema } from '../contracts/runtime-flavor.js'

const AcquireResultSchema = z.object({ acquired: z.boolean() }).passthrough()

/**
 * Serialize a shared-data mutation across production and development Runtime
 * processes. The state file itself is still written by Manager's atomic JSON
 * API; this lease keeps multi-step read/side-effect/write transactions intact.
 */
export async function withManagerDataMutex<T>(
  resource: string,
  operation: () => Promise<T>
): Promise<T> {
  const manager = managerRuntimeIdentity()
  if (!manager) return operation()
  const resourceId = `data:${createHash('sha256').update(resource).digest('hex').slice(0, 32)}`
  const leasePath = `${manager.baseUrl}/v1/leases/resources/${encodeURIComponent(resourceId)}`
  const body = {
    ownerFlavor: manager.flavor,
    ownerInstanceId: manager.instanceId
  }
  const deadline = Date.now() + 30_000
  for (;;) {
    const acquired = AcquireResultSchema.parse(await managerRequest(
      `${leasePath}/acquire`,
      manager.token,
      body
    )).acquired
    if (acquired) break
    if (Date.now() >= deadline) throw new Error(`shared data resource is busy: ${resource}`)
    await delay(100)
  }

  let renewalFailure: unknown
  const renew = setInterval(() => {
    void managerRequest(`${leasePath}/acquire`, manager.token, body)
      .then((value) => {
        if (!AcquireResultSchema.parse(value).acquired) {
          renewalFailure = new Error(`shared data resource lease was lost: ${resource}`)
        }
      })
      .catch((error) => { renewalFailure = error })
  }, 3_000)
  renew.unref?.()
  try {
    const result = await operation()
    if (renewalFailure) throw renewalFailure
    return result
  } finally {
    clearInterval(renew)
    await managerRequest(`${leasePath}/release`, manager.token, body).catch(() => undefined)
  }
}

function managerRuntimeIdentity(): {
  baseUrl: string
  token: string
  flavor: 'production' | 'development'
  instanceId: string
} | null {
  const baseUrl = process.env.KUN_MANAGER_BASE_URL?.trim().replace(/\/+$/u, '')
  const token = process.env.KUN_MANAGER_TOKEN?.trim()
  const instanceId = process.env.KUN_RUNTIME_INSTANCE_ID?.trim()
  const flavor = RuntimeFlavorSchema.safeParse(process.env.KUN_RUNTIME_FLAVOR?.trim())
  if (!baseUrl || !token || !instanceId || !flavor.success) return null
  return { baseUrl, token, instanceId, flavor: flavor.data }
}

async function managerRequest(url: string, token: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000)
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Kun Service Manager data mutex failed with HTTP ${response.status}: ${detail.slice(0, 512)}`)
  }
  return response.json()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
