import { createHash, randomBytes } from 'node:crypto'
import {
  BrowserWindow,
  WebContentsView,
  type Rectangle
} from 'electron'
import type {
  BrowserUseActionConsentRequest,
  BrowserUseAuditEntry,
  BrowserUseBudgetState,
  BrowserUseMode,
  BrowserUseOriginConsentRequest,
  BrowserUseRect,
  BrowserUseViewState
} from '../../shared/browser-use'
import type { KunBrowserUseSettingsV1 } from '../../shared/app-settings'
import {
  BrowserUseToolResult,
  type BrowserUseActionInput as BrowserUseAction,
  type BrowserUseKunApprovalMode,
  type BrowserUseSnapshot,
  type BrowserUseSnapshotNode,
  type BrowserUseToolResult as BrowserUseResult
} from '../../../kun/src/contracts/browser-use.js'
import {
  hardenedRemoteWebPreferences
} from '../browser-security/web-contents-hardening'
import {
  BrowserUsePolicyProxy,
  type BrowserUsePolicyProxy as BrowserUsePolicyProxyType
} from './network-policy'

export const ORIGIN_DECISION_TIMEOUT_MS = 60_000
export const ACTION_DECISION_TIMEOUT_MS = 30_000
export const MOUNT_TIMEOUT_MS = 15_000
export const PREPARED_ACTION_TTL_MS = 30_000
export const MAX_AUDIT_ENTRIES = 2_000
export const BACKGROUND_VIEW_BOUNDS: Rectangle = {
  x: 0,
  y: 0,
  width: 1280,
  height: 800
}
export const MUTATION_EVENTS = new Set([
  'DOM.attributeModified',
  'DOM.attributeRemoved',
  'DOM.characterDataModified',
  'DOM.childNodeCountUpdated',
  'DOM.childNodeInserted',
  'DOM.childNodeRemoved',
  'DOM.documentUpdated',
  'DOM.shadowRootPopped',
  'DOM.shadowRootPushed'
])
export const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem'
])
export const SENSITIVE_AUTOCOMPLETE = /(?:^|\s)(?:cc-|current-password|new-password|one-time-code|webauthn|username|email)/i
export const SENSITIVE_FIELD = /(?:pass(?:word|code)?|passwd|username|user.?name|e-?mail|api.?key|secret|access.?token|otp|one.?time|2fa|mfa|auth.?code|verification.?code|captcha|human.?verification|card.?number|credit.?card|cvv|cvc|security.?code|ssn|social.?security|file.?upload)/i
export const SENSITIVE_COMMIT_ACTION = /(?:\bbuy now\b|\bpay now\b|\bpurchase\b|\bplace order\b|\bconfirm order\b|\bcheckout\b|\btransfer\b|\bsend money\b|\bwithdraw\b|\bsubscribe\b)/i

export type BrowserUseManagerOptions = {
  settings: () => KunBrowserUseSettingsV1
  now?: () => Date
  createView?: (partition: string) => WebContentsView
  createProxy?: (
    mode: BrowserUseMode,
    exactLocalOrigin: string | undefined,
    onPolicyEvent: (event: {
      outcome: 'allowed' | 'blocked'
      sanitizedUrl: string
      code?: string
    }) => void
  ) => BrowserUsePolicyProxy
  onState?: (state: BrowserUseViewState) => void
  onAudit?: (entry: BrowserUseAuditEntry) => void | Promise<void>
}

export type BrowserMount = {
  window: BrowserWindow
  bounds: Rectangle
  visible: boolean
  supervisionActive: boolean
  onRendererLost?: () => void
}

export type BrowserTarget = {
  ref: string
  tabId: string
  documentGeneration: number
  backendNodeId: number
  role: string
  name: string
  sensitive: boolean
  rect: BrowserUseRect
  fingerprint: string
}

export type PreparedAction = {
  id: string
  action: Extract<BrowserUseAction, { action: 'click' | 'type' | 'select' | 'press' }>
  target: BrowserTarget
  origin: string
  createdAt: number
  expiresAt: number
  used: boolean
}

export type PendingDecision = {
  id: string
  resolve: (decision: BrowserDecision) => void
  timer: ReturnType<typeof setTimeout>
}

export type BrowserDecision = 'allow-once' | 'deny' | 'expired' | 'cancelled'

export type BrowserTab = {
  id: string
  view: WebContentsView
  loading: boolean
  error?: string
}

export type TurnBudget = {
  observationUsed: number
  interactionUsed: number
}

export type BrowserSessionEntry = {
  id: string
  threadId: string
  mode: BrowserUseMode
  partition: string
  createdAt: number
  lastActivityAt: number
  lifecycle: BrowserUseViewState['lifecycle']
  controlOwner: BrowserUseViewState['controlOwner']
  mount?: BrowserMount
  mountWaiters: Set<() => void>
  proxy?: BrowserUsePolicyProxy
  proxyUrl?: string
  exactLocalOrigin?: string
  grants: Set<string>
  tabs: Map<string, BrowserTab>
  activeTabId?: string
  documentGeneration: number
  refs: Map<string, BrowserTarget>
  prepared: Map<string, PreparedAction>
  pendingOrigin?: BrowserUseOriginConsentRequest
  pendingAction?: BrowserUseActionConsentRequest
  pendingOriginDecision?: PendingDecision
  pendingActionDecision?: PendingDecision
  turnBudgets: Map<string, TurnBudget>
  activeTurnId?: string
  idleTimer?: ReturnType<typeof setTimeout>
  stopping: boolean
  agentInputDispatchActive: boolean
  kunApprovalMode?: {
    mode: BrowserUseKunApprovalMode
    turnId: string
  }
}

export type AxValue = {
  value?: unknown
}

export type AxProperty = {
  name?: string
  value?: AxValue
}

export type AxNode = {
  ignored?: boolean
  backendDOMNodeId?: number
  role?: AxValue
  name?: AxValue
  value?: AxValue
  properties?: AxProperty[]
}

export type DomDescription = {
  node?: {
    backendNodeId?: number
    localName?: string
    nodeName?: string
    attributes?: string[]
  }
}

export type BoxModelResult = {
  model?: {
    border?: number[]
    content?: number[]
  }
}

export function createBrowserUseView(partition: string): WebContentsView {
  const view = new WebContentsView({
    webPreferences: hardenedRemoteWebPreferences(partition)
  })
  view.setBackgroundColor('#ffffff')
  return view
}

export function isInteractionAction(
  action: BrowserUseAction
): action is Extract<BrowserUseAction, { action: 'click' | 'type' | 'select' | 'press' }> {
  return action.action === 'click' ||
    action.action === 'type' ||
    action.action === 'select' ||
    action.action === 'press'
}

export function resultOk(
  code: string,
  message: string,
  entry?: BrowserSessionEntry,
  tabId?: string
): BrowserUseResult {
  return BrowserUseToolResult.parse({
    ok: true,
    code,
    message,
    ...(entry ? { sessionId: entry.id } : {}),
    ...(tabId ?? entry?.activeTabId ? { tabId: tabId ?? entry?.activeTabId } : {})
  })
}

export function resultError(
  code: string,
  message: string,
  entry?: BrowserSessionEntry,
  tabId?: string
): BrowserUseResult {
  return BrowserUseToolResult.parse({
    ok: false,
    code,
    message: message.slice(0, 2048),
    ...(entry ? { sessionId: entry.id } : {}),
    ...(tabId ?? entry?.activeTabId ? { tabId: tabId ?? entry?.activeTabId } : {})
  })
}

export function normalizeBounds(
  input: BrowserUseRect,
  windowBounds: Pick<Rectangle, 'width' | 'height'>,
  zoomFactor: number
): Rectangle {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  const x = clamp(Math.round(input.x * zoom), 0, windowBounds.width)
  const y = clamp(Math.round(input.y * zoom), 0, windowBounds.height)
  return {
    x,
    y,
    width: clamp(Math.round(input.width * zoom), 0, Math.max(0, windowBounds.width - x)),
    height: clamp(Math.round(input.height * zoom), 0, Math.max(0, windowBounds.height - y))
  }
}

export function isVisibleMount(mount: BrowserMount | undefined): boolean {
  return Boolean(
    mount?.visible &&
    !mount.window.isDestroyed() &&
    mount.bounds.width > 0 &&
    mount.bounds.height > 0
  )
}

export function safeOrigin(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

export function originOnly(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).origin
  } catch {
    return undefined
  }
}

export function pathOnly(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).pathname.slice(0, 1024)
  } catch {
    return undefined
  }
}

export function attributesRecord(raw: string[] | undefined): Readonly<Record<string, string>> {
  const attributes: Record<string, string> = {}
  if (!raw) return attributes
  for (let index = 0; index + 1 < raw.length && index < 64; index += 2) {
    attributes[String(raw[index]).toLowerCase().slice(0, 64)] = String(raw[index + 1]).slice(0, 512)
  }
  return attributes
}

export function isSensitiveTarget(
  role: string,
  name: string,
  description: DomDescription,
  attributes: Readonly<Record<string, string>>
): boolean {
  const type = attributes.type?.toLowerCase() ?? ''
  if (type === 'password' || type === 'file' || type === 'hidden') return true
  if (SENSITIVE_AUTOCOMPLETE.test(attributes.autocomplete ?? '')) return true
  const identity = [
    role,
    name,
    description.node?.localName,
    description.node?.nodeName,
    attributes.name,
    attributes.id,
    attributes.placeholder,
    attributes['aria-label']
  ].filter(Boolean).join(' ')
  return SENSITIVE_FIELD.test(identity)
}

export function isForbiddenCommitTarget(name: string): boolean {
  return SENSITIVE_COMMIT_ACTION.test(name)
}

export function axString(value: AxValue | undefined): string {
  return typeof value?.value === 'string' ? value.value : ''
}

export function axProperties(properties: AxProperty[] | undefined): Map<string, unknown> {
  return new Map((properties ?? []).flatMap((property) =>
    property.name ? [[property.name, property.value?.value] as const] : []
  ))
}

export function isNearViewport(rect: BrowserUseRect, bounds: Rectangle | undefined): boolean {
  const width = bounds?.width ?? 1920
  const height = bounds?.height ?? 1080
  const margin = Math.max(width, height)
  return rect.x + rect.width >= -margin &&
    rect.y + rect.height >= -margin &&
    rect.x <= width + margin &&
    rect.y <= height + margin
}

export async function dispatchClick(tab: BrowserTab, x: number, y: number): Promise<void> {
  await tab.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await tab.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
}

export async function dispatchKey(tab: BrowserTab, key: string): Promise<void> {
  await tab.view.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key
  })
  await tab.view.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key
  })
}

export function randomToken(): string {
  return randomBytes(24).toString('base64url')
}

export function sanitizePageTitle(value: string): string {
  return value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\b(?:sk|pk|api|token)[-_][A-Za-z0-9_-]{8,}\b/gi, '[redacted]')
    .replace(/\b(token|secret|api[_ -]?key)=\S+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512)
}

export function roundRect(value: number): number {
  return Math.round(value * 100) / 100
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function once<T extends (...args: never[]) => void>(callback: T): T {
  let called = false
  return ((...args: never[]) => {
    if (called) return
    called = true
    callback(...args)
  }) as T
}

export function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason ?? new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function auditDecision(
  decision: BrowserDecision
): 'allowed' | 'denied' | 'expired' | 'cancelled' {
  if (decision === 'allow-once') return 'allowed'
  if (decision === 'deny') return 'denied'
  return decision
}
