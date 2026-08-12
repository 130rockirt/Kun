import type { WriteBlockType } from '../../write/block-type'
import type { OfficeDocumentPreviewFormat } from '@shared/office-document'

export type WriteSelectionSourceKind =
  | 'text'
  | 'pdf'
  | 'word'
  | 'presentation'
  | 'spreadsheet'

export type WriteSelectionAnchorRect = {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

export type WriteSelectionPageRect = {
  page: number
  x: number
  y: number
  width: number
  height: number
}

export type WriteSelectionRange = {
  from: number
  to: number
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  text: string
  charCount: number
  page?: number
}

export type WriteEditorSelectionState = {
  text: string
  ranges: WriteSelectionRange[]
  charCount: number
  anchorRect?: WriteSelectionAnchorRect
  rects?: WriteSelectionPageRect[]
  sourceKind?: WriteSelectionSourceKind
  sourceFormat?: OfficeDocumentPreviewFormat
  pageStart?: number
  pageEnd?: number
  slide?: number
  sheetName?: string
  cellRange?: string
  formulas?: string[]
  /** Block type of the line at the selection start (selection toolbar). */
  blockType?: WriteBlockType
  /** Set when a single raster image is selected (TipTap node selection or a
   * caret on an image markdown line in source mode). */
  selectedImage?: WriteSelectedImage
}

export type WriteSelectedImage = {
  src: string
  alt: string
  /** Source-mode only: the document offsets of the image markdown line. */
  line?: { from: number; to: number }
}

/**
 * Imperative surface for the selection toolbar: replaces a document range
 * through the editor so undo history stays granular and the selection ends up
 * covering the replacement (allowing chained formatting).
 */
export type WriteMarkdownEditorHandle = {
  applyRangeReplacement: (
    range: { from: number; to: number },
    original: string,
    replacement: string
  ) => boolean
  /** Rewrite the block markers of the lines spanning the current selection. */
  setBlockType: (type: WriteBlockType) => boolean
  /**
   * Enters an inline red/green diff review: swaps the document to `nextDoc` and
   * shows a per-chunk accept/reject merge view against `original`. Returns false
   * when the editor is read-only/unavailable, a review is already running, or
   * the texts are identical.
   */
  beginDiffReview: (params: { original: string; nextDoc: string }) => boolean
  /** True while an inline diff review is in progress. */
  isDiffReviewActive: () => boolean
  /** Accepts every pending diff chunk and commits the result. */
  acceptAllDiff: () => void
  /** Rejects every pending diff chunk (reverting to the original) and commits. */
  rejectAllDiff: () => void
}
