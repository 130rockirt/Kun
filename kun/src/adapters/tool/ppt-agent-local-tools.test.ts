import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolHostContext } from '../../ports/tool-host.js'
import {
  buildPptAgentLocalTools,
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
        fadeTransitions: 1,
        transition: 'fade',
        validated: true
      }
    })
    const pptx = await readFile(join(root, 'deck.pptx'))
    expect(pptx.length).toBeGreaterThan(1_000)
    expect(pptx.subarray(0, 2).toString()).toBe('PK')
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
