import { AgentLoopExecution } from './agent-loop-execution.js'

export type { AgentLoopOptions } from './agent-loop-options.js'
export {
  PLAN_MODE_INSTRUCTION,
  isPlanClarifyingQuestion,
  isStalePlanContext,
  resolvePlanModeToolSpecs,
  turnHasUnverifiedSourceChanges
} from './plan-mode.js'
export {
  buildRuntimeContextInstruction,
  shouldInjectInitialRuntimeContext
} from './runtime-context.js'
export {
  svgArtifactCompletionState,
  type SvgArtifactCompletionState
} from './svg-artifact-completion.js'
export { canUpgradeThreadTitle } from './thread-title-policy.js'
export { memoryInstructions } from './memory-instructions.js'
export {
  goalContinuationInstruction,
  todoContinuationInstruction
} from './continuation-instructions.js'

export class AgentLoop extends AgentLoopExecution {}
