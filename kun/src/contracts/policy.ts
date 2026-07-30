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
 * Compatibility defaults for persisted settings that predate the unified
 * permission selector. Product-level fresh defaults are defined by
 * `full-access`; callers loading legacy partial settings use these narrower
 * axes so an upgrade does not silently widen existing authority.
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

export const APPROVAL_REVIEWERS = ['user', 'agent'] as const
export const DEFAULT_APPROVAL_REVIEWER = 'user'

export const ApprovalReviewerSchema = z.enum(APPROVAL_REVIEWERS)
export type ApprovalReviewer = z.infer<typeof ApprovalReviewerSchema>

export const KUN_TOOL_PERMISSION_MODES = [
  'ask-for-approval',
  'approve-for-me',
  'full-access'
] as const
export type KunToolPermissionMode = (typeof KUN_TOOL_PERMISSION_MODES)[number]

export type KunToolPermissionSettings = {
  approvalPolicy: ApprovalPolicy
  sandboxMode: SandboxMode
  approvalReviewer: ApprovalReviewer
}

export type KunToolPermissionSettingsInput = Omit<
  KunToolPermissionSettings,
  'approvalReviewer'
> & {
  approvalReviewer?: ApprovalReviewer
}

/**
 * Shared GUI/TUI permission presets. Keep the product modes separate from the
 * independent runtime policy axes so every client writes the same complete
 * authority snapshot without narrowing the raw compatibility contract.
 */
export function kunToolPermissionModeSettings(
  mode: KunToolPermissionMode
): KunToolPermissionSettings {
  switch (mode) {
    case 'ask-for-approval':
      return {
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        approvalReviewer: 'user'
      }
    case 'approve-for-me':
      return {
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        approvalReviewer: 'agent'
      }
    case 'full-access':
      return {
        approvalPolicy: 'auto',
        sandboxMode: 'danger-full-access',
        approvalReviewer: 'user'
      }
  }
}

/**
 * Projects any schema-valid raw authority snapshot into the three-mode product
 * vocabulary without mutating it. Custom/legacy combinations deliberately
 * project to the reviewed user mode unless they exactly match another
 * canonical mode, so merely rendering a selector never presents legacy data as
 * unrestricted. Callers must not persist the projection unless the user
 * explicitly selects that mode.
 */
export function kunToolPermissionModeFromSettings(
  settings: KunToolPermissionSettingsInput
): KunToolPermissionMode {
  const normalized = {
    ...settings,
    approvalReviewer: settings.approvalReviewer ?? DEFAULT_APPROVAL_REVIEWER
  }
  if (kunToolPermissionSettingsEqual(normalized, kunToolPermissionModeSettings('full-access'))) {
    return 'full-access'
  }
  if (kunToolPermissionSettingsEqual(normalized, kunToolPermissionModeSettings('approve-for-me'))) {
    return 'approve-for-me'
  }
  return 'ask-for-approval'
}

export function kunToolPermissionSettingsEqual(
  left: KunToolPermissionSettings,
  right: KunToolPermissionSettings
): boolean {
  return (
    left.approvalPolicy === right.approvalPolicy &&
    left.sandboxMode === right.sandboxMode &&
    left.approvalReviewer === right.approvalReviewer
  )
}

export function isKunFullAccessSettings(
  settings: KunToolPermissionSettingsInput
): boolean {
  return kunToolPermissionModeFromSettings(settings) === 'full-access'
}
