import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolHostContext } from '../../ports/tool-host.js'
import {
  buildPptAgentLocalTools,
  PPT_EXPORT_TOOL_NAME,
  PPT_IMPORT_ASSET_TOOL_NAME
} from './ppt-agent-local-tools.js'

const cleanup: string[] = []
const toolchain = resolve(process.cwd(), '..', 'resources', 'ppt-toolchain')

function context(workspace: string): ToolHostContext {
  return {
    threadId: 'thr_physical_scope',
    turnId: 'turn_physical_scope',
    workspace,
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    allowedReadPaths: ['project', '.kun/images', 'presentations'],
    allowedWritePaths: ['project', '.kun/images', 'presentations'],
    pptWorkflowScope: {
      action: 'approve_and_build',
      workflowId: 'ppt_physical_scope',
      projectDir: 'project',
      parentThreadId: 'thr_parent',
      previewMode: 'image-first'
    },
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}

async function fixture(): Promise<{ root: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), 'kun-ppt-physical-'))
  const outside = await mkdtemp(join(tmpdir(), 'kun-ppt-outside-'))
  cleanup.push(root, outside)
  await Promise.all([
    mkdir(join(root, '.kun', 'images'), { recursive: true }),
    mkdir(join(root, 'project'), { recursive: true }),
    mkdir(join(root, 'presentations'), { recursive: true })
  ])
  return { root, outside }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('PPT physical path scopes', () => {
  it('imports generated image bytes unchanged into project/media', async () => {
    const { root } = await fixture()
    const bytes = Buffer.from([0, 255, 13, 10, 128, 64, 1])
    await writeFile(join(root, '.kun', 'images', 'source.png'), bytes)
    const tool = buildPptAgentLocalTools().find((entry) => entry.name === PPT_IMPORT_ASSET_TOOL_NAME)!

    const result = await tool.execute({ source: '.kun/images/source.png', name: 'asset.png' }, context(root))

    expect(result).toMatchObject({
      output: { source: '.kun/images/source.png', importedPath: 'project/media/asset.png', bytes: bytes.length }
    })
    expect(await readFile(join(root, 'project', 'media', 'asset.png'))).toEqual(bytes)
  })

  it('rejects source and destination symlink escapes before importing', async () => {
    const { root, outside } = await fixture()
    await writeFile(join(outside, 'secret.png'), Buffer.from([1, 2, 3]))
    await symlink(join(outside, 'secret.png'), join(root, '.kun', 'images', 'linked.png'))
    const tool = buildPptAgentLocalTools().find((entry) => entry.name === PPT_IMPORT_ASSET_TOOL_NAME)!

    const sourceEscape = await tool.execute({ source: '.kun/images/linked.png' }, context(root))
    expect(sourceEscape.isError).toBe(true)
    expect(JSON.stringify(sourceEscape.output)).toMatch(/symbolic link|junction|scope|workspace root/)

    await rm(join(root, '.kun', 'images', 'linked.png'))
    await writeFile(join(root, '.kun', 'images', 'source.png'), Buffer.from([4, 5, 6]))
    await symlink(outside, join(root, 'project', 'media'), 'dir')
    const destinationEscape = await tool.execute({ source: '.kun/images/source.png' }, context(root))
    expect(destinationEscape.isError).toBe(true)
    expect(JSON.stringify(destinationEscape.output)).toMatch(/symbolic link|junction|scope/)
    await expect(readFile(join(outside, 'source.png'))).rejects.toThrow()
  })

  it('rejects hard-linked image sources and existing hard-linked destinations', async () => {
    const { root, outside } = await fixture()
    await writeFile(join(outside, 'shared.png'), Buffer.from([7, 8, 9]))
    await link(join(outside, 'shared.png'), join(root, '.kun', 'images', 'hard.png'))
    const tool = buildPptAgentLocalTools().find((entry) => entry.name === PPT_IMPORT_ASSET_TOOL_NAME)!

    const sourceHardlink = await tool.execute({ source: '.kun/images/hard.png' }, context(root))
    expect(sourceHardlink.isError).toBe(true)
    expect(JSON.stringify(sourceHardlink.output)).toContain('hard-linked')

    await rm(join(root, '.kun', 'images', 'hard.png'))
    await writeFile(join(root, '.kun', 'images', 'source.png'), Buffer.from([10, 11]))
    await mkdir(join(root, 'project', 'media'))
    await link(join(outside, 'shared.png'), join(root, 'project', 'media', 'source.png'))
    const destinationHardlink = await tool.execute({ source: '.kun/images/source.png' }, context(root))
    expect(destinationHardlink.isError).toBe(true)
    expect(JSON.stringify(destinationHardlink.output)).toContain('hard-linked')
  })

  it('rejects ppt_export input and presentations output symlink escapes', async () => {
    const { root, outside } = await fixture()
    await writeFile(join(root, 'project', 'deck.pptd'), 'version: v2\ntitle: Test\nsize: [960, 540]\npages: []\n')
    const tool = buildPptAgentLocalTools({ toolchainDirectory: () => toolchain })
      .find((entry) => entry.name === PPT_EXPORT_TOOL_NAME)!
    await symlink(outside, join(root, 'presentations', 'linked'), 'dir')

    const outputEscape = await tool.execute({
      input: 'project/deck.pptd', output: 'presentations/linked/deck.pptx'
    }, context(root))
    expect(outputEscape.isError).toBe(true)
    expect(JSON.stringify(outputEscape.output)).toMatch(/symbolic link|junction|scope|workspace root/)

    await rm(join(root, 'presentations', 'linked'))
    await writeFile(join(outside, 'outside.pptd'), 'version: v2\npages: []\n')
    await symlink(join(outside, 'outside.pptd'), join(root, 'project', 'linked.pptd'))
    const inputEscape = await tool.execute({
      input: 'project/linked.pptd', output: 'presentations/deck.pptx'
    }, context(root))
    expect(inputEscape.isError).toBe(true)
    expect(JSON.stringify(inputEscape.output)).toMatch(/symbolic link|junction|scope|workspace root/)
  })
})
