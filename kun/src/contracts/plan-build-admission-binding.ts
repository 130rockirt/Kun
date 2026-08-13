import { z } from 'zod'

/**
 * Host-only CAS backfill for legacy plan-build threads that were persisted
 * with `planBuildRunId` but lost the admission binding during a cross-runtime
 * write. The raw capability is hashed before persistence exactly like the
 * fork path; it is never stored.
 */
export const BackfillPlanBuildAdmissionBindingRequest = z
  .object({
    planBuildRunId: z.string().trim().min(1).max(160)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    expectedWorkspace: z.string().trim().min(1).max(4096),
    planBuildAdmissionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    planBuildAdmissionCapability: z.string().trim().regex(/^[A-Za-z0-9_-]{43,128}$/)
  })
  .strict()
  .refine((value) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value.expectedWorkspace), {
    message: 'expected workspace must be absolute'
  })
export type BackfillPlanBuildAdmissionBindingRequest = z.infer<
  typeof BackfillPlanBuildAdmissionBindingRequest
>
