import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PptWorkflowScope, ToolHostContext } from '../../ports/tool-host.js'
import {
  buildPptAgentLocalTools,
  PPT_CREATE_REVIEW_BUNDLE_TOOL_NAME,
  PPT_EXPORT_TOOL_NAME,
  PPT_READ_GUIDE_TOOL_NAME,
  PPT_SUBMIT_DESIGN_PLAN_TOOL_NAME
} from './ppt-agent-local-tools.js'

const roots: string[] = []
const governanceRoots = new Set<string>()
const toolchain = resolve(process.cwd(), '..', 'resources', 'ppt-toolchain')
const sourceRequest = 'Create a restrained technical architecture deck. Use a blue-purple gradient only when explicitly justified.'
const completePlan = {
  category: 'tech-engineering',
  audience: 'Engineering reviewers',
  purpose: 'Explain the architecture and support a decision',
  pageStrategy: { pageCount: 2, narrative: 'Context to mechanism to evidence and decision' },
  fontRoles: { display: 'Inter', body: 'Inter', monospace: 'JetBrains Mono' },
  colorRoles: {
    background: '#F7F8FA',
    foreground: '#18202A',
    accent: '#C54A2C',
    muted: '#66717D',
    positive: '#287A4B',
    caution: '#A56A16',
    critical: '#B33030'
  },
  backgroundTreatment: { kind: 'solid' },
  effects: [],
  typeScale: { title: 40, section: 30, body: 18, caption: 11 },
  spacingRhythm: { unit: 8, pageMargin: 48, columns: 12, gutter: 20 },
  layoutSystem: 'Stable title axis with direct evidence layouts and thin rules',
  imageryStrategy: 'Use architecture diagrams and source imagery only when informative',
  policyExceptions: []
}

function context(workspace: string, scope: Partial<PptWorkflowScope> = {}): ToolHostContext {
  return {
    threadId: 'thr_ppt_export',
    turnId: 'turn_ppt_export',
    workspace,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    approvalIntent: sourceRequest,
    pptWorkflowScope: {
      action: 'start', workflowId: 'ppt_workflow', projectDir: '.',
      parentThreadId: 'thr_parent', previewMode: 'image-first', ...scope
    },
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}

function governedTools() {
  return buildPptAgentLocalTools({
    toolchainDirectory: () => toolchain,
    governanceDirectory: (toolContext) => {
      const directory = `${toolContext.workspace}.host-ppt-governance`
      governanceRoots.add(directory)
      return directory
    },
    resolveSourceRequest: () => sourceRequest
  })
}

async function govern(
  root: string,
  projectDir = '.',
  workflowId = 'ppt_workflow',
  pageCount = 2
): Promise<string> {
  const tools = governedTools()
  const guide = tools.find((candidate) => candidate.name === PPT_READ_GUIDE_TOOL_NAME)!
  const plan = tools.find((candidate) => candidate.name === PPT_SUBMIT_DESIGN_PLAN_TOOL_NAME)!
  for (const path of ['slides_categories.md', 'slides_categories/tech-engineering.md']) {
    const result = await guide.execute(
      { workflowId, projectDir, path, max_lines: 400 }, context(root, { workflowId, projectDir })
    )
    if (result.isError) throw new Error(JSON.stringify(result.output))
  }
  const result = await plan.execute({
    workflowId,
    projectDir,
    plan: { ...completePlan, pageStrategy: { ...completePlan.pageStrategy, pageCount } }
  }, context(root, { workflowId, projectDir }))
  if (result.isError) throw new Error(JSON.stringify(result.output))
  return workflowId
}

async function governForExport(
  root: string,
  projectDir = '.',
  workflowId = 'ppt_workflow',
  pageCount = 1
): Promise<string> {
  await govern(root, projectDir, workflowId, pageCount)
  const review = governedTools().find(
    (candidate) => candidate.name === PPT_CREATE_REVIEW_BUNDLE_TOOL_NAME
  )!
  const result = await review.execute({
    workflowId,
    parentThreadId: 'thr_parent',
    projectDir,
    deckTitle: 'Governed export',
    pageCount,
    slides: Array.from({ length: pageCount }, (_, index) => ({
      title: `Slide ${index + 1}`,
      prompt: `Review slide ${index + 1}`,
      error: 'preview unavailable in exporter test'
    }))
  }, context(root, { workflowId, projectDir }))
  if (result.isError) throw new Error(JSON.stringify(result.output))
  return workflowId
}

afterEach(async () => {
  const cleanup = [...roots.splice(0), ...governanceRoots]
  governanceRoots.clear()
  await Promise.all(cleanup.map((root) => rm(root, { recursive: true, force: true })))
})

describe('PPT agent local tools', () => {
  it('exports and validates a real one-slide PPTX from a version-2 governed manifest', async () => {
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

    await governForExport(root, '.', 'ppt_workflow', 1)
    const governedManifestPath = join(root, '.kun-ppt-review', 'manifest.json')
    const governedManifest = JSON.parse(await readFile(governedManifestPath, 'utf8'))
    await writeFile(governedManifestPath, `${JSON.stringify({ ...governedManifest, version: 2 }, null, 2)}\n`)
    const tool = governedTools().find((candidate) => candidate.name === PPT_EXPORT_TOOL_NAME)
    expect(tool).toBeDefined()

    const result = await tool!.execute({
      input: 'deck.pptd',
      output: 'presentations/deck.pptx',
      transition: 'fade'
    }, context(root, { action: 'approve_and_build' }))

    expect(result).toMatchObject({
      output: {
        output: 'presentations/deck.pptx',
        exporter: 'local-wasm-patched',
        slides: 1,
        editableSlides: 1,
        fadeTransitions: 1,
        transition: 'fade',
        validated: true
      }
    })
    const pptx = await readFile(join(root, 'presentations', 'deck.pptx'))
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
    await governForExport(root, '.', 'ppt_workflow', 1)
    const tool = governedTools().find((candidate) => candidate.name === PPT_EXPORT_TOOL_NAME)!

    const result = await tool.execute(
      { input: 'deck.pptd', output: 'presentations/deck.pptx' }, context(root, { action: 'approve_and_build' }))
    expect(result).toMatchObject({ isError: true })
    expect(JSON.stringify(result.output)).toContain('contains only raster image content')
  }, 30_000)

  it('enforces workspace paths and does not replace output without force', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-ppt-boundary-'))
    roots.push(root)
    await mkdir(join(root, 'presentations'))
    await writeFile(join(root, 'presentations', 'existing.pptx'), 'keep')
    await governForExport(root, '.', 'ppt_workflow', 1)
    const tool = governedTools().find((candidate) => candidate.name === PPT_EXPORT_TOOL_NAME)!

    const escape = await tool.execute({
      input: '../deck.pptd',
      output: 'presentations/deck.pptx'
    }, context(root, { action: 'approve_and_build' }))
    expect(escape.isError).toBe(true)

    const existing = await tool.execute({
      input: root,
      output: 'presentations/existing.pptx'
    }, context(root, { action: 'approve_and_build' }))
    expect(existing).toMatchObject({
      isError: true,
      output: { error: 'output already exists; pass force=true to replace it' }
    })
    expect(await readFile(join(root, 'presentations', 'existing.pptx'), 'utf8')).toBe('keep')
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
    await governForExport(root, '.', 'ppt_workflow', 1)
    const tool = governedTools().find((candidate) => candidate.name === PPT_EXPORT_TOOL_NAME)!

    const result = await tool.execute(
      { input: 'deck.pptd', output: 'presentations/deck.pptx' }, context(root, { action: 'approve_and_build' }))
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
    await governForExport(root, '.', 'ppt_workflow', 1)
    const tool = governedTools().find((candidate) => candidate.name === PPT_EXPORT_TOOL_NAME)!

    const result = await tool.execute(
      { input: 'deck.pptd', output: 'presentations/deck.pptx' }, context(root, { action: 'approve_and_build' }))
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
    await governForExport(root, 'project', 'ppt_workflow', 1)
    const tool = governedTools().find((candidate) => candidate.name === PPT_EXPORT_TOOL_NAME)!

    const pageEscape = await tool.execute({
      input: 'project/deck.pptd',
      output: 'presentations/page-escape.pptx'
    }, context(root, { action: 'approve_and_build', projectDir: 'project' }))
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
      output: 'presentations/image-escape.pptx'
    }, context(root, { action: 'approve_and_build', projectDir: 'project' }))
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
    const workflowId = await govern(root, 'deck')
    const tool = governedTools().find((candidate) => candidate.name === PPT_CREATE_REVIEW_BUNDLE_TOOL_NAME)!

    const created = await tool.execute({
      workflowId,
      parentThreadId: 'thr_parent',
      projectDir: 'deck',
      deckTitle: 'Visual first deck',
      pageCount: 2,
      styleSummary: 'Warm editorial paper, cobalt accents',
      slides: [
        { title: 'Opening', prompt: 'Editorial title composition', imagePath: '.kun/images/slide-1.png' },
        { title: 'Evidence', prompt: 'Data-led evidence page', error: 'provider timeout' }
      ]
    }, context(root, { workflowId, projectDir: 'deck' }))

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
    }, context(root, { action: 'revise_previews', workflowId, projectDir: 'deck' }))
    expect(wrongWorkflow).toMatchObject({ isError: true })
    expect(JSON.stringify(wrongWorkflow.output)).toContain('workflowId')

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
    }, context(root, { action: 'revise_previews', workflowId, projectDir: 'deck' }))
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
    await Promise.all([
      govern(root, 'deck', 'ppt_incomplete'),
      govern(root, 'deck-2', 'ppt_invalid_path', 1),
      govern(root, 'deck-3', 'ppt_duplicate')
    ])
    const tool = governedTools().find((candidate) => candidate.name === PPT_CREATE_REVIEW_BUNDLE_TOOL_NAME)!
    const incomplete = await tool.execute({
      workflowId: 'ppt_incomplete',
      parentThreadId: 'thr_parent', projectDir: 'deck', deckTitle: 'Deck', pageCount: 2,
      slides: [{ title: 'Only one', prompt: 'One', error: 'failed' }]
    }, context(root, { workflowId: 'ppt_incomplete', projectDir: 'deck' }))
    expect(incomplete).toMatchObject({ isError: true })
    expect(JSON.stringify(incomplete.output)).toContain('initial review must cover all 2 slides')

    const invalidPath = await tool.execute({
      workflowId: 'ppt_invalid_path',
      parentThreadId: 'thr_parent', projectDir: 'deck-2', deckTitle: 'Deck', pageCount: 1,
      slides: [{ title: 'One', prompt: 'One', imagePath: 'manual.png' }]
    }, context(root, { workflowId: 'ppt_invalid_path', projectDir: 'deck-2' }))
    expect(invalidPath).toMatchObject({ isError: true })
    expect(JSON.stringify(invalidPath.output)).toContain('imagePath must come from generate_image')

    const duplicateIds = await tool.execute({
      workflowId: 'ppt_duplicate',
      parentThreadId: 'thr_parent', projectDir: 'deck-3', deckTitle: 'Deck', pageCount: 2,
      slides: [
        { slideId: 'duplicate', title: 'One', prompt: 'One', error: 'failed' },
        { slideId: 'duplicate', title: 'Two', prompt: 'Two', error: 'failed' }
      ]
    }, context(root, { workflowId: 'ppt_duplicate', projectDir: 'deck-3' }))
    expect(duplicateIds).toMatchObject({ isError: true })
    expect(JSON.stringify(duplicateIds.output)).toContain('slideId must be omitted for an initial review')
  })

  it('enforces guide order, source-backed plans, persisted governance, and stale-plan review gates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-ppt-governance-'))
    roots.push(root)
    const workflowId = 'ppt_governed'
    const projectDir = 'governed-deck'
    const tools = governedTools()
    const guide = tools.find((candidate) => candidate.name === PPT_READ_GUIDE_TOOL_NAME)!
    const plan = tools.find((candidate) => candidate.name === PPT_SUBMIT_DESIGN_PLAN_TOOL_NAME)!
    const review = tools.find((candidate) => candidate.name === PPT_CREATE_REVIEW_BUNDLE_TOOL_NAME)!
    const startContext = context(root, { workflowId, projectDir })

    const outOfOrder = await guide.execute({
      workflowId,
      projectDir,
      path: 'slides_categories/tech-engineering.md',
      max_lines: 400
    }, startContext)
    expect(outOfOrder).toMatchObject({ isError: true })
    expect(JSON.stringify(outOfOrder.output)).toContain('category index')

    await guide.execute({ workflowId, projectDir, path: 'slides_categories.md', max_lines: 1 }, startContext)
    const afterPartialIndex = await guide.execute({
      workflowId,
      projectDir,
      path: 'slides_categories/tech-engineering.md',
      max_lines: 400
    }, startContext)
    expect(afterPartialIndex).toMatchObject({ isError: true })
    await guide.execute({
      workflowId,
      projectDir,
      path: 'slides_categories.md',
      start_line: 2,
      max_lines: 400
    }, startContext)
    await guide.execute({
      workflowId,
      projectDir,
      path: 'slides_categories/tech-engineering.md',
      max_lines: 400
    }, startContext)

    const secondCategory = await guide.execute({
      workflowId,
      projectDir,
      path: 'slides_categories/business-plan.md',
      max_lines: 400
    }, startContext)
    expect(secondCategory).toMatchObject({ isError: true })
    expect(JSON.stringify(secondCategory.output)).toContain('exactly one category guide')

    const incomplete = await plan.execute({ workflowId, projectDir, plan: {} }, startContext)
    expect(incomplete).toMatchObject({ isError: true })
    expect(JSON.stringify(incomplete.output)).toContain('audience')
    expect(JSON.stringify(incomplete.output)).toContain('purpose')

    const unbacked = await plan.execute({
      workflowId,
      projectDir,
      plan: {
        ...completePlan,
        layoutSystem: 'Use a restrained neon glow around the title',
        policyExceptions: [{ rule: 'glow-or-glass', evidence: 'neon glow everywhere' }]
      }
    }, startContext)
    expect(unbacked).toMatchObject({ isError: true })
    expect(JSON.stringify(unbacked.output)).toContain('exact evidence quote')

    const accepted = await plan.execute({
      workflowId,
      projectDir,
      plan: {
        ...completePlan,
        imageryStrategy: 'Use a blue-purple gradient only when explicitly justified by the source request',
        policyExceptions: [{ rule: 'generic-tech-gradient', evidence: 'blue-purple gradient' }]
      }
    }, startContext)
    expect(accepted).toMatchObject({ output: { validated: true, planRevision: 1 } })

    const created = await review.execute({
      workflowId,
      parentThreadId: 'thr_parent',
      projectDir,
      deckTitle: 'Governed deck',
      pageCount: 2,
      slides: [
        { title: 'Opening', prompt: 'Opening visual', error: 'image unavailable' },
        { title: 'Architecture', prompt: 'Architecture visual', error: 'image unavailable' }
      ]
    }, startContext)
    expect(created).toMatchObject({ output: { reviewBundle: { designGovernance: { category: 'tech-engineering' } } } })
    const manifest = JSON.parse(
      await readFile(join(root, projectDir, '.kun-ppt-review', 'manifest.json'), 'utf8')
    ) as { version: number; governance: { policy: { version: string }; designPlan: { fingerprint: string } } }
    expect(manifest).toMatchObject({
      version: 3,
      governance: { policy: { version: '1.0.0' }, designPlan: { fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } }
    })

    await plan.execute({
      workflowId,
      projectDir,
      plan: { ...completePlan, colorRoles: { ...completePlan.colorRoles, accent: '#9B3E24' } }
    }, context(root, { action: 'revise_previews', workflowId, projectDir }))
    const bundle = (created.output as { reviewBundle: { slides: Array<{ slideId: string }> } }).reviewBundle
    const stale = await review.execute({
      workflowId,
      parentThreadId: 'thr_parent',
      projectDir,
      deckTitle: 'Governed deck',
      pageCount: 2,
      slides: [{ slideId: bundle.slides[0].slideId, title: 'Opening', prompt: 'New visual', error: 'retry' }]
    }, context(root, { action: 'revise_previews', workflowId, projectDir }))
    expect(stale).toMatchObject({ isError: true })
    expect(JSON.stringify(stale.output)).toContain('design plan changed')
  })

  it('ignores forged workspace governance and rejects a tampered manifest at review and export', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-ppt-governance-adversarial-'))
    roots.push(root)
    const tools = governedTools()
    const review = tools.find((candidate) => candidate.name === PPT_CREATE_REVIEW_BUNDLE_TOOL_NAME)!
    const exportTool = tools.find((candidate) => candidate.name === PPT_EXPORT_TOOL_NAME)!

    await govern(root, 'forged-deck', 'ppt_forged', 1)
    const hostDirectory = `${root}.host-ppt-governance`
    const [hostStateFile] = await readdir(hostDirectory)
    const forgedState = await readFile(join(hostDirectory, hostStateFile), 'utf8')
    await rm(hostDirectory, { recursive: true, force: true })
    await mkdir(join(root, 'forged-deck', '.kun-ppt-review'), { recursive: true })
    await writeFile(join(root, 'forged-deck', '.kun-ppt-review', 'governance.json'), forgedState)

    const forgedReview = await review.execute({
      workflowId: 'ppt_forged', parentThreadId: 'thr_parent', projectDir: 'forged-deck',
      deckTitle: 'Forged deck', pageCount: 1,
      slides: [{ title: 'Forged', prompt: 'Forged preview', error: 'unavailable' }]
    }, context(root, { workflowId: 'ppt_forged', projectDir: 'forged-deck' }))
    expect(forgedReview).toMatchObject({ isError: true })
    expect(JSON.stringify(forgedReview.output)).toContain('PPT design governance is incomplete')

    await govern(root, 'tampered-deck', 'ppt_tampered', 1)
    const created = await review.execute({
      workflowId: 'ppt_tampered', parentThreadId: 'thr_parent', projectDir: 'tampered-deck',
      deckTitle: 'Tampered deck', pageCount: 1,
      slides: [{ title: 'Original', prompt: 'Original preview', error: 'unavailable' }]
    }, context(root, { workflowId: 'ppt_tampered', projectDir: 'tampered-deck' }))
    expect(created.isError).not.toBe(true)
    const bundle = (created.output as { reviewBundle: { slides: Array<{ slideId: string }> } }).reviewBundle
    const manifestPath = join(root, 'tampered-deck', '.kun-ppt-review', 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      governance: { designPlan: { fingerprint: string } }
    }
    manifest.governance.designPlan.fingerprint = 'f'.repeat(64)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(join(root, 'tampered-deck', '.kun-ppt-review', 'governance.json'), forgedState)

    const tamperedReview = await review.execute({
      workflowId: 'ppt_tampered', parentThreadId: 'thr_parent', projectDir: 'tampered-deck',
      deckTitle: 'Tampered deck', pageCount: 1,
      slides: [{ slideId: bundle.slides[0].slideId, title: 'Revision', prompt: 'Revision', error: 'unavailable' }]
    }, context(root, {
      action: 'revise_previews', workflowId: 'ppt_tampered', projectDir: 'tampered-deck'
    }))
    expect(tamperedReview).toMatchObject({ isError: true })
    expect(JSON.stringify(tamperedReview.output)).toContain('authoritative host governance state')

    const tamperedExport = await exportTool.execute({
      input: 'tampered-deck', output: 'presentations/tampered.pptx'
    }, context(root, {
      action: 'approve_and_build', workflowId: 'ppt_tampered', projectDir: 'tampered-deck'
    }))
    expect(tamperedExport).toMatchObject({ isError: true })
    expect(JSON.stringify(tamperedExport.output)).toContain('no fresh review bundle')
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

  it('hides and rejects managed tools without a host-minted workflow scope', async () => {
    const { pptWorkflowScope: _scope, ...unscoped } = context(process.cwd())
    const tools = buildPptAgentLocalTools({ toolchainDirectory: () => toolchain })
    expect(tools.every((tool) => tool.shouldAdvertise?.(unscoped) === false)).toBe(true)
    const result = await tools.find((tool) => tool.name === PPT_READ_GUIDE_TOOL_NAME)!
      .execute({ path: 'pptd.md' }, unscoped)
    expect(result).toMatchObject({ isError: true })
    expect(JSON.stringify(result.output)).toContain('host-scoped ppt_agent execution')
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
