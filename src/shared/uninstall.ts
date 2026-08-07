import { z } from 'zod'

export const UNINSTALL_SCHEMA_VERSION = 1 as const

export const UninstallRemoveAppModeSchema = z.enum(['bundle', 'uninstaller', 'appimage', 'none'])
export type UninstallRemoveAppMode = z.infer<typeof UninstallRemoveAppModeSchema>

export const UninstallPathKindSchema = z.enum([
  'userData',
  'legacyUserData',
  'kunData',
  'legacyKunData',
  'customData'
])
export type UninstallPathKind = z.infer<typeof UninstallPathKindSchema>

export const UninstallPathItemSchema = z.object({
  kind: UninstallPathKindSchema,
  path: z.string().min(1).max(32_767),
  exists: z.boolean()
}).strict()
export type UninstallPathItem = z.infer<typeof UninstallPathItemSchema>

export const UninstallStatusSchema = z.object({
  schemaVersion: z.literal(UNINSTALL_SCHEMA_VERSION),
  platform: z.string().min(1),
  isPackaged: z.boolean(),
  canRemoveApp: z.boolean(),
  removeAppMode: UninstallRemoveAppModeSchema,
  removeAppTarget: z.string().max(32_767).optional(),
  appInstallPath: z.string().max(32_767).optional(),
  appRemovalHint: z.string().max(2_000).optional(),
  paths: z.array(UninstallPathItemSchema).max(16)
}).strict()
export type UninstallStatus = z.infer<typeof UninstallStatusSchema>

export const UninstallOptionsSchema = z.object({
  deleteAllData: z.boolean(),
  removeApp: z.boolean()
}).strict()
export type UninstallOptions = z.infer<typeof UninstallOptionsSchema>

export const UninstallPerformResultSchema = z.object({
  scheduled: z.literal(true),
  operationId: z.string().uuid(),
  pathCount: z.number().int().nonnegative(),
  removeAppMode: UninstallRemoveAppModeSchema,
  cleanupScriptPath: z.string().min(1).max(32_767)
}).strict()
export type UninstallPerformResult = z.infer<typeof UninstallPerformResultSchema>

export type UninstallApi = {
  getStatus: () => Promise<UninstallStatus>
  perform: (options: UninstallOptions) => Promise<UninstallPerformResult>
}
