import type { WorkspaceFileReadResult, WorkspaceFileTarget } from '@shared/workspace-file'
import type { SendMessageOverrides } from '../store/chat-store-types'
import { canImplementDesignArtifact } from './design-artifact-actions'
import type { DesignArtifact } from './design-types'
import { hashDesignSystem } from './design-context'
import { parseProjectDesignMdWithOfficialLint } from './design-md/design-md-adapter'
import { PROJECT_DESIGN_MD_PATH } from './design-md/design-md-paths'
import type { DesignWorkspaceState } from './design-workspace-store-types'
import { buildImplementDesignPrompt } from './design-implement-prompt'

export type DesignCodeRoundtripWriteApi = {
  readWorkspaceFile?: (payload: WorkspaceFileTarget) => Promise<WorkspaceFileReadResult>
}

export type DesignCodeRoundtripCreateThread = (
  options: { workspaceRoot: string }
) => Promise<unknown>

export type DesignCodeRoundtripSendMessage = (
  text: string,
  mode?: string,
  overrides?: SendMessageOverrides
) => Promise<boolean>

type ImplementDesignState = Pick<
  DesignWorkspaceState,
  'publishDesignSystem' | 'designContext' | 'implementStackHint' | 'injectIntoCode'
>

export type PrepareImplementDesignTurnOptions = {
  artifact: DesignArtifact
  designState: ImplementDesignState
  workspaceRoot: string
  api?: DesignCodeRoundtripWriteApi
}

export type PrepareImplementDesignTurnResult =
  | { ok: true; prompt: string; designSystemHash?: string }
  | { ok: false; reason: 'unsupported-artifact' }

type DispatchImplementDesignState = ImplementDesignState & Pick<
  DesignWorkspaceState,
  'openImplementPanel' | 'markImplemented'
>

export type DispatchImplementDesignTurnOptions = {
  artifact: DesignArtifact
  designState: DispatchImplementDesignState
  workspaceRoot: string
  createThread: DesignCodeRoundtripCreateThread
  sendMessage: DesignCodeRoundtripSendMessage
  displayText: string
  getActiveThreadId: () => string | null
  api?: DesignCodeRoundtripWriteApi
}

export type DispatchImplementDesignTurnResult =
  | { status: 'sent'; designSystemHash?: string }
  | { status: 'unsupported-artifact' }
  | { status: 'send-failed'; designSystemHash?: string }

export function canPrepareImplementDesignTurn(
  artifact: DesignArtifact | null | undefined
): artifact is DesignArtifact & { kind: 'html' } {
  return canImplementDesignArtifact(artifact)
}

function currentWriteApi(api?: DesignCodeRoundtripWriteApi): DesignCodeRoundtripWriteApi | undefined {
  return api ?? (typeof window !== 'undefined' ? window.kunGui : undefined)
}

async function publishDesignSystemForImplementation(options: {
  workspaceRoot: string
  designState: ImplementDesignState
  api?: DesignCodeRoundtripWriteApi
}): Promise<{ relativePath?: string; hash?: string }> {
  if (!options.designState.publishDesignSystem) return {}
  const api = currentWriteApi(options.api)
  if (typeof api?.readWorkspaceFile !== 'function') return {}
  try {
    const result = await api.readWorkspaceFile({
      path: PROJECT_DESIGN_MD_PATH,
      workspaceRoot: options.workspaceRoot
    })
    if (!result.ok || !(await parseProjectDesignMdWithOfficialLint(result.content, { truncated: result.truncated })).ok) return {}
    return { relativePath: PROJECT_DESIGN_MD_PATH, hash: hashDesignSystem(result.content) }
  } catch {
    return {}
  }
}

export async function prepareImplementDesignTurn(
  options: PrepareImplementDesignTurnOptions
): Promise<PrepareImplementDesignTurnResult> {
  if (!canImplementDesignArtifact(options.artifact)) {
    return { ok: false, reason: 'unsupported-artifact' }
  }
  const designSystem = await publishDesignSystemForImplementation({
    workspaceRoot: options.workspaceRoot,
    designState: options.designState,
    api: options.api
  })
  const prompt = buildImplementDesignPrompt({
    artifactTitle: options.artifact.title,
    artifactRelativePath: options.artifact.relativePath,
    ...(designSystem.relativePath ? { designSystemRelativePath: designSystem.relativePath } : {}),
    ...(options.artifact.designMdPath ? { designNotesRelativePath: options.artifact.designMdPath } : {}),
    stackHint: options.designState.implementStackHint || undefined,
    referenceDesignSystem: options.designState.injectIntoCode,
    workspaceRoot: options.workspaceRoot,
    designContext: options.designState.designContext
  })
  return {
    ok: true,
    prompt,
    ...(designSystem.hash ? { designSystemHash: designSystem.hash } : {})
  }
}

function implementationDispatchResult(
  status: 'sent' | 'send-failed',
  designSystemHash?: string
): DispatchImplementDesignTurnResult {
  return designSystemHash ? { status, designSystemHash } : { status }
}

export async function dispatchImplementDesignTurn(
  options: DispatchImplementDesignTurnOptions
): Promise<DispatchImplementDesignTurnResult> {
  const prepared = await prepareImplementDesignTurn({
    artifact: options.artifact,
    designState: options.designState,
    workspaceRoot: options.workspaceRoot,
    api: options.api
  })
  if (!prepared.ok) return { status: 'unsupported-artifact' }

  await options.createThread({ workspaceRoot: options.workspaceRoot })
  options.designState.openImplementPanel(options.artifact.title)
  const ok = await options.sendMessage(prepared.prompt, 'agent', {
    displayText: options.displayText
  })
  if (!ok) return implementationDispatchResult('send-failed', prepared.designSystemHash)

  options.designState.markImplemented(
    options.artifact.id,
    options.getActiveThreadId() ?? '',
    prepared.designSystemHash
  )
  return implementationDispatchResult('sent', prepared.designSystemHash)
}
