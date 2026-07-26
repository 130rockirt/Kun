import type { ReactElement } from 'react'
import { Check, CornerDownLeft, HelpCircle, X } from 'lucide-react'
import type { UserInputOption, UserInputQuestion } from '../../agent/types'
import type { ComposerUserInputController } from './use-composer-user-input'
import {
  isMultipleChoiceQuestion,
  optionsNeedRows,
  shouldShowQuestionHeader
} from './user-input-panel-logic'

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * The ask-user input surface, docked directly above the composer. The common
 * single-question case renders as bare chips (no header / progress / dismiss);
 * multi-question asks add a light stepper. Selecting advances and auto-submits
 * on the last question — see {@link ComposerUserInputController}. The timeline
 * keeps the immutable record; this is only the input.
 */
export function FloatingComposerUserInputPanel({
  controller,
  t
}: {
  controller: ComposerUserInputController
  t: Translate
}): ReactElement | null {
  const { currentQuestion, total, index } = controller
  if (!controller.active || !currentQuestion) return null
  const multi = total > 1
  const options = currentQuestion.options
  const hasOptions = options.length > 0
  const useRows = optionsNeedRows(options)
  const showHeader = shouldShowQuestionHeader(currentQuestion, total)
  const multipleChoice = isMultipleChoiceQuestion(currentQuestion)

  return (
    <div
      role="group"
      aria-label={t('userInputPanelTitle')}
      data-composer-stack-item="user-input"
      className="ds-no-drag relative z-30 w-[calc(100%_-_1rem)] overflow-hidden rounded-[26px] border border-accent/30 bg-ds-card/95 p-3.5 shadow-[0_18px_52px_rgba(20,47,95,0.14)] backdrop-blur-xl dark:bg-ds-card/90"
    >
      {multi ? (
        <div className="mb-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <HelpCircle className="h-4 w-4 shrink-0 text-accent" strokeWidth={1.9} />
              <span className="truncate text-[13px] font-semibold text-ds-ink">
                {t('userInputPanelTitle')}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-[11.5px] font-medium text-ds-faint">
                {index + 1}/{total}
              </span>
              <button
                type="button"
                onClick={controller.cancel}
                aria-label={t('userInputCancel')}
                title={t('userInputCancel')}
                className="rounded-lg p-1 text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
              >
                <X className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
            </div>
          </div>
          <div className="mt-2 flex gap-1">
            {controller.questions.map((question, i) => (
              <span
                key={question.id}
                className={`h-[3px] flex-1 rounded-full transition ${
                  controller.isAnswered(question.id) || i === index
                    ? 'bg-accent'
                    : 'bg-ds-border-muted'
                }`}
              />
            ))}
          </div>
        </div>
      ) : null}

      {showHeader ? (
        <div className="mb-1 text-[12px] font-semibold text-ds-muted">{currentQuestion.header}</div>
      ) : null}

      <p className="whitespace-pre-wrap break-words text-[14px] font-semibold leading-6 text-ds-ink [overflow-wrap:anywhere]">
        {currentQuestion.question}
      </p>

      {hasOptions ? (
        useRows ? (
          <div className="mt-2.5 flex flex-col gap-1.5">
            {options.map((option) => (
              <OptionRow
                key={option.label}
                option={option}
                multiple={multipleChoice}
                selected={controller.isSelected(currentQuestion.id, option.label)}
                disabled={controller.isOptionDisabled(currentQuestion, option)}
                onSelect={() => controller.chooseOption(currentQuestion, option)}
              />
            ))}
          </div>
        ) : (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {options.map((option) => (
              <OptionChip
                key={option.label}
                option={option}
                multiple={multipleChoice}
                selected={controller.isSelected(currentQuestion.id, option.label)}
                disabled={controller.isOptionDisabled(currentQuestion, option)}
                onSelect={() => controller.chooseOption(currentQuestion, option)}
              />
            ))}
          </div>
        )
      ) : (
        <div className="mt-2.5 flex items-center gap-2 rounded-2xl border border-ds-border-muted bg-ds-card/70 px-3 py-2 text-[12.5px] text-ds-muted">
          <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={1.9} />
          <span className="min-w-0">{t('userInputPanelFreeformHint')}</span>
        </div>
      )}

      {hasOptions ? (
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-ds-faint">
            <CornerDownLeft className="h-3 w-3 shrink-0" strokeWidth={1.9} />
            <span className="min-w-0">{t('userInputPanelCustomHint')}</span>
          </div>
          {multipleChoice ? (
            <button
              type="button"
              onClick={controller.confirmCurrentQuestion}
              disabled={!controller.canConfirmCurrentQuestion}
              className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-[10px] border border-accent/35 bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-white shadow-sm transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:border-ds-border-muted disabled:bg-ds-subtle disabled:text-ds-faint disabled:shadow-none"
            >
              <Check className="h-3.5 w-3.5" strokeWidth={2.2} />
              <span>{t('confirm')}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function OptionChip({
  option,
  multiple,
  selected,
  disabled,
  onSelect
}: {
  option: UserInputOption
  multiple: boolean
  selected: boolean
  disabled: boolean
  onSelect: () => void
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      title={option.description || undefined}
      className={`inline-flex min-w-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition ${
        selected
          ? 'border-accent/45 bg-accent/12 text-ds-ink'
          : disabled
            ? 'cursor-not-allowed border-ds-border-muted bg-ds-subtle text-ds-faint opacity-70'
            : 'border-ds-border-muted bg-ds-card/80 text-ds-muted hover:border-ds-border hover:bg-ds-card hover:text-ds-ink'
      }`}
    >
      {selected ? (
        <Check className="h-3 w-3 shrink-0 text-accent" strokeWidth={multiple ? 2.2 : 2.4} />
      ) : null}
      <span className="min-w-0 truncate">{option.label}</span>
    </button>
  )
}

function OptionRow({
  option,
  multiple,
  selected,
  disabled,
  onSelect
}: {
  option: UserInputOption
  multiple: boolean
  selected: boolean
  disabled: boolean
  onSelect: () => void
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={`group flex min-w-0 items-start gap-2.5 rounded-[14px] border px-3 py-2 text-left transition ${
        selected
          ? 'border-accent/40 bg-accent/10 text-ds-ink ring-1 ring-accent/10'
          : disabled
            ? 'cursor-not-allowed border-ds-border-muted bg-ds-subtle text-ds-faint opacity-70'
            : 'border-ds-border-muted bg-ds-card/80 text-ds-muted hover:border-ds-border hover:bg-ds-card hover:text-ds-ink'
      }`}
    >
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border transition ${
          multiple ? 'rounded-[4px]' : 'rounded-full'
        } ${
          selected ? 'border-accent bg-accent/10' : 'border-ds-border group-hover:border-ds-muted'
        }`}
      >
        {selected ? (
          multiple ? (
            <Check className="h-3 w-3 text-accent" strokeWidth={2.4} />
          ) : (
            <span className="h-2 w-2 rounded-full bg-accent" />
          )
        ) : null}
      </span>
      <span className="min-w-0">
        <span className="block break-words text-[13px] font-semibold [overflow-wrap:anywhere]">
          {option.label}
        </span>
        {option.description ? (
          <span className="mt-0.5 block break-words text-[12px] leading-5 text-ds-faint [overflow-wrap:anywhere]">
            {option.description}
          </span>
        ) : null}
      </span>
    </button>
  )
}
