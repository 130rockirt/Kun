import { z } from 'zod'

export const APPROVAL_POLICIES = [
  'always',
  'on-request',
  'untrusted',
  'never',
  'auto',
  'suggest'
] as const
/**
 * A fresh runtime must not silently grant model-controlled tools host-wide
 * execution. Users can still opt into trusted-workspace or bypass modes
 * explicitly in settings.
 */
export const DEFAULT_APPROVAL_POLICY = 'on-request'

export const ApprovalPolicySchema = z.enum(APPROVAL_POLICIES)
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>

export const SANDBOX_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
  'external-sandbox'
 ] as const
export const DEFAULT_SANDBOX_MODE = 'workspace-write'

export const SandboxModeSchema = z.enum(SANDBOX_MODES)
export type SandboxMode = z.infer<typeof SandboxModeSchema>

export const KUN_TOOL_PERMISSION_MODES = [
  'always-ask',
  'read-only',
  'sensitive-ask',
  'workspace-write',
  'trusted-workspace',
  'bypass'
] as const
export type KunToolPermissionMode = (typeof KUN_TOOL_PERMISSION_MODES)[number]

export type KunToolPermissionSettings = {
  approvalPolicy: ApprovalPolicy
  sandboxMode: SandboxMode
}

/**
 * Shared GUI/TUI permission presets. Keep the task-oriented mode names separate
 * from the two independent runtime policy axes so both clients present the same
 * safe, understandable defaults without narrowing the raw runtime contract.
 */
export function kunToolPermissionModeSettings(
  mode: KunToolPermissionMode
): KunToolPermissionSettings {
  switch (mode) {
    case 'always-ask':
      return { approvalPolicy: 'always', sandboxMode: 'danger-full-access' }
    case 'read-only':
      return { approvalPolicy: 'on-request', sandboxMode: 'danger-full-access' }
    case 'sensitive-ask':
      return { approvalPolicy: 'untrusted', sandboxMode: 'danger-full-access' }
    case 'workspace-write':
      return { approvalPolicy: 'on-request', sandboxMode: 'workspace-write' }
    case 'trusted-workspace':
      return { approvalPolicy: 'auto', sandboxMode: 'workspace-write' }
    case 'bypass':
      return { approvalPolicy: 'auto', sandboxMode: 'danger-full-access' }
  }
}

/**
 * Projects any schema-valid raw pair into the six-mode client vocabulary.
 * This is intentionally lossy for custom combinations; callers must not
 * persist the projected pair unless the user explicitly selects the preset.
 */
export function kunToolPermissionModeFromSettings(
  settings: KunToolPermissionSettings
): KunToolPermissionMode {
  if (settings.approvalPolicy === 'always') return 'always-ask'
  if (settings.approvalPolicy === 'untrusted') return 'sensitive-ask'
  if (
    settings.approvalPolicy === 'auto' &&
    settings.sandboxMode === 'danger-full-access'
  ) {
    return 'bypass'
  }
  if (
    settings.approvalPolicy === 'auto' &&
    settings.sandboxMode === 'workspace-write'
  ) {
    return 'trusted-workspace'
  }
  if (settings.sandboxMode === 'workspace-write') return 'workspace-write'
  return 'read-only'
}
