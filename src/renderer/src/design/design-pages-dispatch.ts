import { runDesignPages, type RunDesignPagesDeps } from './design-pages-run'
import type { DesignWorkspaceState } from './design-workspace-store-types'

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
  labels?: RunDesignPagesDeps['labels']
  reasoningEffort?: string
  serviceTier?: 'priority'
  expectedThreadId?: string
  onFirstSendSettled?: RunDesignPagesDeps['onFirstSendSettled']
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
  labels,
  reasoningEffort,
  serviceTier,
  expectedThreadId,
  onFirstSendSettled
}: DesignPagesDispatchOptions): RunDesignPagesDeps {
  const model = promptState.assistantModel.trim()
  const providerId = promptState.assistantProviderId.trim() || resolveProviderId(model)
  return {
    brief,
    workspaceRoot,
    sendMessage,
    ...(model ? { model } : {}),
    ...(providerId ? { providerId } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(expectedThreadId ? { expectedThreadId } : {}),
    ...(promptState.generationPrompt ? { generationPrompt: promptState.generationPrompt } : {}),
    designContext: promptState.designContext,
    ...(labels ? { labels } : {}),
    ...(onFirstSendSettled ? { onFirstSendSettled } : {})
  }
}

export async function runDesignPagesDispatch(options: DesignPagesDispatchOptions): Promise<void> {
  const runPages = options.runPages ?? runDesignPages
  await runPages(buildDesignPagesRunOptions(options))
}
