import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import type { WpsOfficeDocumentRef, WpsOfficeFormat, WpsOfficeSession } from '../contracts/wps-office.js'
import { WpsOfficeGatewayError } from '../contracts/wps-office.js'
import type { WpsOfficeGateway } from '../ports/wps-office.js'

const MAX_SOURCE_BYTES = 32 * 1024 * 1024
const ZIP_SIGNATURES = [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08]]
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

export type WpsOfficeServiceOptions = {
  gateway: WpsOfficeGateway
  workspaceRoot: string
  workspaceIdentity: string
}

/** Foundation-only orchestration. Mutation and local sync stay disabled until the capability gate passes. */
export class WpsOfficeService {
  constructor(private readonly options: WpsOfficeServiceOptions) {}

  async upload(path: string, signal?: AbortSignal): Promise<WpsOfficeDocumentRef> {
    const source = await this.readSource(path)
    const document = await this.options.gateway.putDocument({
      content: source.content,
      format: source.format,
      sourceSha256: source.sha256,
      workspaceIdentity: this.options.workspaceIdentity,
      relativePath: source.relativePath,
      idempotencyKey: `upload-${source.sha256}`
    }, signal)
    if (document.sourceSha256 !== source.sha256 || document.format !== source.format) {
      throw new WpsOfficeGatewayError(
        'invalid_gateway_response',
        'WPS document identity does not match the uploaded source'
      )
    }
    return document
  }

  async createSession(
    path: string,
    mode: 'read' | 'edit',
    locale?: string,
    signal?: AbortSignal
  ): Promise<{ document: WpsOfficeDocumentRef; session: WpsOfficeSession }> {
    const document = await this.upload(path, signal)
    const session = await this.options.gateway.createSession(document.documentId, {
      mode,
      ...(locale ? { locale } : {}),
      idempotencyKey: randomUUID()
    }, signal)
    if (session.fileId !== document.fileId) {
      throw new WpsOfficeGatewayError(
        'invalid_gateway_response',
        'WPS session file identity does not match the uploaded document'
      )
    }
    return { document, session }
  }

  async inspect(path: string, input: Parameters<WpsOfficeGateway['inspect']>[1], signal?: AbortSignal) {
    const document = await this.upload(path, signal)
    const inspection = await this.options.gateway.inspect(document.documentId, input, signal)
    return { document, inspection }
  }

  private async readSource(path: string) {
    const physicalWorkspaceRoot = await realpath(resolve(this.options.workspaceRoot))
    const physicalPath = await realpath(resolve(path))
    const relativePath = relative(physicalWorkspaceRoot, physicalPath).replace(/\\/g, '/')
    if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) {
      throw new Error('Office document must be physically inside the configured workspace')
    }
    const format = officeFormat(physicalPath)
    const info = await stat(physicalPath)
    if (!info.isFile() || info.size <= 0 || info.size > MAX_SOURCE_BYTES) {
      throw new Error(`Office document must be a non-empty file up to ${MAX_SOURCE_BYTES} bytes`)
    }
    const content = new Uint8Array(await readFile(physicalPath))
    validateOfficeHeader(content, format)
    return { relativePath, format, content, sha256: sha256(content) }
  }
}

export function validateOfficeHeader(content: Uint8Array, format: WpsOfficeFormat): void {
  const header = Array.from(content.subarray(0, 8))
  const expected = format === 'docx' || format === 'xlsx' || format === 'pptx'
    ? ZIP_SIGNATURES
    : [OLE_SIGNATURE]
  if (!expected.some((signature) => signature.every((byte, index) => header[index] === byte))) {
    throw new Error(`Office content does not match .${format}`)
  }
}

function officeFormat(path: string): WpsOfficeFormat {
  const extension = extname(path).slice(1).toLowerCase()
  if (extension === 'doc' || extension === 'docx' || extension === 'xls' || extension === 'xlsx' || extension === 'ppt' || extension === 'pptx') return extension
  throw new Error('Unsupported Office document type')
}
function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}
