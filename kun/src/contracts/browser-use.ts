import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export const BROWSER_USE_BRIDGE_CONTRACT_VERSION = 2 as const
export const KUN_BROWSER_USE_BRIDGE_URL_ENV = 'KUN_BROWSER_USE_BRIDGE_URL' as const
export const KUN_BROWSER_USE_BRIDGE_TOKEN_ENV = 'KUN_BROWSER_USE_BRIDGE_TOKEN' as const
export const KUN_BROWSER_USE_APPROVAL_SIGNING_KEY_ENV =
  'KUN_BROWSER_USE_APPROVAL_SIGNING_KEY' as const

const BrowserUseRef = z.string().min(16).max(512)
const BrowserUseTabId = z.string().min(1).max(256)
const BrowserUseExpectedTarget = z.object({
  sessionId: z.string().min(16).max(256),
  tabId: BrowserUseTabId,
  documentGeneration: z.number().int().nonnegative(),
  origin: z.string().url().max(2_048).refine((value) => {
    try {
      const parsed = new URL(value)
      return (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.origin === value &&
        !parsed.username &&
        !parsed.password
      )
    } catch {
      return false
    }
  }, 'expected target origin must be an exact credential-free HTTP(S) origin'),
  sanitizedUrl: z.string().url().max(2_048).refine((value) => {
    try {
      const parsed = new URL(value)
      return (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash
      )
    } catch {
      return false
    }
  }, 'expected target URL must be a credential-free URL without query or fragment'),
  role: z.string().max(128),
  name: z.string().max(512)
}).strict()
export type BrowserUseExpectedTarget = z.infer<typeof BrowserUseExpectedTarget>

const BrowserUseTopLevelUrl = z.string().url().max(4096).refine((value) => {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}, 'browser use only accepts credential-free http or https top-level URLs')

export const BrowserUseActionInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('open'),
    url: BrowserUseTopLevelUrl
  }).strict(),
  z.object({
    action: z.literal('snapshot')
  }).strict(),
  z.object({
    action: z.literal('screenshot')
  }).strict(),
  z.object({
    action: z.literal('click'),
    ref: BrowserUseRef,
    expectedTarget: BrowserUseExpectedTarget
  }).strict(),
  z.object({
    action: z.literal('type'),
    ref: BrowserUseRef,
    expectedTarget: BrowserUseExpectedTarget,
    text: z.string().max(2000)
  }).strict(),
  z.object({
    action: z.literal('select'),
    ref: BrowserUseRef,
    expectedTarget: BrowserUseExpectedTarget,
    value: z.string().max(512)
  }).strict(),
  z.object({
    action: z.literal('press'),
    ref: BrowserUseRef,
    expectedTarget: BrowserUseExpectedTarget,
    key: z.enum([
      'Enter',
      'Escape',
      'Tab',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'Backspace',
      'Delete',
      'Space'
    ])
  }).strict(),
  z.object({
    action: z.literal('scroll'),
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().int().min(1).max(2000).default(600)
  }).strict(),
  z.object({
    action: z.literal('wait'),
    milliseconds: z.number().int().min(100).max(5000).default(500)
  }).strict(),
  z.object({
    action: z.literal('tabs'),
    operation: z.enum(['list', 'switch', 'close']).default('list'),
    tabId: BrowserUseTabId.optional()
  }).strict(),
  z.object({
    action: z.literal('close')
  }).strict()
])
export type BrowserUseActionInput = z.infer<typeof BrowserUseActionInput>

export const BrowserUseSnapshotNode = z.object({
  ref: BrowserUseRef.optional(),
  role: z.string().max(128),
  name: z.string().max(512),
  value: z.string().max(512).optional(),
  disabled: z.boolean().optional(),
  checked: z.boolean().optional(),
  selected: z.boolean().optional(),
  expanded: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  rect: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative()
  }).strict()
}).strict()
export type BrowserUseSnapshotNode = z.infer<typeof BrowserUseSnapshotNode>

export const BrowserUseSnapshot = z.object({
  untrustedContent: z.literal(true),
  sessionId: z.string().min(16).max(256),
  tabId: BrowserUseTabId,
  origin: z.string().max(2048),
  sanitizedUrl: z.string().max(2048),
  title: z.string().max(512),
  documentGeneration: z.number().int().nonnegative(),
  truncated: z.boolean(),
  nodes: z.array(BrowserUseSnapshotNode).max(500)
}).strict()
export type BrowserUseSnapshot = z.infer<typeof BrowserUseSnapshot>

export const BrowserUseImage = z.object({
  mediaType: z.enum(['image/png', 'image/jpeg']),
  data: z.string().max(12_000_000)
}).strict()
export type BrowserUseImage = z.infer<typeof BrowserUseImage>

export const BrowserUseToolResult = z.object({
  ok: z.boolean(),
  code: z.string().min(1).max(128),
  message: z.string().max(2048),
  sessionId: z.string().min(16).max(256).optional(),
  tabId: BrowserUseTabId.optional(),
  snapshot: BrowserUseSnapshot.optional(),
  image: BrowserUseImage.optional(),
  tabs: z.array(z.object({
    id: BrowserUseTabId,
    title: z.string().max(512),
    origin: z.string().max(2048),
    active: z.boolean()
  }).strict()).max(3).optional()
}).strict()
export type BrowserUseToolResult = z.infer<typeof BrowserUseToolResult>

const BrowserUseKunApprovalGrantClaims = z.object({
  id: z.string().regex(/^(?:appr|grant)_[a-f0-9]{32}$/),
  source: z.enum(['user', 'agent', 'full-access']),
  toolName: z.literal('browser_use'),
  threadId: z.string().min(1).max(256),
  turnId: z.string().min(1).max(256),
  callId: z.string().min(1).max(512),
  argumentsHash: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict()
export type BrowserUseKunApprovalGrantClaims = z.infer<
  typeof BrowserUseKunApprovalGrantClaims
>

export const BrowserUseKunApprovalGrant = BrowserUseKunApprovalGrantClaims.extend({
  signature: z.string().regex(/^[a-f0-9]{64}$/)
}).strict().refine(
  (value) => {
    const issuedAt = Date.parse(value.issuedAt)
    const expiresAt = Date.parse(value.expiresAt)
    return expiresAt > issuedAt && expiresAt - issuedAt <= 5 * 60 * 1_000
  },
  { message: 'Browser Use approval grants must have a short bounded lifetime' }
)
export type BrowserUseKunApprovalGrant = z.infer<typeof BrowserUseKunApprovalGrant>
export type BrowserUseKunApprovalGrantDraft = Omit<
  BrowserUseKunApprovalGrantClaims,
  'threadId' | 'turnId'
>

const BROWSER_USE_APPROVAL_GRANT_DOMAIN = 'kun-browser-use-approval-grant-v1'

/**
 * Signs the complete call authority sent from the trusted Kun tool boundary to
 * Electron Main. The independent signing key is captured by Kun before any
 * model-controlled provider child starts and is never exposed in a tool
 * schema or result.
 */
export function signBrowserUseKunApprovalGrant(
  input: BrowserUseKunApprovalGrantClaims,
  signingKey: string
): BrowserUseKunApprovalGrant {
  const claims = BrowserUseKunApprovalGrantClaims.parse(input)
  const key = normalizeBrowserUseApprovalSigningKey(signingKey)
  if (!key) throw new Error('Browser Use approval signing key is unavailable')
  return BrowserUseKunApprovalGrant.parse({
    ...claims,
    signature: createHmac('sha256', key)
      .update(browserUseApprovalGrantPayload(claims))
      .digest('hex')
  })
}

export function verifyBrowserUseKunApprovalGrant(
  input: BrowserUseKunApprovalGrant,
  signingKey: string
): boolean {
  const parsed = BrowserUseKunApprovalGrant.safeParse(input)
  const key = normalizeBrowserUseApprovalSigningKey(signingKey)
  if (!parsed.success || !key) return false
  const expected = createHmac('sha256', key)
    .update(browserUseApprovalGrantPayload(parsed.data))
    .digest()
  const supplied = Buffer.from(parsed.data.signature, 'hex')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function browserUseApprovalGrantPayload(
  grant: BrowserUseKunApprovalGrantClaims
): string {
  return JSON.stringify([
    BROWSER_USE_APPROVAL_GRANT_DOMAIN,
    grant.id,
    grant.source,
    grant.toolName,
    grant.threadId,
    grant.turnId,
    grant.callId,
    grant.argumentsHash,
    grant.issuedAt,
    grant.expiresAt
  ])
}

function normalizeBrowserUseApprovalSigningKey(value: string): string | undefined {
  const normalized = value.trim()
  return /^[A-Za-z0-9_-]{32,512}$/.test(normalized)
    ? normalized
    : undefined
}

export const BrowserUseKunApprovalMode = z.enum(['user', 'agent', 'full-access'])
export type BrowserUseKunApprovalMode = z.infer<typeof BrowserUseKunApprovalMode>

const BrowserUseBridgeRequestBase = z.object({
  contractVersion: z.literal(BROWSER_USE_BRIDGE_CONTRACT_VERSION),
  requestId: z.string().uuid(),
  threadId: z.string().min(1).max(256),
  turnId: z.string().min(1).max(256),
  action: BrowserUseActionInput,
  kunApprovalMode: BrowserUseKunApprovalMode.optional(),
  kunApprovalGrant: BrowserUseKunApprovalGrant.optional()
}).strict()

export const BrowserUseBridgeRequest = BrowserUseBridgeRequestBase.superRefine((value, context) => {
  const approvalBoundary = isBrowserUseApprovalBoundaryAction(value.action)
  if (approvalBoundary && !value.kunApprovalGrant) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['kunApprovalGrant'],
      message: 'approval-worthy Browser Use actions require a one-call Kun approval grant'
    })
  }
  if (approvalBoundary && !value.kunApprovalMode) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['kunApprovalMode'],
      message: 'approval-worthy Browser Use actions require frozen Kun approval routing'
    })
  }
  if (!approvalBoundary && (value.kunApprovalMode || value.kunApprovalGrant)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['kunApprovalMode'],
      message: 'observation actions cannot change or carry Browser Use approval authority'
    })
  }
  if (
    value.kunApprovalGrant &&
    value.kunApprovalMode &&
    value.kunApprovalGrant.source !== value.kunApprovalMode
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['kunApprovalMode'],
      message: 'Browser Use approval routing must match the one-call grant source'
    })
  }
})
export type BrowserUseBridgeRequest = z.infer<typeof BrowserUseBridgeRequest>

export const BrowserUseBridgeResponse = z.object({
  contractVersion: z.literal(BROWSER_USE_BRIDGE_CONTRACT_VERSION),
  requestId: z.string().uuid(),
  result: BrowserUseToolResult
}).strict()
export type BrowserUseBridgeResponse = z.infer<typeof BrowserUseBridgeResponse>

export function isBrowserUseApprovalBoundaryAction(action: BrowserUseActionInput): boolean {
  return action.action === 'open' ||
    action.action === 'click' ||
    action.action === 'type' ||
    action.action === 'select' ||
    action.action === 'press'
}

export function redactBrowserUseUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname.slice(0, 1024)}`
  } catch {
    return '<invalid-url>'
  }
}

export function redactBrowserUseActionForPersistence(input: unknown): unknown {
  const parsed = BrowserUseActionInput.safeParse(input)
  if (!parsed.success) return { action: 'invalid' }
  const action = parsed.data
  if (action.action === 'open') {
    return { ...action, url: redactBrowserUseUrl(action.url) }
  }
  if (action.action === 'type') {
    return {
      ...action,
      expectedTarget: { ...action.expectedTarget, name: '[redacted]' },
      text: '[redacted]'
    }
  }
  if (action.action === 'select') {
    return {
      ...action,
      expectedTarget: { ...action.expectedTarget, name: '[redacted]' },
      value: '[redacted]'
    }
  }
  if (
    action.action === 'click' ||
    action.action === 'press'
  ) {
    return {
      ...action,
      expectedTarget: { ...action.expectedTarget, name: '[redacted]' }
    }
  }
  return action
}
