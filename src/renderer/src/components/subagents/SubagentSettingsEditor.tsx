import type { Dispatch, ReactElement, ReactNode, SetStateAction } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { Bot, Check, ChevronDown, ChevronLeft, ChevronRight, Pencil, Plug, Plus, Power, Search, Sparkles, Trash2, Wrench, X } from 'lucide-react'
import type {
  KunRuntimeSettingsPatchV1,
  KunRuntimeSettingsV1,
  KunSubagentProfileV1,
  KunSubagentSurfaceV1,
  KunSubagentsSettingsV1,
  ModelProviderModelProfileV1,
  ModelReasoningEffort
} from '@shared/app-settings'
import type { ModelProviderModelGroup } from '@shared/kun-gui-api'
import { KUN_RUNTIME_TOOLS_PATH, kunDelegationProfilesPath } from '@shared/kun-endpoints'
import type { CoreRuntimeToolDiagnosticsJson } from '../../agent/kun-contract'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { confirmDialog } from '../../lib/confirm-dialog'
import { useChatStore } from '../../store/chat-store'
import { Toggle } from '../settings-controls'
import { AgentKun } from './AgentKun'
import {
  BUILTIN_AGENT_CATALOG,
  type BuiltinAgentCategory
} from '../../../../../kun/src/delegation/builtin-agent-catalog'

type EditorVariant = 'panel' | 'settings'

export type SubagentSettingsEditorProps = {
  kun: KunRuntimeSettingsV1
  onPatch: (patch: KunRuntimeSettingsPatchV1) => void | Promise<void>
  variant: EditorVariant
  className?: string
}

const EMPTY_SUBAGENTS: KunSubagentsSettingsV1 = {
  enabled: true,
  useExistingAgents: true,
  maxParallel: 256,
  profiles: []
}
const PRESET_COLORS = ['#3b82d8', '#1d9e75', '#e8943a', '#7f77dd', '#d4537e', '#d85a30']

/** kun's built-in tool names (mirror kun/src/adapters/tool/builtin-tool-types.ts). Small,
 *  stable set — a static catalog gives nicer labels than parsing the loose diagnostics shape. */
const BUILTIN_TOOL_NAMES = [
  'read',
  'grep',
  'find',
  'ls',
  'repo_map',
  'git_inspect',
  'edit',
  'write',
  'bash',
  'lsp',
  'verify_changes',
  'send_im_attachment'
] as const

type CapabilityCatalog = {
  mcpServers: Array<{ id: string; toolCount: number; status?: string }>
  skills: Array<{ id: string; name: string; description?: string }>
}

/** Fetch the live MCP-server + skill catalog from kun for the permission picker.
 *  Built-in tools come from the static list above; this only needs the dynamic bits.
 *  Returns empty lists on any failure so the dialog still renders. */
async function loadCapabilityCatalog(): Promise<CapabilityCatalog> {
  const empty: CapabilityCatalog = { mcpServers: [], skills: [] }
  try {
    const res = await rendererRuntimeClient.runtimeRequest(KUN_RUNTIME_TOOLS_PATH, 'GET')
    if (!res.ok) return empty
    const data = JSON.parse(res.body) as CoreRuntimeToolDiagnosticsJson
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')
    const mcpServers = (data.mcpServers ?? [])
      .map((raw) => {
        const rec = raw as Record<string, unknown>
        return { id: str(rec.id), toolCount: Number(rec.toolCount ?? 0) || 0, status: str(rec.status) || undefined }
      })
      .filter((server) => server.id)
    const skills = (data.skills?.skills ?? [])
      .map((raw) => {
        const rec = raw as Record<string, unknown>
        const id = str(rec.id)
        return { id, name: str(rec.name) || id, description: str(rec.description) || undefined }
      })
      .filter((skill) => skill.id)
    return { mcpServers, skills }
  } catch {
    return empty
  }
}

/** Canonical runtime catalog; settings store only user overrides. */
const BUILTIN_AGENTS: KunSubagentProfileV1[] = BUILTIN_AGENT_CATALOG.map((agent) => ({
  id: agent.id,
  enabled: true,
  name: agent.name,
  description: agent.description,
  mode: 'subagent',
  toolPolicy: agent.toolPolicy,
  color: agent.color,
  surfaces: [...agent.surfaces]
}))
const BUILTIN_IDS = new Set(BUILTIN_AGENTS.map((agent) => agent.id))
const BUILTIN_AGENT_BY_ID: ReadonlyMap<string, (typeof BUILTIN_AGENT_CATALOG)[number]> =
  new Map(BUILTIN_AGENT_CATALOG.map((agent) => [agent.id, agent]))

type AgentCategory = BuiltinAgentCategory | 'custom'
type AgentCatalogFilter = AgentCategory | 'base'
type AgentCategoryFilter = AgentCatalogFilter | 'all'
type SurfaceTab = KunSubagentSurfaceV1

const SURFACE_TABS: readonly SurfaceTab[] = ['shared', 'code', 'write', 'design']
const SETTINGS_PAGE_SIZE = 12

const AGENT_CATEGORY_ORDER: readonly AgentCategory[] = [
  'development',
  'review',
  'quality',
  'planning',
  'operations',
  'research',
  'custom'
]

type CatalogAgentSource = 'builtin' | 'configured' | 'workspace'

type CatalogAgent = {
  profile: KunSubagentProfileV1
  builtin: boolean
  source: CatalogAgentSource
  filePath?: string
  name: string
  desc: string
  category: AgentCategory
  baseAgent: boolean
  searchText: string
}

type WorkspaceAgentJson = {
  id: string
  source: 'workspace'
  filePath?: string
  name?: string
  description?: string
  mode?: KunSubagentProfileV1['mode']
  toolPolicy?: KunSubagentProfileV1['toolPolicy']
  color?: string
  systemPrompt?: string
  promptPreamble?: string
  allowedTools?: string[]
  blockedTools?: string[]
}

function workspaceProfileToKun(entry: WorkspaceAgentJson): KunSubagentProfileV1 {
  return {
    id: entry.id,
    enabled: true,
    name: entry.name?.trim() || entry.id,
    description: entry.description,
    mode: entry.mode === 'primary' || entry.mode === 'all' ? entry.mode : 'subagent',
    toolPolicy: entry.toolPolicy === 'inherit' ? 'inherit' : 'readOnly',
    color: entry.color,
    systemPrompt: entry.systemPrompt,
    promptPreamble: entry.promptPreamble,
    allowedTools: entry.allowedTools,
    blockedTools: entry.blockedTools,
    // Workspace markdown roles are available on every surface unless the file
    // later gains an explicit surfaces field; shared keeps them in the base pool.
    surfaces: ['shared']
  }
}

async function loadWorkspaceAgentCatalog(workspaceRoot: string): Promise<WorkspaceAgentJson[]> {
  const workspace = workspaceRoot.trim()
  if (!workspace) return []
  try {
    const res = await rendererRuntimeClient.runtimeRequest(
      kunDelegationProfilesPath(workspace),
      'GET'
    )
    if (!res.ok) return []
    const data = JSON.parse(res.body) as { profiles?: unknown }
    if (!Array.isArray(data.profiles)) return []
    return data.profiles.flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return []
      const rec = raw as Record<string, unknown>
      const id = typeof rec.id === 'string' ? rec.id.trim() : ''
      if (!id || rec.source !== 'workspace') return []
      return [{
        id,
        source: 'workspace' as const,
        ...(typeof rec.filePath === 'string' ? { filePath: rec.filePath } : {}),
        ...(typeof rec.name === 'string' ? { name: rec.name } : {}),
        ...(typeof rec.description === 'string' ? { description: rec.description } : {}),
        ...(rec.mode === 'primary' || rec.mode === 'all' || rec.mode === 'subagent'
          ? { mode: rec.mode }
          : {}),
        ...(rec.toolPolicy === 'inherit' || rec.toolPolicy === 'readOnly'
          ? { toolPolicy: rec.toolPolicy }
          : {}),
        ...(typeof rec.color === 'string' ? { color: rec.color } : {}),
        ...(typeof rec.systemPrompt === 'string' ? { systemPrompt: rec.systemPrompt } : {}),
        ...(typeof rec.promptPreamble === 'string' ? { promptPreamble: rec.promptPreamble } : {}),
        ...(Array.isArray(rec.allowedTools)
          ? { allowedTools: rec.allowedTools.filter((item): item is string => typeof item === 'string') }
          : {}),
        ...(Array.isArray(rec.blockedTools)
          ? { blockedTools: rec.blockedTools.filter((item): item is string => typeof item === 'string') }
          : {})
      }]
    })
  } catch {
    return []
  }
}

function newProfile(surface: SurfaceTab): KunSubagentProfileV1 {
  return {
    id: crypto.randomUUID(),
    enabled: true,
    name: '',
    mode: 'subagent',
    toolPolicy: 'readOnly',
    surfaces: [surface]
  }
}

function profileSurfaces(profile: KunSubagentProfileV1): KunSubagentSurfaceV1[] {
  if (profile.surfaces !== undefined) {
    return profile.surfaces.includes('shared') ? ['shared'] : [...new Set(profile.surfaces)]
  }
  const builtin = BUILTIN_AGENT_BY_ID.get(profile.id)
  return builtin ? [...builtin.surfaces] : ['shared']
}

function profileAvailableOnSurface(
  profile: KunSubagentProfileV1,
  surface: Exclude<SurfaceTab, 'shared'>
): boolean {
  const surfaces = profileSurfaces(profile)
  return surfaces.includes('shared') || surfaces.includes(surface)
}

// Reasoning-effort segment (mirrors the composer's reasoning picker). Labels
// reuse the composer i18n keys (composerReasoning*). When a model declares
// supportedEfforts those are used; otherwise the full list is offered so
// follow-default / unprofiled models can still set profile.reasoningEffort.
const REASONING_OPTIONS: Array<{ id: ModelReasoningEffort; labelKey: string }> = [
  { id: 'auto', labelKey: 'composerReasoningAuto' },
  { id: 'off', labelKey: 'composerReasoningOff' },
  { id: 'low', labelKey: 'composerReasoningLow' },
  { id: 'medium', labelKey: 'composerReasoningMedium' },
  { id: 'high', labelKey: 'composerReasoningHigh' },
  { id: 'max', labelKey: 'composerReasoningMax' }
]

function normalizeModelCapabilityKey(modelId: string): string {
  return modelId.trim().toLowerCase()
}

/** Resolve the model profile for (group, model), matching by id or alias. */
function modelProfileForModel(
  group: ModelProviderModelGroup | undefined,
  modelId: string
): ModelProviderModelProfileV1 | undefined {
  if (!group || !modelId) return undefined
  const key = normalizeModelCapabilityKey(modelId)
  if (!key) return undefined
  const profiles = group.modelProfiles ?? {}
  const direct = profiles[key] ?? profiles[modelId.trim()]
  if (direct) return direct
  return Object.values(profiles).find((p) =>
    p.aliases?.some((alias) => normalizeModelCapabilityKey(alias) === key)
  )
}

/** Capability-gated options for a model profile; empty when unsupported/unknown. */
function reasoningOptionsForModel(
  profile: ModelProviderModelProfileV1 | undefined
): Array<{ id: ModelReasoningEffort; labelKey: string }> {
  const supported = profile?.reasoning?.supportedEfforts
  if (!supported || supported.length === 0) return []
  return supported
    .map((effort) => REASONING_OPTIONS.find((o) => o.id === effort))
    .filter((o): o is { id: ModelReasoningEffort; labelKey: string } => Boolean(o))
}

/** Resolve picker options: prefer model capability list, else full REASONING_OPTIONS. */
function resolveReasoningOptions(
  groups: ModelProviderModelGroup[],
  model: string,
  providerId: string
): Array<{ id: ModelReasoningEffort; labelKey: string }> {
  if (!model) return REASONING_OPTIONS
  const selectedGroup = providerId ? groups.find((group) => group.providerId === providerId) : undefined
  const profile = modelProfileForModel(selectedGroup, model)
    ?? groups.map((group) => modelProfileForModel(group, model)).find(Boolean)
  const gated = reasoningOptionsForModel(profile)
  return gated.length > 0 ? gated : REASONING_OPTIONS
}

function normalizeStoredReasoning(effort: string | undefined): ModelReasoningEffort {
  return effort && REASONING_OPTIONS.some((option) => option.id === effort)
    ? (effort as ModelReasoningEffort)
    : 'off'
}

type RoleSlot = {
  model: string
  providerId: string
}

export function SubagentSettingsEditor({
  kun,
  onPatch,
  variant,
  className
}: SubagentSettingsEditorProps): ReactElement {
  const { t } = useTranslation('common')
  const { t: tSettings } = useTranslation('settings')
  const composerModelGroups = useChatStore((s) => s.composerModelGroups)
  const activeRoute = useChatStore((s) => s.route)
  const workspaceRoot = useChatStore((s) => s.workspaceRoot)
  const loadComposerModels = useChatStore((s) => s.loadComposerModels)
  const [dialog, setDialog] = useState<{ profile: KunSubagentProfileV1; isNew: boolean } | null>(null)
  const [catalogQuery, setCatalogQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<AgentCategoryFilter>(variant === 'panel' ? 'base' : 'all')
  const [selectedSurface, setSelectedSurface] = useState<SurfaceTab>('shared')
  const [catalogPage, setCatalogPage] = useState(1)
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)
  const [collapsedCategories, setCollapsedCategories] = useState<Set<AgentCategory>>(
    () => new Set(AGENT_CATEGORY_ORDER.slice(1))
  )
  const [systemRolesOpen, setSystemRolesOpen] = useState(false)
  const [workspaceAgents, setWorkspaceAgents] = useState<WorkspaceAgentJson[]>([])
  const subagents = kun.subagents ?? EMPTY_SUBAGENTS
  // Compaction always runs in model mode (the heuristic fold is only a silent
  // fallback when the model call fails), so there is no user-facing mode toggle.
  // The model lives under contextCompaction.summaryModel (distinct from the
  // top-level kun.summaryModel, which drives the session-summary role).
  const compactionSlot: RoleSlot = {
    model: kun.contextCompaction.summaryModel ?? '',
    providerId: kun.contextCompaction.summaryProviderId ?? ''
  }
  const smallModel: RoleSlot = { model: kun.smallModel ?? '', providerId: kun.smallModelProviderId ?? '' }
  const titleSlot: RoleSlot = { model: kun.titleModel ?? '', providerId: kun.titleProviderId ?? '' }
  const summarySlot: RoleSlot = { model: kun.summaryModel ?? '', providerId: kun.summaryProviderId ?? '' }
  const codeReviewSlot: RoleSlot = { model: kun.codeReviewModel ?? '', providerId: kun.codeReviewProviderId ?? '' }
  const planSlot: RoleSlot = { model: kun.planModel ?? '', providerId: kun.planProviderId ?? '' }
  const titleReasoning = kun.titleReasoningEffort ?? 'off'
  const summaryReasoning = kun.summaryReasoningEffort ?? 'off'
  const codeReviewReasoning = kun.codeReviewReasoningEffort ?? 'off'

  useEffect(() => { void loadComposerModels() }, [loadComposerModels])

  useEffect(() => {
    let cancelled = false
    const workspace = workspaceRoot?.trim() ?? ''
    if (!workspace) {
      setWorkspaceAgents([])
      return
    }
    void loadWorkspaceAgentCatalog(workspace).then((agents) => {
      if (cancelled) return
      setWorkspaceAgents(agents)
      if (agents.length === 0) return
      // Sidebar defaults to the base filter; promote to "all" once so
      // workspace-defined custom roles are visible without hunting filters.
      if (variant === 'panel') {
        setCategoryFilter((current) => (current === 'base' ? 'all' : current))
      }
      setCollapsedCategories((current) => {
        if (!current.has('custom')) return current
        const next = new Set(current)
        next.delete('custom')
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [variant, workspaceRoot])

  const patchSubagents = useCallback((patch: Partial<KunSubagentsSettingsV1>): void => {
    void onPatch({
      subagents: {
        ...subagents,
        ...patch,
        profiles: patch.profiles ?? subagents.profiles
      }
    })
  }, [onPatch, subagents])

  const persistProfiles = useCallback((profiles: KunSubagentProfileV1[]): void => {
    const defaultProfile = subagents.defaultProfile
    patchSubagents({
      profiles,
      ...(defaultProfile && !profiles.some((profile) => profile.enabled && profile.id === defaultProfile)
        ? { defaultProfile: '' }
        : {})
    })
  }, [patchSubagents, subagents.defaultProfile])

  // Built-ins may not be in settings yet — upsert so configuring one persists it for the first time.
  const upsertProfile = useCallback((id: string, patch: Partial<KunSubagentProfileV1>): void => {
    const baseline = subagents.profiles.find((p) => p.id === id) ?? BUILTIN_AGENTS.find((p) => p.id === id)
    if (!baseline) return
    const next = { ...baseline, ...patch }
    const exists = subagents.profiles.some((p) => p.id === id)
    persistProfiles(exists ? subagents.profiles.map((p) => (p.id === id ? next : p)) : [...subagents.profiles, next])
  }, [subagents.profiles, persistProfiles])

  const setProfileModel = useCallback((id: string, model: string, providerId: string): void => {
    upsertProfile(id, {
      ...(model ? { model } : { model: undefined }),
      ...(providerId ? { providerId } : { providerId: undefined })
    })
  }, [upsertProfile])

  // Batch-apply one model pair to every id in a single persistProfiles write so
  // sequential upserts cannot clobber each other.
  const setCategoryModels = useCallback((ids: string[], model: string, providerId: string): void => {
    if (ids.length === 0) return
    const modelPatch: Pick<KunSubagentProfileV1, 'model' | 'providerId'> = {
      model: model || undefined,
      providerId: providerId || undefined
    }
    let next = [...subagents.profiles]
    for (const id of ids) {
      const existingIdx = next.findIndex((profile) => profile.id === id)
      const baseline = (existingIdx >= 0 ? next[existingIdx] : undefined)
        ?? BUILTIN_AGENTS.find((profile) => profile.id === id)
      if (!baseline) continue
      const patched = { ...baseline, ...modelPatch }
      if (existingIdx >= 0) next[existingIdx] = patched
      else next.push(patched)
    }
    persistProfiles(next)
  }, [subagents.profiles, persistProfiles])

  // Per-profile reasoning depth. 'off' is the default → store undefined so the
  // round-trip omits it (mergeKunRuntimeSettings strips 'off'/invalid).
  const setProfileReasoning = useCallback((id: string, effort: ModelReasoningEffort): void => {
    upsertProfile(id, { reasoningEffort: effort === 'off' ? undefined : effort })
  }, [upsertProfile])

  const setCategoryReasoning = useCallback((ids: string[], effort: ModelReasoningEffort): void => {
    if (ids.length === 0) return
    const reasoningEffort = effort === 'off' ? undefined : effort
    let next = [...subagents.profiles]
    for (const id of ids) {
      const existingIdx = next.findIndex((profile) => profile.id === id)
      const baseline = (existingIdx >= 0 ? next[existingIdx] : undefined)
        ?? BUILTIN_AGENTS.find((profile) => profile.id === id)
      if (!baseline) continue
      const patched = { ...baseline, reasoningEffort }
      if (existingIdx >= 0) next[existingIdx] = patched
      else next.push(patched)
    }
    persistProfiles(next)
  }, [subagents.profiles, persistProfiles])

  const resetCategoryConfiguration = useCallback((ids: string[]): void => {
    if (ids.length === 0) return
    let next = [...subagents.profiles]
    for (const id of ids) {
      const existingIdx = next.findIndex((profile) => profile.id === id)
      const baseline = (existingIdx >= 0 ? next[existingIdx] : undefined)
        ?? BUILTIN_AGENTS.find((profile) => profile.id === id)
      if (!baseline) continue
      const reset = {
        ...baseline,
        model: undefined,
        providerId: undefined,
        reasoningEffort: undefined
      }
      if (existingIdx >= 0) next[existingIdx] = reset
      else next.push(reset)
    }
    persistProfiles(next)
  }, [subagents.profiles, persistProfiles])

  const toggleEnabled = useCallback((id: string): void => {
    const cur = subagents.profiles.find((p) => p.id === id) ?? BUILTIN_AGENTS.find((p) => p.id === id)
    upsertProfile(id, { enabled: !(cur?.enabled ?? true) })
  }, [subagents.profiles, upsertProfile])

  const removeProfile = useCallback(async (id: string): Promise<void> => {
    const p = subagents.profiles.find((x) => x.id === id)
    if (!(await confirmDialog(t('agentsView.deleteConfirm', 'Delete this agent?'), p?.name ?? id))) return
    persistProfiles(subagents.profiles.filter((x) => x.id !== id))
  }, [subagents.profiles, persistProfiles, t])

  const saveDialog = useCallback((profile: KunSubagentProfileV1): void => {
    const exists = subagents.profiles.some((p) => p.id === profile.id)
    persistProfiles(exists
      ? subagents.profiles.map((p) => (p.id === profile.id ? profile : p))
      : [...subagents.profiles, profile])
    setDialog(null)
  }, [subagents.profiles, persistProfiles])

  // Compaction model override is nested under contextCompaction (not a flat
  // kun.* key), so it needs its own patch. Empty string clears it → compaction
  // falls back to the main conversation model.
  const persistCompactionSlot = useCallback((model: string, providerId: string): void => {
    void onPatch({ contextCompaction: { summaryModel: model, summaryProviderId: providerId } })
  }, [onPatch])

  // Each role slot patches its own agents.kun.* override fields. The model/
  // provider keys are typed pairs on KunRuntimeSettingsV1; empty string clears
  // them server-side (mergeKunRuntimeSettings omits blank slots).
  const persistRoleSlot = useCallback(
    (
      modelKey: 'smallModel' | 'titleModel' | 'summaryModel' | 'codeReviewModel' | 'planModel',
      providerKey: 'smallModelProviderId' | 'titleProviderId' | 'summaryProviderId' | 'codeReviewProviderId' | 'planProviderId',
      model: string,
      providerId: string
    ): void => {
      void onPatch({ [modelKey]: model, [providerKey]: providerId })
    },
    [onPatch]
  )

  // Persist a role-level reasoning slot to agents.kun.*. 'off' is the default;
  // mergeKunRuntimeSettings strips 'off'/invalid, so the field round-trips clean.
  const persistRoleReasoning = useCallback(
    (
      key: 'titleReasoningEffort' | 'summaryReasoningEffort' | 'codeReviewReasoningEffort',
      effort: ModelReasoningEffort
    ): void => {
      void onPatch({ [key]: effort })
    },
    [onPatch]
  )

  const isBuiltin = (id: string): boolean => BUILTIN_IDS.has(id)
  const delegatable = useMemo(() => {
    // Kun always installs its first-party profiles at composition time. Until
    // the runtime contract has an explicit disabled-builtin list, presenting a
    // power switch here would be a false promise: an omitted builtin is added
    // back by mergeBuiltinSubagentProfiles(). Keep those rows honestly enabled.
    const builtins = BUILTIN_AGENTS.map((builtin) => {
      const override = subagents.profiles.find((profile) => profile.id === builtin.id)
      return override ? { ...builtin, ...override, enabled: true } : builtin
    })
    const custom = subagents.profiles.filter((p) => !BUILTIN_IDS.has(p.id))
    return [...builtins, ...custom]
  }, [subagents.profiles])

  const extensionAgentIds = useMemo(() => new Set(
    BUILTIN_AGENT_CATALOG
      .filter((agent) => agent.family !== 'base')
      .map((agent) => agent.id)
  ), [])
  const extensionAgentsEnabled = delegatable.some((profile) =>
    extensionAgentIds.has(profile.id) && profileSurfaces(profile).length > 0
  )
  const setExtensionAgentsEnabled = useCallback((enabled: boolean): void => {
    const profilesById = new Map(subagents.profiles.map((profile) => [profile.id, profile]))
    for (const builtin of BUILTIN_AGENTS) {
      if (!extensionAgentIds.has(builtin.id)) continue
      const current = profilesById.get(builtin.id) ?? builtin
      const activeSurfaces: KunSubagentSurfaceV1[] = [
        ...(BUILTIN_AGENT_BY_ID.get(builtin.id)?.recommendedSurfaces ?? [])
      ]
      profilesById.set(builtin.id, {
        ...current,
        surfaces: enabled ? activeSurfaces : []
      })
    }
    persistProfiles([...profilesById.values()])
  }, [extensionAgentIds, persistProfiles, subagents.profiles])

  const toggleSurface = useCallback((id: string, surface: SurfaceTab): void => {
    const profile = delegatable.find((candidate) => candidate.id === id)
    if (!profile || (id === 'general' && surface === 'shared')) return
    const current = profileSurfaces(profile)
    if (surface === 'shared') {
      upsertProfile(id, { surfaces: current.includes('shared') ? [] : ['shared'] })
      return
    }
    if (current.includes('shared')) return
    const next = current.includes(surface)
      ? current.filter((candidate) => candidate !== surface)
      : [...current, surface]
    upsertProfile(id, { surfaces: next })
  }, [delegatable, upsertProfile])

  const catalogAgents = useMemo<CatalogAgent[]>(() => {
    const workspaceById = new Map(workspaceAgents.map((entry) => [entry.id, entry]))
    const seen = new Set<string>()
    const rows: CatalogAgent[] = []

    for (const profile of delegatable) {
      const workspace = workspaceById.get(profile.id)
      const builtin = isBuiltin(profile.id)
      const metadata = BUILTIN_AGENT_BY_ID.get(profile.id)
      if (workspace) {
        const merged = {
          ...workspaceProfileToKun(workspace),
          // Keep any GUI surface/model overrides when the same id exists in settings,
          // but the role body still comes from the workspace markdown overlay.
          ...(profile.surfaces !== undefined ? { surfaces: profile.surfaces } : {}),
          ...(profile.model ? { model: profile.model } : {}),
          ...(profile.providerId ? { providerId: profile.providerId } : {}),
          ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {})
        }
        const name = merged.name || merged.id
        const desc = merged.description ?? ''
        rows.push({
          profile: merged,
          builtin: false,
          source: 'workspace',
          ...(workspace.filePath ? { filePath: workspace.filePath } : {}),
          name,
          desc,
          // Overlays of first-party ids keep their catalog category so Base/filters
          // still find them; pure workspace ids land in custom.
          category: metadata?.category ?? 'custom',
          baseAgent: metadata?.family === 'base',
          searchText: [merged.id, name, desc, workspace.filePath, metadata?.name, metadata?.description]
            .filter(Boolean)
            .join(' ')
            .toLocaleLowerCase()
        })
        seen.add(profile.id)
        continue
      }
      const name = builtin
        ? t(`subagentsPanel.role.${profile.id}.name`, profile.name || profile.id)
        : profile.name || profile.id
      const desc = builtin
        ? t(`subagentsPanel.role.${profile.id}.desc`, profile.description ?? '')
        : (profile.description ?? '')
      const category: AgentCategory = metadata?.category ?? 'custom'
      const baseAgent = metadata?.family === 'base'
      rows.push({
        profile,
        builtin,
        source: builtin ? 'builtin' : 'configured',
        name,
        desc,
        category,
        baseAgent,
        searchText: [
          profile.id,
          name,
          desc,
          metadata?.name,
          metadata?.description,
          ...(metadata?.routingTerms ?? [])
        ].filter(Boolean).join(' ').toLocaleLowerCase()
      })
      seen.add(profile.id)
    }

    for (const workspace of workspaceAgents) {
      if (seen.has(workspace.id)) continue
      const profile = workspaceProfileToKun(workspace)
      const name = profile.name || profile.id
      const desc = profile.description ?? ''
      rows.push({
        profile,
        builtin: false,
        source: 'workspace',
        ...(workspace.filePath ? { filePath: workspace.filePath } : {}),
        name,
        desc,
        category: 'custom',
        baseAgent: false,
        searchText: [profile.id, name, desc, workspace.filePath].filter(Boolean).join(' ').toLocaleLowerCase()
      })
    }

    return rows.sort((left, right) => {
      const categoryDelta = AGENT_CATEGORY_ORDER.indexOf(left.category) - AGENT_CATEGORY_ORDER.indexOf(right.category)
      return categoryDelta || left.name.localeCompare(right.name)
    })
  }, [delegatable, t, workspaceAgents])

  const panelSurface: Exclude<SurfaceTab, 'shared'> = activeRoute === 'write'
    ? 'write'
    : activeRoute === 'design'
      ? 'design'
      : 'code'

  const normalizedQuery = catalogQuery.trim().toLocaleLowerCase()
  const filteredCatalogAgents = useMemo(() => catalogAgents.filter((agent) => {
    if (variant === 'panel' && !profileAvailableOnSurface(agent.profile, panelSurface)) return false
    if (categoryFilter === 'base' && !agent.baseAgent) return false
    if (categoryFilter !== 'all' && categoryFilter !== 'base' && agent.category !== categoryFilter) return false
    return !normalizedQuery || agent.searchText.includes(normalizedQuery)
  }), [catalogAgents, categoryFilter, normalizedQuery, panelSurface, variant])

  const pageCount = Math.max(1, Math.ceil(filteredCatalogAgents.length / SETTINGS_PAGE_SIZE))
  const visibleCatalogAgents = variant === 'settings'
    ? filteredCatalogAgents.slice((catalogPage - 1) * SETTINGS_PAGE_SIZE, catalogPage * SETTINGS_PAGE_SIZE)
    : filteredCatalogAgents

  useEffect(() => {
    setCatalogPage(1)
  }, [catalogQuery, categoryFilter, selectedSurface])

  useEffect(() => {
    if (catalogPage > pageCount) setCatalogPage(pageCount)
  }, [catalogPage, pageCount])

  const groupedCatalogAgents = useMemo(() => AGENT_CATEGORY_ORDER
    .map((category) => ({
      category,
      agents: visibleCatalogAgents.filter((agent) => agent.category === category)
    }))
    .filter((group) => group.agents.length > 0), [visibleCatalogAgents])

  const categoryCounts = useMemo(() => new Map<AgentCatalogFilter, number>([
    ['base', catalogAgents.filter((agent) => agent.baseAgent).length],
    ...AGENT_CATEGORY_ORDER.map((category): [AgentCatalogFilter, number] => [
      category,
      catalogAgents.filter((agent) => agent.category === category).length
    ])
  ]), [catalogAgents])

  const selectedCatalogAgent = visibleCatalogAgents.find((agent) => agent.profile.id === selectedProfileId)
    ?? visibleCatalogAgents[0]
    ?? null
  const configuredCount = catalogAgents.filter(({ profile }) => Boolean(
    profile.model || profile.providerId || profile.reasoningEffort
  )).length

  const toggleCategory = useCallback((category: AgentCategory): void => {
    setCollapsedCategories((current) => {
      const next = new Set(current)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }, [])

  const selectCategory = useCallback((category: AgentCategoryFilter): void => {
    setCategoryFilter(category)
    if (category === 'all' || category === 'base') return
    setCollapsedCategories((current) => {
      if (!current.has(category)) return current
      const next = new Set(current)
      next.delete(category)
      return next
    })
  }, [])

  const selectCatalogAgent = useCallback((agent: CatalogAgent): void => {
    setSelectedProfileId(agent.profile.id)
    setCollapsedCategories((current) => {
      if (!current.has(agent.category)) return current
      const next = new Set(current)
      next.delete(agent.category)
      return next
    })
  }, [])

  if (variant === 'settings') {
    return (
      <div className={`space-y-5 ${className ?? ''}`} data-testid="subagent-settings-editor">
        <div className="rounded-2xl border border-accent/20 bg-accent-soft/55 px-5 py-3 text-[13px] leading-6 text-ds-muted">
          {tSettings('subagentsSettingsIntro')}
        </div>

        <section className="overflow-hidden rounded-2xl border border-ds-border bg-ds-card/95 shadow-sm shadow-black/5 dark:shadow-black/25">
          <div className="flex flex-col gap-1 border-b border-ds-border-muted px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-[15px] font-semibold text-ds-ink">{tSettings('subagentsRuntimePolicy')}</h2>
              <p className="mt-0.5 text-[12px] text-ds-muted">{tSettings('subagentsRuntimePolicyDesc')}</p>
            </div>
            <span className="mt-2 inline-flex w-fit rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent sm:mt-0">
              {t('subagentsPanel.policySummary', 'Queue and session limits')}
            </span>
          </div>
          <div className="grid gap-px bg-ds-border-muted sm:grid-cols-2">
            <div className="sm:col-span-2">
              <CompactPolicySetting
                title={tSettings('subagentsUseExistingAgents')}
                description={tSettings('subagentsUseExistingAgentsDesc')}
              >
                <Toggle
                  checked={subagents.useExistingAgents !== false}
                  onChange={(useExistingAgents) => patchSubagents({ useExistingAgents })}
                  ariaLabel={tSettings('subagentsUseExistingAgents')}
                />
              </CompactPolicySetting>
            </div>
            <CompactPolicySetting
              title={tSettings('subagentsMaxParallel')}
              description={tSettings('subagentsMaxParallelDesc')}
            >
              <BoundedNumberInput
                value={subagents.maxParallel ?? 256}
                min={1}
                max={256}
                onCommit={(maxParallel) => patchSubagents({ maxParallel })}
              />
            </CompactPolicySetting>
            <CompactPolicySetting
              title={tSettings('subagentsMaxChildRuns')}
              description={tSettings('subagentsMaxChildRunsDesc')}
            >
              <BoundedNumberInput
                value={subagents.maxChildRuns ?? 25}
                min={1}
                max={10_000}
                onCommit={(maxChildRuns) => patchSubagents({ maxChildRuns })}
              />
            </CompactPolicySetting>
          </div>
        </section>

        <section className="overflow-visible rounded-2xl border border-ds-border bg-ds-card/95 shadow-sm shadow-black/5 dark:shadow-black/25">
          <div className="flex flex-col gap-3 border-b border-ds-border-muted px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[16px] font-semibold text-ds-ink">{tSettings('subagentsDelegatable')}</h2>
                <span className="rounded-full bg-ds-card-muted px-2 py-0.5 text-[10.5px] font-semibold text-ds-muted">
                  {t('subagentsPanel.delegatableCount', '{{count}} delegatable roles', { count: catalogAgents.length })}
                </span>
              </div>
              <p className="mt-1 text-[13px] leading-5 text-ds-muted">{tSettings('subagentsDelegatableDesc')}</p>
            </div>
            <button
              type="button"
              onClick={() => setDialog({ profile: newProfile(selectedSurface), isNew: true })}
              className="inline-flex items-center gap-2 rounded-xl bg-accent px-3 py-2 text-[12.5px] font-semibold text-white shadow-sm transition hover:bg-accent/90"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2.4} />
              {t('subagentsPanel.newSubagent', 'New subagent')}
            </button>
          </div>

          <div className="sticky top-0 z-20 border-b border-ds-border-muted bg-ds-main/95 px-4 py-3 backdrop-blur-xl">
            <SurfaceTabs value={selectedSurface} onChange={setSelectedSurface} t={t} />
            <AgentCatalogToolbar
              query={catalogQuery}
              onQueryChange={setCatalogQuery}
              selectedCategory={categoryFilter}
              onCategoryChange={selectCategory}
              counts={categoryCounts}
              total={catalogAgents.length}
              t={t}
            />
          </div>

          <div className="grid min-h-[360px] lg:grid-cols-[minmax(0,1fr)_310px]">
            <div className="min-w-0 border-b border-ds-border-muted px-4 py-3 lg:border-b-0 lg:border-r">
              {groupedCatalogAgents.length > 0 ? groupedCatalogAgents.map(({ category, agents }) => {
                const expanded = normalizedQuery.length > 0
                  || categoryFilter !== 'all'
                  || !collapsedCategories.has(category)
                const categoryLabel = agentCategoryLabel(t, category)
                return (
                  <AgentCategorySection
                    key={category}
                    category={category}
                    count={agents.length}
                    expanded={expanded}
                    onToggle={() => toggleCategory(category)}
                    t={t}
                    summary={categoryConfigurationSummary(agents, t)}
                    configuration={(
                      <CategoryBatchControls
                        agents={agents}
                        groups={composerModelGroups}
                        categoryLabel={categoryLabel}
                        onModelsChange={setCategoryModels}
                        onReasoningChange={setCategoryReasoning}
                        onReset={resetCategoryConfiguration}
                        t={t}
                      />
                    )}
                  >
                    <div className="grid gap-2 sm:grid-cols-2">
                      {agents.map((agent) => (
                        <CatalogAgentRow
                          key={agent.profile.id}
                          agent={agent}
                          selected={selectedCatalogAgent?.profile.id === agent.profile.id}
                          variant="settings"
                          onSelect={() => selectCatalogAgent(agent)}
                          t={t}
                        />
                      ))}
                    </div>
                  </AgentCategorySection>
                )
              }) : (
                <EmptyCatalogState query={catalogQuery} t={t} />
              )}
              {filteredCatalogAgents.length > 0 ? (
                <CatalogPagination
                  page={catalogPage}
                  pageCount={pageCount}
                  total={filteredCatalogAgents.length}
                  onPageChange={setCatalogPage}
                  t={t}
                />
              ) : null}
            </div>

            <div className="min-w-0 bg-ds-main/30 p-4">
              {selectedCatalogAgent ? (
                <AgentDetailsPanel
                  agent={selectedCatalogAgent}
                  groups={composerModelGroups}
                  onModelChange={(model, providerId) =>
                    setProfileModel(selectedCatalogAgent.profile.id, model, providerId)}
                  onReasoningChange={(effort) => setProfileReasoning(selectedCatalogAgent.profile.id, effort)}
                  selectedSurface={selectedSurface}
                  onToggleSurface={() => toggleSurface(selectedCatalogAgent.profile.id, selectedSurface)}
                  onToggle={() => toggleEnabled(selectedCatalogAgent.profile.id)}
                  onEdit={() => setDialog({ profile: { ...selectedCatalogAgent.profile }, isNew: false })}
                  onDelete={() => void removeProfile(selectedCatalogAgent.profile.id)}
                  t={t}
                />
              ) : (
                <EmptyCatalogState query={catalogQuery} t={t} compact />
              )}
            </div>
          </div>
        </section>

        <EditorSettingsCard
          title={tSettings('subagentsAutomaticRoles')}
          description={tSettings('subagentsAutomaticRolesDesc')}
        >
          <Row
            variant="settings"
            roleId="compaction"
            name={t('subagentsPanel.role.compaction.name', 'Compaction')}
            desc={t('subagentsPanel.role.compaction.desc', 'Configurable · defaults to main model')}
          >
            <ModelSelect
              value={compactionSlot.model}
              providerId={compactionSlot.providerId}
              groups={composerModelGroups}
              small
              stretch
              onChange={persistCompactionSlot}
            />
          </Row>
          <Row
            variant="settings"
            roleId="code-review"
            name={t('subagentsPanel.role.codeReview.name', 'Code review')}
            desc={t('subagentsPanel.role.codeReview.desc', 'Isolated read-only run · configurable')}
          >
            <div className="flex w-full min-w-0 flex-col gap-1.5">
              <ModelSelect
                value={codeReviewSlot.model}
                providerId={codeReviewSlot.providerId}
                groups={composerModelGroups}
                stretch
                onChange={(model, providerId) =>
                  persistRoleSlot('codeReviewModel', 'codeReviewProviderId', model, providerId)}
              />
              <ReasoningEffortPicker
                value={normalizeStoredReasoning(codeReviewReasoning)}
                options={resolveReasoningOptions(
                  composerModelGroups,
                  codeReviewSlot.model,
                  codeReviewSlot.providerId
                )}
                onChange={(effort) => persistRoleReasoning('codeReviewReasoningEffort', effort)}
              />
            </div>
          </Row>
          <Row
            variant="settings"
            roleId="plan"
            name={t('subagentsPanel.role.plan.name', 'Plan mode')}
            desc={t('subagentsPanel.role.plan.desc', 'Used for planning turns; empty follows the conversation model')}
          >
            <ModelSelect
              value={planSlot.model}
              providerId={planSlot.providerId}
              groups={composerModelGroups}
              stretch
              onChange={(model, providerId) => persistRoleSlot('planModel', 'planProviderId', model, providerId)}
            />
          </Row>
          <Row
            variant="settings"
            roleId="title"
            name={t('subagentsPanel.role.title.name', 'Title')}
            desc={t('subagentsPanel.role.title.desc', 'LLM · defaults to small model')}
          >
            <div className="flex w-full min-w-0 flex-col gap-1.5">
              <ModelSelect
                value={titleSlot.model}
                providerId={titleSlot.providerId}
                groups={composerModelGroups}
                small
                stretch
                onChange={(model, providerId) => persistRoleSlot('titleModel', 'titleProviderId', model, providerId)}
              />
              <ReasoningEffortPicker
                value={normalizeStoredReasoning(titleReasoning)}
                options={resolveReasoningOptions(
                  composerModelGroups,
                  titleSlot.model,
                  titleSlot.providerId
                )}
                onChange={(effort) => persistRoleReasoning('titleReasoningEffort', effort)}
              />
            </div>
          </Row>
          <Row
            variant="settings"
            roleId="summary"
            name={t('subagentsPanel.role.summary.name', 'Summary')}
            desc={t('subagentsPanel.role.summary.desc', 'LLM · defaults to small model')}
          >
            <div className="flex w-full min-w-0 flex-col gap-1.5">
              <ModelSelect
                value={summarySlot.model}
                providerId={summarySlot.providerId}
                groups={composerModelGroups}
                small
                stretch
                onChange={(model, providerId) => persistRoleSlot('summaryModel', 'summaryProviderId', model, providerId)}
              />
              <ReasoningEffortPicker
                value={normalizeStoredReasoning(summaryReasoning)}
                options={resolveReasoningOptions(
                  composerModelGroups,
                  summarySlot.model,
                  summarySlot.providerId
                )}
                onChange={(effort) => persistRoleReasoning('summaryReasoningEffort', effort)}
              />
            </div>
          </Row>
          <Row
            variant="settings"
            roleId="small-model"
            name={t('subagentsPanel.smallModel.name', 'Small model')}
            desc={t('subagentsPanel.smallModel.desc', 'Default for Title & Summary')}
          >
            <ModelSelect
              value={smallModel.model}
              providerId={smallModel.providerId}
              groups={composerModelGroups}
              small
              stretch
              onChange={(model, providerId) => persistRoleSlot('smallModel', 'smallModelProviderId', model, providerId)}
            />
          </Row>
        </EditorSettingsCard>

        {dialog ? (
          <ProfileDialog
            profile={dialog.profile}
            isNew={dialog.isNew}
            builtin={isBuiltin(dialog.profile.id)}
            groups={composerModelGroups}
            onSave={saveDialog}
            onCancel={() => setDialog(null)}
          />
        ) : null}
      </div>
    )
  }

  return (
    <div className={`ds-no-drag flex h-full min-h-0 flex-col overflow-hidden bg-ds-sidebar ${className ?? ''}`}>
      <div className="shrink-0 border-b border-ds-border-muted px-3 py-3">
        <div
          className="mb-2.5 flex items-center gap-3 rounded-xl border border-ds-border bg-ds-card px-3 py-2.5 shadow-sm shadow-black/5"
          data-testid="subagent-delegation-mode-control"
        >
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-semibold text-ds-heading">
              {tSettings('subagentsUseExistingAgents')}
            </div>
            <p className="mt-0.5 text-[10.5px] leading-4 text-ds-muted">
              {tSettings('subagentsUseExistingAgentsDesc')}
            </p>
          </div>
          <Toggle
            checked={subagents.useExistingAgents !== false}
            onChange={(useExistingAgents) => patchSubagents({ useExistingAgents })}
            ariaLabel={tSettings('subagentsUseExistingAgents')}
          />
        </div>
        <ExtensionAgentsControl
          enabled={extensionAgentsEnabled}
          count={extensionAgentIds.size}
          onToggle={setExtensionAgentsEnabled}
          t={t}
        />
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <span className="text-[12px] font-semibold text-ds-heading">
            {t('subagentsPanel.delegatableCount', '{{count}} delegatable roles', { count: catalogAgents.length })}
          </span>
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] font-semibold text-accent">
            {t('subagentsPanel.configuredCount', '{{count}} configured', { count: configuredCount })}
          </span>
        </div>
        <AgentCatalogToolbar
          query={catalogQuery}
          onQueryChange={setCatalogQuery}
          selectedCategory={categoryFilter}
          onCategoryChange={selectCategory}
          counts={categoryCounts}
          total={catalogAgents.length}
          t={t}
          compact
        />
      </div>

      <div className="h-0 min-h-0 flex-1 touch-pan-y overscroll-contain overflow-y-auto overflow-x-hidden px-2 py-2 [scrollbar-gutter:stable]">
        {groupedCatalogAgents.length > 0 ? groupedCatalogAgents.map(({ category, agents }) => {
          const expanded = normalizedQuery.length > 0
            || categoryFilter !== 'all'
            || !collapsedCategories.has(category)
          const categoryLabel = agentCategoryLabel(t, category)
          return (
            <AgentCategorySection
              key={category}
              category={category}
              count={agents.length}
              expanded={expanded}
              onToggle={() => toggleCategory(category)}
              t={t}
              compact
              summary={categoryConfigurationSummary(agents, t)}
              configuration={(
                <CategoryBatchControls
                  agents={agents}
                  groups={composerModelGroups}
                  categoryLabel={categoryLabel}
                  onModelsChange={setCategoryModels}
                  onReasoningChange={setCategoryReasoning}
                  onReset={resetCategoryConfiguration}
                  t={t}
                />
              )}
            >
              <div className="space-y-1">
                {agents.map((agent) => {
                  const selected = selectedCatalogAgent?.profile.id === agent.profile.id
                  const workspaceLocked = agent.source === 'workspace'
                  return (
                    <CatalogAgentRow
                      key={agent.profile.id}
                      agent={agent}
                      selected={selected}
                      variant="panel"
                      onSelect={() => selectCatalogAgent(agent)}
                      t={t}
                    >
                      {selected ? (
                        <div className="space-y-2 border-t border-ds-border-muted px-3 py-2.5">
                          {workspaceLocked ? (
                            <div className="rounded-lg border border-ds-border-muted bg-ds-card-muted px-2.5 py-2 text-[10.5px] leading-4 text-ds-muted">
                              {t('subagentsPanel.workspaceReadOnly', 'Edit this role in .kun/agents/*.md')}
                              {agent.filePath ? (
                                <div className="mt-1 truncate text-[9.5px] text-ds-faint" title={agent.filePath}>
                                  {agent.filePath}
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            <>
                              <div className="flex items-center gap-2">
                                <ModelSelect
                                  value={agent.profile.model ?? ''}
                                  providerId={agent.profile.providerId ?? ''}
                                  groups={composerModelGroups}
                                  stretch
                                  onChange={(model, providerId) => setProfileModel(agent.profile.id, model, providerId)}
                                />
                                <RowActions
                                  enabled={agent.profile.enabled}
                                  builtin={agent.builtin}
                                  t={t}
                                  onToggle={() => toggleEnabled(agent.profile.id)}
                                  onEdit={() => setDialog({ profile: { ...agent.profile }, isNew: false })}
                                  onDelete={() => void removeProfile(agent.profile.id)}
                                />
                              </div>
                              <ReasoningEffortPicker
                                value={normalizeStoredReasoning(agent.profile.reasoningEffort)}
                                options={resolveReasoningOptions(
                                  composerModelGroups,
                                  agent.profile.model ?? '',
                                  agent.profile.providerId ?? ''
                                )}
                                onChange={(effort) => setProfileReasoning(agent.profile.id, effort)}
                              />
                            </>
                          )}
                        </div>
                      ) : null}
                    </CatalogAgentRow>
                  )
                })}
              </div>
            </AgentCategorySection>
          )
        }) : (
          <EmptyCatalogState query={catalogQuery} t={t} />
        )}

        <div className="mt-2 border-t border-ds-border-muted pt-2">
          <button
            type="button"
            aria-expanded={systemRolesOpen}
            onClick={() => setSystemRolesOpen((open) => !open)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[11px] font-semibold text-ds-muted transition hover:bg-ds-hover hover:text-ds-heading"
          >
            <ChevronRight className={`h-3.5 w-3.5 transition ${systemRolesOpen ? 'rotate-90' : ''}`} />
            <span>{t('subagentsPanel.system', 'System · internal')}</span>
            <span className="ml-auto rounded-full bg-ds-card-muted px-1.5 py-0.5 text-[9.5px]">5</span>
          </button>
          {systemRolesOpen ? (
            <div className="mt-1 space-y-0.5">
              <Row
                roleId="compaction"
                name={t('subagentsPanel.role.compaction.name', 'Compaction')}
                desc={t('subagentsPanel.role.compaction.desc', 'Configurable · defaults to main model')}
              >
                <ModelSelect
                  value={compactionSlot.model}
                  providerId={compactionSlot.providerId}
                  groups={composerModelGroups}
                  small
                  onChange={(m, pid) => void persistCompactionSlot(m, pid)}
                />
              </Row>
              <Row
                roleId="code-review"
                name={t('subagentsPanel.role.codeReview.name', 'Code review')}
                desc={t('subagentsPanel.role.codeReview.desc', 'Isolated read-only run · configurable')}
              >
                <div className="flex min-w-0 flex-col items-end gap-1">
                  <ModelSelect
                    value={codeReviewSlot.model}
                    providerId={codeReviewSlot.providerId}
                    groups={composerModelGroups}
                    onChange={(m, pid) => persistRoleSlot('codeReviewModel', 'codeReviewProviderId', m, pid)}
                  />
                  <ReasoningEffortPicker
                    value={normalizeStoredReasoning(codeReviewReasoning)}
                    options={resolveReasoningOptions(
                      composerModelGroups,
                      codeReviewSlot.model,
                      codeReviewSlot.providerId
                    )}
                    compact
                    onChange={(effort) => persistRoleReasoning('codeReviewReasoningEffort', effort)}
                  />
                </div>
              </Row>
              <Row
                roleId="title"
                name={t('subagentsPanel.role.title.name', 'Title')}
                desc={t('subagentsPanel.role.title.desc', 'LLM · defaults to small model')}
              >
                <div className="flex min-w-0 flex-col items-end gap-1">
                  <ModelSelect
                    value={titleSlot.model}
                    providerId={titleSlot.providerId}
                    groups={composerModelGroups}
                    small
                    onChange={(m, pid) => persistRoleSlot('titleModel', 'titleProviderId', m, pid)}
                  />
                  <ReasoningEffortPicker
                    value={normalizeStoredReasoning(titleReasoning)}
                    options={resolveReasoningOptions(
                      composerModelGroups,
                      titleSlot.model,
                      titleSlot.providerId
                    )}
                    compact
                    onChange={(effort) => persistRoleReasoning('titleReasoningEffort', effort)}
                  />
                </div>
              </Row>
              <Row
                roleId="summary"
                name={t('subagentsPanel.role.summary.name', 'Summary')}
                desc={t('subagentsPanel.role.summary.desc', 'LLM · defaults to small model')}
              >
                <div className="flex min-w-0 flex-col items-end gap-1">
                  <ModelSelect
                    value={summarySlot.model}
                    providerId={summarySlot.providerId}
                    groups={composerModelGroups}
                    small
                    onChange={(m, pid) => persistRoleSlot('summaryModel', 'summaryProviderId', m, pid)}
                  />
                  <ReasoningEffortPicker
                    value={normalizeStoredReasoning(summaryReasoning)}
                    options={resolveReasoningOptions(
                      composerModelGroups,
                      summarySlot.model,
                      summarySlot.providerId
                    )}
                    compact
                    onChange={(effort) => persistRoleReasoning('summaryReasoningEffort', effort)}
                  />
                </div>
              </Row>
              <Row
                roleId="small-model"
                name={t('subagentsPanel.smallModel.name', 'Small model')}
                desc={t('subagentsPanel.smallModel.desc', 'Default for Title & Summary')}
              >
                <ModelSelect
                  value={smallModel.model}
                  providerId={smallModel.providerId}
                  groups={composerModelGroups}
                  small
                  onChange={(m, pid) => persistRoleSlot('smallModel', 'smallModelProviderId', m, pid)}
                />
              </Row>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t border-ds-border px-3 py-2.5">
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-ds-faint">
          {t('subagentsPanel.showingCount', 'Showing {{visible}} of {{total}}', {
            visible: filteredCatalogAgents.length,
            total: catalogAgents.length
          })}
        </span>
        <button
          type="button"
          onClick={() => setDialog({ profile: newProfile(panelSurface), isNew: true })}
          className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[9px] bg-accent px-3 py-2 text-[11.5px] font-semibold text-white transition hover:bg-accent/90"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.4} />
          {t('subagentsPanel.newSubagent', 'New subagent')}
        </button>
      </div>

      {dialog ? (
        <ProfileDialog
          profile={dialog.profile}
          isNew={dialog.isNew}
          builtin={isBuiltin(dialog.profile.id)}
          groups={composerModelGroups}
          onSave={saveDialog}
          onCancel={() => setDialog(null)}
        />
      ) : null}
    </div>
  )
}

function EditorSettingsCard({
  title,
  description,
  action,
  children
}: {
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
}): ReactElement {
  return (
    <details className="group overflow-visible rounded-2xl border border-ds-border bg-ds-card/95 shadow-sm shadow-black/5 dark:shadow-black/25">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3.5 transition hover:bg-ds-hover/55 group-open:border-b group-open:border-ds-border-muted [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <h2 className="text-[16px] font-semibold text-ds-ink">{title}</h2>
          {description ? <p className="mt-1 text-[13px] leading-5 text-ds-muted">{description}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {action}
          <ChevronDown className="h-4 w-4 text-ds-faint transition group-open:rotate-180" />
        </div>
      </summary>
      <div className="divide-y divide-ds-border-muted px-2 py-1">{children}</div>
    </details>
  )
}

function CompactPolicySetting({
  title,
  description,
  children
}: {
  title: string
  description: string
  children: ReactNode
}): ReactElement {
  return (
    <div className="flex items-center gap-4 bg-ds-card px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-ds-ink">{title}</div>
        <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-4 text-ds-muted">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

const CATEGORY_FALLBACKS: Record<AgentCategory, string> = {
  development: 'Development',
  review: 'Review',
  quality: 'Quality',
  planning: 'Planning',
  operations: 'Operations',
  research: 'Research',
  custom: 'Custom'
}

function agentCategoryLabel(t: TFunction<'common'>, category: AgentCategory): string {
  return t(`subagentsPanel.category.${category}`, CATEGORY_FALLBACKS[category])
}

function sharedCategoryModel(agents: CatalogAgent[]): {
  model: string
  providerId: string
  mixed: boolean
} {
  if (agents.length === 0) return { model: '', providerId: '', mixed: false }
  const model = agents[0]?.profile.model ?? ''
  const providerId = agents[0]?.profile.providerId ?? ''
  const mixed = agents.some((agent) =>
    (agent.profile.model ?? '') !== model || (agent.profile.providerId ?? '') !== providerId)
  return mixed ? { model: '', providerId: '', mixed: true } : { model, providerId, mixed: false }
}

function sharedCategoryReasoning(agents: CatalogAgent[]): {
  effort: ModelReasoningEffort
  mixed: boolean
} {
  if (agents.length === 0) return { effort: 'off', mixed: false }
  const effort = normalizeStoredReasoning(agents[0]?.profile.reasoningEffort)
  const mixed = agents.some((agent) =>
    normalizeStoredReasoning(agent.profile.reasoningEffort) !== effort)
  return mixed ? { effort: 'off', mixed: true } : { effort, mixed: false }
}

function categoryConfigurationSummary(
  agents: CatalogAgent[],
  t: TFunction<'common'>
): string {
  const sharedModel = sharedCategoryModel(agents)
  const sharedReasoning = sharedCategoryReasoning(agents)
  if (sharedModel.mixed || sharedReasoning.mixed) {
    return t('subagentsPanel.mixedConfiguration', 'Multiple configurations')
  }
  const model = sharedModel.model || t('agentsView.followDefault', 'Follow default')
  const reasoning = REASONING_OPTIONS.find((option) => option.id === sharedReasoning.effort)
  const reasoningLabel = reasoning ? t(reasoning.labelKey, reasoning.id) : sharedReasoning.effort
  return `${model} · ${reasoningLabel}`
}

function CategoryBatchControls({
  agents,
  groups,
  categoryLabel,
  onModelsChange,
  onReasoningChange,
  onReset,
  t
}: {
  agents: CatalogAgent[]
  groups: ModelProviderModelGroup[]
  categoryLabel: string
  onModelsChange: (ids: string[], model: string, providerId: string) => void
  onReasoningChange: (ids: string[], effort: ModelReasoningEffort) => void
  onReset: (ids: string[]) => void
  t: TFunction<'common'>
}): ReactElement {
  const shared = sharedCategoryModel(agents)
  const sharedReasoning = sharedCategoryReasoning(agents)
  const ids = agents.map((agent) => agent.profile.id)
  const hasOverrides = agents.some((agent) =>
    Boolean(agent.profile.model || agent.profile.providerId || agent.profile.reasoningEffort))
  const reasoningOptions = shared.mixed
    ? REASONING_OPTIONS
    : resolveReasoningOptions(groups, shared.model, shared.providerId)
  return (
    <div
      data-testid="subagent-category-configuration"
      className="mb-2.5 rounded-xl border border-ds-border-muted bg-ds-main/45 p-3"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[11.5px] font-semibold text-ds-heading">
            {t('subagentsPanel.categoryConfiguration', 'Category default configuration')}
          </div>
          <div className="mt-0.5 text-[10px] text-ds-faint">
            {t('subagentsPanel.categoryConfigurationDesc', 'Apply the same defaults to every agent in this category')}
          </div>
        </div>
        <button
          type="button"
          disabled={!hasOverrides}
          onClick={() => onReset(ids)}
          className="shrink-0 rounded-lg px-2 py-1 text-[10px] font-semibold text-accent transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:text-ds-faint disabled:hover:bg-transparent"
        >
          {t('subagentsPanel.resetCategoryConfiguration', 'Reset defaults')}
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(160px,0.8fr)_minmax(280px,1.2fr)] md:items-end">
        <div className="min-w-0">
          <div className="mb-1.5 text-[9.5px] font-semibold uppercase tracking-wide text-ds-faint">
            {t('agentsView.fModel', 'Model')}
          </div>
          <ModelSelect
            value={shared.model}
            providerId={shared.providerId}
            groups={groups}
            stretch
            emptyLabel={shared.mixed
              ? t('subagentsPanel.mixedModels', 'Mixed models')
              : undefined}
            ariaLabel={t(
              'subagentsPanel.batchModelAria',
              'Set the same model for all {{count}} agents in {{category}}',
              { count: agents.length, category: categoryLabel }
            )}
            onChange={(model, providerId) => onModelsChange(ids, model, providerId)}
          />
        </div>
        <div className="min-w-0">
          <div className="mb-1.5 text-[9.5px] font-semibold uppercase tracking-wide text-ds-faint">
            {t('subagentsPanel.reasoning', 'Reasoning')}
          </div>
          <ReasoningEffortPicker
            value={sharedReasoning.mixed ? null : sharedReasoning.effort}
            options={reasoningOptions}
            mixedLabel={sharedReasoning.mixed
              ? t('subagentsPanel.mixedReasoning', 'Mixed reasoning')
              : undefined}
            ariaLabel={t(
              'subagentsPanel.batchReasoningAria',
              'Set the same reasoning effort for all {{count}} agents in {{category}}',
              { count: agents.length, category: categoryLabel }
            )}
            onChange={(effort) => onReasoningChange(ids, effort)}
          />
        </div>
      </div>
    </div>
  )
}

function surfaceLabel(t: TFunction<'common'>, surface: SurfaceTab): string {
  const fallbacks: Record<SurfaceTab, string> = {
    shared: 'Base',
    code: 'Code',
    write: 'Write',
    design: 'Design'
  }
  return t(`subagentsPanel.surface.${surface}`, fallbacks[surface])
}

function SurfaceTabs({
  value,
  onChange,
  t
}: {
  value: SurfaceTab
  onChange: (surface: SurfaceTab) => void
  t: TFunction<'common'>
}): ReactElement {
  return (
    <div className="mb-3 grid grid-cols-4 gap-1 rounded-xl bg-ds-card-muted p-1" role="tablist">
      {SURFACE_TABS.map((surface) => (
        <button
          key={surface}
          type="button"
          role="tab"
          aria-selected={value === surface}
          onClick={() => onChange(surface)}
          className={`rounded-lg px-2 py-1.5 text-[11px] font-semibold transition ${
            value === surface
              ? 'bg-ds-card text-accent shadow-sm'
              : 'text-ds-muted hover:text-ds-heading'
          }`}
        >
          {surfaceLabel(t, surface)}
        </button>
      ))}
    </div>
  )
}

function CatalogPagination({
  page,
  pageCount,
  total,
  onPageChange,
  t
}: {
  page: number
  pageCount: number
  total: number
  onPageChange: (page: number) => void
  t: TFunction<'common'>
}): ReactElement {
  return (
    <nav className="mt-3 flex items-center justify-between gap-3 border-t border-ds-border-muted pt-3" aria-label={t('subagentsPanel.pagination', 'Agent pages')}>
      <span className="text-[10.5px] text-ds-muted">
        {t('subagentsPanel.pageSummary', 'Page {{page}} of {{pages}} · {{count}} agents', {
          page,
          pages: pageCount,
          count: total
        })}
      </span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
          aria-label={t('subagentsPanel.previousPage', 'Previous page')}
          className="rounded-lg border border-ds-border p-1.5 text-ds-muted transition hover:bg-ds-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="min-w-12 text-center text-[11px] font-semibold text-ds-heading">{page}/{pageCount}</span>
        <button
          type="button"
          disabled={page >= pageCount}
          onClick={() => onPageChange(Math.min(pageCount, page + 1))}
          aria-label={t('subagentsPanel.nextPage', 'Next page')}
          className="rounded-lg border border-ds-border p-1.5 text-ds-muted transition hover:bg-ds-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </nav>
  )
}

function ExtensionAgentsControl({
  enabled,
  count,
  onToggle,
  t
}: {
  enabled: boolean
  count: number
  onToggle: (enabled: boolean) => void
  t: TFunction<'common'>
}): ReactElement {
  return (
    <section className="mb-3 rounded-xl border border-ds-border bg-ds-card px-3 py-2.5 shadow-sm shadow-black/5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-ds-heading">
            {t('subagentsPanel.extensionAgents.title', 'Extension agents')}
          </div>
          <div className="mt-0.5 text-[10.5px] text-ds-muted">
            {t('subagentsPanel.extensionAgents.description', 'Write and Design specialists · {{count}}', { count })}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`text-[10.5px] font-semibold ${enabled ? 'text-accent' : 'text-ds-faint'}`}>
            {enabled
              ? t('subagentsPanel.extensionAgents.enabled', 'Enabled')
              : t('subagentsPanel.extensionAgents.disabled', 'Disabled')}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={t('subagentsPanel.extensionAgents.toggle', 'Toggle extension agents')}
            onClick={() => onToggle(!enabled)}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              enabled ? 'bg-accent' : 'bg-ds-border'
            }`}
          >
            <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
              enabled ? 'translate-x-4' : 'translate-x-0'
            }`} />
          </button>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 border-t border-ds-border-muted pt-2">
        <span className="text-[10px] text-ds-faint">
          {t('subagentsPanel.extensionAgents.baseAlwaysAvailable', 'Base agents are always available')}
        </span>
        <button
          type="button"
          onClick={() => onToggle(!enabled)}
          className="shrink-0 rounded-md px-1.5 py-1 text-[10px] font-semibold text-accent transition hover:bg-accent-soft"
        >
          <span>{enabled
            ? t('subagentsPanel.extensionAgents.keepBaseOnly', 'Keep base agents only')
            : t('subagentsPanel.extensionAgents.enableExtensions', 'Enable extension agents')}</span>
        </button>
      </div>
    </section>
  )
}

function AgentCatalogToolbar({
  query,
  onQueryChange,
  selectedCategory,
  onCategoryChange,
  counts,
  total,
  t,
  compact = false
}: {
  query: string
  onQueryChange: (value: string) => void
  selectedCategory: AgentCategoryFilter
  onCategoryChange: (category: AgentCategoryFilter) => void
  counts: Map<AgentCatalogFilter, number>
  total: number
  t: TFunction<'common'>
  compact?: boolean
}): ReactElement {
  const filters: AgentCategoryFilter[] = [
    'all',
    'base',
    ...AGENT_CATEGORY_ORDER.filter((category) => (counts.get(category) ?? 0) > 0)
  ]
  return (
    <div className="space-y-2.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ds-faint" />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          aria-label={t('subagentsPanel.search', 'Search agents')}
          placeholder={t('subagentsPanel.searchPlaceholder', 'Search names, capabilities, or scenarios')}
          className={`w-full rounded-[10px] border border-ds-border bg-ds-card pl-9 pr-9 text-ds-heading outline-none transition placeholder:text-ds-faint focus:border-accent/45 focus:ring-2 focus:ring-accent/10 ${
            compact ? 'h-9 text-[12px]' : 'h-10 text-[13px]'
          }`}
        />
        {query ? (
          <button
            type="button"
            onClick={() => onQueryChange('')}
            aria-label={t('subagentsPanel.clearSearch', 'Clear search')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-ds-faint hover:bg-ds-subtle hover:text-ds-heading"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {filters.map((filter) => {
          const active = selectedCategory === filter
          const count = filter === 'all' ? total : (counts.get(filter) ?? 0)
          const label = filter === 'all'
            ? t('subagentsPanel.category.all', 'All')
            : filter === 'base'
              ? t('subagentsPanel.category.baseAgent', 'Base agents')
              : agentCategoryLabel(t, filter)
          return (
            <button
              key={filter}
              type="button"
              aria-pressed={active}
              onClick={() => onCategoryChange(filter)}
              className={`inline-flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-[10.5px] font-semibold transition ${
                active
                  ? 'border-accent bg-accent text-white shadow-sm'
                  : 'border-ds-border bg-ds-card text-ds-muted hover:border-accent/30 hover:text-ds-heading'
              }`}
            >
              <span>{label}</span>
              <span className={active ? 'text-white/80' : 'text-ds-faint'}>{count}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function AgentCategorySection({
  category,
  count,
  expanded,
  onToggle,
  t,
  compact = false,
  summary,
  configuration,
  children
}: {
  category: AgentCategory
  count: number
  expanded: boolean
  onToggle: () => void
  t: TFunction<'common'>
  compact?: boolean
  summary: string
  configuration?: ReactNode
  children: ReactNode
}): ReactElement {
  const label = agentCategoryLabel(t, category)
  return (
    <section
      data-agent-category={category}
      className={`mb-2 overflow-visible rounded-xl border transition ${
        expanded
          ? 'border-accent/20 bg-ds-card shadow-sm shadow-black/[0.03]'
          : 'border-ds-border-muted bg-ds-card/80 hover:border-accent/20'
      }`}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={t('subagentsPanel.toggleCategory', 'Toggle {{category}} category', { category: label })}
        onClick={onToggle}
        className={`flex w-full min-w-0 items-center gap-2 rounded-xl text-left font-semibold text-ds-heading transition hover:bg-ds-hover/60 ${
          compact ? 'px-3 py-2.5 text-[11.5px]' : 'px-3 py-3 text-[12.5px]'
        }`}
      >
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-ds-faint transition ${expanded ? 'rotate-90' : ''}`} />
        <span className="truncate">{label}</span>
        <span className="rounded-full bg-ds-card-muted px-1.5 py-0.5 text-[9.5px] font-semibold text-ds-muted">{count}</span>
        {!expanded ? (
          <span
            title={summary}
            className="ml-auto max-w-[55%] truncate rounded-full bg-ds-card-muted px-2 py-1 text-[9.5px] font-medium text-ds-muted"
          >
            {summary}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className={compact ? 'px-2.5 pb-2.5' : 'px-3 pb-3'}>
          {configuration}
          {children}
        </div>
      ) : null}
    </section>
  )
}

function agentSourceChip(
  agent: Pick<CatalogAgent, 'builtin' | 'source'>,
  t: TFunction<'common'>
): ReactElement | null {
  if (agent.source === 'workspace' || (!agent.builtin && agent.source === 'configured')) {
    return (
      <span className="shrink-0 rounded-full bg-violet-500/10 px-1.5 py-px text-[8.5px] font-semibold text-violet-600 dark:text-violet-400">
        {t('subagentsPanel.customTag', 'Custom')}
      </span>
    )
  }
  if (agent.builtin || agent.source === 'builtin') {
    return (
      <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-px text-[8.5px] font-semibold text-accent">
        {t('subagentsPanel.builtin', 'Built-in')}
      </span>
    )
  }
  return null
}

function CatalogAgentRow({
  agent,
  selected,
  variant,
  onSelect,
  t,
  children
}: {
  agent: CatalogAgent
  selected: boolean
  variant: EditorVariant
  onSelect: () => void
  t: TFunction<'common'>
  children?: ReactNode
}): ReactElement {
  const { profile, name, desc } = agent
  const settings = variant === 'settings'
  const modelLabel = profile.model || t('agentsView.followDefault', 'Follow default')
  return (
    <div
      data-agent-id={profile.id}
      data-agent-source={agent.source}
      className={`overflow-visible rounded-xl border transition ${
        selected
          ? 'border-accent/70 bg-accent-soft/45 shadow-[0_0_0_1px_rgba(59,130,216,0.08)]'
          : 'border-ds-border-muted bg-ds-card hover:border-accent/25 hover:bg-ds-hover/35'
      } ${profile.enabled ? '' : 'opacity-60'}`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`flex w-full min-w-0 items-center gap-2.5 text-left ${settings ? 'px-3 py-2.5' : 'px-2.5 py-2'}`}
      >
        <span
          className={`flex shrink-0 items-center justify-center rounded-full ${settings ? 'h-10 w-10' : 'h-9 w-9'}`}
          style={{
            background: 'radial-gradient(circle at 50% 36%, #fff 0%, rgba(238,244,251,0.9) 78%)',
            boxShadow: 'inset 0 0 0 1px rgba(188,214,245,0.7)'
          }}
        >
          <AgentKun id={profile.id} disabled={!profile.enabled} className={settings ? 'h-8 w-8' : 'h-7 w-7'} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={`truncate font-semibold text-ds-heading ${settings ? 'text-[12.5px]' : 'text-[12px]'}`}>{name}</span>
            {agentSourceChip(agent, t)}
            {agent.baseAgent ? (
              <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-px text-[8.5px] font-semibold text-emerald-600 dark:text-emerald-400">
                {t('subagentsPanel.surface.shared', 'Base')}
              </span>
            ) : null}
          </span>
          <span className={`mt-0.5 block truncate text-ds-muted ${settings ? 'text-[10.5px]' : 'text-[10px]'}`}>{desc}</span>
          {settings ? (
            <span className="mt-1 inline-flex max-w-full rounded-md bg-ds-card-muted px-1.5 py-0.5 text-[9px] font-semibold text-ds-muted">
              <span className="truncate">{modelLabel}</span>
            </span>
          ) : null}
        </span>
        {!settings ? (
          <span className="flex max-w-[132px] shrink-0 flex-col items-end gap-0.5">
            <span className="text-[8.5px] font-semibold uppercase tracking-wide text-ds-faint">
              {t('subagentsPanel.effectiveModel', 'Effective model')}
            </span>
            <span
              title={modelLabel}
              className="max-w-full truncate text-[9.5px] font-semibold text-ds-muted"
            >
              {modelLabel}
            </span>
          </span>
        ) : null}
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-ds-faint transition ${selected && !settings ? 'rotate-90' : ''}`} />
      </button>
      {children}
    </div>
  )
}

function AgentDetailsPanel({
  agent,
  groups,
  onModelChange,
  onReasoningChange,
  selectedSurface,
  onToggleSurface,
  onToggle,
  onEdit,
  onDelete,
  t
}: {
  agent: CatalogAgent
  groups: ModelProviderModelGroup[]
  onModelChange: (model: string, providerId: string) => void
  onReasoningChange: (effort: ModelReasoningEffort) => void
  selectedSurface: SurfaceTab
  onToggleSurface: () => void
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
  t: TFunction<'common'>
}): ReactElement {
  const { profile, builtin, name, desc, category, source, filePath } = agent
  const surfaces = profileSurfaces(profile)
  const inherited = selectedSurface !== 'shared' && surfaces.includes('shared')
  const assigned = inherited || surfaces.includes(selectedSurface)
  const workspaceLocked = source === 'workspace'
  const locked = profile.id === 'general' || inherited || workspaceLocked
  return (
    <aside className="lg:sticky lg:top-4" data-testid="subagent-details-panel">
      <div className="flex items-start gap-3">
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full"
          style={{
            background: 'radial-gradient(circle at 50% 36%, #fff 0%, rgba(238,244,251,0.9) 78%)',
            boxShadow: 'inset 0 0 0 1px rgba(188,214,245,0.7)'
          }}
        >
          <AgentKun id={profile.id} disabled={!profile.enabled} className="h-10 w-10" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-[14px] font-semibold text-ds-heading">{name}</h3>
            {agentSourceChip(agent, t)}
          </div>
          <p className="mt-1 text-[11.5px] leading-5 text-ds-muted">{desc}</p>
          {workspaceLocked && filePath ? (
            <p className="mt-1 truncate text-[10px] text-ds-faint" title={filePath}>
              {t('subagentsPanel.workspaceFile', 'Defined in {{path}}', { path: filePath })}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-4 space-y-4 border-t border-ds-border-muted pt-4">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-ds-border-muted bg-ds-card px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-ds-heading">
              {surfaceLabel(t, selectedSurface)}
            </div>
            <div className="mt-0.5 text-[10px] text-ds-muted">
              {inherited
                ? t('subagentsPanel.surfaceInherited', 'Inherited from Base')
                : assigned
                  ? t('subagentsPanel.surfaceAssigned', 'Available in this mode')
                  : t('subagentsPanel.surfaceUnassigned', 'Not available in this mode')}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={assigned}
            disabled={locked}
            onClick={onToggleSurface}
            className={`relative h-6 w-11 shrink-0 rounded-full transition ${assigned ? 'bg-accent' : 'bg-ds-card-muted'} disabled:cursor-not-allowed disabled:opacity-60`}
          >
            <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${assigned ? 'translate-x-5' : ''}`} />
          </button>
        </div>
        <div>
          <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-ds-faint">
            {t('agentsView.fModel', 'Model')}
          </div>
          {workspaceLocked ? (
            <div className="rounded-lg border border-ds-border-muted bg-ds-card-muted px-3 py-2 text-[11px] text-ds-muted">
              {t('agentsView.followDefault', 'Follow default')}
            </div>
          ) : (
            <ModelSelect
              value={profile.model ?? ''}
              providerId={profile.providerId ?? ''}
              groups={groups}
              stretch
              onChange={onModelChange}
            />
          )}
        </div>
        <div>
          <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-ds-faint">
            {t('subagentsPanel.reasoning', 'Reasoning')}
          </div>
          {workspaceLocked ? (
            <div className="rounded-lg border border-ds-border-muted bg-ds-card-muted px-3 py-2 text-[11px] text-ds-muted">
              {t('composerReasoningOff', 'Off')}
            </div>
          ) : (
            <ReasoningEffortPicker
              value={normalizeStoredReasoning(profile.reasoningEffort)}
              options={resolveReasoningOptions(groups, profile.model ?? '', profile.providerId ?? '')}
              onChange={onReasoningChange}
            />
          )}
        </div>

        <div>
          <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-ds-faint">
            {t('subagentsPanel.capabilities', 'Capabilities')}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <span className="rounded-md bg-ds-card-muted px-2 py-1 text-[10px] font-medium text-ds-muted">
              {agentCategoryLabel(t, category)}
            </span>
            <span className="rounded-md bg-ds-card-muted px-2 py-1 text-[10px] font-medium text-ds-muted">
              {profile.toolPolicy === 'readOnly'
                ? t('agentsView.toolReadOnly', 'Read-only')
                : t('agentsView.toolInherit', 'All tools')}
            </span>
            <span className="rounded-md bg-ds-card-muted px-2 py-1 text-[10px] font-medium text-ds-muted">
              {profile.mode === 'primary'
                ? t('agentsView.modePersona', 'Persona')
                : profile.mode === 'all'
                  ? t('agentsView.modeBoth', 'Both')
                  : t('agentsView.modeDelegate', 'Delegate')}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-lg border border-ds-border-muted bg-ds-card px-3 py-2">
          <span className={`h-2 w-2 rounded-full ${profile.enabled ? 'bg-emerald-500' : 'bg-ds-faint'}`} />
          <span className="text-[11px] font-medium text-ds-muted">
            {profile.enabled ? t('enable', 'Enabled') : t('disable', 'Disabled')}
          </span>
        </div>
      </div>

      <div className="mt-5 flex items-center gap-2 border-t border-ds-border-muted pt-4">
        {!builtin && source !== 'workspace' ? (
          <button
            type="button"
            onClick={onToggle}
            className="rounded-lg border border-ds-border px-2.5 py-2 text-ds-muted transition hover:bg-ds-hover hover:text-ds-heading"
            title={profile.enabled ? t('disable', 'Disable') : t('enable', 'Enable')}
          >
            <Power className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {source === 'workspace' ? (
          <div className="flex-1 rounded-lg border border-ds-border-muted bg-ds-card-muted px-3 py-2 text-[11px] text-ds-muted">
            {t('subagentsPanel.workspaceReadOnly', 'Edit this role in .kun/agents/*.md')}
          </div>
        ) : (
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[11.5px] font-semibold text-white transition hover:bg-accent/90"
          >
            <Pencil className="h-3.5 w-3.5" />
            {t('agentsView.edit', 'Edit')}
          </button>
        )}
        {!builtin && source !== 'workspace' ? (
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg border border-ds-border px-2.5 py-2 text-ds-muted transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"
            title={t('agentsView.delete', 'Delete')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </aside>
  )
}

function EmptyCatalogState({
  query,
  t,
  compact = false
}: {
  query: string
  t: TFunction<'common'>
  compact?: boolean
}): ReactElement {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? 'min-h-40' : 'min-h-56'}`}>
      <Search className="h-7 w-7 text-ds-faint" strokeWidth={1.6} />
      <div className="mt-3 text-[12.5px] font-semibold text-ds-heading">
        {t('subagentsPanel.emptyTitle', 'No matching agents')}
      </div>
      <p className="mt-1 max-w-56 text-[11px] leading-5 text-ds-muted">
        {query
          ? t('subagentsPanel.emptySearch', 'Try another name, capability, or scenario.')
          : t('subagentsPanel.emptyCategory', 'Choose another category to continue browsing.')}
      </p>
    </div>
  )
}

function BoundedNumberInput({
  value,
  min,
  max,
  onCommit
}: {
  value: number
  min: number
  max: number
  onCommit: (value: number) => void
}): ReactElement {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])

  const commit = (): void => {
    const parsed = Number(draft)
    const next = Number.isFinite(parsed)
      ? Math.min(max, Math.max(min, Math.floor(parsed)))
      : value
    setDraft(String(next))
    if (next !== value) onCommit(next)
  }

  return (
    <input
      type="number"
      min={min}
      max={max}
      value={draft}
      onChange={(event) => {
        const raw = event.target.value
        setDraft(raw)
        const parsed = Number(raw)
        if (raw.trim() && Number.isInteger(parsed) && parsed >= min && parsed <= max && parsed !== value) {
          onCommit(parsed)
        }
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
      className="w-28 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-right font-mono text-[14px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
    />
  )
}

export function SubagentPanelHeader({
  onCollapse
}: {
  onCollapse: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-ds-border px-4 py-3.5">
      <Bot className="h-[17px] w-[17px] text-accent" strokeWidth={2} />
      <b className="text-[14px] font-semibold text-ds-heading">{t('subagents', 'Subagents')}</b>
      <span className="text-[11px] text-ds-faint">· {t('subagentsPanel.configModel', 'configure model')}</span>
      <button
        type="button"
        onClick={onCollapse}
        title={t('agentsView.cancel', 'Close')}
        aria-label={t('agentsView.cancel', 'Close')}
        className="ml-auto rounded-md p-1 text-ds-faint transition hover:bg-ds-subtle hover:text-ds-heading"
      >
        <X className="h-4 w-4" strokeWidth={2} />
      </button>
    </div>
  )
}

function Row({
  variant = 'panel',
  roleId,
  disabled = false,
  builtin = false,
  name,
  desc,
  children
}: {
  variant?: EditorVariant
  roleId: string
  disabled?: boolean
  builtin?: boolean
  name: string
  desc: string
  children: ReactNode
}): ReactElement {
  const { t } = useTranslation('common')
  const settings = variant === 'settings'
  return (
    <div className={`${
      settings
        ? 'grid grid-cols-[42px_minmax(0,1fr)] items-center gap-x-3 gap-y-3 px-4 py-4 transition hover:bg-ds-hover/45 sm:flex sm:gap-3'
        : 'mx-2 flex items-center gap-3 rounded-xl px-2.5 py-2.5 transition hover:bg-ds-hover/60'
    } ${disabled ? 'opacity-60' : ''}`}>
      <span
        className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full"
        style={{ background: 'radial-gradient(circle at 50% 36%, #fff 0%, rgba(238,244,251,0.9) 78%)', boxShadow: 'inset 0 0 0 1px rgba(188,214,245,0.7)' }}
      >
        <AgentKun id={roleId} disabled={disabled} className="h-9 w-9" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13.5px] font-semibold text-ds-heading">{name}</span>
          {builtin ? (
            <span
              className="shrink-0 rounded-full px-1.5 py-px text-[9.5px] font-semibold"
              style={{ backgroundColor: 'rgba(59,130,216,0.14)', color: '#3b82d8' }}
            >
              {t('subagentsPanel.builtin', '内置')}
            </span>
          ) : null}
        </div>
        {desc ? (
          <div className={`${settings ? 'text-[12.5px] leading-5' : 'truncate text-[11px]'} text-ds-muted`}>{desc}</div>
        ) : null}
      </div>
      <div className={`${
        settings
          ? 'col-span-2 flex w-full min-w-0 items-center gap-2 sm:ml-auto sm:w-[340px] sm:shrink-0'
          : 'flex shrink-0 items-center gap-1'
      }`}>{children}</div>
    </div>
  )
}

function RowActions({
  enabled,
  builtin,
  t,
  onToggle,
  onEdit,
  onDelete
}: {
  enabled: boolean
  builtin: boolean
  t: TFunction<'common'>
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}): ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {builtin ? null : (
        <button
          type="button"
          onClick={onToggle}
          title={enabled ? t('disable', 'Disable') : t('enable', 'Enable')}
          className={`rounded p-1.5 hover:bg-ds-subtle ${enabled ? 'text-accent' : 'text-ds-faint'}`}
        >
          <Power className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        type="button"
        onClick={onEdit}
        title={t('agentsView.edit', 'Edit')}
        className="rounded p-1.5 text-ds-muted hover:bg-ds-subtle hover:text-ds-heading"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      {builtin ? null : (
        <button
          type="button"
          onClick={onDelete}
          title={t('agentsView.delete', 'Delete')}
          className="rounded p-1.5 text-ds-muted hover:bg-ds-subtle hover:text-red-500"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

/**
 * Two-step model picker (mirrors the composer): trigger → pick provider → pick
 * model, with a "follow default" option. `stretch` = full-width dialog variant.
 * Reasoning lives in ReasoningEffortPicker, not inside this dropdown.
 */
function ModelSelect({
  value,
  providerId,
  groups,
  onChange,
  disabled,
  small,
  stretch,
  emptyLabel,
  ariaLabel
}: {
  value: string
  providerId: string
  groups: ModelProviderModelGroup[]
  onChange: (model: string, providerId: string) => void
  disabled?: boolean
  small?: boolean
  stretch?: boolean
  emptyLabel?: string
  ariaLabel?: string
}): ReactElement {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  useEffect(() => {
    if (open) setPicked(providerId || null)
  }, [open, providerId])

  const label = value || emptyLabel || t('agentsView.followDefault', '跟随默认')
  const activeGroup = groups.find((g) => g.providerId === picked)

  const triggerCls = stretch
    ? 'flex h-9 w-full items-center justify-between rounded-md border border-ds-border bg-[var(--ds-surface-elevated)] pl-3 pr-2.5 text-sm text-ds-heading disabled:opacity-50'
    : `flex h-8 w-[132px] items-center justify-between gap-1 rounded-[9px] border bg-[var(--ds-surface-elevated)] pl-3 pr-2 text-[12px] font-semibold disabled:opacity-50 ${
        small ? 'border-emerald-200 text-emerald-700 dark:border-emerald-900/60 dark:text-emerald-300' : 'border-ds-border text-accent'
      }`

  return (
    <div className={`relative ${stretch ? 'min-w-0 flex-1' : 'shrink-0'}`} ref={ref}>
      <button
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className={triggerCls}
        style={{ backgroundColor: 'var(--ds-surface-elevated)' }}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ds-faint" />
      </button>
      {open ? (
        <div
          style={{ backgroundColor: 'var(--ds-surface-elevated)' }}
          className={`absolute z-50 mt-1 max-h-[300px] overflow-auto rounded-xl border border-ds-border p-1 shadow-[0_12px_32px_rgba(31,45,64,0.16)] ${
            stretch ? 'left-0 w-full' : 'right-0 w-[230px]'
          }`}
        >
          {picked === null ? (
            <>
              <PickerItem active={!value} onClick={() => { onChange('', ''); setOpen(false) }}>
                {t('agentsView.followDefault', '跟随默认')}
              </PickerItem>
              {groups.map((g) => (
                <button
                  key={g.providerId}
                  type="button"
                  onClick={() => setPicked(g.providerId)}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[13px] text-ds-ink hover:bg-accent-soft"
                >
                  <span className="truncate">{g.label}</span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ds-faint" />
                </button>
              ))}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setPicked(null)}
                className="mb-0.5 flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-medium text-ds-muted hover:bg-ds-card-muted"
              >
                <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{activeGroup?.label ?? picked}</span>
              </button>
              {(activeGroup?.modelIds ?? []).map((id) => (
                <PickerItem
                  key={id}
                  active={value === id && providerId === picked}
                  onClick={() => { onChange(id, picked); setOpen(false) }}
                >
                  {id}
                </PickerItem>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

function ReasoningEffortPicker({
  value,
  onChange,
  options,
  compact = false,
  ariaLabel,
  mixedLabel
}: {
  value: ModelReasoningEffort | null
  onChange: (effort: ModelReasoningEffort) => void
  options: Array<{ id: ModelReasoningEffort; labelKey: string }>
  compact?: boolean
  ariaLabel?: string
  mixedLabel?: string
}): ReactElement {
  const { t } = useTranslation('common')
  return (
    <div
      role="group"
      aria-label={ariaLabel ?? t('subagentsPanel.reasoning', 'Reasoning')}
      className={`flex flex-wrap items-center gap-1 ${compact ? 'justify-end' : ''}`}
    >
      {mixedLabel && value === null ? (
        <span className="mr-0.5 text-[10px] font-semibold text-ds-faint">{mixedLabel}</span>
      ) : null}
      {options.map((opt) => {
        const on = value === opt.id
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            className={`rounded-md px-2 py-1 font-semibold transition ${
              compact ? 'text-[10px]' : 'text-[11px]'
            } ${
              on
                ? 'bg-accent-soft text-accent shadow-[inset_0_0_0_1px_var(--ds-accent)]'
                : 'text-ds-muted hover:bg-ds-card-muted'
            }`}
          >
            {t(opt.labelKey, opt.id)}
          </button>
        )
      })}
    </div>
  )
}

function PickerItem({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] hover:bg-accent-soft ${
        active ? 'font-semibold text-accent' : 'text-ds-ink'
      }`}
    >
      <Check className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-accent opacity-100' : 'opacity-0'}`} />
      <span className="truncate">{children}</span>
    </button>
  )
}

function ProfileDialog({
  profile: initial,
  isNew,
  builtin,
  groups,
  onSave,
  onCancel
}: {
  profile: KunSubagentProfileV1
  isNew: boolean
  builtin: boolean
  groups: ModelProviderModelGroup[]
  onSave: (p: KunSubagentProfileV1) => void
  onCancel: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const [d, setD] = useState<KunSubagentProfileV1>(initial)
  const [tab, setTab] = useState<'basic' | 'permissions'>('basic')
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const set = <K extends keyof KunSubagentProfileV1>(k: K, v: KunSubagentProfileV1[K]): void =>
    setD((p) => ({ ...p, [k]: v }))

  // Lazily fetch the MCP/skill catalog the first time the Permissions tab opens —
  // avoids a runtime round-trip for users who only edit the basic fields.
  useEffect(() => {
    if (tab !== 'permissions' || catalog || catalogLoading) return
    setCatalogLoading(true)
    void loadCapabilityCatalog().then(setCatalog).finally(() => setCatalogLoading(false))
  }, [tab, catalog, catalogLoading])

  // Drives the "Custom" chip on the Permissions tab: readOnly, or any deny-list set.
  const customized = d.toolPolicy === 'readOnly'
    || Boolean(d.blockedTools?.length || d.blockedMcpServers?.length || d.blockedSkills?.length)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-ds-border bg-ds-main shadow-2xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-ds-border px-4 py-3">
          <Bot className="h-4 w-4 text-ds-muted" />
          <span className="text-sm font-semibold text-ds-heading">
            {isNew ? t('subagentsPanel.newSubagent', 'New subagent') : t('agentsView.editAgent', 'Edit agent')}
          </span>
        </div>
        <div className="flex shrink-0 gap-1 border-b border-ds-border px-3 pt-2">
          <TabButton active={tab === 'basic'} onClick={() => setTab('basic')}>
            {t('agentsView.tabBasic', 'Basic')}
          </TabButton>
          <TabButton
            active={tab === 'permissions'}
            onClick={() => setTab('permissions')}
            badge={customized ? t('agentsView.permScopeCustom', 'Custom') : undefined}
          >
            {t('agentsView.tabPermissions', 'Permissions')}
          </TabButton>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {tab === 'basic' ? (
            <>
          <Field label={t('agentsView.fName', 'Name')}>
            <input
              autoFocus
              value={d.name}
              disabled={builtin}
              onChange={(e) => set('name', e.target.value)}
              className="w-full rounded-md border border-ds-border bg-[var(--ds-surface-elevated)] px-3 py-1.5 text-sm"
            />
          </Field>
          <Field label={t('agentsView.fDesc', 'Description')}>
            <input
              value={d.description ?? ''}
              onChange={(e) => set('description', e.target.value || undefined)}
              className="w-full rounded-md border border-ds-border bg-[var(--ds-surface-elevated)] px-3 py-1.5 text-sm"
            />
          </Field>
          <Field label={t('agentsView.fColor', 'Color')}>
            <div className="flex gap-2.5">
              {PRESET_COLORS.map((c) => {
                const selected = d.color === c
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => set('color', c)}
                    aria-pressed={selected}
                    className="relative h-8 w-8 rounded-full transition-transform hover:scale-110"
                    style={{
                      backgroundColor: c,
                      boxShadow: selected
                        ? `0 0 0 2px var(--ds-surface-card), 0 0 0 4px ${c}, 0 2px 6px ${c}66`
                        : `inset 0 0 0 1px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.15)`
                    }}
                  >
                    {selected && (
                      <span className="absolute inset-0 flex items-center justify-center text-white text-sm font-semibold drop-shadow">
                        ✓
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </Field>
          <Field label={t('agentsView.fMode', 'Mode')}>
            <select
              value={d.mode}
              onChange={(e) => set('mode', e.target.value as KunSubagentProfileV1['mode'])}
              className="w-full rounded-md border border-ds-border bg-[var(--ds-surface-elevated)] px-3 py-1.5 text-sm"
            >
              <option value="subagent">{t('agentsView.modeDelegate', 'delegate')}</option>
              <option value="primary">{t('agentsView.modePersona', 'persona')}</option>
              <option value="all">{t('agentsView.modeBoth', 'both')}</option>
            </select>
          </Field>
          <Field label={t('agentsView.fModel', 'Model')}>
            <ModelSelectFull
              value={d.model ?? ''}
              providerId={d.providerId ?? ''}
              groups={groups}
              onChange={(m, pid) => setD((p) => ({ ...p, model: m || undefined, providerId: pid || undefined }))}
            />
          </Field>
          <Field label={t('subagentsPanel.reasoning', 'Reasoning')}>
            <ReasoningEffortPicker
              value={normalizeStoredReasoning(d.reasoningEffort)}
              options={resolveReasoningOptions(groups, d.model ?? '', d.providerId ?? '')}
              onChange={(effort) =>
                setD((p) => ({ ...p, reasoningEffort: effort === 'off' ? undefined : effort }))
              }
            />
          </Field>
          <Field label={t('agentsView.fSystemPrompt', 'System prompt')}>
            <textarea
              value={d.systemPrompt ?? ''}
              rows={3}
              onChange={(e) => set('systemPrompt', e.target.value || undefined)}
              className="w-full resize-none rounded-md border border-ds-border bg-[var(--ds-surface-elevated)] px-3 py-1.5 text-sm"
            />
          </Field>
            </>
          ) : (
            <PermissionsTab d={d} setD={setD} catalog={catalog} loading={catalogLoading} t={t} />
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-ds-border px-4 py-3">
          <button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-sm text-ds-muted hover:text-ds-heading">
            {t('agentsView.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            onClick={() => onSave({ ...d, name: d.name.trim() || d.id })}
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
          >
            {isNew ? t('agentsView.create', 'Create') : t('agentsView.save', 'Save')}
          </button>
        </div>
      </div>
    </div>
  )
}

function TabButton({ active, onClick, badge, children }: {
  active: boolean
  onClick: () => void
  badge?: string
  children: ReactNode
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition ${
        active ? 'border-accent text-ds-heading' : 'border-transparent text-ds-muted hover:text-ds-heading'
      }`}
    >
      {children}
      {badge ? (
        <span
          className="rounded-full px-1.5 py-px text-[9.5px] font-semibold"
          style={{ backgroundColor: 'rgba(59,130,216,0.14)', color: '#3b82d8' }}
        >
          {badge}
        </span>
      ) : null}
    </button>
  )
}

/**
 * Permission scope editor. The preset segmented control maps to the profile's
 * deny-list fields: readOnly → toolPolicy:'readOnly'; All → inherit + cleared
 * deny-lists; Custom → inherit + per-section block-lists. Everything here only
 * REMOVES capabilities, so the child can never exceed the main agent.
 */
function PermissionsTab({ d, setD, catalog, loading, t }: {
  d: KunSubagentProfileV1
  setD: Dispatch<SetStateAction<KunSubagentProfileV1>>
  catalog: CapabilityCatalog | null
  loading: boolean
  t: TFunction<'common'>
}): ReactElement {
  const [query, setQuery] = useState('')
  const readOnly = d.toolPolicy === 'readOnly'
  const hasDeny = Boolean(d.blockedTools?.length || d.blockedMcpServers?.length || d.blockedSkills?.length)
  const scope: 'readOnly' | 'all' | 'custom' = readOnly ? 'readOnly' : hasDeny ? 'custom' : 'all'

  const setScope = (next: 'readOnly' | 'all' | 'custom'): void => {
    if (next === 'readOnly') { setD((p) => ({ ...p, toolPolicy: 'readOnly' })); return }
    if (next === 'all') {
      setD((p) => ({ ...p, toolPolicy: 'inherit', blockedTools: undefined, blockedMcpServers: undefined, blockedSkills: undefined }))
      return
    }
    setD((p) => ({ ...p, toolPolicy: 'inherit' }))
  }

  const toggle = (key: 'blockedTools' | 'blockedMcpServers' | 'blockedSkills', id: string): void => {
    setD((p) => {
      const cur = new Set(p[key] ?? [])
      if (cur.has(id)) cur.delete(id)
      else cur.add(id)
      const next = [...cur]
      return { ...p, [key]: next.length ? next : undefined }
    })
  }

  const q = query.trim().toLowerCase()
  const tools = BUILTIN_TOOL_NAMES.filter((name) => !q || name.includes(q))
  const servers = (catalog?.mcpServers ?? []).filter((s) => !q || s.id.toLowerCase().includes(q))
  const skills = (catalog?.skills ?? []).filter((s) => !q || s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))

  const toolsOn = BUILTIN_TOOL_NAMES.length - (d.blockedTools?.length ?? 0)
  const serversTotal = catalog?.mcpServers.length ?? 0
  const serversOn = serversTotal - (d.blockedMcpServers?.length ?? 0)
  const skillsTotal = catalog?.skills.length ?? 0
  const skillsBlocked = d.blockedSkills?.length ?? 0

  const SEG: Array<{ id: 'readOnly' | 'all' | 'custom'; label: string }> = [
    { id: 'readOnly', label: t('agentsView.permScopeReadOnly', 'Read-only') },
    { id: 'all', label: t('agentsView.permScopeAll', 'All') },
    { id: 'custom', label: t('agentsView.permScopeCustom', 'Custom') }
  ]

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-ds-muted">{t('agentsView.permScope', 'Capability scope')}</label>
        <div className="flex gap-1 rounded-lg bg-ds-subtle p-1">
          {SEG.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setScope(s.id)}
              className={`flex-1 rounded-md px-2 py-1.5 text-[12.5px] font-medium transition ${
                scope === s.id
                  ? 'bg-[var(--ds-surface-elevated)] text-ds-heading shadow-[inset_0_0_0_1px_var(--ds-border)]'
                  : 'text-ds-muted hover:text-ds-heading'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-ds-faint">
          {scope === 'readOnly'
            ? t('agentsView.permScopeReadOnlyNote', 'Investigation only: read / grep / find / ls. No MCP or skills.')
            : scope === 'all'
              ? t('agentsView.permScopeAllNote', 'Inherits every capability the main agent has.')
              : t('agentsView.permScopeHint', 'Pick the capabilities this agent may use — never exceeds the main agent.')}
        </p>
      </div>

      {readOnly ? null : (
        <>
          <div className="flex items-center gap-2 rounded-md border border-ds-border bg-[var(--ds-surface-elevated)] px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-ds-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('agentsView.permSearch', 'Search tools / MCP / skills…')}
              className="w-full bg-transparent text-[12.5px] text-ds-heading outline-none placeholder:text-ds-faint"
            />
          </div>

          <Section
            icon={<Wrench className="h-3.5 w-3.5" />}
            title={t('agentsView.permSecTools', 'Built-in tools')}
            badge={`${toolsOn} / ${BUILTIN_TOOL_NAMES.length}`}
          >
            <div className="flex flex-wrap gap-1.5">
              {tools.map((name) => {
                const on = !d.blockedTools?.includes(name)
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => toggle('blockedTools', name)}
                    className={`rounded-md px-2 py-1 text-[11.5px] font-medium transition ${
                      on
                        ? 'bg-accent-soft text-accent shadow-[inset_0_0_0_1px_var(--ds-accent)]'
                        : 'text-ds-faint line-through hover:text-ds-muted'
                    }`}
                  >
                    {name}
                  </button>
                )
              })}
            </div>
          </Section>

          <Section
            icon={<Plug className="h-3.5 w-3.5" />}
            title={t('agentsView.permSecMcp', 'MCP servers')}
            badge={serversTotal ? `${serversOn} / ${serversTotal}` : undefined}
          >
            {loading ? (
              <Hint>{t('agentsView.permLoading', 'Loading capabilities…')}</Hint>
            ) : serversTotal === 0 ? (
              <Hint>{t('agentsView.permNoMcp', 'No MCP servers configured.')}</Hint>
            ) : (
              <div className="space-y-0.5">
                {servers.map((s) => (
                  <CapRow
                    key={s.id}
                    on={!d.blockedMcpServers?.includes(s.id)}
                    onToggle={() => toggle('blockedMcpServers', s.id)}
                    label={s.id}
                    meta={`${s.toolCount} ${t('agentsView.permToolsWord', 'tools')}`}
                  />
                ))}
              </div>
            )}
          </Section>

          <Section
            icon={<Sparkles className="h-3.5 w-3.5" />}
            title={t('agentsView.permSecSkills', 'Skills')}
            badge={skillsTotal
              ? (skillsBlocked
                  ? `${t('agentsView.permScopeAll', 'All')} · ${skillsBlocked} ${t('agentsView.permBlocked', 'blocked')}`
                  : t('agentsView.permScopeAll', 'All'))
              : undefined}
          >
            {loading ? (
              <Hint>{t('agentsView.permLoading', 'Loading capabilities…')}</Hint>
            ) : skillsTotal === 0 ? (
              <Hint>{t('agentsView.permNoSkills', 'No skills discovered.')}</Hint>
            ) : (
              <>
                <p className="mb-1.5 text-[11px] text-ds-faint">{t('agentsView.permSkillsInheritNote', 'Inherits all available skills by default; block individually.')}</p>
                <div className="max-h-44 space-y-0.5 overflow-y-auto">
                  {skills.map((s) => (
                    <CapRow
                      key={s.id}
                      on={!d.blockedSkills?.includes(s.id)}
                      onToggle={() => toggle('blockedSkills', s.id)}
                      label={s.name || s.id}
                      meta={s.description}
                    />
                  ))}
                </div>
              </>
            )}
          </Section>
        </>
      )}
    </div>
  )
}

function Section({ icon, title, badge, children }: {
  icon: ReactNode
  title: string
  badge?: string
  children: ReactNode
}): ReactElement {
  return (
    <div className="rounded-lg border border-ds-border">
      <div className="flex items-center gap-2 border-b border-ds-border px-3 py-2">
        <span className="text-ds-muted">{icon}</span>
        <span className="text-[12.5px] font-medium text-ds-heading">{title}</span>
        {badge ? <span className="ml-auto rounded-full bg-ds-subtle px-2 py-px text-[10.5px] text-ds-muted">{badge}</span> : null}
      </div>
      <div className="px-3 py-2.5">{children}</div>
    </div>
  )
}

function CapRow({ on, onToggle, label, meta }: {
  on: boolean
  onToggle: () => void
  label: string
  meta?: string
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left hover:bg-ds-hover/60"
    >
      <span className={`flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition ${on ? 'justify-end bg-accent' : 'justify-start bg-ds-border'}`}>
        <span className="h-3 w-3 rounded-full bg-white" />
      </span>
      <span className={`min-w-0 flex-1 truncate text-[12.5px] ${on ? 'text-ds-heading' : 'text-ds-faint'}`}>{label}</span>
      {meta ? <span className="max-w-[45%] shrink-0 truncate pl-2 text-[10.5px] text-ds-faint">{meta}</span> : null}
    </button>
  )
}

function Hint({ children }: { children: ReactNode }): ReactElement {
  return <p className="text-[11.5px] text-ds-faint">{children}</p>
}

/** Full-width model picker for the dialog (reuses ModelSelect, stretched). */
function ModelSelectFull(props: {
  value: string
  providerId: string
  groups: ModelProviderModelGroup[]
  onChange: (model: string, providerId: string) => void
}): ReactElement {
  return <ModelSelect {...props} stretch />
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactElement }): ReactElement {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-ds-muted">{label}</label>
      {children}
      {hint ? <p className="mt-1 text-xs text-ds-faint">{hint}</p> : null}
    </div>
  )
}
