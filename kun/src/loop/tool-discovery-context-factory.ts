import type { PptWorkflowScope, ToolHostContext } from '../ports/tool-host.js'
import type { ToolTurnContextInput } from './turn-execution-types.js'
import type { InteractiveToolBridge } from './interactive-tool-bridge.js'

export type ToolDiscoveryContextFactoryDeps = {
  memoryEnabled: boolean
  allowedProviderIds?: readonly string[]
  allowedSkillIds?: readonly string[]
  allowedReadPaths?: readonly string[]
  allowedWritePaths?: readonly string[]
  allowedArtifactIds?: readonly string[]
  pptWorkflowScope?: PptWorkflowScope
  blockedProviderIds?: readonly string[]
  blockedToolNames?: readonly string[]
  blockedSkillIds?: readonly string[]
  runtimeDataDir?: string
  interactiveToolBridge: Pick<InteractiveToolBridge, 'awaitUserInput'>
}

/**
 * Build the context used only to advertise a turn's available tool schema.
 *
 * Discovery must never register an approval gate: listTools may inspect the
 * callback but must not make an approval observable. The execution context is
 * intentionally built by a separate factory, where approval side effects are
 * explicit and persisted.
 */
export function createToolDiscoveryContext(
  input: ToolTurnContextInput,
  deps: ToolDiscoveryContextFactoryDeps
): ToolHostContext {
  return {
    threadId: input.threadId,
    turnId: input.turnId,
    workspace: input.workspace,
    ...(input.orchestration ? { orchestration: input.orchestration } : {}),
    ...(input.messageSource ? { messageSource: input.messageSource } : {}),
    ...(input.subagentResume ? { subagentResume: input.subagentResume } : {}),
    ...(input.additionalWorkspaces?.length ? { additionalWorkspaces: input.additionalWorkspaces } : {}),
    ...(input.knowledgeBases?.length ? { knowledgeBases: input.knowledgeBases } : {}),
    clientSurface: input.clientSurface,
    threadMode: input.threadMode,
    ...(input.activePlanContext ? { guiPlan: input.activePlanContext } : {}),
    ...(input.guiDesignCanvas ? { guiDesignCanvas: true } : {}),
    ...(input.guiDesignMode ? { guiDesignMode: true } : {}),
    agentSurface: input.agentSurface ?? 'code',
    ...(input.guiDesignArtifact ? { guiDesignArtifact: input.guiDesignArtifact } : {}),
    ...(input.imContext ? { imContext: true } : {}),
    model: input.modelCapabilities,
    actingModelRoute: input.actingModelRoute,
    activeSkillIds: input.activeSkillIds,
    memoryPolicy: { enabled: deps.memoryEnabled },
    delegationPolicy: { enabled: false },
    ...(input.allowedToolNames ? { allowedToolNames: input.allowedToolNames } : {}),
    ...(input.extensionToolCatalogEpoch
      ? { extensionToolCatalogEpoch: input.extensionToolCatalogEpoch }
      : {}),
    ...(deps.allowedProviderIds ? { allowedProviderIds: deps.allowedProviderIds } : {}),
    ...(deps.allowedSkillIds ? { allowedSkillIds: deps.allowedSkillIds } : {}),
    ...(deps.allowedReadPaths ? { allowedReadPaths: deps.allowedReadPaths } : {}),
    ...(deps.allowedWritePaths ? { allowedWritePaths: deps.allowedWritePaths } : {}),
    ...(deps.allowedArtifactIds ? { allowedArtifactIds: deps.allowedArtifactIds } : {}),
    ...(deps.pptWorkflowScope ? { pptWorkflowScope: deps.pptWorkflowScope } : {}),
    ...(deps.blockedProviderIds ? { blockedProviderIds: deps.blockedProviderIds } : {}),
    ...(deps.blockedToolNames ? { blockedToolNames: deps.blockedToolNames } : {}),
    ...(deps.blockedSkillIds ? { blockedSkillIds: deps.blockedSkillIds } : {}),
    approvalPolicy: input.approvalPolicy,
    approvalReviewer: input.approvalReviewer,
    sandboxMode: input.sandboxMode,
    ...(deps.runtimeDataDir ? { runtimeDataDir: deps.runtimeDataDir } : {}),
    abortSignal: input.signal,
    // A tool schema lookup is not tool execution. Retain the existing inert
    // approval callback so a provider cannot create a real approval request
    // merely by enumerating its schemas.
    awaitApproval: async () => 'allow',
    ...(input.userInputDisabled
      ? {}
      : {
          awaitUserInput: (request) => deps.interactiveToolBridge.awaitUserInput({
            threadId: input.threadId,
            turnId: input.turnId,
            input: request,
            signal: input.signal
          })
        })
  }
}
