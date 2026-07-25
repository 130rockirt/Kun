import type {
  CoreAttachmentMetadataJson,
  CoreAttachmentTextFallbackJson
} from '../agent/kun-contract'
import { getProvider } from '../agent/registry'
import type { AgentProvider } from '../agent/types'

export type RuntimeAttachmentUploadInput = {
  name: string
  mimeType?: string
  dataBase64: string
  documentText?: string
  documentFormat?: 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'csv' | 'json' | 'xml'
  sourceSha256?: string
  pageCount?: number
  localFilePath?: string
  textFallback?: CoreAttachmentTextFallbackJson
  visualPreview?: CoreAttachmentTextFallbackJson
  threadId?: string
  workspace?: string
}

/**
 * Generic runtime attachment entry point. Image callers remain compatible
 * with the dedicated desktop image pipeline inside the provider, while
 * documents use the same authenticated attachment-store contract.
 */
export async function uploadRuntimeAttachment(
  input: RuntimeAttachmentUploadInput,
  provider: AgentProvider = getProvider()
): Promise<CoreAttachmentMetadataJson> {
  if (typeof provider.uploadAttachment !== 'function') {
    throw new Error('Runtime attachment upload is unavailable.')
  }
  return provider.uploadAttachment(input)
}
