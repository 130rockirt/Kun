import type { WorkspacePresentationViewReference } from '@shared/office-document'
import { writeDocumentKey } from './write-editor-layout'
import type {
  WriteEditorGroupId,
  WriteWorkspaceGet,
  WriteWorkspaceSet,
  WriteWorkspaceState
} from './write-workspace-store-types'

type PresentationViewSource = Pick<
  WorkspacePresentationViewReference,
  'path' | 'sourceSha256'
>

type PresentationViewState = Pick<
  WriteWorkspaceState,
  'documentsByPath' | 'editorLayout' | 'presentationViewByGroup'
>

type PresentationViewActions = Pick<
  WriteWorkspaceState,
  'clearPresentationViewForGroup' | 'setPresentationViewForGroup'
>

export function selectFocusedPresentationView(
  state: PresentationViewState
): WorkspacePresentationViewReference | null {
  const groupId = state.editorLayout.focusedGroupId
  const view = state.presentationViewByGroup[groupId]
  return view && presentationViewMatchesGroupSource(state, groupId, view) ? view : null
}

export function createWritePresentationViewActions(
  set: WriteWorkspaceSet,
  get: WriteWorkspaceGet
): PresentationViewActions {
  return {
    setPresentationViewForGroup: (groupId, view) => {
      const state = get()
      if (!presentationViewMatchesGroupSource(state, groupId, view)) return
      const normalizedView = { ...view, path: writeDocumentKey(view.path) }
      const previous = state.presentationViewByGroup[groupId]
      if (previous && presentationViewsEqual(previous, normalizedView)) return
      set({
        presentationViewByGroup: {
          ...state.presentationViewByGroup,
          [groupId]: normalizedView
        }
      })
    },

    clearPresentationViewForGroup: (groupId, source) => {
      const state = get()
      const current = state.presentationViewByGroup[groupId]
      if (!current || !presentationSourceMatches(current, source)) return
      const presentationViewByGroup = { ...state.presentationViewByGroup }
      delete presentationViewByGroup[groupId]
      set({ presentationViewByGroup })
    }
  }
}

function presentationViewMatchesGroupSource(
  state: PresentationViewState,
  groupId: WriteEditorGroupId,
  view: WorkspacePresentationViewReference
): boolean {
  if (!validPresentationCoordinates(view)) return false
  const group = state.editorLayout.groups.find((candidate) => candidate.id === groupId)
  if (!group?.activePath || writeDocumentKey(group.activePath) !== writeDocumentKey(view.path)) return false
  const document = state.documentsByPath[writeDocumentKey(group.activePath)]
  const preview = document?.kind === 'office' ? document.officePreview : null
  return Boolean(
    preview &&
    preview.viewer === 'presentation' &&
    writeDocumentKey(preview.path) === writeDocumentKey(view.path) &&
    preview.name === view.sourceName &&
    preview.sourceFormat === view.sourceFormat &&
    preview.sourceSha256 === view.sourceSha256
  )
}

function validPresentationCoordinates(view: WorkspacePresentationViewReference): boolean {
  return view.kind === 'presentation' &&
    Number.isInteger(view.slide) &&
    Number.isInteger(view.slideCount) &&
    view.slideCount >= 1 &&
    view.slide >= 1 &&
    view.slide <= view.slideCount
}

function presentationSourceMatches(
  view: WorkspacePresentationViewReference,
  source: PresentationViewSource
): boolean {
  return writeDocumentKey(view.path) === writeDocumentKey(source.path) &&
    view.sourceSha256 === source.sourceSha256
}

function presentationViewsEqual(
  left: WorkspacePresentationViewReference,
  right: WorkspacePresentationViewReference
): boolean {
  return left.kind === right.kind &&
    left.path === right.path &&
    left.sourceName === right.sourceName &&
    left.sourceFormat === right.sourceFormat &&
    left.sourceSha256 === right.sourceSha256 &&
    left.slide === right.slide &&
    left.slideCount === right.slideCount
}
