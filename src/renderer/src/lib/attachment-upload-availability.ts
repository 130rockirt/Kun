export type AttachmentUploadAvailabilityInput = {
  runtimeConnection: string
  route: string
  mode: 'plan' | 'agent'
  attachmentStoreAvailable?: boolean
  modelSupportsImageInput?: boolean
}

export function isChatAttachmentUploadEnabled(input: AttachmentUploadAvailabilityInput): boolean {
  return (
    input.runtimeConnection === 'ready' &&
    (input.route === 'chat' || input.route === 'write' || input.route === 'design') &&
    (input.mode === 'agent' || input.mode === 'plan') &&
    input.attachmentStoreAvailable === true
  )
}
