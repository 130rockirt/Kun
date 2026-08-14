import type { ToolBlock } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'
import { useDesignWorkspaceStore } from '../design-workspace-store'
import {
  extractCanvasAgentExportRequest,
  type CanvasAgentExportRequestHandler,
  type CanvasAgentExportResult
} from './canvas-export'
import { sendCanvasTurnReceipt } from './canvas-receipt-sender'

type CanvasExportReceiptContext = {
  threadId?: string | null
  turnId?: string | null
}

function receiptKeyFromExport(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const receiptKey = (value as Record<string, unknown>).receiptKey
  return typeof receiptKey === 'string' && receiptKey.trim() ? receiptKey.trim() : undefined
}

function sendCanvasExportReceipt(
  context: CanvasExportReceiptContext | undefined,
  receiptKey: string | undefined,
  result: CanvasAgentExportResult | null,
  error?: string
): void {
  const threadId = context?.threadId?.trim()
  const turnId = context?.turnId?.trim()
  if (!threadId || !turnId || !receiptKey) return
  sendCanvasTurnReceipt({
    threadId,
    turnId,
    receiptKey,
    affectedIds: [],
    errors: error ? [{ code: 'CANVAS_EXPORT_FAILED', message: error }] : [],
    ...(result
      ? {
          generatedFiles: [{
            name: result.name,
            relativePath: result.relativePath,
            ...(result.absolutePath ? { absolutePath: result.absolutePath } : {}),
            mimeType: result.mimeType,
            byteSize: result.byteSize
          }]
        }
      : {})
  })
}

function publishCanvasExportResult(blockId: string, result: CanvasAgentExportResult): void {
  useChatStore.setState((state) => ({
    blocks: state.blocks.map((block) => {
      if (block.kind !== 'tool' || block.id !== blockId) return block
      const current = Array.isArray(block.meta?.generatedFiles)
        ? block.meta.generatedFiles.filter((candidate) => {
            if (!candidate || typeof candidate !== 'object') return false
            return (candidate as { relativePath?: unknown }).relativePath !== result.relativePath
          })
        : []
      return {
        ...block,
        meta: { ...block.meta, generatedFiles: [...current, result] }
      }
    })
  }))
}

function failCanvasExportToolBlock(blockId: string, message: string): void {
  useDesignWorkspaceStore.getState().setFileError(message)
  useChatStore.setState((state) => ({
    blocks: state.blocks.map((block) =>
      block.kind === 'tool' && block.id === blockId
        ? {
            ...block,
            status: 'error' as const,
            summary: 'Whiteboard export failed',
            detail: message,
            meta: { ...block.meta, generatedFiles: [], canvasExportError: message }
          }
        : block
    )
  }))
}

export function dispatchCanvasExportToolBlock(
  block: ToolBlock,
  parsed: unknown,
  appliedBlockIds: Set<string>,
  onRequest?: CanvasAgentExportRequestHandler,
  receiptContext?: CanvasExportReceiptContext
): boolean {
  if (block.meta?.toolName !== 'design_export_canvas') return false
  if (appliedBlockIds.has(block.id)) return true
  appliedBlockIds.add(block.id)
  const request = extractCanvasAgentExportRequest(parsed)
  const receiptKey = receiptKeyFromExport(parsed)
  if (!request || !onRequest) {
    const message = request ? 'Whiteboard export is unavailable.' : 'Whiteboard export request is invalid.'
    failCanvasExportToolBlock(block.id, message)
    sendCanvasExportReceipt(receiptContext, receiptKey, null, message)
    return true
  }
  void Promise.resolve()
    .then(() => onRequest(request))
    .then((result) => {
      publishCanvasExportResult(block.id, result)
      sendCanvasExportReceipt(receiptContext, receiptKey, result)
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      const detail = `Whiteboard export failed: ${message}`
      failCanvasExportToolBlock(block.id, detail)
      sendCanvasExportReceipt(receiptContext, receiptKey, null, detail)
    })
  return true
}

export type { CanvasAgentExportRequestHandler }
