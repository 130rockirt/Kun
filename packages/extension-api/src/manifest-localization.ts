import { z } from 'zod'
import { LocalIdSchema } from './common.js'

export const ManifestLocaleTagSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(
    /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/,
    'Expected a bounded BCP 47 language tag'
  )
export type ManifestLocaleTag = z.infer<typeof ManifestLocaleTagSchema>

const LocalizedTitleSchema = z.strictObject({
  title: z.string().min(1).max(128).optional()
})
const LocalizedDescriptionSchema = z.strictObject({
  description: z.string().max(2048).optional()
})
const LocalizedCommandSchema = LocalizedTitleSchema.extend({
  category: z.string().min(1).max(128).optional(),
  description: z.string().max(2048).optional()
}).strict()
const LocalizedNotificationSchema = LocalizedTitleSchema.extend({
  message: z.string().min(1).max(4096).optional(),
  actions: z.record(LocalIdSchema, LocalizedTitleSchema).superRefine((value, context) => {
    if (Object.keys(value).length > 4) {
      context.addIssue({ code: 'custom', message: 'Notification localization supports at most 4 actions' })
    }
  }).optional()
}).strict()
const LocalizedSettingPropertySchema = z.strictObject({
  title: z.string().min(1).max(128).optional(),
  description: z.string().max(2048).optional()
})
const LocalizedSettingsSchema = LocalizedTitleSchema.extend({
  properties: z.record(
    z.string().min(1).max(256),
    LocalizedSettingPropertySchema
  ).superRefine((value, context) => {
    if (Object.keys(value).length > 256) {
      context.addIssue({ code: 'custom', message: 'Settings localization supports at most 256 properties' })
    }
  }).optional()
}).strict()
const LocalizedModelSchema = z.strictObject({
  displayName: z.string().min(1).max(256).optional(),
  description: z.string().max(2048).optional()
})
const LocalizedModelProviderSchema = z.strictObject({
  displayName: z.string().min(1).max(128).optional(),
  models: z.record(z.string().min(1).max(256), LocalizedModelSchema).superRefine((value, context) => {
    if (Object.keys(value).length > 512) {
      context.addIssue({ code: 'custom', message: 'Provider localization supports at most 512 models' })
    }
  }).optional()
})
const LocalizedDisplayNameSchema = z.strictObject({
  displayName: z.string().min(1).max(128).optional()
})
const LocalizedAgentProfileSchema = LocalizedTitleSchema.extend({
  description: z.string().max(2048).optional()
}).strict()

function boundedLocalizationRecord<T extends z.ZodType>(
  valueSchema: T,
  maxEntries: number
) {
  return z.record(LocalIdSchema, valueSchema).superRefine((value, context) => {
    if (Object.keys(value).length > maxEntries) {
      context.addIssue({
        code: 'custom',
        message: `Localization map must contain at most ${maxEntries} entries`
      })
    }
  })
}

export const ManifestContributionLocalizationsSchema = z.strictObject({
  commands: boundedLocalizationRecord(LocalizedCommandSchema, 512).optional(),
  'views.containers': boundedLocalizationRecord(LocalizedTitleSchema, 64).optional(),
  'views.leftSidebar': boundedLocalizationRecord(LocalizedTitleSchema, 128).optional(),
  'views.rightSidebar': boundedLocalizationRecord(LocalizedTitleSchema, 128).optional(),
  'views.auxiliaryPanel': boundedLocalizationRecord(LocalizedTitleSchema, 128).optional(),
  'views.editorTab': boundedLocalizationRecord(LocalizedTitleSchema, 128).optional(),
  'views.fullPage': boundedLocalizationRecord(LocalizedTitleSchema, 128).optional(),
  'actions.topBar': boundedLocalizationRecord(LocalizedTitleSchema, 128).optional(),
  'actions.composer': boundedLocalizationRecord(LocalizedTitleSchema, 128).optional(),
  'actions.message': boundedLocalizationRecord(LocalizedTitleSchema, 128).optional(),
  'message.resultPreviews': boundedLocalizationRecord(LocalizedTitleSchema, 128).optional(),
  settings: boundedLocalizationRecord(LocalizedSettingsSchema, 64).optional(),
  notifications: boundedLocalizationRecord(LocalizedNotificationSchema, 128).optional(),
  agentProfiles: boundedLocalizationRecord(LocalizedAgentProfileSchema, 64).optional(),
  tools: boundedLocalizationRecord(LocalizedDescriptionSchema, 512).optional(),
  modelProviders: boundedLocalizationRecord(LocalizedModelProviderSchema, 64).optional(),
  authentication: boundedLocalizationRecord(LocalizedDisplayNameSchema, 64).optional()
})
export type ManifestContributionLocalizations = z.infer<
  typeof ManifestContributionLocalizationsSchema
>

export const ManifestLocalizationSchema = z.strictObject({
  displayName: z.string().min(1).max(128).optional(),
  description: z.string().max(4096).optional(),
  contributes: ManifestContributionLocalizationsSchema.optional()
})
export type ManifestLocalization = z.infer<typeof ManifestLocalizationSchema>

export const ManifestLocalizationsSchema = z
  .record(ManifestLocaleTagSchema, ManifestLocalizationSchema)
  .superRefine((value, context) => {
    const entries = Object.entries(value)
    if (entries.length > 32) {
      context.addIssue({ code: 'custom', message: 'Manifest must contain at most 32 locale overlays' })
    }
    const normalized = new Set<string>()
    for (const [locale] of entries) {
      const key = locale.toLowerCase()
      if (normalized.has(key)) {
        context.addIssue({
          code: 'custom',
          path: [locale],
          message: `Duplicate locale overlay after case normalization: ${locale}`
        })
      }
      normalized.add(key)
    }
  })
export type ManifestLocalizations = z.infer<typeof ManifestLocalizationsSchema>
