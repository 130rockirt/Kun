import type {
  BrowserUseActionInput,
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
    signal: AbortSignal
  }): Promise<BrowserUseToolResult>
}
