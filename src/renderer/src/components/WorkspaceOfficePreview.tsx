import type { ReactElement } from 'react'
import type {
  OfficeSessionDescriptor,
  WorkspaceOfficePreviewResult,
  WorkspaceOfficeSelection,
  WorkspacePresentationViewReference,
  WorkspacePresentationViewSource
} from '@shared/office-document'
import { WorkspaceDocxPreview } from './WorkspaceDocxPreview'
import { WorkspacePptxPreview } from './WorkspacePptxPreview'
import { WorkspaceSpreadsheetPreview } from './WorkspaceSpreadsheetPreview'
import { WpsOfficeEditor, type WpsOfficeSdkBridge } from './WpsOfficeEditor'
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
  providerMode?: 'local' | 'wps'
  wpsSession?: OfficeSessionDescriptor | null
  wpsSdk?: WpsOfficeSdkBridge
  wpsReadOnly?: boolean
}

export function WorkspaceOfficePreview({
  result,
  loading,
  refreshError,
  onSelectionChange,
  onQuoteSelection,
  onPresentationViewChange,
  presentationKeyboardActive = true,
  providerMode = 'local',
  wpsSession,
  wpsSdk,
  wpsReadOnly = true
}: WorkspaceOfficePreviewProps): ReactElement {
  if (providerMode === 'wps') {
    return (
      <WpsOfficeEditor
        result={result}
        session={wpsSession}
        sdk={wpsSdk}
        loading={loading}
        error={refreshError}
        readOnly={wpsReadOnly}
        onSelectionChange={onSelectionChange}
      />
    )
  }
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
