import type { Dispatch, ReactElement, SetStateAction } from 'react'
import {
  Archive,
  AudioLines,
  Bot,
  BrainCircuit,
  Bug,
  ChevronLeft,
  GitBranch,
  Globe,
  Keyboard,
  Mic,
  PackageOpen,
  Palette,
  PencilLine,
  Puzzle,
  RefreshCw,
  ServerCog,
  Settings,
  ShieldCheck,
  Smartphone,
  Sparkles,
  TerminalSquare,
  UsersRound,
  type LucideIcon
} from 'lucide-react'

export type SettingsCategory =
  | 'general'
  | 'providers'
  | 'write'
  | 'design'
  | 'mediaGeneration'
  | 'speechToText'
  | 'agents'
  | 'subagents'
  | 'archives'
  | 'worktree'
  | 'memory'
  | 'shortcuts'
  | 'easterEgg'
  | 'claw'
  | 'updates'
  | 'debug'
  | 'terminal'
  | 'extensions'
  | 'dataMigration'

type SettingsNavigationItem = {
  category: SettingsCategory
  labelKey: string
  navigationLabelKey?: string
  icon: LucideIcon
  extensionOnly?: boolean
}

type SettingsNavigationGroup = {
  id: string
  labelKey: string
  items: SettingsNavigationItem[]
}

const SETTINGS_NAVIGATION_GROUPS: SettingsNavigationGroup[] = [
  {
    id: 'core',
    labelKey: 'settingsGroupCore',
    items: [
      { category: 'general', labelKey: 'general', icon: Globe },
      { category: 'providers', labelKey: 'providers', icon: ServerCog },
      { category: 'extensions', labelKey: 'extensions', icon: Puzzle, extensionOnly: true }
    ]
  },
  {
    id: 'workbench',
    labelKey: 'settingsGroupWorkbench',
    items: [
      { category: 'write', labelKey: 'write', icon: PencilLine },
      { category: 'design', labelKey: 'design', icon: Palette },
      {
        category: 'mediaGeneration',
        labelKey: 'mediaGeneration',
        navigationLabelKey: 'settingsNavMedia',
        icon: AudioLines
      },
      {
        category: 'speechToText',
        labelKey: 'speechToText',
        navigationLabelKey: 'settingsNavSpeech',
        icon: Mic
      }
    ]
  },
  {
    id: 'intelligence',
    labelKey: 'settingsGroupIntelligence',
    items: [
      { category: 'agents', labelKey: 'agents', navigationLabelKey: 'settingsNavAssistant', icon: Bot },
      { category: 'subagents', labelKey: 'subagents', icon: UsersRound },
      { category: 'memory', labelKey: 'memory', icon: BrainCircuit }
    ]
  },
  {
    id: 'data',
    labelKey: 'settingsGroupData',
    items: [
      { category: 'archives', labelKey: 'archives', navigationLabelKey: 'settingsNavArchives', icon: Archive },
      {
        category: 'dataMigration',
        labelKey: 'dataMigration',
        navigationLabelKey: 'settingsNavMigration',
        icon: PackageOpen
      },
      { category: 'worktree', labelKey: 'worktree', icon: GitBranch }
    ]
  },
  {
    id: 'system',
    labelKey: 'settingsGroupSystem',
    items: [
      {
        category: 'shortcuts',
        labelKey: 'keyboardShortcuts',
        navigationLabelKey: 'settingsNavShortcuts',
        icon: Keyboard
      },
      {
        category: 'easterEgg',
        labelKey: 'easterEgg',
        navigationLabelKey: 'settingsNavAppearance',
        icon: Sparkles
      },
      { category: 'updates', labelKey: 'updates', navigationLabelKey: 'settingsNavUpdates', icon: RefreshCw },
      { category: 'claw', labelKey: 'claw', navigationLabelKey: 'settingsNavPhone', icon: Smartphone },
      { category: 'terminal', labelKey: 'terminal', icon: TerminalSquare },
      { category: 'debug', labelKey: 'debug', icon: Bug }
    ]
  }
]

const SETTINGS_CATEGORY_DESCRIPTION_KEYS: Record<SettingsCategory, string> = {
  general: 'subtitle',
  providers: 'providersDesc',
  extensions: 'subtitle',
  write: 'subtitle',
  design: 'subtitle',
  mediaGeneration: 'mediaGenerationDesc',
  speechToText: 'speechToTextEnabledDesc',
  agents: 'kunProviderDesc',
  subagents: 'subagentsSettingsIntro',
  archives: 'archivesOverviewDesc',
  worktree: 'worktreeOverviewDesc',
  memory: 'memoryOverviewDesc',
  shortcuts: 'subtitle',
  easterEgg: 'uiModeWorkshopDesc',
  claw: 'clawEnabledDesc',
  updates: 'guiUpdateDesc',
  debug: 'llmDebugDesc',
  terminal: 'terminalColorModeDesc',
  dataMigration: 'dataMigrationSubtitle'
}

export function settingsCategoryLabelKey(category: SettingsCategory): string {
  for (const group of SETTINGS_NAVIGATION_GROUPS) {
    const item = group.items.find((candidate) => candidate.category === category)
    if (item) return item.labelKey
  }
  return 'title'
}

export function settingsCategoryDescriptionKey(category: SettingsCategory): string {
  return SETTINGS_CATEGORY_DESCRIPTION_KEYS[category]
}

export function SettingsSidebar({
  category,
  goBack,
  setCategory,
  extensionSettingsAvailable = false,
  t
}: {
  category: SettingsCategory
  goBack: () => void
  setCategory: Dispatch<SetStateAction<SettingsCategory>>
  extensionSettingsAvailable?: boolean
  t: (key: string) => string
}): ReactElement {
  return (
    <aside className="ds-settings-sidebar ds-drag flex h-full min-h-0 w-[228px] shrink-0 flex-col border-r border-ds-border bg-ds-sidebar backdrop-blur-md">
      <div className="shrink-0 px-3 pb-2 pt-3">
        <div aria-hidden className="ds-titlebar-safe-block" />
        <div className="flex items-center gap-2 px-1">
          <button
            type="button"
            aria-label={t('back')}
            title={t('back')}
            data-cursor-spotlight-target
            onClick={goBack}
            className="ds-no-drag flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={1.9} />
          </button>
          <h1 className="truncate text-[16px] font-semibold tracking-tight text-ds-ink">
            {t('title')}
          </h1>
        </div>
      </div>

      <nav
        aria-label={t('title')}
        className="ds-no-drag min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3"
      >
        {SETTINGS_NAVIGATION_GROUPS.map((group, groupIndex) => {
          const items = group.items.filter((item) => !item.extensionOnly || extensionSettingsAvailable)
          if (items.length === 0) return null
          const headingId = `settings-nav-group-${group.id}`
          return (
            <section
              key={group.id}
              aria-labelledby={headingId}
              className={groupIndex === 0 ? '' : 'mt-3'}
            >
              <h2
                id={headingId}
                className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-ds-faint"
              >
                {t(group.labelKey)}
              </h2>
              <div className="space-y-0.5">
                {items.map((item) => {
                  const Icon = item.icon
                  const selected = category === item.category
                  const fullLabel = t(item.labelKey)
                  const navigationLabelKey = item.navigationLabelKey ?? item.labelKey
                  const translatedNavigationLabel = t(navigationLabelKey)
                  const label = translatedNavigationLabel === navigationLabelKey
                    ? fullLabel
                    : translatedNavigationLabel
                  return (
                    <button
                      key={item.category}
                      type="button"
                      aria-label={fullLabel}
                      aria-current={selected ? 'page' : undefined}
                      title={fullLabel}
                      data-settings-category={item.category}
                      data-cursor-spotlight-target
                      className={`group flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-1.5 text-left text-[13px] font-medium transition ${
                        selected
                          ? 'bg-accent/10 text-accent ring-1 ring-inset ring-accent/20'
                          : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
                      }`}
                      onClick={() => setCategory(item.category)}
                    >
                      <span
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition ${
                          selected
                            ? 'border-accent/20 bg-accent text-white shadow-sm'
                            : 'border-ds-border-muted bg-ds-card/70 text-ds-muted group-hover:border-ds-border group-hover:text-ds-ink'
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      {selected ? <span aria-hidden className="mr-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /> : null}
                    </button>
                  )
                })}
              </div>
            </section>
          )
        })}
      </nav>

      <div className="ds-no-drag shrink-0 border-t border-ds-border px-3 py-2.5">
        <div className="flex items-center gap-2 rounded-xl px-1">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ds-subtle text-ds-muted">
            <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.8} />
          </div>
          <div className="min-w-0 text-[11px] leading-4 text-ds-faint">
            <div className="truncate font-medium text-ds-muted">Kun</div>
            <div className="truncate">{t('settingsFooter')}</div>
          </div>
          <Settings aria-hidden className="ml-auto h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={1.75} />
        </div>
      </div>
    </aside>
  )
}
