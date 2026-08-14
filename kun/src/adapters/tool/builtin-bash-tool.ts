import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from './truncate.js'
import type { BashLocalToolOptions } from './builtin-tool-types.js'
import { DEFAULT_BACKGROUND_BASH_TIMEOUT_SECONDS, DEFAULT_BASH_TIMEOUT_SECONDS } from './builtin-tool-types.js'
import { createShellCommandRunner, ShellSpawnError, normalizePositiveInteger, withToolBoundary, workspaceRoot } from './builtin-tool-utils.js'
import { BashTimeoutError, bashExecute } from './builtin-bash-foreground.js'
import { startBackgroundBashSession } from './builtin-bash-background.js'
import {
  DEFAULT_FOREGROUND_BASH_LIVENESS_INTERVAL_MS,
  DEFAULT_MAX_BACKGROUND_BASH_TIMEOUT_SECONDS,
  DEFAULT_MAX_RUNNING_BACKGROUND_BASH_SESSIONS,
  DEFAULT_MAX_RUNNING_BACKGROUND_BASH_SESSIONS_PER_THREAD,
  resultPayload
} from './builtin-bash-session-state.js'
import type { BackgroundSessionLimits } from './builtin-bash-types.js'

export {
  DEFAULT_FOREGROUND_BASH_LIVENESS_INTERVAL_MS,
  DEFAULT_MAX_BACKGROUND_BASH_TIMEOUT_SECONDS,
  DEFAULT_MAX_RUNNING_BACKGROUND_BASH_SESSIONS,
  DEFAULT_MAX_RUNNING_BACKGROUND_BASH_SESSIONS_PER_THREAD,
  isBashSessionId,
  listBashSessionRecords,
  pollBashSession,
  readBashSessionPayload,
  stopBashSessionById,
  writeBashSessionStdin
} from './builtin-bash-session-state.js'

export function createBashLocalTool(options: BashLocalToolOptions = {}): LocalTool {
  const bashOps = options.operations
  const shellHooks = options.backgroundShell
  const backgroundShellDataDir = options.backgroundShellDataDir
  const backgroundLimits: BackgroundSessionLimits = {
    maxRunningSessions: Math.max(
      1,
      normalizePositiveInteger(
        options.maxBackgroundSessions,
        DEFAULT_MAX_RUNNING_BACKGROUND_BASH_SESSIONS
      )
    ),
    maxRunningSessionsPerThread: Math.max(
      1,
      normalizePositiveInteger(
        options.maxBackgroundSessionsPerThread,
        DEFAULT_MAX_RUNNING_BACKGROUND_BASH_SESSIONS_PER_THREAD
      )
    ),
    maxTimeoutSeconds: Math.max(
      1,
      normalizePositiveInteger(
        options.maxBackgroundTimeoutSeconds,
        DEFAULT_MAX_BACKGROUND_BASH_TIMEOUT_SECONDS
      )
    )
  }
  const outputLimits = {
    maxLines: options.maxLines ?? DEFAULT_MAX_LINES,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES
  }
  const foregroundTimeoutSeconds = normalizePositiveInteger(
    options.defaultTimeoutSeconds,
    DEFAULT_BASH_TIMEOUT_SECONDS
  )
  const backgroundTimeoutSeconds = normalizePositiveInteger(
    options.defaultBackgroundTimeoutSeconds,
    options.defaultTimeoutSeconds === undefined
      ? DEFAULT_BACKGROUND_BASH_TIMEOUT_SECONDS
      : foregroundTimeoutSeconds
  )
  const foregroundLivenessIntervalMs = normalizePositiveInteger(
    options.foregroundLivenessIntervalMs,
    DEFAULT_FOREGROUND_BASH_LIVENESS_INTERVAL_MS
  )
  const shellRunner = createShellCommandRunner()
  const shellRuntime = shellRunner.runtime
  return LocalToolHost.defineTool({
    name: 'bash',
    description: `Execute a shell command in the workspace using the host platform shell. Current shell: ${shellRuntime.name}. Use ${shellRuntime.syntax} syntax. Return combined stdout and stderr. Foreground commands run synchronously with a runtime-owned ${foregroundTimeoutSeconds}-second ceiling (15 minutes by default). Commands expected to run longer must set background=true; explicit background sessions have a ${backgroundTimeoutSeconds}-second ceiling (24 hours by default), keep running after the turn ends, and return an 8-character session_id. Use the background_shell tool to list, read, poll, write, or stop background sessions.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        background: { type: 'boolean', default: false }
      },
      required: ['command'],
      additionalProperties: false
    },
    policy: 'on-request',
    toolKind: 'command_execution',
    effects: {
      network: true,
      externalWrite: true,
      processExecution: true,
      guiAutomation: false
    },
    execute: async (args, context, onUpdate) => withToolBoundary(async () => {
      const command = typeof args.command === 'string' ? args.command : ''
      if (!command.trim()) return { output: { error: 'command is required' }, isError: true }
      const background = args.background === true
      const timeout = background ? backgroundTimeoutSeconds : foregroundTimeoutSeconds
      const cwd = workspaceRoot(context.workspace)
      try {
        if (background) {
          if (timeout > backgroundLimits.maxTimeoutSeconds) {
            return {
              output: {
                error: `background shell timeout exceeds ${backgroundLimits.maxTimeoutSeconds} seconds`,
                timeout
              },
              isError: true
            }
          }
          if (bashOps?.exec) {
            return {
              output: { error: 'background sessions are not supported with custom bash exec operations' },
              isError: true
            }
          }
          const result = await startBackgroundBashSession(
            {
              command,
              cwd,
              threadId: context.threadId,
              turnId: context.turnId,
              signal: context.abortSignal,
              timeoutSeconds: timeout,
              detached: true,
              dataDir: backgroundShellDataDir,
              outputLimits,
              backgroundLimits
            },
            shellHooks,
            onUpdate,
            shellRunner
          )
          return {
            output: result.payload,
            isError: result.isError
          }
        }
        const result = await bashExecute(
          command,
          cwd,
          context.abortSignal,
          timeout,
          outputLimits,
          foregroundLivenessIntervalMs,
          onUpdate,
          bashOps?.exec,
          shellRunner
        )
        const payload = resultPayload({
          command,
          cwd,
          shell: result.shell,
          exitCode: result.exitCode ?? 0,
          output: result.output,
          truncated: result.truncated,
          maxBytes: outputLimits.maxBytes,
          fullOutputPath: result.fullOutputPath
        })
        if (result.exitCode && result.exitCode !== 0) {
          return {
            output: payload,
            isError: true
          }
        }
        return {
          output: payload
        }
      } catch (error) {
        const spawnError = error instanceof ShellSpawnError ? error.toJSON() : undefined
        const timeoutError = error instanceof BashTimeoutError ? error : undefined
        return {
          output: {
            command,
            cwd,
            error: error instanceof Error ? error.message : String(error),
            ...(timeoutError
              ? { code: 'tool_timeout', timeout_seconds: timeoutError.timeoutSeconds }
              : {}),
            ...(spawnError ? { spawn_error: spawnError } : {})
          },
          isError: true
        }
      }
    })
  })
}

export const createBashTool = createBashLocalTool
export const createBashToolDefinition = createBashLocalTool
