import {
  ComposerContextAttachmentSchema,
  type ComposerContextAttachment,
  type JsonObject
} from '@kun/extension-api'

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function createDevPreviewComposerContextAttachment(input: {
  workspaceRoot: string
  threadId: string
  kind: 'element' | 'issue'
  title: string
  summary: string
  reference: JsonObject
  now?: number
}): Promise<ComposerContextAttachment> {
  const workspaceId = await sha256Hex(input.workspaceRoot.trim() || '__default__')
  const identity = await sha256Hex(JSON.stringify({
    workspaceId,
    threadId: input.threadId,
    kind: input.kind,
    reference: input.reference
  }))
  return ComposerContextAttachmentSchema.parse({
    schemaVersion: 1,
    id: `preview-${input.kind}-${identity.slice(0, 24)}`,
    title: input.title.trim().slice(0, 128),
    summary: input.summary.trim().slice(0, 1_024) || input.title.trim().slice(0, 128),
    reference: input.reference,
    revision: Math.max(0, Math.floor(input.now ?? Date.now())),
    generation: 0,
    attachmentId: `dev-preview-context:${identity}`,
    provenance: {
      source: 'dev-preview',
      workspaceId
    }
  })
}

