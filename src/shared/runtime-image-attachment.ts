export type RuntimeImageAttachmentSource =
  | { kind: 'clipboard' }
  | { kind: 'localPath'; path: string }
  | { kind: 'base64'; dataBase64: string; mimeType: string }

export type RuntimeImageAttachmentUploadRequest = {
  source: RuntimeImageAttachmentSource
  name?: string
  threadId?: string
  workspace?: string
}

export type RuntimeImageAttachmentTextFallback = {
  dataBase64: string
  mimeType: string
  byteSize: number
  width?: number
  height?: number
  wasCompressed?: boolean
}

export type RuntimeImageAttachmentMetadata = {
  id: string
  name: string
  kind?: 'image' | 'document'
  mimeType: string
  byteSize: number
  hash: string
  width?: number
  height?: number
  documentText?: string
  documentFormat?: 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'csv' | 'json' | 'xml'
  sourceSha256?: string
  pageCount?: number
  truncated?: boolean
  localFilePath?: string
  textFallback?: RuntimeImageAttachmentTextFallback
  visualPreview?: RuntimeImageAttachmentTextFallback
  threadIds?: string[]
  workspaces?: string[]
  createdAt: string
  updatedAt: string
}

export type RuntimeImageAttachmentCompression = {
  sourceBytes: number
  outputBytes: number
  fallbackBytes: number
  wasCompressed: boolean
}

export type RuntimeImageAttachmentUploadResult =
  | {
      ok: true
      attachment: RuntimeImageAttachmentMetadata
      preview: RuntimeImageAttachmentTextFallback
      compression: RuntimeImageAttachmentCompression
    }
  | { ok: false; message: string }
