import type { ReactElement } from 'react'
import type { WorkspaceOfficePreviewResult, WorkspaceOfficeSelection } from '@shared/office-document'
import { WorkspaceDocxPreview } from './WorkspaceDocxPreview'
import { WorkspacePptxPreview } from './WorkspacePptxPreview'
import { WorkspaceSpreadsheetPreview } from './WorkspaceSpreadsheetPreview'

type WorkspaceOfficePreviewProps = {
  result: Extract<WorkspaceOfficePreviewResult, { ok: true }>
  loading: boolean
  refreshError?: string | null
  onSelectionChange?: (selection: WorkspaceOfficeSelection) => void
}

export function WorkspaceOfficePreview({
  result,
  loading,
  refreshError,
  onSelectionChange
}: WorkspaceOfficePreviewProps): ReactElement {
  if (result.viewer === 'word') {
    return <WorkspaceDocxPreview result={result} loading={loading} refreshError={refreshError} onSelectionChange={onSelectionChange} />
  }
  if (result.viewer === 'presentation') {
    return <WorkspacePptxPreview result={result} loading={loading} refreshError={refreshError} onSelectionChange={onSelectionChange} />
  }
  return <WorkspaceSpreadsheetPreview result={result} loading={loading} refreshError={refreshError} onSelectionChange={onSelectionChange} />
}
