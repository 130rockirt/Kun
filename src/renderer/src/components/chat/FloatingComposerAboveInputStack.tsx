import type { ReactElement, ReactNode } from 'react'

type Props = {
  todo?: ReactNode
  graph?: ReactNode
  incoming?: ReactNode
  goal?: ReactNode
}

/**
 * Owns the persistent surfaces above the composer.
 *
 * Todo and Graph are durable progress summaries, newly arriving surfaces grow
 * through the middle, and the active goal stays anchored nearest the input.
 * Temporary menus and portaled previews remain outside this stack.
 */
export function FloatingComposerAboveInputStack({
  todo,
  graph,
  incoming,
  goal
}: Props): ReactElement {
  return (
    <div
      data-composer-above-input-stack
      className="mb-2 flex w-full flex-col items-center gap-2 empty:hidden"
    >
      {todo}
      {graph}
      {incoming}
      {goal}
    </div>
  )
}
