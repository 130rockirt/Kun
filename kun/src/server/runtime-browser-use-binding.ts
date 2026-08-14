import {
  currentBrowserUseHostAuthority,
  replaceBrowserUseHostAuthority
} from '../adapters/browser-use/browser-controller-authority.js'
import type { RuntimeConfigApplyRequest } from '../contracts/runtime-config.js'
import type { BrowserUseHostBinding } from '../contracts/runtime-config.js'

type StagedBrowserUseHostBinding = {
  commit(): void
  rollback(): void
}

const NOOP_STAGE: StagedBrowserUseHostBinding = {
  commit() {},
  rollback() {}
}

const MAX_REVOKED_BINDINGS = 4_096
const revokedBindings = new Set<string>()

/** Stage an ephemeral authority update outside persistent KunConfig state. */
export function stageBrowserUseHostBinding(
  request: RuntimeConfigApplyRequest
): StagedBrowserUseHostBinding {
  const explicitlyDisabled = request.capabilities?.browserUse?.enabled === false
  if (explicitlyDisabled) {
    const previous = replaceBrowserUseHostAuthority(undefined)
    let committed = false
    return {
      commit() {
        committed = true
      },
      rollback() {
        if (!committed) replaceBrowserUseHostAuthority(previous)
      }
    }
  }
  const conditionalRevoke = request.browserUseHostBindingRevoke
  if (conditionalRevoke) {
    const key = browserUseBindingKey(conditionalRevoke)
    const current = currentBrowserUseHostAuthority().binding
    const matches = current !== undefined && browserUseBindingKey(current) === key
    revokedBindings.add(key)
    trimRevokedBindings()
    const previous = matches ? replaceBrowserUseHostAuthority(undefined) : undefined
    let committed = false
    return {
      commit() {
        committed = true
      },
      rollback() {
        if (committed) return
        revokedBindings.delete(key)
        if (matches) replaceBrowserUseHostAuthority(previous)
      }
    }
  }
  if (request.browserUseHostBinding === undefined) return NOOP_STAGE

  if (
    request.browserUseHostBinding &&
    revokedBindings.has(browserUseBindingKey(request.browserUseHostBinding))
  ) return NOOP_STAGE

  const previous = replaceBrowserUseHostAuthority(
    request.browserUseHostBinding ?? undefined
  )
  let committed = false
  return {
    commit() {
      committed = true
    },
    rollback() {
      if (!committed) replaceBrowserUseHostAuthority(previous)
    }
  }
}

export function resetRevokedBrowserUseBindingsForTests(): void {
  revokedBindings.clear()
}

function browserUseBindingKey(binding: Readonly<BrowserUseHostBinding>): string {
  return JSON.stringify([
    binding.bridgeUrl,
    binding.bridgeToken,
    binding.approvalSigningKey
  ])
}

function trimRevokedBindings(): void {
  while (revokedBindings.size > MAX_REVOKED_BINDINGS) {
    const oldest = revokedBindings.values().next().value
    if (typeof oldest !== 'string') return
    revokedBindings.delete(oldest)
  }
}
