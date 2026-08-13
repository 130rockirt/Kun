import { z } from 'zod'
import { jsonResponse, type JsonResponse } from '../response.js'
import { readJsonBody } from '../read-json-body.js'
import { ERRORS } from './runtime-error.js'
import type { CanvasReceiptRegistry } from '../../services/canvas-receipt-registry.js'

const CanvasReceiptBody = z.object({
  turnId: z.string().min(1).max(200),
  receiptKey: z.string().min(1).max(200).optional(),
  status: z.enum(['applied', 'failed']),
  errors: z.array(z.object({
    code: z.string(),
    message: z.string(),
    suggestion: z.string().optional()
  })).max(32).optional(),
  affectedIds: z.array(z.string()).max(2000).optional()
})

export async function receiveCanvasReceipt(input: {
  threadId: string
  request: Request
  receipts: CanvasReceiptRegistry
}): Promise<JsonResponse | Response> {
  const body = await readJsonBody(input.request)
  if (!body.ok) return body.response
  const parsed = CanvasReceiptBody.safeParse(body.value)
  if (!parsed.success) {
    return ERRORS.validation('invalid canvas receipt body', parsed.error.issues)
  }
  const { turnId, receiptKey, status, errors, affectedIds } = parsed.data
  const payload = {
    status,
    ...(errors?.length ? { errors } : {}),
    ...(affectedIds?.length ? { affectedIds } : {})
  }
  const accepted = receiptKey
    ? await input.receipts.fulfillForTurn(receiptKey, input.threadId, turnId, payload)
    : await input.receipts.fulfillTurn(input.threadId, turnId, payload)
  if (!accepted) {
    // Unknown or already-settled turns are idempotent no-ops, not errors: the
    // renderer may resend after a reconnect or the loop may have timed out.
    return jsonResponse({
      threadId: input.threadId, turnId, ...(receiptKey ? { receiptKey } : {}),
      status, accepted: false, alreadySettled: true
    })
  }
  return jsonResponse({
    threadId: input.threadId, turnId, ...(receiptKey ? { receiptKey } : {}),
    status, accepted: true
  })
}
