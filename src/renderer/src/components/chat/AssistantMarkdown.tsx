import type { ReactElement } from 'react'
import { lazy, Suspense } from 'react'
import { useLiveAssistantStreaming } from './live-assistant-streaming'

let streamdownAssistantModule: Promise<typeof import('./StreamdownAssistant')> | null = null

function loadStreamdownAssistant(): Promise<typeof import('./StreamdownAssistant')> {
  if (!streamdownAssistantModule) {
    streamdownAssistantModule = import('./StreamdownAssistant').catch((error) => {
      streamdownAssistantModule = null
      throw error
    })
  }
  return streamdownAssistantModule
}

const LazyStreamdownAssistant = lazy(() =>
  loadStreamdownAssistant().then((module) => ({ default: module.StreamdownAssistant }))
)

/** Warm the settled Markdown renderer before a restored conversation is revealed. */
export async function prepareAssistantMarkdownRenderer(): Promise<void> {
  await loadStreamdownAssistant()
}

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
  const liveStreaming = useLiveAssistantStreaming()
  const effectiveStreaming = streaming && liveStreaming
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
