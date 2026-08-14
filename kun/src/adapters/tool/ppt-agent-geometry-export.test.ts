import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
const sourceRequest = 'Create a restrained technical architecture deck with a complete visual system.'
const completePlan = {
  category: 'tech-engineering',
  audience: 'Engineering reviewers',
  purpose: 'Explain the architecture and support a decision',
  pageStrategy: { pageCount: 1, narrative: 'Evidence and decision' },
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
    threadId: 'thr_ppt_export_qa',
    turnId: 'turn_ppt_export_qa',
    workspace,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    approvalIntent: sourceRequest,
    pptWorkflowScope: {
      action: 'start',
      workflowId: 'ppt_workflow_qa',
      projectDir: '.',
      parentThreadId: 'thr_parent',
      previewMode: 'image-first',
      ...scope
    },
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}

function tools() {
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

async function governForExport(root: string): Promise<void> {
  const workflowId = 'ppt_workflow_qa'
  const toolContext = context(root, { workflowId })
  const localTools = tools()
  const guide = localTools.find((candidate) => candidate.name === PPT_READ_GUIDE_TOOL_NAME)!
  for (const path of ['slides_categories.md', 'slides_categories/tech-engineering.md']) {
    const result = await guide.execute({ workflowId, projectDir: '.', path, max_lines: 400 }, toolContext)
    if (result.isError) throw new Error(JSON.stringify(result.output))
  }
  const submit = localTools.find((candidate) => candidate.name === PPT_SUBMIT_DESIGN_PLAN_TOOL_NAME)!
  const plan = await submit.execute({ workflowId, projectDir: '.', plan: completePlan }, toolContext)
  if (plan.isError) throw new Error(JSON.stringify(plan.output))
  const review = localTools.find((candidate) => candidate.name === PPT_CREATE_REVIEW_BUNDLE_TOOL_NAME)!
  const bundle = await review.execute({
    workflowId,
    parentThreadId: 'thr_parent',
    projectDir: '.',
    deckTitle: 'Geometry QA export',
    pageCount: 1,
    slides: [{
      title: 'QA slide',
      prompt: 'Review geometry QA slide',
      error: 'preview unavailable in exporter test'
    }]
  }, toolContext)
  if (bundle.isError) throw new Error(JSON.stringify(bundle.output))
}

async function createTextDeck(root: string, fontSize: number): Promise<void> {
  await mkdir(join(root, 'pages'))
  await writeFile(join(root, 'deck.pptd'), [
    'version: v2',
    'title: Geometry QA export',
    'size: [960, 540]',
    'pages:',
    '  - pages/01.page',
    ''
  ].join('\n'))
  await writeFile(join(root, 'pages', '01.page'), [
    'pageType: content',
    'background:',
    '  type: solid',
    '  color: "#F7F8FA"',
    'elements:',
    '  - elementId: qa-text',
    '    elementType: text',
    '    bounds: [80, 120, 800, 240]',
    '    content:',
    `      fontSize: ${fontSize}`,
    '      color: "#18202A"',
    '      wrap: false',
    '      align: [left, top]',
    '      text: "Geometry QA text"',
    ''
  ].join('\n'))
}

afterEach(async () => {
  const cleanup = [...roots.splice(0), ...governanceRoots]
  governanceRoots.clear()
  await Promise.all(cleanup.map((root) => rm(root, { recursive: true, force: true })))
})

describe('PPT geometry QA export integration', () => {
  it('blocks publication and becomes recoverable after two repair retries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-ppt-export-qa-error-'))
    roots.push(root)
    await createTextDeck(root, 6)
    await governForExport(root)
    const exportTool = tools().find((candidate) => candidate.name === PPT_EXPORT_TOOL_NAME)!
    const exportContext = context(root, { action: 'approve_and_build' })

    for (const [attempt, remaining] of [[0, 2], [1, 1], [2, 0]] as const) {
      const result = await exportTool.execute({
        input: 'deck.pptd',
        output: 'presentations/deck.pptx'
      }, exportContext)
      expect(result).toMatchObject({
        isError: true,
        output: {
          validated: false,
          phase: attempt === 2 ? 'failed_recoverable' : 'validating_deck',
          qa: { attempt, counts: { errors: 1 } },
          repairAttemptsRemaining: remaining
        }
      })
      if (attempt === 2) {
        expect(result.output).toMatchObject({ reviewBundle: { phase: 'failed_recoverable' } })
      }
      await expect(readFile(join(root, 'presentations', 'deck.pptx'))).rejects.toMatchObject({ code: 'ENOENT' })
    }

    const report = JSON.parse(await readFile(join(root, '.kun-ppt-review', 'qa.json'), 'utf8'))
    expect(report).toMatchObject({ version: 1, attempt: 2, counts: { errors: 1 } })
    const manifest = JSON.parse(await readFile(join(root, '.kun-ppt-review', 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({
      phase: 'failed_recoverable',
      qa: { attempt: 2, counts: { errors: 1 } },
      slides: [{ qaIssues: [{ severity: 'error', rule: 'text.minimum_font_size' }] }]
    })

    const exhausted = await exportTool.execute({
      input: 'deck.pptd',
      output: 'presentations/deck.pptx'
    }, exportContext)
    expect(exhausted).toMatchObject({ isError: true })
  }, 60_000)

  it('publishes warning-only decks with the QA summary in the manifest and result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-ppt-export-qa-warning-'))
    roots.push(root)
    await createTextDeck(root, 9)
    await governForExport(root)
    const exportTool = tools().find((candidate) => candidate.name === PPT_EXPORT_TOOL_NAME)!

    const result = await exportTool.execute({
      input: 'deck.pptd',
      output: 'presentations/deck.pptx'
    }, context(root, { action: 'approve_and_build' }))

    expect(result).toMatchObject({
      output: {
        validated: true,
        qa: { attempt: 0, counts: { errors: 0, warnings: 1 } },
        reviewBundle: {
          phase: 'completed',
          slides: [{ qaIssues: [{ severity: 'warning', rule: 'text.minimum_font_size' }] }]
        }
      }
    })
    const manifest = JSON.parse(await readFile(join(root, '.kun-ppt-review', 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({
      phase: 'completed',
      qa: { attempt: 0, counts: { errors: 0, warnings: 1 } },
      validatedExport: { qa: { attempt: 0, counts: { errors: 0, warnings: 1 } } },
      slides: [{ qaIssues: [{ severity: 'warning', rule: 'text.minimum_font_size' }] }]
    })
    const pptx = await readFile(join(root, 'presentations', 'deck.pptx'))
    expect(pptx.subarray(0, 2).toString()).toBe('PK')
  }, 30_000)
})
