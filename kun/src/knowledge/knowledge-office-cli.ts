import type {
  KnowledgeOfficeArtifact,
  KnowledgeOfficeEvidenceChunk,
  KnowledgeSourceFile
} from './knowledge-types.js'

const MAX_EVIDENCE_CHARS = 1_000_000
const MAX_WORD_PARAGRAPHS = 4_000
const MAX_PRESENTATION_SLIDES = 500
const WORD_GROUP_SIZE = 20

export type KnowledgeOfficeCliRunResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type KnowledgeOfficeCliRunner = {
  run(args: readonly string[], signal?: AbortSignal): Promise<KnowledgeOfficeCliRunResult>
}

export async function extractWordKnowledge(
  file: KnowledgeSourceFile,
  sourceSha256: string,
  sourceFormat: 'doc' | 'docx',
  runner: KnowledgeOfficeCliRunner,
  signal?: AbortSignal
): Promise<KnowledgeOfficeArtifact> {
  const result = await runner.run(['view', file.absolutePath, 'annotated'], signal)
  assertSuccess(result, 'Word knowledge extraction failed')
  const paragraphs = splitParagraphs(result.stdout).slice(0, MAX_WORD_PARAGRAPHS)
  if (paragraphs.length === 0) throw new Error('OfficeCLI returned no readable Word content')
  const chunks: KnowledgeOfficeEvidenceChunk[] = []
  let currentSection: string | undefined
  let truncated = splitParagraphs(result.stdout).length > MAX_WORD_PARAGRAPHS
  let charsSeen = 0
  let group: Array<{ text: string; paragraph: number }> = []

  const flush = (): void => {
    if (group.length === 0 || charsSeen >= MAX_EVIDENCE_CHARS) return
    const raw = group.map((entry) => entry.text).join('\n\n')
    const remaining = MAX_EVIDENCE_CHARS - charsSeen
    const text = raw.slice(0, remaining)
    if (text.length < raw.length) truncated = true
    charsSeen += text.length
    const first = group[0]!.paragraph
    const last = group.at(-1)!.paragraph
    chunks.push({
      key: `paragraphs:${first}-${last}`,
      ...(currentSection ? { parentKey: currentSection } : {}),
      kind: 'range',
      title: `Paragraphs ${first}-${last}`,
      summary: compact(text).slice(0, 280),
      location: { kind: 'word', paragraphStart: first, paragraphEnd: last },
      text
    })
    group = []
  }

  paragraphs.forEach((paragraph, index) => {
    const paragraphNumber = index + 1
    const heading = headingText(paragraph)
    if (heading) {
      flush()
      currentSection = `section:${paragraphNumber}`
      chunks.push({
        key: currentSection,
        kind: 'section',
        title: heading,
        summary: heading,
        location: { kind: 'word', paragraphStart: paragraphNumber, paragraphEnd: paragraphNumber },
        text: paragraph
      })
      return
    }
    group.push({ text: paragraph, paragraph: paragraphNumber })
    if (group.length >= WORD_GROUP_SIZE) flush()
  })
  flush()
  if (charsSeen >= MAX_EVIDENCE_CHARS) truncated = true
  return artifact(sourceFormat, sourceSha256, truncated, chunks)
}

export async function extractPresentationKnowledge(
  file: KnowledgeSourceFile,
  sourceSha256: string,
  sourceFormat: 'ppt' | 'pptx',
  runner: KnowledgeOfficeCliRunner,
  signal?: AbortSignal
): Promise<KnowledgeOfficeArtifact> {
  const result = await runner.run(['view', file.absolutePath, 'outline'], signal)
  assertSuccess(result, 'Presentation knowledge extraction failed')
  const slides = presentationSlides(result.stdout)
  if (slides.length === 0) {
    throw new Error('OfficeCLI outline did not expose stable Slide markers')
  }
  let charsSeen = 0
  let truncated = slides.length > MAX_PRESENTATION_SLIDES
  const chunks = slides.slice(0, MAX_PRESENTATION_SLIDES).flatMap((slide) => {
    if (charsSeen >= MAX_EVIDENCE_CHARS) {
      truncated = true
      return []
    }
    const remaining = MAX_EVIDENCE_CHARS - charsSeen
    const text = slide.text.slice(0, remaining)
    charsSeen += text.length
    if (text.length < slide.text.length) truncated = true
    return [{
      key: `slide:${slide.number}`,
      kind: 'slide' as const,
      title: slide.title || `Slide ${slide.number}`,
      summary: compact(text).slice(0, 280),
      location: { kind: 'presentation' as const, slideStart: slide.number, slideEnd: slide.number },
      text
    }]
  })
  return artifact(sourceFormat, sourceSha256, truncated, chunks)
}

function artifact(
  format: 'doc' | 'docx' | 'ppt' | 'pptx',
  sourceSha256: string,
  truncated: boolean,
  chunks: KnowledgeOfficeEvidenceChunk[]
): KnowledgeOfficeArtifact {
  return {
    version: 1,
    extractorVersion: 'office-v1',
    sourceSha256,
    format,
    truncated,
    chunks,
    diagnostics: truncated ? ['Office semantic evidence was truncated by knowledge limits'] : []
  }
}

function splitParagraphs(value: string): string[] {
  const normalized = value.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []
  const blocks = normalized.split(/\n\s*\n/).map((entry) => entry.trim()).filter(Boolean)
  return blocks.length > 1
    ? blocks
    : normalized.split('\n').map((entry) => entry.trim()).filter(Boolean)
}

function headingText(value: string): string | null {
  const markdown = /^#{1,6}\s+(.+)$/.exec(value)
  if (markdown) return markdown[1]!.trim()
  const office = /^(?:heading|标题)\s*\d*\s*[:：]\s*(.+)$/i.exec(value)
  return office?.[1]?.trim() || null
}

function presentationSlides(value: string): Array<{ number: number; title: string; text: string }> {
  const jsonSlides = parseJsonSlides(value)
  if (jsonSlides.length > 0) return jsonSlides
  const output: Array<{ number: number; title: string; text: string }> = []
  let current: { number: number; title: string; lines: string[] } | null = null
  for (const line of value.replace(/\r\n?/g, '\n').split('\n')) {
    const match = /^\s*(?:#{1,6}\s*)?(?:slide|幻灯片)\s*#?\s*(\d+)\s*(?:[:：.-]\s*)?(.*)$/i.exec(line)
    if (match) {
      if (current) output.push({ ...current, text: current.lines.join('\n').trim() })
      current = { number: Number(match[1]), title: match[2]?.trim() ?? '', lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) output.push({ ...current, text: current.lines.join('\n').trim() })
  return output.filter((slide) => Number.isSafeInteger(slide.number) && slide.number > 0)
}

function parseJsonSlides(value: string): Array<{ number: number; title: string; text: string }> {
  try {
    const parsed = JSON.parse(value) as { slides?: unknown[] }
    if (!Array.isArray(parsed.slides)) return []
    return parsed.slides.flatMap((entry, index) => {
      if (!entry || typeof entry !== 'object') return []
      const record = entry as Record<string, unknown>
      const number = typeof record.number === 'number' ? record.number : index + 1
      const title = typeof record.title === 'string' ? record.title : ''
      const text = typeof record.text === 'string'
        ? record.text
        : Array.isArray(record.content) ? record.content.filter((item) => typeof item === 'string').join('\n') : ''
      return Number.isSafeInteger(number) && number > 0 ? [{ number, title, text }] : []
    })
  } catch {
    return []
  }
}

function assertSuccess(result: KnowledgeOfficeCliRunResult, fallback: string): void {
  if (result.exitCode === 0) return
  const detail = result.stderr.trim() || result.stdout.trim()
  throw new Error(detail ? `${fallback}: ${detail}` : fallback)
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
