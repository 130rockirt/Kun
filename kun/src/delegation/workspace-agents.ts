import { constants, type Dirent } from 'node:fs'
import { open, readdir, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  SUBAGENT_READ_ONLY_TOOL_NAMES,
  SubagentProfileConfig,
  type SubagentMode,
  type SubagentToolPolicy
} from '../contracts/capabilities.js'

/**
 * Workspace-level agent overlay.
 *
 * Loads `<workspace>/.kun/agents/*.md` and produces a profile map that
 * the delegation runtime overlays on top of (`internal < GUI < workspace`).
 * Frontmatter format:
 *
 *     ---
 *     id: code-reviewer       # optional, defaults to filename stem
 *     name: Code Reviewer
 *     description: One-line "when to use"
 *     mode: subagent          # subagent | primary | all
 *     toolPolicy: readOnly    # default readOnly; set inherit for write tools
 *     allowedTools: [read, grep]
 *     omit_base_prompt: false # when true, role prompt replaces Kun base
 *     color: "#3b82f6"
 *     ---
 *     Body becomes the systemPrompt verbatim (kun's base prompt is
 *     prepended unless omit_base_prompt: true).
 *
 * Workspace roles enter automatic BM25/LLM routing (indexed by id/name/
 * description only — body is never searchable). They may opt into
 * `toolPolicy: inherit` for write tools under the parent capability
 * snapshot. They still cannot choose a model/provider/reasoning level,
 * cannot load skills, and cannot nest `delegate_task` / `generate_subagent`.
 * Files with invalid frontmatter are dropped silently so a single broken
 * file doesn't take down delegation.
 */
export type WorkspaceAgentProfile = {
  id: string
  source: 'workspace'
  filePath: string
  profile: SubagentProfileConfig
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const MAX_WORKSPACE_AGENT_FILES = 32
const MAX_WORKSPACE_AGENT_FILE_BYTES = 64 * 1024
const WORKSPACE_AGENT_LOCAL_READ_TOOLS = ['read', 'grep', 'glob', 'ls', 'repo_map'] as const

export async function loadWorkspaceAgentProfiles(workspace: string): Promise<WorkspaceAgentProfile[]> {
  if (!workspace) return []
  const workspaceRoot = resolve(workspace)
  const dir = join(workspaceRoot, '.kun', 'agents')
  let resolvedWorkspace: string
  let resolvedDir: string
  try {
    [resolvedWorkspace, resolvedDir] = await Promise.all([realpath(workspaceRoot), realpath(dir)])
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return []
    throw error
  }
  if (!isPathInside(resolvedWorkspace, resolvedDir)) return []

  let entries: Dirent<string>[]
  try {
    entries = await readdir(resolvedDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return []
    throw error
  }
  const results: WorkspaceAgentProfile[] = []
  for (const entry of entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_WORKSPACE_AGENT_FILES)) {
    const filePath = join(resolvedDir, entry.name)
    try {
      const text = await readWorkspaceAgentFile(filePath)
      if (text === null) continue
      const parsed = parseAgentMarkdown(text, entry.name.replace(/\.md$/i, ''))
      if (parsed) results.push({ ...parsed, filePath, source: 'workspace' })
    } catch {
      // Skip unreadable / malformed files; do not bubble — overlay should
      // never break the parent delegate_task call.
    }
  }
  return results
}

async function readWorkspaceAgentFile(path: string): Promise<string | null> {
  let handle: FileHandle | undefined
  try {
    handle = await open(
      path,
      process.platform === 'win32'
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW
    )
    const fileStat = await handle.stat()
    if (!fileStat.isFile() || fileStat.size > MAX_WORKSPACE_AGENT_FILE_BYTES) return null
    const buffer = Buffer.allocUnsafe(MAX_WORKSPACE_AGENT_FILE_BYTES + 1)
    let offset = 0
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    // A growing file cannot bypass the stat precheck and turn an overlay scan
    // into an unbounded read. Do not parse truncated configuration.
    if (offset > MAX_WORKSPACE_AGENT_FILE_BYTES) return null
    return buffer.subarray(0, offset).toString('utf8')
  } catch {
    return null
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function parseAgentMarkdown(text: string, defaultId: string): { id: string; profile: SubagentProfileConfig } | null {
  const match = FRONTMATTER_RE.exec(text)
  if (!match) return null
  const yamlRaw = match[1] ?? ''
  const body = text.slice(match[0].length).trim()
  const fields = parseSimpleYaml(yamlRaw)
  const id = fields.id?.trim() || defaultId
  if (!id) return null
  const omitBase = boolField(fields, 'omit_base_prompt') === true || boolField(fields, 'omitBasePrompt') === true
  const systemPromptFromBody = body || undefined
  const toolPolicy = normalizeToolPolicy(fields.toolPolicy)
  const requestedAllowedTools = parseListField(fields, 'allowedTools')
  const safeReadOnlyTools = new Set<string>(SUBAGENT_READ_ONLY_TOOL_NAMES)
  const localReadTools = new Set<string>(WORKSPACE_AGENT_LOCAL_READ_TOOLS)
  const allowedTools = toolPolicy === 'readOnly'
    ? (requestedAllowedTools ?? WORKSPACE_AGENT_LOCAL_READ_TOOLS)
      .filter((tool) => safeReadOnlyTools.has(tool) && localReadTools.has(tool))
    : requestedAllowedTools
  const raw: Record<string, unknown> = {
    ...(fields.name ? { name: fields.name } : {}),
    ...(fields.description ? { description: fields.description } : {}),
    ...(fields.color ? { color: fields.color } : {}),
    mode: normalizeMode(fields.mode),
    ...(fields.systemPrompt ? { systemPrompt: fields.systemPrompt } : systemPromptFromBody ? { systemPrompt: systemPromptFromBody } : {}),
    ...(omitBase ? { omitBasePrompt: true } : {}),
    ...(fields.promptPreamble ? { promptPreamble: fields.promptPreamble } : {}),
    toolPolicy,
    ...(toolPolicy === 'readOnly'
      ? { allowedTools: (allowedTools && allowedTools.length)
        ? allowedTools
        : [...WORKSPACE_AGENT_LOCAL_READ_TOOLS] }
      : allowedTools && allowedTools.length ? { allowedTools } : {}),
    blockedTools: [...new Set([
      'delegate_task',
      'generate_subagent',
      'load_skill',
      ...(parseListField(fields, 'blockedTools') ?? [])
    ])],
    ...(parseListField(fields, 'blockedMcpServers') ? { blockedMcpServers: parseListField(fields, 'blockedMcpServers') } : {}),
    ...(parseListField(fields, 'blockedSkills') ? { blockedSkills: parseListField(fields, 'blockedSkills') } : {}),
    skillsEnabled: false
  }
  const parsed = SubagentProfileConfig.safeParse(raw)
  if (!parsed.success) return null
  return { id, profile: parsed.data }
}

function normalizeMode(value: string | undefined): SubagentMode {
  if (value === 'primary' || value === 'all') return value
  return 'subagent'
}

function normalizeToolPolicy(value: string | undefined): SubagentToolPolicy {
  return value === 'inherit' ? 'inherit' : 'readOnly'
}

function boolField(fields: Record<string, string>, key: string): boolean | undefined {
  const raw = fields[key]?.trim().toLowerCase()
  if (raw === 'true' || raw === 'yes') return true
  if (raw === 'false' || raw === 'no') return false
  return undefined
}

function parseListField(fields: Record<string, string>, key: string): string[] | undefined {
  const raw = fields[key]?.trim()
  if (!raw) return undefined
  // Support both inline `[a, b, c]` and comma-separated `a, b, c`.
  const stripped = raw.replace(/^\[/, '').replace(/\]$/, '')
  const items = stripped.split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
    .slice(0, 32)
  return items.length ? items : undefined
}

/**
 * Lean YAML key:value parser. Only supports flat scalars, lists, and
 * double-quoted strings — sufficient for agent frontmatter without pulling
 * in a YAML dependency.
 */
function parseSimpleYaml(raw: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim()
    if (!line || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    if (!key) continue
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
    result[key] = value
  }
  return result
}
