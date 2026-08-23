import {
  lazy,
  Suspense,
  type ComponentProps,
  type ReactElement,
  type ReactNode
} from 'react'
import type { MessageTimeline } from './MessageTimeline'

const LazyLoadedMessageTimeline = lazy(() =>
  import('./MessageTimeline').then((module) => ({ default: module.MessageTimeline }))
)

export type LazyMessageTimelineProps = ComponentProps<typeof MessageTimeline> & {
  fallback?: ReactNode
}

export function LazyMessageTimeline({
  fallback = null,
  ...props
}: LazyMessageTimelineProps): ReactElement {
  const timelineKey = props.activeThreadId ?? 'empty'
  return (
    <Suspense fallback={fallback}>
      <LazyLoadedMessageTimeline key={timelineKey} {...props} />
    </Suspense>
  )
}
