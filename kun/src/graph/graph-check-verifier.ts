import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import type { GraphVerifiedCheckResultV1 } from '../contracts/graph.js'

const CHECK_COMMANDS: Readonly<Record<string, readonly [string, ...string[]]>> = {
  verification: ['git', 'diff', '--check', 'HEAD'],
  'git diff --check': ['git', 'diff', '--check', 'HEAD']
}

export function createGraphCheckVerifier(): (
  input: {
    attempt: { assignment: { workspaceRoot: string; maxWallTimeMs: number } }
    checkNames: readonly string[]
  }
) => Promise<GraphVerifiedCheckResultV1[]> {
  return async ({ attempt, checkNames }) => {
    const cwd = attempt.assignment.workspaceRoot
    const workspaceRevision = await captureWorkspaceRevision(cwd)
    const timeout = Math.max(1_000, Math.min(attempt.assignment.maxWallTimeMs, 15 * 60_000))
    const results: GraphVerifiedCheckResultV1[] = []
    for (const name of checkNames) {
      const command = CHECK_COMMANDS[name]
      if (!command) {
        results.push({
          name,
          status: 'not_run',
          summary: 'The requested check is not in the host verifier allow-list.',
          artifactRefs: [],
          command: ['not-allow-listed'],
          exitCode: null,
          workspaceRevision,
          outputSummary: 'The requested check is not in the host verifier allow-list.'
        })
        continue
      }
      const outcome = await run(command, cwd, timeout)
      results.push({
        name,
        status: outcome.exitCode === 0 ? 'passed' : 'failed',
        summary: outcome.exitCode === 0
          ? 'Host verification passed.'
          : `Host verification failed with exit code ${outcome.exitCode ?? 'unknown'}.`,
        artifactRefs: [],
        command: [...command],
        exitCode: outcome.exitCode,
        workspaceRevision,
        outputSummary: outcome.output
      })
    }
    return results
  }
}

async function captureWorkspaceRevision(cwd: string): Promise<string> {
  const [head, status] = await Promise.all([
    run(['git', 'rev-parse', '--verify', 'HEAD'], cwd, 10_000),
    run(['git', 'status', '--porcelain=v1', '--untracked-files=all'], cwd, 10_000)
  ])
  const headValue = head.exitCode === 0 ? head.output.trim().split(/\s+/)[0] : 'unborn'
  const worktree = createHash('sha256').update(status.output).digest('hex').slice(0, 16)
  return `${headValue}:${worktree}`.slice(0, 256)
}

function run(
  command: readonly [string, ...string[]],
  cwd: string,
  timeout: number
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    execFile(command[0], command.slice(1), {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`.trim().slice(0, 4_096)
      resolve({
        exitCode: typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
          ? (error as NodeJS.ErrnoException & { code: number }).code
          : error
            ? null
            : 0,
        output: output || (error ? error.message.slice(0, 4_096) : 'No output.')
      })
    })
  })
}
