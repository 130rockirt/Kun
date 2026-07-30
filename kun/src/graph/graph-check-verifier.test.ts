import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createGraphCheckVerifier } from './graph-check-verifier.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })))
})

describe('createGraphCheckVerifier', () => {
  it('checks staged worktree changes against HEAD', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'kun-graph-check-'))
    roots.push(repository)
    await mkdir(join(repository, 'src'))
    await writeFile(join(repository, 'src', 'file.txt'), 'base\n')
    await git(repository, ['init'])
    await git(repository, ['config', 'user.email', 'graph-test@example.test'])
    await git(repository, ['config', 'user.name', 'Graph Test'])
    await git(repository, ['add', '.'])
    await git(repository, ['commit', '-m', 'test: base'])
    await writeFile(join(repository, 'src', 'file.txt'), 'trailing whitespace   \n')
    await git(repository, ['add', '-A'])

    const [result] = await createGraphCheckVerifier()({
      attempt: {
        assignment: {
          workspaceRoot: repository,
          maxWallTimeMs: 60_000
        }
      },
      checkNames: ['git diff --check']
    })

    expect(result).toMatchObject({
      name: 'git diff --check',
      status: 'failed',
      command: ['git', 'diff', '--check', 'HEAD'],
      exitCode: 2
    })
    expect(result?.outputSummary).toContain('trailing whitespace')
  })
})

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}
