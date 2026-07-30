import type { LocalTool } from './local-tool-host.js'
import { spawnCapture, withToolBoundary, workspaceRoot } from './builtin-tool-utils.js'

const GIT_INSPECT_OPERATIONS = [
  'status',
  'branch',
  'log',
  'show',
  'diff',
  'merge-base',
  'rev-list',
  'rev-parse',
  'ls-files',
  'ls-tree'
] as const

type GitInspectOperation = typeof GIT_INSPECT_OPERATIONS[number]

const BLOCKED_ARGUMENTS = new Set([
  '--ext-diff',
  '--textconv',
  '--no-index',
  '--exec',
  '--open-files-in-pager',
  '-O'
])

const BRANCH_MUTATION_ARGUMENTS = new Set([
  '-d',
  '-D',
  '-m',
  '-M',
  '-c',
  '-C',
  '--delete',
  '--move',
  '--copy',
  '--edit-description',
  '--set-upstream-to',
  '--unset-upstream'
])

export function createGitInspectLocalTool(): LocalTool {
  return {
    name: 'git_inspect',
    description:
      'Run a host-allowlisted read-only Git inspection in the workspace. ' +
      'Use this in Plan mode for repository status, branches, history, revisions, diffs, merge bases, and file/tree listings. ' +
      'Pass the Git subcommand as operation and its remaining arguments as args.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: GIT_INSPECT_OPERATIONS
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 128,
          description:
            'Arguments after the Git subcommand, for example ["--short", "--branch"] or ["production:package.json"].'
        }
      },
      required: ['operation'],
      additionalProperties: false
    },
    policy: 'auto',
    toolKind: 'tool_call',
    sideEffect: 'read-only',
    effects: {
      network: false,
      externalWrite: false,
      processExecution: true,
      guiAutomation: false
    },
    execute: async (input, context) => withToolBoundary(async () => {
      const operation = typeof input.operation === 'string' ? input.operation : ''
      if (!isGitInspectOperation(operation)) {
        return {
          output: { error: `unsupported read-only Git operation: ${operation || '(missing)'}` },
          isError: true
        }
      }
      const parsedArgs = parseGitInspectArgs(input.args)
      if (!parsedArgs.ok) {
        return { output: { error: parsedArgs.error }, isError: true }
      }
      const policyError = gitInspectPolicyError(operation, parsedArgs.args)
      if (policyError) {
        return { output: { error: policyError }, isError: true }
      }

      const commandArgs = [
        '--no-pager',
        '-c',
        'core.pager=cat',
        '-c',
        'diff.external=',
        operation,
        ...parsedArgs.args
      ]
      const result = await spawnCapture('git', commandArgs, {
        cwd: workspaceRoot(context.workspace),
        signal: context.abortSignal
      })
      const output = `${result.stdout}${result.stderr}`.trim()
      return {
        output: {
          command: ['git', operation, ...parsedArgs.args],
          cwd: workspaceRoot(context.workspace),
          exit_code: result.exitCode,
          output,
          output_truncated: result.outputTruncated
        },
        isError: result.exitCode !== 0
      }
    })
  }
}

function isGitInspectOperation(value: string): value is GitInspectOperation {
  return (GIT_INSPECT_OPERATIONS as readonly string[]).includes(value)
}

function parseGitInspectArgs(
  value: unknown
): { ok: true; args: string[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, args: [] }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return { ok: false, error: 'args must be an array of strings' }
  }
  if (value.length > 128) return { ok: false, error: 'args may contain at most 128 entries' }
  const args = value as string[]
  if (args.some((arg) => arg.includes('\0'))) {
    return { ok: false, error: 'Git inspection arguments cannot contain NUL bytes' }
  }
  if (args.reduce((total, arg) => total + arg.length, 0) > 16_384) {
    return { ok: false, error: 'Git inspection arguments are too large' }
  }
  return { ok: true, args }
}

function gitInspectPolicyError(operation: GitInspectOperation, args: readonly string[]): string | null {
  for (const arg of args) {
    const option = arg.split('=', 1)[0] ?? arg
    if (
      BLOCKED_ARGUMENTS.has(option) ||
      option === '--output' ||
      option.startsWith('--output=')
    ) {
      return `Git argument is not allowed in read-only inspection: ${arg}`
    }
  }
  if (operation !== 'branch') return null
  if (args.some((arg) => BRANCH_MUTATION_ARGUMENTS.has(arg.split('=', 1)[0] ?? arg))) {
    return 'git branch mutation options are not allowed in read-only inspection'
  }
  if (args.length === 0) return null
  const listsBranches = args.some((arg) =>
    arg === '--show-current' ||
    arg === '--list' ||
    arg.startsWith('--list=') ||
    arg === '--all' ||
    arg === '--remotes' ||
    arg === '--contains' ||
    arg.startsWith('--contains=') ||
    arg === '--no-contains' ||
    arg.startsWith('--no-contains=') ||
    arg === '--merged' ||
    arg.startsWith('--merged=') ||
    arg === '--no-merged' ||
    arg.startsWith('--no-merged=') ||
    /^-[arv]+$/.test(arg)
  )
  return listsBranches
    ? null
    : 'git branch requires a listing option in read-only inspection'
}
