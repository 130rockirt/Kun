import type { ChatBlock } from '../agent/types'
import { deriveThreadTitleFromPrompt, getDefaultThreadTitle } from '../lib/thread-title'
import type { DesignDocument } from './design-types'

const LEGACY_DEFAULT_DRAWING_TITLES = new Set([
  'My design',
  '我的设计',
  '私のデザイン',
  '내 디자인',
  'Мой дизайн',
  'मेरा डिज़ाइन',
  'การออกแบบของฉัน'
])

export function deriveDrawingTitleFromPrompt(prompt: string): string {
  const trimmed = prompt.trim()
  if (!trimmed) return ''
  const title = deriveThreadTitleFromPrompt(trimmed)
  return title === getDefaultThreadTitle() ? '' : title
}

export function deriveDrawingTitleFromBlocks(blocks: readonly ChatBlock[]): string {
  const firstUser = blocks.find((block) => block.kind === 'user')
  if (!firstUser || firstUser.kind !== 'user') return ''
  return deriveDrawingTitleFromPrompt(firstUser.meta?.displayText ?? firstUser.text)
}

export function drawingTitleNeedsBackfill(
  drawing: Pick<DesignDocument, 'id' | 'title' | 'titleOrigin'>
): boolean {
  if (drawing.titleOrigin === 'generated' || drawing.titleOrigin === 'user') return false
  const title = drawing.title.trim()
  return !title || title === drawing.id || LEGACY_DEFAULT_DRAWING_TITLES.has(title)
}

export function displayDrawingTitle(
  drawing: Pick<DesignDocument, 'id' | 'title' | 'titleOrigin'>,
  untitledLabel: string
): string {
  return drawingTitleNeedsBackfill(drawing)
    ? untitledLabel
    : drawing.title.trim()
}
