import type { ReactElement } from 'react'
import type { WorkspaceOfficePreviewResult } from '@shared/office-document'
import { WorkspaceDocxPreview } from './WorkspaceDocxPreview'
import { WorkspacePptxPreview } from './WorkspacePptxPreview'
import { WorkspaceSpreadsheetPreview } from './WorkspaceSpreadsheetPreview'

type WorkspaceOfficePreviewProps = {
  result: Extract<WorkspaceOfficePreviewResult, { ok: true }>
  loading: boolean
  refreshError?: string | null
}

export function WorkspaceOfficePreview({
  result,
  loading,
  refreshError
}: WorkspaceOfficePreviewProps): ReactElement {
  if (result.viewer === 'word') {
    return <WorkspaceDocxPreview result={result} loading={loading} refreshError={refreshError} />
  }
  if (result.viewer === 'presentation') {
    return <WorkspacePptxPreview result={result} loading={loading} refreshError={refreshError} />
  }
  return <WorkspaceSpreadsheetPreview result={result} loading={loading} refreshError={refreshError} />
}
