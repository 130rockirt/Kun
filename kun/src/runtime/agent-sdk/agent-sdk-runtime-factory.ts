import { AgentSdkRuntime, type SdkRuntimeDeps } from './agent-sdk-runtime.js'
import type { SdkApi } from './sdk-protocol.js'
import { createAgentSdkFactoryContext } from './agent-sdk-runtime-factory-context.js'
import type { AgentSdkRuntimeFactoryDeps } from './agent-sdk-runtime-factory-contracts.js'
import { createAgentSdkTurnRuntimeDeps } from './agent-sdk-runtime-factory-turn.js'
import { createAgentSdkToolRuntimeDeps } from './agent-sdk-runtime-factory-tools.js'
import { createAgentSdkLifecycleRuntimeDeps } from './agent-sdk-runtime-factory-lifecycle.js'

export type { AgentSdkRuntimeFactoryDeps } from './agent-sdk-runtime-factory-contracts.js'
export { resolveTurnPlanContext, waitForGate } from './agent-sdk-runtime-factory-plan.js'

let sdkPromise: Promise<SdkApi> | undefined
function loadAgentSdk(): Promise<SdkApi> {
  if (!sdkPromise) {
    const specifier = '@anthropic-ai/claude-agent-sdk'
    sdkPromise = import(specifier as string).then((mod) => mod as unknown as SdkApi)
  }
  return sdkPromise
}

/**
 * Resolve the plan-tool context for a turn. When the turn carries a (non-stale)
 * GUI plan — the SDD "下一步"/Plan-mode flow — we must expose it so the kun
 * `create_plan` tool is BOTH advertised to the model and executable: its
 * `shouldAdvertise` and executor are gated on `guiPlan`/`threadMode === 'plan'`
 * (create-plan-tool.ts). Without this the model is told to call create_plan but
 * the tool was never bridged, so it writes the plan as prose and the GUI reports
 * "no matching create_plan result". Mirrors the native loop's candidate/stale
 * derivation (agent-loop.ts).
 */

export function createAgentSdkRuntime(deps: AgentSdkRuntimeFactoryDeps): AgentSdkRuntime {
  const context = createAgentSdkFactoryContext(deps)
  const runtimeDeps: SdkRuntimeDeps = {
    ...createAgentSdkTurnRuntimeDeps(deps, context),
    ...createAgentSdkToolRuntimeDeps(deps, context),
    ...createAgentSdkLifecycleRuntimeDeps(deps, context, loadAgentSdk)
  }
  return new AgentSdkRuntime(runtimeDeps)
}
