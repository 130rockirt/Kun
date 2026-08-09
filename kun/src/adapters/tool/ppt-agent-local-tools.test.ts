import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolHostContext } from '../../ports/tool-host.js'
import {
  buildPptAgentLocalTools,
  PPT_CREATE_REVIEW_BUNDLE_TOOL_NAME,
  PPT_EXPORT_TOOL_NAME,
  PPT_READ_GUIDE_TOOL_NAME
} from './ppt-agent-local-tools.js'

const roots: string[] = []
const toolchain = resolve(process.cwd(), '..', 'resources', 'ppt-toolchain')

function context(workspace: string): ToolHostContext {
  return {
    threadId: 'thr_ppt_export',
    turnId: 'turn_ppt_export',
    workspace,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PPT agent local tools', () => {
  it('exports and validates a real one-slide PPTX with fade', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-ppt-export-'))
    roots.push(root)
    await mkdir(join(root, 'pages'))
    await writeFile(join(root, 'deck.pptd'), [
      'version: v2',
      'title: Managed export smoke',
      'size: [960, 540]',
      'pages:',
      '  - pages/01.page',
      ''
    ].join('\n'))
    await writeFile(join(root, 'pages', '01.page'), [
      'pageType: content',
      'background:',
      '  type: solid',
      '  color: "#0C0C0E"',
      'elements:',
      '  - elementId: title',
      '    elementType: text',
      '    bounds: [80, 160, 800, 120]',
      '    content:',
      '      fontSize: 48',
      '      color: "#F2F0EA"',
      '      wrap: false',
      '      align: [center, middle]',
      '      text: "<strong>Managed export smoke</strong>"',
      ''
    ].join('\n'))

    const tool = buildPptAgentLocalTools({
      toolchainDirectory: () => toolchain
    }).find((candidate) => candidate.name === PPT_EXPORT_TOOL_NAME)
    expect(tool).toBeDefined()

    const result = await tool!.execute({
      input: 'deck.pptd',
      output: 'deck.pptx',
      transition: 'fade'
    }, context(root))

    expect(result).toMatchObject({
      output: {
        output: 'deck.pptx',
        exporter: 'local-wasm-patched',
        slides: 1,
        editableSlides: 1,
        fadeTransitions: 1,
        transition: 'fade',
        validated: true
      }
    })
    const pptx = await readFile(join(root, 'deck.pptx'))
    expect(pptx.length).toBeGreaterThan(1_000)
    expect(pptx.subarray(0, 2).toString()).toBe('PK')
  }, 30_000)

  it('rejects a deck page flattened into one full-slide raster image', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-ppt-editable-check-'))
    roots.push(root)
    await Promise.all([
      mkdir(join(root, 'pages')),
      mkdir(join(root, 'media'))
    ])
    await writeFile(join(root, 'media', 'flattened.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4QAAAABJRU5ErkJggg==',
      'base64'
    ))
    await writeFile(join(root, 'deck.pptd'), [
      'version: v2',
      'title: Flattened deck',
      'size: [960, 540]',
      'pages:',
      '  - pages/01.page',
      ''
    ].join('\n'))
    await writeFile(join(root, 'pages', '01.page'), [
      'pageType: cover',
      'elements:',
      '  - elementId: flattened',
      '    elementType: image',
      '    bounds: [0, 0, 960, 540]',
      '    src: "media/flattened.png"',
      ''
    ].join('\n'))
    const tool = buildPptAgentLocalTools({
      toolchainDirectory: () => toolchain
    }).find((candidate) => candidate.name === PPT_EXPORT_TOOL_NAME)!

    const result = await tool.execute({ input: 'deck.pptd', output: 'deck.pptx' }, context(root))
    expect(result).toMatchObject({ isError: true })
    expect(JSON.stringify(result.output)).toContain('contains only raster image content')
  }, 30_000)

  it('enforces workspace paths and does not replace output without force', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-ppt-boundary-'))
    roots.push(root)
    await writeFile(join(root, 'existing.pptx'), 'keep')
    const tool = buildPptAgentLocalTools({
      toolchainDirectory: () => toolchain
    }).find((candidate) => candidate.name === PPT_EXPORT_TOOL_NAME)!

    const escape = await tool.execute({
      input: '../deck.pptd',
      output: 'deck.pptx'
    }, context(root))
    expect(escape.isError).toBe(true)

    const existing = await tool.execute({
      input: root,
      output: 'existing.pptx'
    }, context(root))
    expect(existing).toMatchObject({
      isError: true,
      output: { error: 'output already exists; pass force=true to replace it' }
    })
    expect(await readFile(join(root, 'existing.pptx'), 'utf8')).toBe('keep')
  })

  it('rejects remote image sources in the managed offline export', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-ppt-remote-image-'))
    roots.push(root)
    await mkdir(join(root, 'pages'))
    await writeFile(join(root, 'deck.pptd'), [
      'version: v2',
      'title: Remote image blocked',
      'size: [960, 540]',
      'pages:',
      '  - pages/01.page',
      ''
    ].join('\n'))
    await writeFile(join(root, 'pages', '01.page'), [
      'pageType: content',
      'elements:',
      '  - elementId: remote',
      '    elementType: image',
      '    bounds: [0, 0, 960, 540]',
      '    src: "https://example.com/image.png"',
      ''
    ].join('\n'))
    const tool = buildPptAgentLocalTools({
      toolchainDirectory: () => toolchain
    }).find((candidate) => candidate.name === PPT_EXPORT_TOOL_NAME)!

    const result = await tool.execute({ input: 'deck.pptd', output: 'deck.pptx' }, context(root))
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.output)).toContain('Remote image is not allowed in local-only mode')
  })

  it('rejects missing local images instead of producing a partial deck', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-ppt-missing-image-'))
    roots.push(root)
    await mkdir(join(root, 'pages'))
    await writeFile(join(root, 'deck.pptd'), [
      'version: v2',
      'title: Missing image blocked',
      'size: [960, 540]',
      'pages:',
      '  - pages/01.page',
      ''
    ].join('\n'))
    await writeFile(join(root, 'pages', '01.page'), [
      'pageType: content',
      'elements:',
      '  - elementId: missing',
      '    elementType: image',
      '    bounds: [0, 0, 960, 540]',
      '    src: "media/does-not-exist.png"',
      ''
    ].join('\n'))
    const tool = buildPptAgentLocalTools({
      toolchainDirectory: () => toolchain
    }).find((candidate) => candidate.name === PPT_EXPORT_TOOL_NAME)!

    const result = await tool.execute({ input: 'deck.pptd', output: 'deck.pptx' }, context(root))
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.output)).toContain('Missing local image')
  })

  it('rejects page and image paths that escape the PPTD project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-ppt-contained-'))
    roots.push(root)
    const project = join(root, 'project')
    await mkdir(join(project, 'pages'), { recursive: true })
    await writeFile(join(root, 'outside.page'), 'pageType: content\nelements: []\n')
    await writeFile(join(project, 'deck.pptd'), [
      'version: v2',
      'title: Escaping page',
      'size: [960, 540]',
      'pages:',
      '  - ../outside.page',
      ''
    ].join('\n'))
    const tool = buildPptAgentLocalTools({
      toolchainDirectory: () => toolchain
    }).find((candidate) => candidate.name === PPT_EXPORT_TOOL_NAME)!

    const pageEscape = await tool.execute({
      input: 'project/deck.pptd',
      output: 'project/page-escape.pptx'
    }, context(root))
    expect(pageEscape.isError).toBe(true)
    expect(JSON.stringify(pageEscape.output)).toContain('Local page escapes the PPTD project')

    await writeFile(join(project, 'deck.pptd'), [
      'version: v2',
      'title: Escaping image',
      'size: [960, 540]',
      'pages:',
      '  - pages/01.page',
      ''
    ].join('\n'))
    await writeFile(join(project, 'pages', '01.page'), [
      'pageType: content',
      'elements:',
      '  - elementId: escaped',
      '    elementType: image',
      '    bounds: [0, 0, 960, 540]',
      '    src: "../outside.png"',
      ''
    ].join('\n'))
    await writeFile(join(root, 'outside.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const imageEscape = await tool.execute({
      input: 'project/deck.pptd',
      output: 'project/image-escape.pptx'
    }, context(root))
    expect(imageEscape.isError).toBe(true)
    expect(JSON.stringify(imageEscape.output)).toContain('Local image escapes the PPTD project')
  })

  it('creates a complete generated-image review bundle and revises one stable slide', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-ppt-review-bundle-'))
    roots.push(root)
    await mkdir(join(root, '.kun', 'images'), { recursive: true })
    await Promise.all([
      writeFile(join(root, '.kun', 'images', 'slide-1.png'), Buffer.from([1, 2, 3])),
      writeFile(join(root, '.kun', 'images', 'slide-1b.png'), Buffer.from([4, 5, 6]))
    ])
    const tool = buildPptAgentLocalTools().find((candidate) => candidate.name === PPT_CREATE_REVIEW_BUNDLE_TOOL_NAME)!

    const created = await tool.execute({
      parentThreadId: 'thr_parent',
      projectDir: 'deck',
      deckTitle: 'Visual first deck',
      pageCount: 2,
      styleSummary: 'Warm editorial paper, cobalt accents',
      slides: [
        { title: 'Opening', prompt: 'Editorial title composition', imagePath: '.kun/images/slide-1.png' },
        { title: 'Evidence', prompt: 'Data-led evidence page', error: 'provider timeout' }
      ]
    }, context(root))

    expect(created).toMatchObject({
      output: {
        reviewBundle: {
          childId: 'thr_ppt_export',
          deckTitle: 'Visual first deck',
          phase: 'awaiting_review',
          slides: [
            { index: 0, status: 'ready', previewPath: '.kun/images/slide-1.png', revision: 1 },
            { index: 1, status: 'failed', error: 'provider timeout', revision: 1 }
          ]
        }
      }
    })
    const bundle = (created.output as { reviewBundle: { workflowId: string; slides: Array<{ slideId: string }> } }).reviewBundle
    const wrongWorkflow = await tool.execute({
      workflowId: 'ppt_wrong',
      parentThreadId: 'thr_parent',
      projectDir: 'deck',
      deckTitle: 'Visual first deck',
      pageCount: 2,
      slides: [{ slideId: bundle.slides[0].slideId, title: 'Opening', prompt: 'Retry', error: 'retry later' }]
    }, context(root))
    expect(wrongWorkflow).toMatchObject({ isError: true })
    expect(JSON.stringify(wrongWorkflow.output)).toContain('workflowId must match')

    const revised = await tool.execute({
      workflowId: bundle.workflowId,
      parentThreadId: 'thr_parent',
      projectDir: 'deck',
      deckTitle: 'Visual first deck',
      pageCount: 2,
      slides: [{
        slideId: bundle.slides[0].slideId,
        title: 'Opening revised',
        prompt: 'Larger headline and quieter cobalt field',
        imagePath: '.kun/images/slide-1b.png'
      }]
    }, context(root))
    expect(revised).toMatchObject({
      output: {
        reviewBundle: {
          workflowId: bundle.workflowId,
          slides: [
            { slideId: bundle.slides[0].slideId, previewPath: '.kun/images/slide-1b.png', revision: 2 },
            { status: 'failed', revision: 1 }
          ]
        }
      }
    })
    const revisedManifest = JSON.parse(await readFile(join(root, 'deck', '.kun-ppt-review', 'manifest.json'), 'utf8')) as {
      slides: Array<{ promptHash: string }>
    }
    expect(revisedManifest.slides[0].promptHash).not.toBe(revisedManifest.slides[1].promptHash)
  })

  it('rejects incomplete initial reviews and non-generate_image paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-ppt-review-invalid-'))
    roots.push(root)
    await writeFile(join(root, 'manual.png'), Buffer.from([1]))
    const tool = buildPptAgentLocalTools().find((candidate) => candidate.name === PPT_CREATE_REVIEW_BUNDLE_TOOL_NAME)!
    const incomplete = await tool.execute({
      parentThreadId: 'thr_parent', projectDir: 'deck', deckTitle: 'Deck', pageCount: 2,
      slides: [{ title: 'Only one', prompt: 'One', error: 'failed' }]
    }, context(root))
    expect(incomplete).toMatchObject({ isError: true })
    expect(JSON.stringify(incomplete.output)).toContain('initial review must cover all 2 slides')

    const invalidPath = await tool.execute({
      parentThreadId: 'thr_parent', projectDir: 'deck-2', deckTitle: 'Deck', pageCount: 1,
      slides: [{ title: 'One', prompt: 'One', imagePath: 'manual.png' }]
    }, context(root))
    expect(invalidPath).toMatchObject({ isError: true })
    expect(JSON.stringify(invalidPath.output)).toContain('imagePath must come from generate_image')

    const duplicateIds = await tool.execute({
      parentThreadId: 'thr_parent', projectDir: 'deck-3', deckTitle: 'Deck', pageCount: 2,
      slides: [
        { slideId: 'duplicate', title: 'One', prompt: 'One', error: 'failed' },
        { slideId: 'duplicate', title: 'Two', prompt: 'Two', error: 'failed' }
      ]
    }, context(root))
    expect(duplicateIds).toMatchObject({ isError: true })
    expect(JSON.stringify(duplicateIds.output)).toContain('slideId must be omitted for an initial review')
  })

  it('reads only bounded Markdown from the bundled reference directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-ppt-guide-'))
    roots.push(root)
    const tool = buildPptAgentLocalTools({
      toolchainDirectory: () => toolchain
    }).find((candidate) => candidate.name === PPT_READ_GUIDE_TOOL_NAME)!

    const result = await tool.execute({ path: 'pptd.md', max_lines: 2 }, context(root))
    expect(result).toMatchObject({
      output: {
        path: 'pptd.md',
        start_line: 1,
        end_line: 2,
        truncated: true
      }
    })

    const escape = await tool.execute({ path: '../README.md' }, context(root))
    expect(escape.isError).toBe(true)
  })

  it('hides and rejects both helpers when the Lab feature is disabled', async () => {
    const tools = buildPptAgentLocalTools({ enabled: () => false })
    expect(tools.every((tool) => tool.shouldAdvertise?.(context(process.cwd())) === false)).toBe(true)
    for (const tool of tools) {
      const args = tool.name === PPT_READ_GUIDE_TOOL_NAME
        ? { path: 'pptd.md' }
        : { input: 'deck.pptd', output: 'deck.pptx' }
      const result = await tool.execute(args, context(process.cwd()))
      expect(result).toMatchObject({
        isError: true,
        output: { error: 'PPT Agent is disabled in Lab settings' }
      })
    }
  })
})
