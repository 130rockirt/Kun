import { z } from 'zod'

export const BROWSER_USE_BRIDGE_CONTRACT_VERSION = 1 as const
export const KUN_BROWSER_USE_BRIDGE_URL_ENV = 'KUN_BROWSER_USE_BRIDGE_URL' as const
export const KUN_BROWSER_USE_BRIDGE_TOKEN_ENV = 'KUN_BROWSER_USE_BRIDGE_TOKEN' as const

const BrowserUseRef = z.string().min(16).max(512)
const BrowserUseTabId = z.string().min(1).max(256)
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
    ref: BrowserUseRef
  }).strict(),
  z.object({
    action: z.literal('type'),
    ref: BrowserUseRef,
    text: z.string().max(2000)
  }).strict(),
  z.object({
    action: z.literal('select'),
    ref: BrowserUseRef,
    value: z.string().max(512)
  }).strict(),
  z.object({
    action: z.literal('press'),
    ref: BrowserUseRef,
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

export const BrowserUseBridgeRequest = z.object({
  contractVersion: z.literal(BROWSER_USE_BRIDGE_CONTRACT_VERSION),
  requestId: z.string().uuid(),
  threadId: z.string().min(1).max(256),
  turnId: z.string().min(1).max(256),
  action: BrowserUseActionInput
}).strict()
export type BrowserUseBridgeRequest = z.infer<typeof BrowserUseBridgeRequest>

export const BrowserUseBridgeResponse = z.object({
  contractVersion: z.literal(BROWSER_USE_BRIDGE_CONTRACT_VERSION),
  requestId: z.string().uuid(),
  result: BrowserUseToolResult
}).strict()
export type BrowserUseBridgeResponse = z.infer<typeof BrowserUseBridgeResponse>

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
    return { ...action, text: '[redacted]' }
  }
  if (action.action === 'select') {
    return { ...action, value: '[redacted]' }
  }
  return action
}
