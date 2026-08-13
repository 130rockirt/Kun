import type { ReactElement } from 'react'
import type {
  WorkspaceOfficePreviewResult,
  WorkspaceOfficeSelection,
  WorkspacePresentationViewReference,
  WorkspacePresentationViewSource
} from '@shared/office-document'
import { WorkspaceDocxPreview } from './WorkspaceDocxPreview'
import { WorkspacePptxPreview } from './WorkspacePptxPreview'
import { WorkspaceSpreadsheetPreview } from './WorkspaceSpreadsheetPreview'
import type { WorkspaceDocumentQuoteDraft } from '../lib/workspace-document-quote'

type WorkspaceOfficePreviewProps = {
  result: Extract<WorkspaceOfficePreviewResult, { ok: true }>
  loading: boolean
  refreshError?: string | null
  onSelectionChange?: (selection: WorkspaceOfficeSelection) => void
  onQuoteSelection?: (draft: WorkspaceDocumentQuoteDraft) => Promise<boolean> | boolean
  onPresentationViewChange?: (
    view: WorkspacePresentationViewReference | null,
    source: WorkspacePresentationViewSource
  ) => void
  presentationKeyboardActive?: boolean
}

export function WorkspaceOfficePreview({
  result,
  loading,
  refreshError,
  onSelectionChange,
  onQuoteSelection,
  onPresentationViewChange,
  presentationKeyboardActive = true
}: WorkspaceOfficePreviewProps): ReactElement {
  if (result.viewer === 'word') {
    return <WorkspaceDocxPreview result={result} loading={loading} refreshError={refreshError} onSelectionChange={onSelectionChange} onQuoteSelection={onQuoteSelection} />
  }
  if (result.viewer === 'presentation') {
    return (
      <WorkspacePptxPreview
        result={result}
        loading={loading}
        refreshError={refreshError}
        onSelectionChange={onSelectionChange}
        onPresentationViewChange={onPresentationViewChange}
        keyboardActive={presentationKeyboardActive}
      />
    )
  }
  return <WorkspaceSpreadsheetPreview result={result} loading={loading} refreshError={refreshError} onSelectionChange={onSelectionChange} />
}
