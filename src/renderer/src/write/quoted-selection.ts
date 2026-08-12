import type {
  WriteEditorSelectionState,
  WriteSelectionPageRect
} from '../components/write/WriteMarkdownEditor'
import type { WriteRetrievalContext, WriteRetrievalSnippet } from '@shared/write-retrieval'
import type { OfficeDocumentPreviewFormat } from '@shared/office-document'
import type { WriteSelectionSourceKind } from '../components/write/write-markdown-editor-types'

export const WRITE_QUOTE_ORIGINAL_START = '[引用原文]'
export const WRITE_QUOTE_ORIGINAL_END = '[/引用原文]'
export const WRITE_CONTEXT_HEADING = '[写作上下文]'
export const WRITE_QUOTE_HEADING = '[引用片段]'
export const WRITE_RETRIEVAL_HEADING = '[相关文献上下文]'
export const WRITE_RETRIEVAL_END = '[/相关文献上下文]'
export const WRITE_OFFICE_CONTEXT_HEADING = '[Office 文档上下文]'
export const WRITE_OFFICE_CONTEXT_END = '[/Office 文档上下文]'

const OFFICE_SOURCE_KINDS = ['pdf', 'word', 'presentation', 'spreadsheet'] as const
const OFFICE_SOURCE_FORMATS = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'] as const

const WRITE_ASSISTANT_INTERACTION_RULE =
  '交互约定: 需要更多信息时通常直接用普通文本向用户提问。仅当当前激活的专用工作流明确要求结构化确认（例如 PPT 视觉评审）时，调用该工作流提供的确认工具；其他写作任务不要滥用结构化交互。\n' +
  '改稿约定: 当用户要求修改、改写、润色、翻译、续写、扩写或整理“当前文件”所指的文档时，你必须用 edit 或 write 工具把改动直接写入该文件（建议先用 read 取到准确原文，再 edit/write），完成后只用一两句话说明改了什么——绝不要只在回复里贴出修改后的文本却不落盘。用户会在编辑器里以行级红绿 Diff 审阅你的改动、逐行接受或拒绝，所以请放心直接改。仅当用户只是提问、讨论、或处理的是只读引用片段时，才用纯文本回答、不改文件。'

export type WriteQuotedSelection = {
  id: string
  text: string
  sourceKind?: WriteSelectionSourceKind
  sourceFormat?: OfficeDocumentPreviewFormat
  sourceTitle: string
  sourceFilePath: string
  lineStart?: number
  lineEnd?: number
  pageStart?: number
  pageEnd?: number
  slide?: number
  sheetName?: string
  cellRange?: string
  formulas?: string[]
  rects?: WriteSelectionPageRect[]
  charCount: number
  createdAt: string
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '')
}

function basenameFromPath(value: string): string {
  const normalized = normalizePath(value)
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] || normalized
}

export function relativeWritePath(workspaceRoot: string, filePath: string): string {
  const root = normalizePath(workspaceRoot)
  const file = normalizePath(filePath)
  const prefix = `${root}/`
  if (root && file.startsWith(prefix)) return file.slice(prefix.length)
  return basenameFromPath(filePath)
}

export function quotedSelectionFromEditor(
  selection: WriteEditorSelectionState,
  filePath: string,
  workspaceRoot: string,
  now = Date.now()
): WriteQuotedSelection | null {
  const text = selection.text.trim()
  if (!text || selection.charCount <= 0) return null
  const first = selection.ranges[0]
  const last = selection.ranges[selection.ranges.length - 1]
  return {
    id: `quote-${now}-${Math.random().toString(36).slice(2)}`,
    text,
    sourceKind: selection.sourceKind ?? 'text',
    ...(selection.sourceFormat ? { sourceFormat: selection.sourceFormat } : {}),
    sourceTitle: relativeWritePath(workspaceRoot, filePath),
    sourceFilePath: filePath,
    ...(selection.sourceKind === 'pdf' || selection.sourceKind === 'word'
      ? {
          pageStart: selection.pageStart ?? first?.page,
          pageEnd: selection.pageEnd ?? last?.page,
          ...(selection.rects?.length ? { rects: selection.rects } : {})
        }
      : selection.sourceKind === 'presentation'
        ? { slide: selection.slide }
        : selection.sourceKind === 'spreadsheet'
          ? {
              sheetName: selection.sheetName,
              cellRange: selection.cellRange,
              ...(selection.formulas?.length ? { formulas: selection.formulas } : {})
            }
          : {
          ...(first ? { lineStart: first.startLine } : {}),
          ...(last ? { lineEnd: last.endLine } : {})
        }),
    charCount: selection.charCount,
    createdAt: new Date(now).toISOString()
  }
}

export function formatWriteQuotedSelectionForPrompt(selection: WriteQuotedSelection): string {
  const originalText = selection.formulas?.length
    ? `${selection.text}\n\n[公式注释]\n${selection.formulas.join('\n')}`
    : selection.text
  const sourceSuffix = selection.sourceKind && selection.sourceKind !== 'text'
    ? ` 来源: ${selection.sourceKind}${selection.sourceFormat ? ` 格式: ${selection.sourceFormat}` : ''}`
    : ''
  if (
    (selection.sourceKind === 'pdf' || selection.sourceKind === 'word') &&
    selection.pageStart != null && selection.pageEnd != null
  ) {
    const pageLabel = selection.pageStart === selection.pageEnd
      ? `第${selection.pageStart}页`
      : `第${selection.pageStart}-${selection.pageEnd}页`
    return [
      `[引用片段] ${selection.sourceTitle}（${pageLabel}，共${selection.charCount}字）${sourceSuffix} 路径: ${selection.sourceFilePath}`,
      WRITE_QUOTE_ORIGINAL_START,
      originalText,
      WRITE_QUOTE_ORIGINAL_END
    ].join('\n')
  }
  if (selection.sourceKind === 'presentation' && selection.slide != null) {
    return [
      `[引用片段] ${selection.sourceTitle}（第${selection.slide}张幻灯片，共${selection.charCount}字）${sourceSuffix} 路径: ${selection.sourceFilePath}`,
      WRITE_QUOTE_ORIGINAL_START,
      originalText,
      WRITE_QUOTE_ORIGINAL_END
    ].join('\n')
  }
  if (selection.sourceKind === 'spreadsheet' && selection.sheetName && selection.cellRange) {
    return [
      `[引用片段] ${selection.sourceTitle}（${selection.sheetName}!${selection.cellRange}，共${selection.charCount}字）${sourceSuffix} 路径: ${selection.sourceFilePath}`,
      WRITE_QUOTE_ORIGINAL_START,
      originalText,
      WRITE_QUOTE_ORIGINAL_END
    ].join('\n')
  }
  if (selection.lineStart != null && selection.lineEnd != null) {
    return [
      `[引用片段] ${selection.sourceTitle}（第${selection.lineStart}-${selection.lineEnd}行，共${selection.charCount}字）路径: ${selection.sourceFilePath}`,
      WRITE_QUOTE_ORIGINAL_START,
      originalText,
      WRITE_QUOTE_ORIGINAL_END
    ].join('\n')
  }
  return [
    `[引用片段] ${selection.sourceTitle}（共${selection.charCount}字）路径: ${selection.sourceFilePath}`,
    WRITE_QUOTE_ORIGINAL_START,
    originalText,
    WRITE_QUOTE_ORIGINAL_END
  ].join('\n')
}

type WritePromptContext = {
  workspaceRoot?: string
  activeFilePath?: string | null
  retrieval?: WriteRetrievalContext | null
  officeDocument?: WriteOfficeDocumentContext | null
  /** Active writing-agent persona; folded into the context block so it frames the
   * model without showing as raw text in the user's message bubble. */
  agentPersona?: string
}

export type WriteOfficeDocumentContext = {
  sourceTitle: string
  sourceFilePath: string
  sourceFormat: OfficeDocumentPreviewFormat
  sourceSha256: string
  text: string
  truncated: boolean
}

export type WritePromptDisplayContext = {
  workspaceRoot?: string
  activeFile?: string
  lines: string[]
}

export type WritePromptDisplayQuote = {
  sourceTitle: string
  sourceFilePath?: string
  sourceKind?: WriteSelectionSourceKind
  sourceFormat?: OfficeDocumentPreviewFormat
  lineStart?: number
  lineEnd?: number
  pageStart?: number
  pageEnd?: number
  slide?: number
  sheetName?: string
  cellRange?: string
  charCount?: number
  text: string
}

export type WritePromptDisplayRetrievalSnippet = {
  location: string
  title?: string
  keywords?: string
  text: string
}

export type WritePromptDisplayRetrieval = {
  source?: string
  keywords?: string
  snippets: WritePromptDisplayRetrievalSnippet[]
}

export type WritePromptDisplayOfficeDocument = Omit<WriteOfficeDocumentContext, 'text'> & {
  charCount: number
}

export type WritePromptDisplay = {
  userInput: string
  context: WritePromptDisplayContext | null
  quotes: WritePromptDisplayQuote[]
  retrieval: WritePromptDisplayRetrieval | null
  officeDocument: WritePromptDisplayOfficeDocument | null
}

function formatWriteRetrievalSnippetLocation(snippet: WriteRetrievalSnippet): string {
  if (snippet.location.kind === 'pdf') {
    const page = snippet.location.pageStart === snippet.location.pageEnd
      ? `第${snippet.location.pageStart}页`
      : `第${snippet.location.pageStart}-${snippet.location.pageEnd}页`
    return `${snippet.path} ${page}`
  }
  return snippet.location.lineStart === snippet.location.lineEnd
    ? `${snippet.path}:${snippet.location.lineStart}`
    : `${snippet.path}:${snippet.location.lineStart}-${snippet.location.lineEnd}`
}

export function formatWriteRetrievalContextForPrompt(retrieval: WriteRetrievalContext | null | undefined): string {
  if (!retrieval?.snippets.length) return ''
  const lines = [
    WRITE_RETRIEVAL_HEADING,
    `检索来源: ${retrieval.source}; 查询关键词: ${retrieval.keywords.join(', ')}`
  ]
  retrieval.snippets.forEach((snippet, index) => {
    lines.push('')
    lines.push(`[${index + 1}] ${formatWriteRetrievalSnippetLocation(snippet)}`)
    if (snippet.title) lines.push(`标题: ${snippet.title}`)
    lines.push(`匹配: ${snippet.keywords.join(', ')}`)
    lines.push(snippet.text)
  })
  // Closing marker keeps the retrieval block unambiguously separable from the
  // user's message so the timeline can collapse it (snippet text may contain
  // blank lines, which would otherwise make the boundary a guess).
  lines.push(WRITE_RETRIEVAL_END)
  return lines.join('\n')
}

export function formatWriteOfficeDocumentContextForPrompt(
  document: WriteOfficeDocumentContext | null | undefined
): string {
  if (!document?.text.trim()) return ''
  return [
    WRITE_OFFICE_CONTEXT_HEADING,
    `来源: ${document.sourceTitle}; 格式: ${document.sourceFormat}; SHA-256: ${document.sourceSha256}; 截断: ${document.truncated ? '是' : '否'}; 路径: ${document.sourceFilePath}`,
    document.text.trim(),
    WRITE_OFFICE_CONTEXT_END
  ].join('\n')
}

export function composeWritePrompt(
  input: string,
  selections: WriteQuotedSelection[],
  context: WritePromptContext = {}
): string {
  const body = input.trim()
  const contextLines: string[] = []
  contextLines.push(WRITE_ASSISTANT_INTERACTION_RULE)
  if (context.officeDocument) {
    contextLines.push(
      '只读 Office 约定: 当前 Office 文件只能预览和讨论。禁止调用 edit、write 或 office_edit 修改它；总结、提纲、解释、润色、精简、评审和改写都必须只在回复中给出结果。'
    )
  }
  if (context.agentPersona?.trim()) {
    contextLines.push(`当前写作 Agent 人设（请严格遵循）：${context.agentPersona.trim()}`)
  }
  if (context.workspaceRoot?.trim()) {
    contextLines.push(`工作空间: ${context.workspaceRoot.trim()}`)
  }
  if (context.activeFilePath?.trim()) {
    contextLines.push(`当前文件: ${relativeWritePath(context.workspaceRoot ?? '', context.activeFilePath)}`)
  }
  const contextText = contextLines.length > 0
    ? `[写作上下文]\n${contextLines.join('\n')}`
    : ''
  const quoteText = selections.map(formatWriteQuotedSelectionForPrompt).join('\n\n')
  const retrievalText = formatWriteRetrievalContextForPrompt(context.retrieval)
  const officeText = formatWriteOfficeDocumentContextForPrompt(context.officeDocument)
  return [contextText, quoteText, officeText, retrievalText, body].filter(Boolean).join('\n\n')
}

function parseContextBlock(text: string): WritePromptDisplayContext {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  let workspaceRoot: string | undefined
  let activeFile: string | undefined

  for (const line of lines) {
    const workspaceMatch = line.match(/^工作空间:\s*(.+)$/)
    if (workspaceMatch?.[1]) {
      workspaceRoot = workspaceMatch[1].trim()
      continue
    }
    const fileMatch = line.match(/^当前文件:\s*(.+)$/)
    if (fileMatch?.[1]) {
      activeFile = fileMatch[1].trim()
    }
  }

  return {
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(activeFile ? { activeFile } : {}),
    lines
  }
}

function splitFirstSection(text: string): { head: string; rest: string } {
  const separator = text.search(/\n{2,}/)
  if (separator < 0) return { head: text.trim(), rest: '' }
  return {
    head: text.slice(0, separator).trim(),
    rest: text.slice(separator).trimStart()
  }
}

function parseQuoteHeader(header: string): Omit<WritePromptDisplayQuote, 'text'> {
  const body = header.replace(WRITE_QUOTE_HEADING, '').trim()
  const pathSplit = body.match(/^(.*?)\s*路径:\s*(.+)$/)
  const rawTitleAndMeta = (pathSplit?.[1] ?? body).trim()
  const sourceFilePath = pathSplit?.[2]?.trim()
  const sourceMeta = rawTitleAndMeta.match(
    /^(.*?)\s+来源:\s*(pdf|word|presentation|spreadsheet)(?:\s+格式:\s*(doc|docx|xls|xlsx|ppt|pptx))?$/
  )
  const titleAndMeta = (sourceMeta?.[1] ?? rawTitleAndMeta).trim()
  const sourceKind = sourceMeta?.[2] && OFFICE_SOURCE_KINDS.includes(sourceMeta[2] as typeof OFFICE_SOURCE_KINDS[number])
    ? sourceMeta[2] as WriteSelectionSourceKind
    : undefined
  const sourceFormat = sourceMeta?.[3] && OFFICE_SOURCE_FORMATS.includes(sourceMeta[3] as OfficeDocumentPreviewFormat)
    ? sourceMeta[3] as OfficeDocumentPreviewFormat
    : undefined
  const pdfMetaMatch = titleAndMeta.match(/^(.*?)（第(\d+)(?:[-–—](\d+))?页，共(\d+)字）$/)
  if (pdfMetaMatch) {
    const pageStart = Number.parseInt(pdfMetaMatch[2] ?? '', 10)
    const pageEnd = Number.parseInt(pdfMetaMatch[3] ?? pdfMetaMatch[2] ?? '', 10)
    const charCount = Number.parseInt(pdfMetaMatch[4] ?? '', 10)
    return {
      sourceTitle: (pdfMetaMatch[1] ?? titleAndMeta).trim(),
      sourceKind: sourceKind === 'word' ? 'word' : 'pdf',
      ...(sourceFormat ? { sourceFormat } : {}),
      ...(sourceFilePath ? { sourceFilePath } : {}),
      ...(Number.isFinite(pageStart) ? { pageStart } : {}),
      ...(Number.isFinite(pageEnd) ? { pageEnd } : {}),
      ...(Number.isFinite(charCount) ? { charCount } : {})
    }
  }

  const slideMetaMatch = titleAndMeta.match(/^(.*?)（第(\d+)张幻灯片，共(\d+)字）$/)
  if (slideMetaMatch) {
    const slide = Number.parseInt(slideMetaMatch[2] ?? '', 10)
    const charCount = Number.parseInt(slideMetaMatch[3] ?? '', 10)
    return {
      sourceTitle: (slideMetaMatch[1] ?? titleAndMeta).trim(),
      sourceKind: 'presentation',
      ...(sourceFormat ? { sourceFormat } : {}),
      ...(sourceFilePath ? { sourceFilePath } : {}),
      ...(Number.isFinite(slide) ? { slide } : {}),
      ...(Number.isFinite(charCount) ? { charCount } : {})
    }
  }

  const sheetMetaMatch = titleAndMeta.match(/^(.*?)（(.+)!([A-Z]+\d+:[A-Z]+\d+)，共(\d+)字）$/)
  if (sheetMetaMatch) {
    const charCount = Number.parseInt(sheetMetaMatch[4] ?? '', 10)
    return {
      sourceTitle: (sheetMetaMatch[1] ?? titleAndMeta).trim(),
      sourceKind: 'spreadsheet',
      ...(sourceFormat ? { sourceFormat } : {}),
      ...(sourceFilePath ? { sourceFilePath } : {}),
      sheetName: sheetMetaMatch[2]?.trim(),
      cellRange: sheetMetaMatch[3]?.trim(),
      ...(Number.isFinite(charCount) ? { charCount } : {})
    }
  }

  const metaMatch = titleAndMeta.match(/^(.*?)（(?:第(\d+)[-–—](\d+)行，)?共(\d+)字）$/)
  const sourceTitle = (metaMatch?.[1] ?? titleAndMeta).trim()
  const lineStart = metaMatch?.[2] ? Number.parseInt(metaMatch[2], 10) : undefined
  const lineEnd = metaMatch?.[3] ? Number.parseInt(metaMatch[3], 10) : undefined
  const charCount = metaMatch?.[4] ? Number.parseInt(metaMatch[4], 10) : undefined

  return {
    sourceTitle,
    sourceKind: 'text',
    ...(sourceFilePath ? { sourceFilePath } : {}),
    ...(Number.isFinite(lineStart) ? { lineStart } : {}),
    ...(Number.isFinite(lineEnd) ? { lineEnd } : {}),
    ...(Number.isFinite(charCount) ? { charCount } : {})
  }
}

function consumeOfficeDocumentSection(text: string): {
  document: WritePromptDisplayOfficeDocument | null
  rest: string
} {
  if (!text.startsWith(WRITE_OFFICE_CONTEXT_HEADING)) return { document: null, rest: text }
  const endIndex = text.indexOf(WRITE_OFFICE_CONTEXT_END)
  if (endIndex < 0) return { document: null, rest: text }
  const content = text.slice(WRITE_OFFICE_CONTEXT_HEADING.length, endIndex).trim()
  const firstLineEnd = content.indexOf('\n')
  if (firstLineEnd < 0) return { document: null, rest: text }
  const metadata = content.slice(0, firstLineEnd).trim()
  const semanticText = content.slice(firstLineEnd + 1).trim()
  const match = metadata.match(
    /^来源:\s*(.*?);\s*格式:\s*(doc|docx|xls|xlsx|ppt|pptx);\s*SHA-256:\s*([a-f0-9]{64});\s*截断:\s*(是|否);\s*路径:\s*(.+)$/i
  )
  if (!match) return { document: null, rest: text }
  return {
    document: {
      sourceTitle: match[1]?.trim() ?? '',
      sourceFormat: match[2] as OfficeDocumentPreviewFormat,
      sourceSha256: match[3]?.toLowerCase() ?? '',
      truncated: match[4] === '是',
      sourceFilePath: match[5]?.trim() ?? '',
      charCount: Array.from(semanticText).length
    },
    rest: text.slice(endIndex + WRITE_OFFICE_CONTEXT_END.length).trimStart()
  }
}

function parseRetrievalBlock(text: string): WritePromptDisplayRetrieval {
  const lines = text.split('\n')
  let source: string | undefined
  let keywords: string | undefined
  const snippets: WritePromptDisplayRetrievalSnippet[] = []
  let current: { location: string; title?: string; keywords?: string; textLines: string[] } | null = null

  const commit = (): void => {
    if (!current) return
    snippets.push({
      location: current.location,
      ...(current.title ? { title: current.title } : {}),
      ...(current.keywords ? { keywords: current.keywords } : {}),
      text: current.textLines.join('\n').trim()
    })
    current = null
  }

  for (const line of lines) {
    const snippetStart = line.match(/^\[(\d+)\]\s+(.+)$/)
    if (snippetStart) {
      commit()
      current = { location: (snippetStart[2] ?? '').trim(), textLines: [] }
      continue
    }
    if (!current) {
      const sourceMatch = line.match(/^检索来源:\s*(.*?)(?:;\s*查询关键词:\s*(.*))?$/)
      if (sourceMatch) {
        source = sourceMatch[1]?.trim() || undefined
        keywords = sourceMatch[2]?.trim() || undefined
      }
      continue
    }
    const beforeBody = current.textLines.every((item) => !item.trim())
    const titleMatch = line.match(/^标题:\s*(.*)$/)
    if (titleMatch && current.title === undefined && beforeBody) {
      current.title = titleMatch[1]?.trim() || undefined
      continue
    }
    const keywordMatch = line.match(/^匹配:\s*(.*)$/)
    if (keywordMatch && current.keywords === undefined && beforeBody) {
      current.keywords = keywordMatch[1]?.trim() || undefined
      continue
    }
    current.textLines.push(line)
  }
  commit()

  return {
    ...(source ? { source } : {}),
    ...(keywords ? { keywords } : {}),
    snippets
  }
}

function consumeQuoteSection(text: string): { quote: WritePromptDisplayQuote | null; rest: string } {
  if (!text.startsWith(WRITE_QUOTE_HEADING)) return { quote: null, rest: text }
  const firstLineEnd = text.indexOf('\n')
  if (firstLineEnd < 0) return { quote: null, rest: text }

  const header = text.slice(0, firstLineEnd).trim()
  let rest = text.slice(firstLineEnd + 1).trimStart()
  if (!rest.startsWith(WRITE_QUOTE_ORIGINAL_START)) {
    return { quote: null, rest: text }
  }

  rest = rest.slice(WRITE_QUOTE_ORIGINAL_START.length).trimStart()
  const originalEnd = rest.indexOf(WRITE_QUOTE_ORIGINAL_END)
  if (originalEnd < 0) return { quote: null, rest: text }

  const quotedText = rest.slice(0, originalEnd).trim()
  const afterQuote = rest.slice(originalEnd + WRITE_QUOTE_ORIGINAL_END.length).trimStart()
  return {
    quote: {
      ...parseQuoteHeader(header),
      text: quotedText
    },
    rest: afterQuote
  }
}

export function parseWritePromptForDisplay(text: string): WritePromptDisplay | null {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (
    !normalized.includes(WRITE_CONTEXT_HEADING) &&
    !normalized.includes(WRITE_QUOTE_HEADING) &&
    !normalized.includes(WRITE_RETRIEVAL_HEADING) &&
    !normalized.includes(WRITE_OFFICE_CONTEXT_HEADING)
  ) {
    return null
  }

  let rest = normalized
  let context: WritePromptDisplayContext | null = null
  const quotes: WritePromptDisplayQuote[] = []

  if (rest.startsWith(WRITE_CONTEXT_HEADING)) {
    rest = rest.slice(WRITE_CONTEXT_HEADING.length).trimStart()
    const contextSection = splitFirstSection(rest)
    context = parseContextBlock(contextSection.head)
    rest = contextSection.rest
  }

  while (rest.startsWith(WRITE_QUOTE_HEADING)) {
    const consumed = consumeQuoteSection(rest)
    if (!consumed.quote) break
    quotes.push(consumed.quote)
    rest = consumed.rest
  }

  let officeDocument: WritePromptDisplayOfficeDocument | null = null
  if (rest.startsWith(WRITE_OFFICE_CONTEXT_HEADING)) {
    const consumed = consumeOfficeDocumentSection(rest)
    officeDocument = consumed.document
    rest = consumed.rest
  }

  let retrieval: WritePromptDisplayRetrieval | null = null
  if (rest.startsWith(WRITE_RETRIEVAL_HEADING)) {
    const endIndex = rest.indexOf(WRITE_RETRIEVAL_END)
    if (endIndex >= 0) {
      retrieval = parseRetrievalBlock(rest.slice(WRITE_RETRIEVAL_HEADING.length, endIndex))
      rest = rest.slice(endIndex + WRITE_RETRIEVAL_END.length).trimStart()
    }
  }

  if (!context && quotes.length === 0 && !retrieval && !officeDocument) return null

  return {
    userInput: rest.trim(),
    context,
    quotes,
    retrieval,
    officeDocument
  }
}
