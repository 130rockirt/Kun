import type {
  BrowserUseActionInput,
  BrowserUseKunApprovalGrantDraft,
  BrowserUseKunApprovalMode,
  BrowserUseToolResult
} from '../contracts/browser-use.js'

export type BrowserControllerReadiness = {
  available: boolean
  interactionRequired?: boolean
  reason?: string
}

export interface BrowserController {
  readiness(): BrowserControllerReadiness
  execute(input: {
    threadId: string
    turnId: string
    action: BrowserUseActionInput
    kunApprovalMode?: BrowserUseKunApprovalMode
    kunApprovalGrant?: BrowserUseKunApprovalGrantDraft
    signal: AbortSignal
  }): Promise<BrowserUseToolResult>
}
