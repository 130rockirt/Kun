import { useEffect, useState } from 'react'

// Tracks the mini-pane window mode driven by the main process
// (`desktop:command` -> `toggleMini`). While active the renderer collapses
// secondary chrome (sidebars, headers) via the `data-kun-mini` attribute so
// the shrunken window stays usable.
export function useWindowMiniMode(): boolean {
  const [mini, setMini] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (typeof window.kunGui?.onWindowMiniMode !== 'function') return
    return window.kunGui.onWindowMiniMode(setMini)
  }, [])

  useEffect(() => {
    if (typeof document === 'undefined') return
    if (mini) {
      document.documentElement.dataset.kunMini = 'on'
    } else {
      delete document.documentElement.dataset.kunMini
    }
    return () => {
      delete document.documentElement.dataset.kunMini
    }
  }, [mini])

  return mini
}
