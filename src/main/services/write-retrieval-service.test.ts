import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WriteInlineCompletionRequest } from '../../shared/write-inline-completion'

vi.mock('./write-pdf-text-service', () => ({
  readWritePdfText: async (payload: { path: string }) => {
    const text = [
      'PDF BM25 关键词检索 with literature context improves retrieval quality.',
      'The assistant can cite the relevant page when explaining research evidence.'
    ].join(' ')
    return {
      ok: true,
      path: payload.path,
      size: 123,
      mtimeMs: 1,
      pageCount: 1,
      pages: [{
        page: 1,
        text,
        charStart: 0,
        charEnd: text.length
      }],
      hasText: true,
      truncated: false
    }
  },
  clearWritePdfTextCache: () => undefined
}))

import {
  clearWriteRetrievalCache,
  retrieveWriteContext,
  retrieveWriteInlineCompletionContext,
  setWriteRetrievalIndexTestHooks,
  tokenizeWriteRetrievalText
} from './write-retrieval-service'

function createRequest(workspaceRoot: string): WriteInlineCompletionRequest {
  return {
    workspaceRoot,
    currentFilePath: join(workspaceRoot, 'draft.md'),
    prefix: '# Draft\n\nBM25 关键词',
    suffix: '',
    cursor: {
      line: 3,
      column: 9
    },
    context: {
      language: 'markdown',
      currentLinePrefix: 'BM25 关键词',
      currentLineSuffix: '',
      previousLine: '',
      previousNonEmptyLine: '# Draft',
      nextLine: '',
      indentation: '',
      signals: {
        list: false,
        quote: false,
        heading: false,
        table: false,
        atLineEnd: true,
        endsWithSentencePunctuation: false,
        previousLineEndsWithSentencePunctuation: false,
        prefersNewLineCompletion: false,
        paragraphBreakOpportunity: false
      }
    },
    policy: {
      name: 'precision-inline-v2',
      instruction: 'Return only inserted text.',
      acceptanceCriteria: ['Keep it short.'],
      rejectionCriteria: ['Do not ramble.']
    },
    preview: {
      local: 'BM25 关键词',
      documentTail: '# Draft BM25 关键词'
    },
    model: 'deepseek-v4-flash'
  }
}

const tempRoots: string[] = []

async function createTempWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ds-gui-write-rag-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  setWriteRetrievalIndexTestHooks({})
  clearWriteRetrievalCache()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('write retrieval service', () => {
  it('tokenizes latin terms and CJK keyword ngrams', () => {
    const tokens = tokenizeWriteRetrievalText('BM25 关键词检索 RAG')

    expect(tokens).toContain('bm25')
    expect(tokens).toContain('rag')
    expect(tokens).toContain('关键词')
    expect(tokens).toContain('检索')
  })

  it('retrieves relevant cross-document snippets and excludes the active file', async () => {
    const workspaceRoot = await createTempWorkspace()
    await mkdir(join(workspaceRoot, 'research'), { recursive: true })
    await writeFile(
      join(workspaceRoot, 'draft.md'),
      '# Draft\n\nBM25 关键词',
      'utf8'
    )
    await writeFile(
      join(workspaceRoot, 'research', 'rag.md'),
      [
        '# 检索方案',
        '',
        'BM25 关键词检索用于在写作空间中找到相关片段。',
        '这些片段会作为 RAG 上下文帮助补全保持术语一致。'
      ].join('\n'),
      'utf8'
    )
    await writeFile(
      join(workspaceRoot, 'unrelated.md'),
      '# Shopping',
      'utf8'
    )

    const result = await retrieveWriteInlineCompletionContext(createRequest(workspaceRoot))

    expect(result?.source).toBe('bm25-keyword')
    expect(result?.snippets[0].path).toBe('research/rag.md')
    expect(result?.snippets[0].text).toContain('BM25 关键词检索')
    expect(result?.snippets.some((snippet) => snippet.path === 'draft.md')).toBe(false)
  })

  it('ignores unsupported large data files while scanning the workspace', async () => {
    const workspaceRoot = await createTempWorkspace()
    await writeFile(join(workspaceRoot, 'draft.md'), '# Draft\n\nembedding cache', 'utf8')
    await writeFile(
      join(workspaceRoot, 'notes.md'),
      '# Notes\n\nEmbedding cache notes help the inline completion stay consistent.',
      'utf8'
    )
    await writeFile(join(workspaceRoot, 'output.jsonl'), `${'x'.repeat(10_000)}\n`, 'utf8')

    const result = await retrieveWriteInlineCompletionContext({
      ...createRequest(workspaceRoot),
      prefix: '# Draft\n\nembedding cache',
      context: {
        ...createRequest(workspaceRoot).context,
        currentLinePrefix: 'embedding cache',
        previousNonEmptyLine: '# Draft'
      },
      preview: {
        local: 'embedding cache',
        documentTail: '# Draft embedding cache'
      }
    })

    expect(result?.snippets.some((snippet) => snippet.path === 'output.jsonl')).toBe(false)
    expect(result?.snippets.some((snippet) => snippet.path === 'notes.md')).toBe(true)
  })

  it('retrieves PDF chunks for assistant context with page locations', async () => {
    const workspaceRoot = await createTempWorkspace()
    const pdfPath = join(workspaceRoot, 'papers', 'study.pdf')
    await mkdir(join(workspaceRoot, 'papers'), { recursive: true })
    await writeFile(join(workspaceRoot, 'draft.md'), '# Draft\n\nExplain literature context.', 'utf8')
    await writeFile(pdfPath, Buffer.from('%PDF-1.4\n%%EOF'))

    const result = await retrieveWriteContext({
      workspaceRoot,
      currentFilePath: pdfPath,
      query: 'PDF BM25 关键词检索 literature retrieval quality',
      maxSnippets: 3,
      includeCurrentFile: true
    })

    expect(result?.source).toBe('bm25-keyword')
    expect(result?.snippets[0]).toMatchObject({
      path: 'papers/study.pdf',
      pageStart: 1,
      pageEnd: 1,
      location: {
        kind: 'pdf',
        pageStart: 1,
        pageEnd: 1
      }
    })
    expect(result?.snippets[0].text).toContain('PDF BM25 关键词检索')
  })

  it('invalidates cached current-file snippets immediately after a save', async () => {
    const workspaceRoot = await createTempWorkspace()
    const draftPath = join(workspaceRoot, 'draft.md')
    await writeFile(
      draftPath,
      '# Draft\n\noldsaveuniquemarker is the only cached statement in this document.',
      'utf8'
    )

    const request = (query: string) => retrieveWriteContext({
      workspaceRoot,
      currentFilePath: draftPath,
      query,
      includeCurrentFile: true
    })
    expect((await request('oldsaveuniquemarker'))?.snippets[0]?.text)
      .toContain('oldsaveuniquemarker')

    await writeFile(
      draftPath,
      '# Draft\n\nnewsaveuniquemarker is the only current statement in this document.',
      'utf8'
    )

    expect(await request('oldsaveuniquemarker')).toBeNull()
    expect((await request('newsaveuniquemarker'))?.snippets[0]?.text)
      .toContain('newsaveuniquemarker')
  })

  it('retries when the current file changes after its text is read', async () => {
    const workspaceRoot = await createTempWorkspace()
    const draftPath = join(workspaceRoot, 'draft.md')
    await writeFile(
      draftPath,
      '# Draft\n\noldreadmarker is the only cached statement in this document.',
      'utf8'
    )
    let saved = false
    setWriteRetrievalIndexTestHooks({
      afterFileRead: async (path) => {
        if (path !== draftPath || saved) return
        saved = true
        await writeFile(
          draftPath,
          '# Draft\n\nnewreadmarker is the only current statement in this document.',
          'utf8'
        )
      }
    })

    const result = await retrieveWriteContext({
      workspaceRoot,
      currentFilePath: draftPath,
      query: 'newreadmarker',
      includeCurrentFile: true
    })

    expect(result?.snippets[0]?.text).toContain('newreadmarker')
    expect(JSON.stringify(result)).not.toContain('oldreadmarker')
  })

  it('revalidates a joined in-flight index after the current file is saved', async () => {
    const workspaceRoot = await createTempWorkspace()
    const draftPath = join(workspaceRoot, 'draft.md')
    await writeFile(
      draftPath,
      '# Draft\n\noldflightmarker is the only cached statement in this document.',
      'utf8'
    )
    let releaseBuild!: () => void
    const buildPaused = new Promise<void>((resolve) => { releaseBuild = resolve })
    let buildStarted!: () => void
    const started = new Promise<void>((resolve) => { buildStarted = resolve })
    let firstBuild = true
    setWriteRetrievalIndexTestHooks({
      beforeIndexReturn: async () => {
        if (!firstBuild) return
        firstBuild = false
        buildStarted()
        await buildPaused
      }
    })
    const request = (query: string) => retrieveWriteContext({
      workspaceRoot,
      currentFilePath: draftPath,
      query,
      includeCurrentFile: true
    })
    const first = retrieveWriteContext({
      workspaceRoot,
      currentFilePath: draftPath,
      query: 'oldflightmarker',
      includeCurrentFile: false
    })
    await started
    await writeFile(
      draftPath,
      '# Draft\n\nnewflightmarker is the only current statement in this document.',
      'utf8'
    )
    const joined = request('newflightmarker')
    releaseBuild()

    expect((await joined)?.snippets[0]?.text).toContain('newflightmarker')
    expect(await first).toBeNull()
  })

  it('evicts the least recently used workspace index at the cache limit', async () => {
    const first = await createTempWorkspace()
    await writeFile(
      join(first, 'notes.md'),
      'alphacachemarker provides enough document text for workspace retrieval indexing.',
      'utf8'
    )
    const request = (workspaceRoot: string, query: string) => retrieveWriteContext({
      workspaceRoot,
      currentFilePath: join(workspaceRoot, 'draft.md'),
      query,
      includeCurrentFile: true
    })
    expect(await request(first, 'alphacachemarker')).not.toBeNull()

    const others: string[] = []
    for (let index = 0; index < 7; index += 1) {
      const root = await createTempWorkspace()
      others.push(root)
      await request(root, 'empty')
    }
    expect(await request(first, 'alphacachemarker')).not.toBeNull()
    await request(await createTempWorkspace(), 'overflow')

    await writeFile(
      join(others[0]!, 'notes.md'),
      'betacachemarker provides enough document text for workspace retrieval indexing.',
      'utf8'
    )
    expect(await request(others[0]!, 'betacachemarker')).not.toBeNull()
    await writeFile(
      join(first, 'notes.md'),
      'betacachemarker provides enough document text for workspace retrieval indexing.',
      'utf8'
    )
    expect(await request(first, 'betacachemarker')).toBeNull()
  }, 10_000)
})
