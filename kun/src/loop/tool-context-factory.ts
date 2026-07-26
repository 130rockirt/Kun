import type { ArtifactStore } from '../artifacts/artifact-store.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import type { ToolDispatchInput } from './turn-execution-types.js'
import type { InteractiveToolBridge } from './interactive-tool-bridge.js'

export type ToolExecutionContextFactoryDeps = {
  memoryEnabled: boolean
  allowedProviderIds?: readonly string[]
  allowedSkillIds?: readonly string[]
  allowedReadPaths?: readonly string[]
  allowedWritePaths?: readonly string[]
  allowedArtifactIds?: readonly string[]
  blockedProviderIds?: readonly string[]
  blockedToolNames?: readonly string[]
  blockedSkillIds?: readonly string[]
  runtimeDataDir?: string
  artifactStore?: ArtifactStore
  interactiveToolBridge: Pick<InteractiveToolBridge, 'awaitApproval' | 'awaitUserInput'>
}

/**
 * Build the execution-only context for a persisted tool call. Discovery keeps
 * its own context because it deliberately has no real approval side effect.
 */
export function createToolExecutionContext(
  input: ToolDispatchInput,
  deps: ToolExecutionContextFactoryDeps
): ToolHostContext {
  return {
    threadId: input.threadId,
    turnId: input.turnId,
    workspace: input.workspace,
    ...(input.orchestration ? { orchestration: input.orchestration } : {}),
    ...(input.messageSource ? { messageSource: input.messageSource } : {}),
    threadMode: input.threadMode,
    ...(input.activePlanContext ? { guiPlan: input.activePlanContext } : {}),
    ...(input.guiDesignCanvas ? { guiDesignCanvas: true } : {}),
    ...(input.guiDesignMode ? { guiDesignMode: true } : {}),
    agentSurface: input.agentSurface ?? 'code',
    ...(input.guiDesignArtifact ? { guiDesignArtifact: input.guiDesignArtifact } : {}),
    ...(input.imContext ? { imContext: true } : {}),
    model: input.modelCapabilities,
    ...(input.modelProviderId ? { modelProviderId: input.modelProviderId } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
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
    ...(deps.blockedProviderIds ? { blockedProviderIds: deps.blockedProviderIds } : {}),
    ...(deps.blockedToolNames ? { blockedToolNames: deps.blockedToolNames } : {}),
    ...(deps.blockedSkillIds ? { blockedSkillIds: deps.blockedSkillIds } : {}),
    approvalPolicy: input.approvalPolicy,
    sandboxMode: input.sandboxMode,
    ...(deps.runtimeDataDir ? { runtimeDataDir: deps.runtimeDataDir } : {}),
    ...(deps.artifactStore ? { artifactStore: deps.artifactStore } : {}),
    abortSignal: input.signal,
    awaitApproval: (approval) => deps.interactiveToolBridge.awaitApproval({
      approval,
      approvalPolicy: input.approvalPolicy,
      sandboxMode: input.sandboxMode,
      signal: input.signal
    }),
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
