import type { DesignArtifact } from '../design-types'
import type { DesignWorkspaceState } from '../design-workspace-store-types'
import { projectActiveDoc } from './helpers'

export type SvgPrepareContext = {
  workspaceRoot: string
  documentId: string
}

export function assertSvgPrepareContext(
  get: () => DesignWorkspaceState,
  context: SvgPrepareContext
): DesignWorkspaceState {
  const state = get()
  if (
    state.workspaceRoot !== context.workspaceRoot ||
    state.activeDocumentId !== context.documentId ||
    !state.documents.some((document) => document.id === context.documentId)
  ) {
    throw new Error('SVG preparation was cancelled because the active workspace or drawing changed.')
  }
  return state
}

function applyToDocument(
  state: DesignWorkspaceState,
  documentId: string,
  nextArtifacts: (artifacts: DesignArtifact[]) => DesignArtifact[],
  nextActiveArtifactId?: string | null
): Partial<DesignWorkspaceState> {
  const index = state.documents.findIndex((document) => document.id === documentId)
  if (index < 0) return {}
  const document = state.documents[index]
  const artifacts = nextArtifacts(document.artifacts)
  const nextDocument = {
    ...document,
    artifacts,
    activeArtifactId: nextActiveArtifactId !== undefined
      ? nextActiveArtifactId
      : document.activeArtifactId,
    updatedAt: new Date().toISOString()
  }
  const documents = state.documents.map((candidate, candidateIndex) =>
    candidateIndex === index ? nextDocument : candidate
  )
  return state.activeDocumentId === documentId
    ? { documents, ...projectActiveDoc(documents, documentId) }
    : { documents }
}

export function applyToContextDocument(
  state: DesignWorkspaceState,
  context: SvgPrepareContext,
  nextArtifacts: (artifacts: DesignArtifact[]) => DesignArtifact[],
  nextActiveArtifactId?: string | null
): Partial<DesignWorkspaceState> {
  if (state.workspaceRoot !== context.workspaceRoot) return {}
  return applyToDocument(state, context.documentId, nextArtifacts, nextActiveArtifactId)
}
