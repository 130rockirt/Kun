import type {
  WpsOfficeDocumentRef,
  WpsOfficeFormat,
  WpsOfficeInspectRequest,
  WpsOfficeInspectResponse,
  WpsOfficeOperation,
  WpsOfficeRenderResponse,
  WpsOfficeSession,
  WpsOfficeVersion
} from '../contracts/wps-office.js'

export type WpsOfficeUpload = {
  content: Uint8Array
  format: WpsOfficeFormat
  sourceSha256: string
  workspaceIdentity: string
  relativePath: string
  idempotencyKey: string
}

export interface WpsOfficeGateway {
  putDocument(input: WpsOfficeUpload, signal?: AbortSignal): Promise<WpsOfficeDocumentRef>
  createSession(
    documentId: string,
    input: { mode: 'read' | 'edit'; locale?: string; idempotencyKey: string },
    signal?: AbortSignal
  ): Promise<WpsOfficeSession>
  inspect(
    documentId: string,
    input: WpsOfficeInspectRequest,
    signal?: AbortSignal
  ): Promise<WpsOfficeInspectResponse>
  applyOperations(
    documentId: string,
    input: {
      expectedVersion: string
      operations: WpsOfficeOperation[]
      idempotencyKey: string
    },
    signal?: AbortSignal
  ): Promise<WpsOfficeVersion>
  render(
    documentId: string,
    input: { page?: number; sheet?: string; range?: string },
    signal?: AbortSignal
  ): Promise<WpsOfficeRenderResponse>
  download(documentId: string, version: string, signal?: AbortSignal): Promise<Uint8Array>
  delete(documentId: string, idempotencyKey: string, signal?: AbortSignal): Promise<void>
}
