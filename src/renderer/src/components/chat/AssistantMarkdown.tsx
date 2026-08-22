import type { ReactElement } from 'react'
import { lazy, Suspense } from 'react'
import { useLiveAssistantStreaming } from './live-assistant-streaming'

const LazyStreamdownAssistant = lazy(() =>
  import('./StreamdownAssistant').then((module) => ({ default: module.StreamdownAssistant }))
)

export function AssistantMarkdown({
  text,
  streaming,
  className,
  hideHtmlComments = false
}: {
  text: string
  streaming: boolean
  className?: string
  hideHtmlComments?: boolean
}): ReactElement {
  // An unconfirmed busy flag gates the typewriter off so catch-up replay
  // (returning to a thread that ran while away) renders whole instead of
  // re-typing text the user already watched settle.
  const effectiveStreaming = streaming && useLiveAssistantStreaming()
  const fallbackText = hideHtmlComments
    ? text.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    : text

  return (
    <Suspense
      fallback={
        <div className={className}>
          {fallbackText}
        </div>
      }
    >
      <LazyStreamdownAssistant
        text={text}
        streaming={effectiveStreaming}
        className={className}
        hideHtmlComments={hideHtmlComments}
      />
    </Suspense>
  )
}
