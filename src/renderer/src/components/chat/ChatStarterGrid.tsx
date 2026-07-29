import type { ReactElement } from 'react'
import { Bug, FolderOpen, Lightbulb } from 'lucide-react'
import { useTranslation } from 'react-i18next'

type SuggestionTone = 'blue' | 'emerald' | 'violet'

const SUGGESTION_TONE: Record<SuggestionTone, string> = {
  blue: 'bg-ds-subtle text-ds-muted',
  emerald: 'bg-ds-subtle text-ds-muted',
  violet: 'bg-ds-subtle text-ds-muted'
}

const CHAT_STARTERS: Array<{
  icon: ReactElement
  tone: SuggestionTone
  titleKey: string
  subKey: string
  promptKey: string
}> = [
  {
    icon: <FolderOpen className="h-4 w-4" strokeWidth={1.8} />,
    tone: 'blue',
    titleKey: 'promptStructureTitle',
    subKey: 'promptStructureSub',
    promptKey: 'promptStructurePrompt'
  },
  {
    icon: <Bug className="h-4 w-4" strokeWidth={1.8} />,
    tone: 'emerald',
    titleKey: 'promptBugTitle',
    subKey: 'promptBugSub',
    promptKey: 'promptBugPrompt'
  },
  {
    icon: <Lightbulb className="h-4 w-4" strokeWidth={1.8} />,
    tone: 'violet',
    titleKey: 'promptPlanTitle',
    subKey: 'promptPlanSub',
    promptKey: 'promptPlanPrompt'
  }
]

export function ChatStarterGrid({
  onSelectSuggestion,
  compact = false
}: {
  onSelectSuggestion?: (prompt: string) => void
  compact?: boolean
}): ReactElement {
  const { t } = useTranslation('common')
  return (
    <div className={`${compact ? 'mt-5' : 'mt-10'} grid w-full gap-3 sm:grid-cols-2 ${compact ? 'max-w-none' : 'ds-chat-content-max-width'}`}>
      {CHAT_STARTERS.map((starter) => (
        <button
          key={starter.titleKey}
          type="button"
          onClick={() => onSelectSuggestion?.(t(starter.promptKey))}
          className={`ds-empty-hero-card group flex min-h-[96px] items-center gap-4 rounded-[var(--ds-radius-card)] border border-ds-border bg-ds-card px-5 py-4 text-left transition duration-150 hover:border-ds-border-strong hover:bg-ds-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 ${compact ? 'min-h-[84px]' : ''}`}
        >
          <span
            className={`ds-empty-hero-card-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] ${SUGGESTION_TONE[starter.tone]}`}
          >
            {starter.icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="ds-empty-hero-card-title block truncate text-[14px] font-medium tracking-[0] text-ds-ink">
              {t(starter.titleKey)}
            </span>
            <span className="ds-empty-hero-card-sub mt-1 block text-[12px] leading-[1.4] text-ds-muted">
              {t(starter.subKey)}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}
