import type {
  AttachmentMetadata,
  GraphOrchestrationStrategy,
  GraphRunV1,
  ThreadGoalStatus,
  ThreadSummary,
  ThreadTodoItem,
  ThreadTodoStatus
} from '../contracts/index.js'
import {
  kunToolPermissionModeFromSettings,
  type ApprovalPolicy,
  type ApprovalReviewer,
  type SandboxMode
} from '../contracts/policy.js'
import {
  isModelConnectionProfileUsable,
  type ModelConnectionProfile,
  type ModelConnectionSnapshot
} from '../contracts/model-connections.js'
import type { ModelReasoningEffort, ModelReasoningCapabilityMetadata } from '../contracts/capabilities.js'
import { redactSecretText } from '../config/secret-redaction.js'
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename as renameFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { UserInputAnswer } from './client.js'
import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import {
  KunTuiClient,
  TuiClientError,
  type TuiConnection
} from './client.js'
import type { TuiOptions } from './options.js'
import {
  applyRuntimeEvent,
  hydrateProjectedChildRuns,
  matchingRequestContextSnapshot,
  projectThreadSnapshot,
  setProjectionRunningTurn,
  type ThreadProjection
} from './state.js'
import {
  emptyTuiPersistentState,
  modelStateKey,
  readTuiPersistentState,
  writeTuiPersistentState,
  type TuiPersistentState,
  type TuiRecentModel
} from './persistence.js'
import { modelCapabilitiesForProviderModel } from '../loop/model-context-profile.js'
import { setVisualTheme, type TuiThemeName } from './visual-system.js'
import {
  KunProjectConfigSchema,
  loadKunProjectConfig,
  writeKunProjectConfig
} from '../config/project-config.js'
import { readRuntimeDiscovery } from '../server/runtime-discovery.js'
import { parsePastedFilePaths } from './pasted-paths.js'
import type { ClipboardImage } from './clipboard-image.js'
import {
  isTerminalGraphRun,
  latestTuiGraphRun,
  summarizeTuiGraphRun
} from './graph-mode.js'
import { parseTuiFileMentions } from './file-mentions.js'
const execFile = promisify(execFileCallback)
import { safeMessage, modelConnectionUnavailableMessage, isRefreshConflict, isMissingThread, replaceGraphRun, splitWords, extensionGrantArguments, todoInput, resolveTodo, attachmentIdsFromProjection, mergeAttachmentMetadata, attachmentMimeType, isLikelyUtf8Text, isVideoPath, formatBytes, normalizeSkillId, skillTemplate, assertPathMissing, writeTextAtomically, isPathInside, validateSkillImportTree } from './controller-utils.js'
import { TuiControllerWorkspace } from './controller-workspace.js'

export abstract class TuiControllerIntegrations extends TuiControllerWorkspace {
  async showMcp(action?: string): Promise<void> {
    try {
      const value = action?.trim() ?? ''
      const [verb = '', serverId = '', transportOrTarget = '', ...arguments_] = splitWords(value)
      if (verb === 'authorize') {
        if (!serverId) throw new Error('Usage: /mcp authorize <server-id>')
        this.patch({ busy: true, busyLabel: 'Authorizing MCP server' })
        const result = await this.client.authorizeMcp(serverId)
        this.patch({ busy: false })
        this.notify(result.authorized
          ? `MCP server ${serverId} authorized.`
          : `MCP server ${serverId} authorization did not complete.`, result.authorized ? 'info' : 'error')
        return
      }
      if (verb === 'reset') {
        const result = await this.client.clearMcpOAuth(serverId || undefined)
        this.notify(result.cleared.length
          ? `Cleared MCP OAuth state: ${result.cleared.join(', ')}`
          : 'No MCP OAuth state needed clearing.')
        return
      }
      if (verb === 'add' || verb === 'edit') {
        if (!serverId || !transportOrTarget || !arguments_.length) {
          throw new Error('Usage: /mcp add <id> <stdio|http|sse|http-oauth> <command-or-url> [args...]')
        }
        const target = arguments_[0]!
        if (transportOrTarget === 'stdio') {
          await this.client.putMcpServer(serverId, {
            enabled: true,
            transport: 'stdio',
            command: target,
            args: arguments_.slice(1),
            env: {},
            headers: {},
            workspaceRoots: [],
            trustScope: 'user',
            trustedWorkspaceRoots: [],
            timeoutMs: 30_000
          })
        } else if (['http', 'sse', 'http-oauth'].includes(transportOrTarget)) {
          await this.client.putMcpServer(serverId, {
            enabled: true,
            transport: transportOrTarget === 'sse' ? 'sse' : 'streamable-http',
            url: target,
            args: [],
            env: {},
            headers: {},
            workspaceRoots: [],
            ...(transportOrTarget === 'http-oauth' ? { oauth: { enabled: true, scopes: [], callbackTimeoutMs: 120_000 } } : {}),
            trustScope: 'user',
            trustedWorkspaceRoots: [],
            timeoutMs: 30_000
          })
        } else {
          throw new Error('Transport must be stdio, http, sse, or http-oauth.')
        }
        this.notify(`MCP server ${serverId} saved and hot-applied.`)
        return
      }
      if (verb === 'enable' || verb === 'disable') {
        if (!serverId) throw new Error(`Usage: /mcp ${verb} <server-id>`)
        await this.client.setMcpServerEnabled(serverId, verb === 'enable')
        this.notify(`MCP server ${serverId} ${verb}d.`)
        return
      }
      if (verb === 'reconnect') {
        if (!serverId) throw new Error('Usage: /mcp reconnect <server-id>')
        const current = await this.client.mcpConfig()
        const configured = current.servers.find((server) => server.id === serverId)
        if (!configured) throw new Error(`Unknown MCP server: ${serverId}`)
        await this.client.setMcpServerEnabled(serverId, false)
        await this.client.setMcpServerEnabled(serverId, true)
        if (configured.oauth) {
          const authorization = await this.client.authorizeMcp(serverId)
          this.notify(authorization.authorized
            ? `MCP server ${serverId} reconnected and authorized.`
            : `MCP server ${serverId} restarted; OAuth still needs authorization.`, authorization.authorized ? 'info' : 'error')
        } else {
          this.notify(`MCP server ${serverId} reconnected.`)
        }
        return
      }
      if (verb === 'delete' || verb === 'remove') {
        if (!serverId) throw new Error(`Usage: /mcp ${verb} <server-id>`)
        await this.client.deleteMcpServer(serverId)
        this.notify(`MCP server ${serverId} removed.`)
        return
      }
      if (value && value !== 'list') {
        throw new Error('Usage: /mcp [list|add|edit|enable|disable|reconnect|delete|authorize|reset]')
      }
      const tools = await this.client.runtimeTools()
      const config = typeof this.client.mcpConfig === 'function'
        ? await this.client.mcpConfig().catch(() => ({ enabled: false, servers: [] }))
        : { enabled: false, servers: [] }
      const oauth = typeof this.client.mcpOAuth === 'function'
        ? await this.client.mcpOAuth().catch(() => ({ servers: [] }))
        : { servers: [] }
      const oauthById = new Map(oauth.servers.map((server) => [server.serverId, server]))
      const diagnosticsById = new Map(tools.mcpServers.map((server) => [server.id, server]))
      this.inspect('MCP servers', config.servers.length || tools.mcpServers.length
        ? [...new Set([...config.servers.map((server) => server.id), ...tools.mcpServers.map((server) => server.id)])]
          .flatMap((id) => {
            const server = diagnosticsById.get(id)
            const configured = config.servers.find((entry) => entry.id === id)
            return [
              `${id}: ${server?.status ?? (configured?.enabled ? 'reloading' : 'disabled')} · ${server?.toolCount ?? 0} tools · ${server?.transport ?? configured?.transport ?? 'unknown'}` +
                (oauthById.get(id) ? ` · OAuth ${oauthById.get(id)!.status}` : ''),
              ...(configured ? [`  Target: ${configured.target} · ${configured.trustScope}`] : []),
              ...(server?.toolNames.length ? [`  Tools: ${server.toolNames.join(', ')}`] : []),
              ...(server?.lastError ? [`  ${server.lastError}`] : []),
              ...(oauthById.get(id)?.lastError ? [`  OAuth: ${oauthById.get(id)!.lastError}`] : [])
            ]
          })
        : [
            'No MCP servers are configured.',
            'Use /mcp add <id> <stdio|http|sse|http-oauth> <target> [args...]'
          ])
    } catch (error) {
      this.fail(error)
    }
  }

  async showTasks(): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    try {
      const [delegation, shells, todos, goal, tools] = await Promise.all([
        this.client.delegationDiagnostics(projection.thread.id),
        this.client.backgroundShells(projection.thread.id),
        this.client.threadTodos(projection.thread.id),
        this.client.threadGoal(projection.thread.id),
        this.client.runtimeTools()
      ])
      const jobs = tools.extensions?.jobs
      const lines = [
        `Subagents: ${delegation.active} active / ${delegation.childRuns.length} total`,
        ...delegation.childRuns.map((run) => `  ${run.status} · ${run.label ?? run.profile ?? run.id} · ${run.prompt}`),
        `Background shells: ${shells.running} active / ${shells.sessions.length} total`,
        ...shells.sessions.map((shell) => `  ${shell.status} · ${shell.command}`),
        `Plan tasks: ${todos.todos?.items.length ?? 0}`,
        ...(todos.todos?.items.map((todo) => `  [${todo.status}] ${todo.content}`) ?? []),
        `Goal: ${goal.goal ? `${goal.goal.status} · ${goal.goal.objective}` : 'none'}`,
        `Extension jobs: ${jobs?.activeCount ?? 0} active / ${jobs?.recent.length ?? 0} recent`,
        ...(jobs?.recent.map((job) => `  ${job.state} · ${job.ownerExtensionId}/${job.kind} · ${job.action}`) ?? [])
      ]
      this.inspect('Tasks', lines)
    } catch (error) {
      this.fail(error)
    }
  }

  async manageSubagents(action?: string): Promise<boolean> {
    const projection = this.requireProjection()
    if (!projection) return false
    const value = action?.trim() ?? ''
    if (!value) return false
    const [verb = '', childId = '', ...arguments_] = splitWords(value)
    try {
      if (verb === 'abort') {
        if (!childId) throw new Error('Usage: /subagents abort <child-id>')
        const result = await this.client.abortDelegation(childId)
        if (!result.aborted) {
          const detail = projectThreadSnapshot(await this.client.getThread(childId))
          if (detail.runningTurnId) {
            await this.client.interruptTurn(childId, detail.runningTurnId)
            this.notify(`Subagent ${childId} interrupted.`)
          } else {
            this.notify(`Subagent ${childId} was not running.`)
          }
        } else {
          this.notify(`Subagent ${childId} aborted.`)
        }
        await this.reloadActiveThread()
        return true
      }
      if (verb === 'detach' || verb === 'background') {
        if (!childId) throw new Error('Usage: /subagents background <child-id>')
        const result = await this.client.detachDelegation(childId)
        this.notify(result.detached
          ? `Subagent ${childId} is continuing in the background.`
          : `Subagent ${childId} cannot be moved to the background.`)
        await this.reloadActiveThread()
        return true
      }
      if (verb === 'retry') {
        if (!childId) throw new Error('Usage: /subagents retry <child-id>')
        const diagnostics = await this.client.delegationDiagnostics(projection.thread.id)
        const child = diagnostics.childRuns.find((run) => run.id === childId)
        if (!child) throw new Error(`Unknown subagent: ${childId}`)
        await this.submit(`Retry the delegated task${child.profile ? ` with profile ${child.profile}` : ''}: ${child.prompt}`)
        return true
      }
      if (verb === 'steer') {
        const guidance = arguments_.join(' ').trim()
        if (!childId || !guidance) throw new Error('Usage: /subagents steer <child-id> <guidance>')
        const detail = projectThreadSnapshot(await this.client.getThread(childId))
        if (!detail.runningTurnId) throw new Error(`Subagent ${childId} is not running.`)
        await this.client.steerTurn(childId, detail.runningTurnId, guidance)
        this.notify(`Guidance queued for subagent ${childId}.`)
        return true
      }
      throw new Error('Usage: /subagents [abort|background|retry|steer] <child-id> [guidance]')
    } catch (error) {
      this.fail(error)
      return true
    }
  }

  async manageShells(action?: string): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    const value = action?.trim() ?? ''
    try {
      const [verb = '', sessionId = ''] = splitWords(value)
      if (verb === 'stop') {
        if (!sessionId) throw new Error('Usage: /shells stop <session-id>')
        const result = await this.client.stopBackgroundShell(sessionId)
        this.notify(result.stopped ? `Stopped background shell ${sessionId}.` : `Shell ${sessionId} was not running.`)
        return
      }
      if (verb === 'open' || verb === 'tail') {
        if (!sessionId) throw new Error(`Usage: /shells ${verb} <session-id>`)
        const shell = await this.client.backgroundShell(sessionId)
        this.inspect('Background shell', [
          `ID: ${shell.id}`,
          `Status: ${shell.status}${shell.exitCode !== null ? ` · exit ${shell.exitCode}` : ''}`,
          `Command: ${shell.command}`,
          `CWD: ${shell.cwd}`,
          '',
          shell.output || '(no output)',
          ...(shell.outputTruncated ? ['', '[output truncated]'] : []),
          ...(shell.error ? ['', `Error: ${shell.error}`] : [])
        ])
        return
      }
      if (value && value !== 'list') throw new Error('Usage: /shells [list|open <id>|tail <id>|stop <id>]')
      const shells = await this.client.backgroundShells(projection.thread.id)
      this.inspect('Background shells', shells.sessions.length
        ? shells.sessions.map((shell) =>
            `${shell.id} · ${shell.status}${shell.exitCode !== null ? ` · exit ${shell.exitCode}` : ''}\n  ${shell.command}`
          )
        : ['No background shell sessions for this session.'])
    } catch (error) {
      this.fail(error)
    }
  }

  async manageExtensions(action?: string): Promise<void> {
    const workspace = this.stateValue.projection?.thread.workspace ?? this.options.workspace
    const value = action?.trim() ?? ''
    try {
      const [verb = '', id = '', ...arguments_] = splitWords(value)
      if (verb === 'inspect') {
        if (!id) throw new Error('Usage: /extensions inspect <archive.kunx>')
        const path = isAbsolute(id) ? id : resolve(workspace, id)
        const result = await this.client.inspectExtension(path)
        const manifest = result.inspection.manifest
        this.inspect('Extension inspection', [
          `${manifest.publisher}.${manifest.name} · ${manifest.version}`,
          manifest.displayName ?? '',
          manifest.description ?? '',
          '',
          `Requested permissions: ${manifest.permissions.join(', ') || 'none'}`,
          'Install with: /extensions install <archive> [--grant=permission,...]'
        ].filter((line, index) => line.length > 0 || index === 3))
        return
      }
      if (verb === 'jobs') {
        const result = await this.client.extensionJobs()
        this.inspect('Extension jobs', result.jobs.length
          ? result.jobs.map((job) =>
              `${job.id} · ${job.state} · ${job.ownerExtensionId}/${job.kind} · attempt ${job.executionAttempt}\n  ${job.progress?.message ?? job.initiatingOperation}${job.error?.message ? `\n  Error: ${job.error.message}` : ''}`
            )
          : ['No extension jobs have been recorded.'])
        return
      }
      if (verb === 'cancel-job') {
        if (!id) throw new Error('Usage: /extensions cancel-job <job-id>')
        const result = await this.client.cancelExtensionJob(id)
        this.notify(result.accepted
          ? `Extension job ${id} cancellation requested.`
          : `Extension job ${id} is already ${result.job.state}.`)
        return
      }
      if (verb === 'install' || verb === 'dev') {
        if (!id) throw new Error(`Usage: /extensions ${verb} <path> [--grant=permission,...]`)
        const path = isAbsolute(id) ? id : resolve(workspace, id)
        const permissions = extensionGrantArguments(arguments_)
        const result = await this.client.installExtension({
          source: verb === 'dev' ? 'development' : 'archive',
          path,
          grantedPermissions: permissions
        })
        this.notify(`Extension ${result.extension.id}@${result.extension.version} installed and enabled.`)
        return
      }
      if (verb === 'index') {
        const [extensionId = '', extensionVersion = '', ...grantFlags] = arguments_
        if (!id || !extensionId || !extensionVersion) {
          throw new Error('Usage: /extensions index <index-url> <publisher.name> <version> [--grant=permission,...]')
        }
        const result = await this.client.installExtension({
          source: 'index',
          indexUrl: id,
          extensionId,
          version: extensionVersion,
          grantedPermissions: extensionGrantArguments(grantFlags)
        })
        this.notify(`Extension ${result.extension.id}@${result.extension.version} installed from index.`)
        return
      }
      if (verb === 'select') {
        if (!id || !arguments_[0]) throw new Error('Usage: /extensions select <publisher.name> <version>')
        await this.client.selectExtensionVersion(id, arguments_[0]!)
        this.notify(`Extension ${id} selected version ${arguments_[0]}.`)
        return
      }
      if (verb === 'permissions') {
        if (!id || !arguments_[0]) {
          throw new Error('Usage: /extensions permissions <publisher.name> <version> [permission,...|none]')
        }
        const permissions = arguments_[1] === undefined || arguments_[1] === 'none'
          ? null
          : arguments_[1]!.split(',').map((entry) => entry.trim()).filter(Boolean)
        await this.client.setExtensionPermissions(id, workspace, arguments_[0]!, permissions)
        this.notify(`Extension ${id} workspace permissions updated.`)
        return
      }
      if (verb === 'enable' || verb === 'disable') {
        if (!id) throw new Error(`Usage: /extensions ${verb} <publisher.name>`)
        await this.client.setExtensionEnabled(id, verb === 'enable', workspace)
        this.notify(`Extension ${id} ${verb}d for this workspace.`)
        return
      }
      if (verb === 'remove' || verb === 'uninstall') {
        if (!id) throw new Error(`Usage: /extensions ${verb} <publisher.name>`)
        await this.client.uninstallExtension(id)
        this.notify(`Extension ${id} removed; extension data was preserved.`)
        return
      }
      if (verb === 'rollback') {
        if (!id) throw new Error('Usage: /extensions rollback <publisher.name>')
        await this.client.rollbackExtension(id)
        this.notify(`Extension ${id} rolled back to its previous selected version.`)
        return
      }
      if (verb === 'reload') {
        if (!id) throw new Error('Usage: /extensions reload <publisher.name>')
        await this.client.reloadExtension(id)
        this.notify(`Development extension ${id} reloaded.`)
        return
      }
      if (verb === 'retry') {
        if (!id) throw new Error('Usage: /extensions retry <publisher.name>')
        const result = await this.client.retryExtension(id)
        this.notify(`Extension ${id} activation retry requested${result.diagnostic.state ? `: ${result.diagnostic.state}` : '.'}`)
        return
      }
      if (value && value !== 'list') {
        throw new Error('Usage: /extensions [list|jobs|cancel-job|inspect|install|dev|index|select|permissions|enable|disable|rollback|reload|retry|remove]')
      }
      const snapshot = await this.client.extensions(workspace)
      this.inspect('Extensions', snapshot.extensions.length
        ? snapshot.extensions.map((extension) => {
            const selected = extension.versions.find((version) => version.version === extension.selectedVersion) ??
              extension.development
            return `${extension.id} · ${(extension.effectiveEnabled ?? extension.globallyEnabled) ? 'enabled' : 'disabled'} · ${extension.selectedVersion ?? 'development'}\n  ${selected?.displayName ?? extension.id}${selected?.description ? ` — ${selected.description}` : ''}`
          })
        : ['No Kun extensions are installed.'])
    } catch (error) {
      this.fail(error)
    }
  }
}
