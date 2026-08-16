import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import {
  Archive,
  GitFork,
  ListTodo,
  MessageCircleMore,
  Minimize2,
  Plus,
  RotateCcw,
  Search,
  SearchCode,
  Sparkles,
  Target
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { AppRoute } from '../../store/chat-store-types'
import {
  COMPACT_COMMAND_ALIASES,
  NEW_COMMAND_ALIASES,
  RESEARCH_COMMAND_ALIASES,
  REVIEW_COMMAND_ALIASES,
  type SlashCommand
} from './floating-composer-commands'

export type ComposerSkillCommand = {
  id: string
  name: string
  description?: string
  root?: string
  scope?: 'project' | 'global'
  legacy?: boolean
  triggers?: {
    commands?: string[]
    fileTypes?: string[]
    promptPatterns?: string[]
  }
}

type Options = {
  slashQuery: string | null
  route: AppRoute
  runtimeReady: boolean
  busy: boolean
  activeThreadId: string | null
  activeThreadArchived: boolean
  canOpenGoalPanel: boolean
  canCreateNewThread: boolean
  workspaceRoot: string
  hasPlanCommand: boolean
  hasBtwCommand: boolean
  hideBtwCommand: boolean
  hasReviewCommand: boolean
  skillCommands: ComposerSkillCommand[]
  disabledSkillIds?: string[]
  onDismiss: () => void
}

/** Owns slash-command catalog construction, filtering, selection, and keyboard navigation. */
export function useComposerSlashCommandMenu(options: Options) {
  const commands = useComposerSlashCommands(options)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const filteredCommands = useMemo(() => {
    if (options.slashQuery == null) return []
    if (!options.slashQuery) return commands
    return commands.filter((command) => {
      const haystack = [command.id, command.title, command.description, ...command.keywords]
      return haystack.some((part) => part.toLowerCase().includes(options.slashQuery!))
    })
  }, [commands, options.slashQuery])
  const highlightedCommand = filteredCommands.length > 0
    ? filteredCommands[Math.min(selectedIndex, filteredCommands.length - 1)]
    : null

  useEffect(() => setSelectedIndex(0), [options.slashQuery])

  const handleKeyDown = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
    composing: boolean
  ): boolean => {
    if (composing || options.slashQuery == null) return false
    if (event.key === 'ArrowDown' && filteredCommands.length > 0) {
      event.preventDefault()
      setSelectedIndex((current) => (current + 1) % filteredCommands.length)
      return true
    }
    if (event.key === 'ArrowUp' && filteredCommands.length > 0) {
      event.preventDefault()
      setSelectedIndex((current) => current === 0 ? filteredCommands.length - 1 : current - 1)
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      options.onDismiss()
      return true
    }
    return false
  }

  return {
    commands,
    filteredCommands,
    highlightedCommand,
    selectedIndex,
    handleKeyDown
  }
}

export type ComposerSlashCommandCatalogInput = {
  t: TFunction
  route: AppRoute
  runtimeReady: boolean
  busy: boolean
  activeThreadId: string | null
  activeThreadArchived: boolean
  canOpenGoalPanel: boolean
  canCreateNewThread: boolean
  workspaceRoot: string
  hasPlanCommand: boolean
  hasBtwCommand: boolean
  hideBtwCommand: boolean
  hasReviewCommand: boolean
  skillCommands: ComposerSkillCommand[]
  disabledSkillIds?: string[]
}

/**
 * The single slash-command catalog builder. The composer slash menu and
 * the command palette consume this same function so a new command reaches
 * both surfaces without a second registration.
 */
export function buildComposerSlashCommands({
  t,
  route,
  runtimeReady,
  busy,
  activeThreadId,
  activeThreadArchived,
  canOpenGoalPanel,
  canCreateNewThread,
  workspaceRoot,
  hasPlanCommand,
  hasBtwCommand,
  hideBtwCommand,
  hasReviewCommand,
  skillCommands,
  disabledSkillIds
}: ComposerSlashCommandCatalogInput): SlashCommand[] {
    const threadActionDisabled = !runtimeReady || busy || !activeThreadId
    const disabledSkills = disabledSkillIdSet(disabledSkillIds)
    const commands: SlashCommand[] = []
    if (route !== 'claw') {
      commands.push({
        id: 'new',
        title: t('slashCommandNewTitle'),
        description: t('slashCommandNewDescription'),
        keywords: ['create', 'new', 'thread', 'chat', '会话', '新建', ...NEW_COMMAND_ALIASES],
        icon: <Plus className="h-4 w-4" strokeWidth={1.9} />,
        disabled: !canCreateNewThread
      })
      commands.push({
        id: 'research',
        title: t('slashCommandResearchTitle'),
        description: t('slashCommandResearchDescription'),
        keywords: ['research', 'deep', 'web', 'sources', 'papers', 'evidence', ...RESEARCH_COMMAND_ALIASES],
        icon: <Search className="h-4 w-4" strokeWidth={1.9} />,
        disabled: !runtimeReady
      })
    }
    if (hasPlanCommand) {
      commands.push({
        id: 'plan',
        title: t('slashCommandPlanTitle'),
        description: t('slashCommandPlanDescription'),
        keywords: ['plan', 'planner', 'planning', '规划', '计划'],
        icon: <ListTodo className="h-4 w-4" strokeWidth={1.9} />
      })
    }

    if (route !== 'claw') {
      commands.push(...skillCommands
        .filter((skill) => skill.id.trim() && skill.name.trim())
        .filter((skill) => !disabledSkills.has(normalizeSkillCommandId(skill.id)))
        .sort((left, right) => {
          const leftProject = isProjectSkill(left, workspaceRoot)
          const rightProject = isProjectSkill(right, workspaceRoot)
          if (leftProject !== rightProject) return leftProject ? -1 : 1
          return left.name.localeCompare(right.name)
        })
        .slice(0, 40)
        .map<SlashCommand>((skill) => {
          const prompt = `/skill:${skill.id} `
          const scopeLabel = isProjectSkill(skill, workspaceRoot)
            ? t('slashSkillScopeProject')
            : t('slashSkillScopeGlobal')
          const triggers = [
            ...(skill.triggers?.commands ?? []),
            ...(skill.triggers?.fileTypes ?? []),
            ...(skill.triggers?.promptPatterns ?? [])
          ]
          return {
            id: `skill:${skill.id}`,
            kind: 'skill',
            title: skill.name,
            description: skill.description?.trim() || t('slashSkillDescriptionFallback'),
            keywords: [skill.id, skill.name, skill.root ?? '', scopeLabel, 'skill', '技能', ...triggers],
            icon: <Sparkles className="h-4 w-4" strokeWidth={1.9} />,
            badge: prompt.trim(),
            scopeLabel,
            skillPrompt: prompt,
            disabled: !runtimeReady
          }
        }))

      commands.push({
        id: 'goal',
        title: t('slashCommandGoalTitle'),
        description: t('slashCommandGoalDescription'),
        keywords: ['goal', 'objective', 'target', '目标', '任务'],
        icon: <Target className="h-4 w-4" strokeWidth={1.9} />,
        disabled: !canOpenGoalPanel
      })

      if (hasBtwCommand && !hideBtwCommand) {
        commands.push({
          id: 'btw',
          title: t('slashCommandBtwTitle'),
          description: t('slashCommandBtwDescription'),
          keywords: ['btw', 'by-the-way', 'aside', 'side', '顺便', '旁支'],
          icon: <MessageCircleMore className="h-4 w-4" strokeWidth={1.9} />,
          disabled: !runtimeReady || !activeThreadId
        })
      }

      if (hasReviewCommand) {
        commands.push({
          id: 'review',
          title: t('slashCommandReviewTitle'),
          description: t('slashCommandReviewDescription'),
          keywords: REVIEW_COMMAND_ALIASES,
          icon: <SearchCode className="h-4 w-4" strokeWidth={1.9} />,
          disabled: threadActionDisabled
        })
      }

      commands.push(
        {
          id: 'compact',
          title: t('slashCommandCompactTitle'),
          description: t('slashCommandCompactDescription'),
          keywords: COMPACT_COMMAND_ALIASES,
          icon: <Minimize2 className="h-4 w-4" strokeWidth={1.9} />,
          disabled: threadActionDisabled
        },
        {
          id: 'fork',
          title: t('slashCommandForkTitle'),
          description: t('slashCommandForkDescription'),
          keywords: ['fork', 'branch', 'copy', '分叉', '复制'],
          icon: <GitFork className="h-4 w-4" strokeWidth={1.9} />,
          disabled: threadActionDisabled
        }
      )

      commands.push(activeThreadArchived
        ? {
            id: 'restore',
            title: t('slashCommandRestoreTitle'),
            description: t('slashCommandRestoreDescription'),
            keywords: ['restore', 'unarchive', '恢复'],
            icon: <RotateCcw className="h-4 w-4" strokeWidth={1.9} />,
            disabled: threadActionDisabled
          }
        : {
            id: 'archive',
            title: t('slashCommandArchiveTitle'),
            description: t('slashCommandArchiveDescription'),
            keywords: ['archive', 'hide', '归档'],
            icon: <Archive className="h-4 w-4" strokeWidth={1.9} />,
            disabled: threadActionDisabled
          })
    }
    return commands
}

function useComposerSlashCommands(options: Options): SlashCommand[] {
  const { t } = useTranslation('common')
  const {
    route,
    runtimeReady,
    busy,
    activeThreadId,
    activeThreadArchived,
    canOpenGoalPanel,
    canCreateNewThread,
    workspaceRoot,
    hasPlanCommand,
    hasBtwCommand,
    hideBtwCommand,
    hasReviewCommand,
    skillCommands,
    disabledSkillIds
  } = options
  return useMemo(
    () => buildComposerSlashCommands({
      t,
      route,
      runtimeReady,
      busy,
      activeThreadId,
      activeThreadArchived,
      canOpenGoalPanel,
      canCreateNewThread,
      workspaceRoot,
      hasPlanCommand,
      hasBtwCommand,
      hideBtwCommand,
      hasReviewCommand,
      skillCommands,
      disabledSkillIds
    }),
    [
      activeThreadArchived,
      activeThreadId,
      busy,
      canCreateNewThread,
      canOpenGoalPanel,
      disabledSkillIds,
      hasBtwCommand,
      hasPlanCommand,
      hasReviewCommand,
      hideBtwCommand,
      route,
      runtimeReady,
      skillCommands,
      t,
      workspaceRoot
    ]
  )
}

function comparablePath(path: string | undefined): string {
  return (path ?? '').replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase()
}

function isProjectSkill(skill: ComposerSkillCommand, workspaceRoot: string): boolean {
  if (skill.scope === 'project') return true
  if (skill.scope === 'global') return false
  const root = comparablePath(skill.root)
  const workspace = comparablePath(workspaceRoot)
  return Boolean(root && workspace && (root === workspace || root.startsWith(`${workspace}/`)))
}

function normalizeSkillCommandId(id: string): string {
  return id.trim().replace(/^\/?skill:/i, '').trim()
}

function disabledSkillIdSet(ids: string[] | undefined): Set<string> {
  return new Set((ids ?? []).map(normalizeSkillCommandId).filter(Boolean))
}
