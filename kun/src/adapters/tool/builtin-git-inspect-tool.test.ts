import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { createGitInspectLocalTool } from './builtin-git-inspect-tool.js'

const execFileAsync = promisify(execFile)

describe('createGitInspectLocalTool', () => {
  let workspace = ''

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'kun-git-inspect-'))
    await execFileAsync('git', ['init'], { cwd: workspace })
    await execFileAsync('git', ['config', 'user.email', 'kun@example.test'], { cwd: workspace })
    await execFileAsync('git', ['config', 'user.name', 'Kun Test'], { cwd: workspace })
    await writeFile(join(workspace, 'README.md'), '# Test\n', 'utf8')
    await execFileAsync('git', ['add', 'README.md'], { cwd: workspace })
    await execFileAsync('git', ['commit', '-m', 'test fixture'], { cwd: workspace })
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('runs allowlisted repository inspections without a shell', async () => {
    const tool = createGitInspectLocalTool()
    const status = await tool.execute(
      { operation: 'status', args: ['--short', '--branch'] },
      context(workspace)
    )
    const log = await tool.execute(
      { operation: 'log', args: ['--oneline', '--decorate', '-1'] },
      context(workspace)
    )
    const grep = await tool.execute(
      { operation: 'grep', args: ['-n', 'Test', '--', 'README.md'] },
      context(workspace)
    )

    expect(status.isError).not.toBe(true)
    expect(status.output).toMatchObject({ exit_code: 0 })
    expect(JSON.stringify(status.output)).toContain('##')
    expect(log.isError).not.toBe(true)
    expect(JSON.stringify(log.output)).toContain('test fixture')
    expect(grep.isError).not.toBe(true)
    expect(grep.output).toMatchObject({
      command: ['git', 'grep', '-n', 'Test', '--', 'README.md'],
      exit_code: 0
    })
    expect(JSON.stringify(grep.output)).toContain('README.md:1:# Test')
  })

  it('allows branch listings and rejects branch mutations', async () => {
    const tool = createGitInspectLocalTool()
    const listing = await tool.execute(
      { operation: 'branch', args: ['-vv'] },
      context(workspace)
    )
    const mutation = await tool.execute(
      { operation: 'branch', args: ['new-branch'] },
      context(workspace)
    )

    expect(listing.isError).not.toBe(true)
    expect(mutation).toMatchObject({ isError: true })
    expect(JSON.stringify(mutation.output)).toContain('listing option')
    await expect(execFileAsync('git', ['show-ref', '--verify', 'refs/heads/new-branch'], {
      cwd: workspace
    })).rejects.toThrow()
  })

  it('rejects output-writing and external-diff arguments', async () => {
    const tool = createGitInspectLocalTool()
    for (const args of [['--output=result.txt'], ['--ext-diff']]) {
      const result = await tool.execute({ operation: 'diff', args }, context(workspace))
      expect(result).toMatchObject({ isError: true })
      expect(JSON.stringify(result.output)).toContain('not allowed')
    }
  })
})

function context(workspace: string): ToolHostContext {
  return {
    threadId: 'thread_1',
    turnId: 'turn_1',
    workspace,
    approvalPolicy: 'auto',
    sandboxMode: 'danger-full-access',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}
