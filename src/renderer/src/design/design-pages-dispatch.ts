import { runDesignPages, type RunDesignPagesDeps } from './design-pages-run'
import type { DesignWorkspaceState } from './design-workspace-store-types'
import type {
  DesignDocumentTarget,
  DesignTaskProfileInput
} from '../agent/design-task-profile'
import { designContextFromTaskProfile } from './design-task-profile-input'

export type DesignPagesPromptState = Pick<
  DesignWorkspaceState,
  'assistantModel' | 'assistantProviderId' | 'generationPrompt' | 'designContext'
>

export type DesignPagesRunLabels = NonNullable<RunDesignPagesDeps['labels']>

export type DesignPagesTranslate = (
  key: string,
  options?: Record<string, string | number>
) => string

export type DesignPagesRunInvoker = (deps: RunDesignPagesDeps) => Promise<void>

export type DesignPagesDispatchOptions = {
  brief: string
  workspaceRoot: string
  sendMessage: RunDesignPagesDeps['sendMessage']
  promptState: DesignPagesPromptState
  resolveProviderId: (model: string) => string
  model?: string
  providerId?: string
  labels?: RunDesignPagesDeps['labels']
  reasoningEffort?: string
  serviceTier?: 'priority'
  expectedThreadId?: string
  designProfile?: DesignTaskProfileInput
  designDocumentTarget?: DesignDocumentTarget
  waitForRuntimeAdmission?: boolean
  onFirstSendSettled?: RunDesignPagesDeps['onFirstSendSettled']
  onFirstSendStarting?: RunDesignPagesDeps['onFirstSendStarting']
  runPages?: DesignPagesRunInvoker
}

export function buildDesignPagesRunLabels(t: DesignPagesTranslate): DesignPagesRunLabels {
  return {
    plan: (brief) => t('designPagesPlanDisplay', { brief }),
    page: (title, index, total) => t('designPagesPageDisplay', { title, index, total }),
    foundationStep: (step) =>
      t(
        step === 'spec'
          ? 'designFoundationStepSpec'
          : step === 'system'
            ? 'designFoundationStepSystem'
            : 'designFoundationStepLogo'
      ),
    specDisplay: (brief) => t('designFoundationSpecDisplay', { brief }),
    systemDisplay: () => t('designFoundationSystemDisplay'),
    logoDisplay: () => t('designFoundationLogoDisplay'),
    systemTitle: () => t('designFoundationSystemTitle'),
    logoTitle: () => t('designFoundationLogoTitle')
  }
}

export function buildDesignPagesRunOptions({
  brief,
  workspaceRoot,
  sendMessage,
  promptState,
  resolveProviderId,
  model: selectedModel,
  providerId: selectedProviderId,
  labels,
  reasoningEffort,
  serviceTier,
  expectedThreadId,
  designProfile,
  designDocumentTarget,
  waitForRuntimeAdmission,
  onFirstSendSettled,
  onFirstSendStarting
}: DesignPagesDispatchOptions): RunDesignPagesDeps {
  const model = selectedModel?.trim() || promptState.assistantModel.trim()
  const providerId = selectedProviderId?.trim() ||
    promptState.assistantProviderId.trim() ||
    resolveProviderId(model)
  const designContext = designProfile
    ? designContextFromTaskProfile(designProfile)
    : promptState.designContext
  return {
    brief,
    workspaceRoot,
    sendMessage,
    ...(model ? { model } : {}),
    ...(providerId ? { providerId } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(expectedThreadId ? { expectedThreadId } : {}),
    ...(designProfile ? { designProfile } : {}),
    ...(designDocumentTarget ? { designDocumentTarget } : {}),
    ...(waitForRuntimeAdmission ? { waitForRuntimeAdmission: true } : {}),
    ...(!designProfile && promptState.generationPrompt
      ? { generationPrompt: promptState.generationPrompt }
      : {}),
    designContext,
    ...(labels ? { labels } : {}),
    ...(onFirstSendSettled ? { onFirstSendSettled } : {}),
    ...(onFirstSendStarting ? { onFirstSendStarting } : {})
  }
}

export async function runDesignPagesDispatch(options: DesignPagesDispatchOptions): Promise<void> {
  const runPages = options.runPages ?? runDesignPages
  await runPages(buildDesignPagesRunOptions(options))
}
