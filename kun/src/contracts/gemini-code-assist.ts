import { z } from 'zod'

/**
 * Runtime-only Google OAuth material for Gemini Code Assist.
 *
 * The serialized form is stored through Kun's protected credential account
 * store. It is never written into the GUI-managed runtime config.
 */
export const GeminiCodeAssistCredentialSchema = z.object({
  kind: z.literal('gemini-oauth'),
  accessToken: z.string().min(1),
  refreshToken: z.string().default(''),
  expiresAt: z.number().int().nonnegative(),
  projectId: z.string().min(1),
  userTier: z.string().min(1).optional(),
  userTierName: z.string().min(1).optional(),
  email: z.string().min(1).optional()
}).strict()

export type GeminiCodeAssistCredential = z.infer<typeof GeminiCodeAssistCredentialSchema>
