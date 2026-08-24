import { createHash } from 'node:crypto'
import { z } from 'zod'
import { RuntimeFlavorSchema } from '../contracts/runtime-flavor.js'

const AcquireResultSchema = z.object({
  acquired: z.boolean(),
  lease: z.object({ expiresAt: z.string() }).passthrough().optional()
}).passthrough()

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
  const acquireDeadline = Date.now() + 30_000
  let lease: { expiresAt?: string } | undefined
  for (;;) {
    const result = AcquireResultSchema.parse(await managerRequest(
      `${leasePath}/acquire`,
      manager.token,
      body
    ))
    if (result.acquired) {
      lease = result.lease
      break
    }
    if (Date.now() >= acquireDeadline) throw new Error(`shared data resource is busy: ${resource}`)
    await delay(100)
  }

  // Manager deletes the lease at expiresAt even while this runtime cannot
  // reach it, and another runtime may then enter the critical section. Track
  // expiresAt locally and fail the operation as soon as the lease is
  // definitively lost instead of waiting for operation() to settle.
  let finished = false
  let renewalFailure: unknown
  let rejectLeaseLost: (error: unknown) => void = () => undefined
  const leaseLost = new Promise<never>((_, reject) => { rejectLeaseLost = reject })
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const fail = (error: unknown) => {
    if (finished || renewalFailure) return
    renewalFailure = error
    rejectLeaseLost(error)
  }
  const armDeadline = (expiresAt: string | undefined) => {
    if (deadlineTimer) clearTimeout(deadlineTimer)
    deadlineTimer = undefined
    const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN
    if (!Number.isFinite(expiresAtMs)) return
    deadlineTimer = setTimeout(
      () => fail(new Error(`shared data resource lease expired: ${resource}`)),
      Math.max(0, expiresAtMs - Date.now())
    )
    deadlineTimer.unref?.()
  }
  armDeadline(lease?.expiresAt)

  const renew = setInterval(() => {
    void managerRequest(`${leasePath}/acquire`, manager.token, body)
      .then((value) => {
        const result = AcquireResultSchema.parse(value)
        if (!result.acquired) {
          fail(new Error(`shared data resource lease was lost: ${resource}`))
          return
        }
        armDeadline(result.lease?.expiresAt)
      })
      .catch((error) => {
        // Transient failure: the local deadline remains the hard limit.
        console.warn(
          `[kun] shared data lease renewal delayed resource=${resource}: ` +
          `${error instanceof Error ? error.message : String(error)}`
        )
      })
  }, 3_000)
  renew.unref?.()
  try {
    const operationPromise = operation()
    // The race observes a rejection; this keeps it handled if lease loss wins.
    operationPromise.catch(() => undefined)
    const result = await Promise.race([operationPromise, leaseLost])
    if (renewalFailure) throw renewalFailure
    return result
  } finally {
    finished = true
    clearInterval(renew)
    if (deadlineTimer) clearTimeout(deadlineTimer)
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
