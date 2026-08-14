import {
  KUN_BROWSER_USE_APPROVAL_SIGNING_KEY_ENV,
  KUN_BROWSER_USE_BRIDGE_TOKEN_ENV,
  KUN_BROWSER_USE_BRIDGE_URL_ENV
} from '../../contracts/browser-use.js'
import { BrowserUseHostBinding, type BrowserUseHostBinding as HostBinding } from '../../contracts/runtime-config.js'

export type BrowserUseHostAuthorityLease = Readonly<{
  binding?: Readonly<HostBinding>
  signal: AbortSignal
}>

type BrowserUseHostAuthority = {
  binding?: Readonly<HostBinding>
  controller: AbortController
}

let authority: BrowserUseHostAuthority | undefined

export function currentBrowserUseHostAuthority(): BrowserUseHostAuthorityLease {
  const current = authority ?? captureManagedBridgeEnvironment()
  return {
    ...(current.binding ? { binding: current.binding } : {}),
    signal: current.controller.signal
  }
}

/** Replace launch-scoped authority and revoke every operation using its predecessor. */
export function replaceBrowserUseHostAuthority(
  next: HostBinding | null | undefined
): Readonly<HostBinding> | undefined {
  const current = authority ?? captureManagedBridgeEnvironment()
  const parsed = next ? BrowserUseHostBinding.parse(next) : undefined
  if (sameBinding(current.binding, parsed)) return current.binding
  current.controller.abort(new Error('Browser Use host authority was replaced.'))
  authority = {
    ...(parsed ? { binding: Object.freeze({ ...parsed }) } : {}),
    controller: new AbortController()
  }
  return current.binding
}

function sameBinding(
  left: Readonly<HostBinding> | undefined,
  right: HostBinding | undefined
): boolean {
  if (!left || !right) return left === right
  return left.bridgeUrl === right.bridgeUrl &&
    left.bridgeToken === right.bridgeToken &&
    left.approvalSigningKey === right.approvalSigningKey
}

export function fixedBrowserUseHostAuthority(
  candidate: Partial<HostBinding>
): BrowserUseHostAuthorityLease {
  const parsed = BrowserUseHostBinding.safeParse(candidate)
  const controller = new AbortController()
  return {
    ...(parsed.success ? { binding: Object.freeze({ ...parsed.data }) } : {}),
    signal: controller.signal
  }
}

/** Test-only reset for module-scoped launch authority. */
export function resetBrowserUseHostAuthorityForTests(): void {
  authority?.controller.abort()
  authority = undefined
}

function captureManagedBridgeEnvironment(): BrowserUseHostAuthority {
  const captured = BrowserUseHostBinding.safeParse({
    bridgeUrl: process.env[KUN_BROWSER_USE_BRIDGE_URL_ENV],
    bridgeToken: process.env[KUN_BROWSER_USE_BRIDGE_TOKEN_ENV],
    approvalSigningKey: process.env[KUN_BROWSER_USE_APPROVAL_SIGNING_KEY_ENV]
  })
  delete process.env[KUN_BROWSER_USE_BRIDGE_URL_ENV]
  delete process.env[KUN_BROWSER_USE_BRIDGE_TOKEN_ENV]
  delete process.env[KUN_BROWSER_USE_APPROVAL_SIGNING_KEY_ENV]
  authority = {
    ...(captured.success ? { binding: Object.freeze({ ...captured.data }) } : {}),
    controller: new AbortController()
  }
  return authority
}
