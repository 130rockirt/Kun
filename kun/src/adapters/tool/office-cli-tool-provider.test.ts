import { createHash } from 'node:crypto'
import { link, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { buildOfficeCliLocalTools } from './office-cli-tool-provider.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function context(workspace: string): ToolHostContext {
  return {
    threadId: 'thread_office',
    turnId: 'turn_office',
    workspace,
    approvalPolicy: 'auto',
    sandboxMode: 'workspace-write',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('OfficeCLI controlled tools', () => {
  it('inspects a supported document without exposing an arbitrary command surface', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-office-tools-'))
    roots.push(workspace)
    const filePath = join(workspace, 'book.xlsx')
    await writeFile(filePath, 'source workbook')
    const run = vi.fn(async () => ({
      stdout: '{"sheets":2}',
      stderr: '',
      exitCode: 0
    }))
    const inspect = buildOfficeCliLocalTools({ run })[0]!

    const result = await inspect.execute({
      path: 'book.xlsx',
      action: 'summary'
    }, context(workspace))

    expect(result.isError).not.toBe(true)
    expect(result.output).toMatchObject({
      path: filePath,
      relative_path: 'book.xlsx',
      format: 'xlsx',
      source_sha256: sha256('source workbook'),
      action: 'summary',
      result: { sheets: 2 }
    })
    expect(run).toHaveBeenCalledWith(
      ['view', filePath, 'stats', '--json'],
      expect.any(AbortSignal)
    )
    expect(inspect.inputSchema).not.toHaveProperty('properties.command')
  })

  it('renders scoped previews through the screenshot surface without passing a raw command', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-office-tools-'))
    roots.push(workspace)
    const filePath = join(workspace, 'book.xlsx')
    await writeFile(filePath, 'source workbook')
    const run = vi.fn(async (args: readonly string[]) => {
      const outputIndex = args.indexOf('--out')
      if (outputIndex >= 0) await writeFile(args[outputIndex + 1]!, Buffer.from('PNG preview'))
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const preview = buildOfficeCliLocalTools({ run })[2]!

    const result = await preview.execute({
      path: 'book.xlsx',
      sheet: 'Sheet1',
      range: 'A1:C8'
    }, context(workspace))

    expect(result.isError).not.toBe(true)
    expect(result.output).toMatchObject({
      kind: 'image',
      path: filePath,
      mime_type: 'image/png',
      data_base64: Buffer.from('PNG preview').toString('base64')
    })
    const args = run.mock.calls[0]?.[0] ?? []
    expect(args).toEqual(expect.arrayContaining([
      'view',
      filePath,
      'screenshot',
      '--range',
      'Sheet1!A1:C8'
    ]))
    expect(args).not.toContain('--sheet')
  })

  it('edits a sibling copy and replaces the original only after validation succeeds', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-office-tools-'))
    roots.push(workspace)
    const filePath = join(workspace, 'book.xlsx')
    const source = Buffer.from('source workbook')
    await writeFile(filePath, source)
    const commands: string[][] = []
    const run = vi.fn(async (args: readonly string[]) => {
      commands.push([...args])
      if (args[0] === 'batch') {
        const stagedPath = args[1]!
        const batchInput = JSON.parse(await readFile(args[3]!, 'utf8'))
        expect(batchInput).toEqual([{
          command: 'set',
          path: '/Sheet1/A1',
          props: { value: '42' }
        }])
        await writeFile(stagedPath, 'edited workbook')
        return { stdout: '{"succeeded":1}', stderr: '', exitCode: 0 }
      }
      if (args[0] === 'validate') {
        return { stdout: '{"valid":true}', stderr: '', exitCode: 0 }
      }
      return { stdout: 'Workbook outline', stderr: '', exitCode: 0 }
    })
    const edit = buildOfficeCliLocalTools({ run })[1]!

    const result = await edit.execute({
      path: 'book.xlsx',
      expectedSha256: sha256(source),
      operations: [{
        type: 'set',
        target: '/Sheet1/A1',
        props: { value: '42' }
      }]
    }, context(workspace))

    expect(result.isError).not.toBe(true)
    expect(await readFile(filePath, 'utf8')).toBe('edited workbook')
    expect(result.output).toMatchObject({
      path: filePath,
      operations: 1,
      before_sha256: sha256(source),
      after_sha256: sha256('edited workbook'),
      preview_invalidated: true
    })
    expect(commands.map((args) => args[0])).toEqual(['view', 'batch', 'validate'])
    expect(await readdir(workspace)).toEqual(['book.xlsx'])
    expect(edit).toMatchObject({
      policy: 'on-request',
      toolKind: 'file_change',
      externalWritePathArguments: ['path']
    })
  })

  it('keeps the original byte-identical when validation fails', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-office-tools-'))
    roots.push(workspace)
    const filePath = join(workspace, 'deck.pptx')
    const source = Buffer.from('source deck')
    await writeFile(filePath, source)
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'batch') {
        await writeFile(args[1]!, 'invalid edited deck')
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      if (args[0] === 'validate') {
        return { stdout: '{"valid":false}', stderr: 'schema error', exitCode: 1 }
      }
      return { stdout: 'Deck outline', stderr: '', exitCode: 0 }
    })
    const edit = buildOfficeCliLocalTools({ run })[1]!

    const result = await edit.execute({
      path: 'deck.pptx',
      expectedSha256: sha256(source),
      operations: [{ type: 'remove', target: '/slide[1]/shape[1]' }]
    }, context(workspace))

    expect(result.isError).toBe(true)
    expect(result.output).toMatchObject({ error: expect.stringContaining('schema error') })
    expect(await readFile(filePath)).toEqual(source)
    expect(await readdir(workspace)).toEqual(['deck.pptx'])
  })

  it('refuses to overwrite a concurrent external change', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-office-tools-'))
    roots.push(workspace)
    const filePath = join(workspace, 'report.docx')
    const source = Buffer.from('source report')
    await writeFile(filePath, source)
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'batch') {
        await writeFile(args[1]!, 'edited report')
        await writeFile(filePath, 'changed by Word')
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      if (args[0] === 'validate') {
        return { stdout: '{"valid":true}', stderr: '', exitCode: 0 }
      }
      return { stdout: 'Document outline', stderr: '', exitCode: 0 }
    })
    const edit = buildOfficeCliLocalTools({ run })[1]!

    const result = await edit.execute({
      path: 'report.docx',
      expectedSha256: sha256(source),
      operations: [{
        type: 'replace_text',
        target: '/body',
        find: 'source',
        replace: 'edited'
      }]
    }, context(workspace))

    expect(result.isError).toBe(true)
    expect(await readFile(filePath, 'utf8')).toBe('changed by Word')
    expect(await readdir(workspace)).toEqual(['report.docx'])
  })

  it('rejects hard-linked Office targets before creating a staged edit', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-office-tools-'))
    roots.push(workspace)
    const filePath = join(workspace, 'report.docx')
    const aliasPath = join(workspace, 'report-copy.docx')
    const source = Buffer.from('source report')
    await writeFile(filePath, source)
    await link(filePath, aliasPath)
    const run = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    const edit = buildOfficeCliLocalTools({ run })[1]!

    const result = await edit.execute({
      path: 'report.docx',
      expectedSha256: sha256(source),
      operations: [{ type: 'remove', target: '/body/p[1]' }]
    }, context(workspace))

    expect(result).toMatchObject({
      isError: true,
      output: { error: expect.stringContaining('exactly one hard link') }
    })
    expect(run).not.toHaveBeenCalled()
    expect(await readFile(filePath)).toEqual(source)
    expect(await readFile(aliasPath)).toEqual(source)
  })
})
