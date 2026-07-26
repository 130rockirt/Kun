import type { ReactElement, ReactNode } from 'react'

type Props = {
  todo?: ReactNode
  incoming?: ReactNode
  goal?: ReactNode
}

/**
 * Owns the persistent surfaces above the composer.
 *
 * Todo progress is always the top-level summary, newly arriving surfaces grow
 * through the middle, and the active goal stays anchored nearest the input.
 * Temporary menus and popovers remain outside this stack.
 */
export function FloatingComposerAboveInputStack({
  todo,
  incoming,
  goal
}: Props): ReactElement {
  return (
    <div
      data-composer-above-input-stack
      className="mb-2 flex w-full flex-col items-center gap-2 empty:hidden"
    >
      {todo}
      {incoming}
      {goal}
    </div>
  )
}
