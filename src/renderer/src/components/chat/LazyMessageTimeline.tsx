import {
  lazy,
  Suspense,
  type ComponentProps,
  type ReactElement,
  type ReactNode
} from 'react'
import type { MessageTimeline } from './MessageTimeline'
import { useChatStore } from '../../store/chat-store'

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
  const threadLoadingId = useChatStore((state) => state.threadLoadingId)
  const timelinePhase = props.activeThreadId && threadLoadingId === props.activeThreadId
    ? 'hydrating'
    : 'ready'
  const timelineKey = `${props.activeThreadId ?? 'empty'}:${timelinePhase}`
  return (
    <Suspense fallback={fallback}>
      <LazyLoadedMessageTimeline key={timelineKey} {...props} />
    </Suspense>
  )
}
