import {
  ComposerContextAttachmentSchema,
  type ComposerContextAttachment
} from '@kun/extension-api'
import type { WorkspacePresentationViewReference } from '@shared/office-document'

export const OFFICE_VIEW_POSITION_CONTEXT_KIND = 'office-view-position'

export type WorkspaceOfficeViewPosition = Omit<WorkspacePresentationViewReference, 'path'>

type OfficeViewPositionReference = Pick<
  WorkspaceOfficeViewPosition,
  'sourceName' | 'sourceFormat' | 'sourceSha256'
> & {
  kind: typeof OFFICE_VIEW_POSITION_CONTEXT_KIND
  schemaVersion: 1
  location: {
    kind: 'presentation'
    slide: number
    slideCount: number
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function cleanView(view: WorkspacePresentationViewReference): WorkspaceOfficeViewPosition {
  const { path: _path, ...pathFreeView } = view
  return pathFreeView
}

export async function createWorkspaceOfficeViewPositionAttachment(input: {
  workspaceRoot: string
  view: WorkspacePresentationViewReference
  now?: number
}): Promise<ComposerContextAttachment> {
  const view = cleanView(input.view)
  const reference: OfficeViewPositionReference = {
    kind: OFFICE_VIEW_POSITION_CONTEXT_KIND,
    schemaVersion: 1,
    sourceName: view.sourceName,
    sourceFormat: view.sourceFormat,
    sourceSha256: view.sourceSha256,
    location: {
      kind: 'presentation',
      slide: view.slide,
      slideCount: view.slideCount
    }
  }
  if (!validReference(reference)) {
    throw new Error('Invalid workspace presentation view reference')
  }
  const workspaceId = await sha256Hex(input.workspaceRoot.trim() || '__default__')
  const identity = await sha256Hex(JSON.stringify({ workspaceId, view }))
  return ComposerContextAttachmentSchema.parse({
    schemaVersion: 1,
    id: `office-view-${identity.slice(0, 24)}`,
    title: view.sourceName.trim().slice(0, 128),
    summary: `Current view · Slide ${view.slide} of ${view.slideCount}`,
    reference,
    revision: Math.max(0, Math.floor(input.now ?? Date.now())),
    generation: 0,
    attachmentId: `workspace-view-context:${identity}`,
    provenance: { source: 'workspace-view', workspaceId }
  })
}

function validReference(value: unknown): value is OfficeViewPositionReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const reference = value as Record<string, unknown>
  return (
    reference.kind === OFFICE_VIEW_POSITION_CONTEXT_KIND &&
    reference.schemaVersion === 1 &&
    typeof reference.sourceName === 'string' &&
    reference.sourceName.trim().length > 0 &&
    (reference.sourceFormat === 'ppt' || reference.sourceFormat === 'pptx') &&
    typeof reference.sourceSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(reference.sourceSha256) &&
    reference.location !== null &&
    typeof reference.location === 'object' &&
    !Array.isArray(reference.location) &&
    (reference.location as Record<string, unknown>).kind === 'presentation' &&
    typeof (reference.location as Record<string, unknown>).slide === 'number' &&
    Number.isSafeInteger((reference.location as Record<string, unknown>).slide) &&
    typeof (reference.location as Record<string, unknown>).slideCount === 'number' &&
    Number.isSafeInteger((reference.location as Record<string, unknown>).slideCount) &&
    ((reference.location as Record<string, unknown>).slide as number) >= 1 &&
    ((reference.location as Record<string, unknown>).slideCount as number) >=
      ((reference.location as Record<string, unknown>).slide as number)
  )
}

export function isWorkspaceOfficeViewPositionAttachment(
  attachment: ComposerContextAttachment
): boolean {
  const parsed = ComposerContextAttachmentSchema.safeParse(attachment)
  if (!parsed.success) return false
  const trusted = parsed.data
  return (
    'source' in trusted.provenance &&
    trusted.provenance.source === 'workspace-view' &&
    trusted.attachmentId.startsWith('workspace-view-context:') &&
    validReference(trusted.reference)
  )
}

export function readWorkspaceOfficeViewPosition(
  attachment: ComposerContextAttachment
): WorkspaceOfficeViewPosition | null {
  if (!isWorkspaceOfficeViewPositionAttachment(attachment)) return null
  const reference = attachment.reference as OfficeViewPositionReference
  return {
    kind: 'presentation',
    sourceName: reference.sourceName,
    sourceFormat: reference.sourceFormat,
    sourceSha256: reference.sourceSha256,
    slide: reference.location.slide,
    slideCount: reference.location.slideCount
  }
}
