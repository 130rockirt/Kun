// 必须是第一个 import:把旧品牌前缀的 localStorage 键拷贝到新前缀,
// 后面的 store 模块在 import 阶段就会读这些键。
import './lib/legacy-local-storage-migration'
import React from 'react'
import ReactDOM from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './index.css'
import './styles/base-shell.css'
import './styles/settings-layout.css'
import './styles/surfaces-write.css'
import './styles/markdown-code.css'
import './styles/write-editor.css'
import './styles/write-rich-editor.css'
import './styles/workflow-canvas.css'
import './styles/graph-workbench.css'
import './styles/neutral-polish.css'
import './styles/provider-quota-panel.css'
import { applyCursorSpotlight } from './lib/apply-theme'
import { installCursorSpotlightTracking } from './lib/cursor-spotlight'
import { installDataMigrationRendererRpc } from './data-migration/renderer-state-rpc'
import { installSharedBusinessStorage } from './lib/shared-business-storage'
import { resolveDesktopTitleBarMode } from '@shared/desktop-title-bar'
import type { DesktopStartupPhase } from '@shared/desktop-startup-state'
import { startupPhaseLabel, startupShellAllowsWorkbench } from './startup-shell'

document.documentElement.dataset.platform = window.kunGui?.platform ?? 'unknown'
document.documentElement.dataset.desktopTitleBar = window.kunGui?.desktopTitleBarMode
  ?? resolveDesktopTitleBarMode(window.kunGui?.platform ?? 'unknown', false)
applyCursorSpotlight(true)
installCursorSpotlightTracking()
const storageRelocationMode = new URLSearchParams(window.location.search).get('storageRelocation') === '1'
const runtimeMigrationRecoveryMode = new URLSearchParams(window.location.search).get('runtimeMigrationRecovery') === '1'
if (!storageRelocationMode && !runtimeMigrationRecoveryMode) installDataMigrationRendererRpc()

void bootstrap()

function renderStartupShell(phase: DesktopStartupPhase): void {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <main className="flex min-h-screen items-center justify-center bg-ds-canvas p-8 text-ds-ink">
        <section className="flex items-center gap-3 rounded-full border border-ds-border bg-ds-surface px-5 py-3 shadow-sm">
          <span
            className={`h-2.5 w-2.5 rounded-full ${phase === 'recovery_required' ? 'bg-red-500' : 'animate-pulse bg-blue-500'}`}
            aria-hidden="true"
          />
          <span className="text-sm font-medium">{startupPhaseLabel(phase)}</span>
        </section>
      </main>
    </React.StrictMode>
  )
}

async function bootstrap(): Promise<void> {
  await import('./i18n')
  if (storageRelocationMode) {
    const { StorageRelocationBootView } = await import('./components/StorageRelocationBootView')
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <StorageRelocationBootView />
      </React.StrictMode>
    )
    return
  }
  if (runtimeMigrationRecoveryMode) {
    const { RuntimeMigrationRecoveryView } = await import('./components/RuntimeMigrationRecoveryView')
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <RuntimeMigrationRecoveryView />
      </React.StrictMode>
    )
    return
  }

  let workbenchStarted = false
  let unsubscribe = (): void => undefined
  const startWorkbench = async (): Promise<void> => {
    if (workbenchStarted) return
    workbenchStarted = true
    unsubscribe()
    await installSharedBusinessStorage()
    const { default: App } = await import('./App')
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    )
  }
  const applyPhase = (next: DesktopStartupPhase): void => {
    if (startupShellAllowsWorkbench(next)) {
      void startWorkbench()
      return
    }
    if (!workbenchStarted) renderStartupShell(next)
  }
  unsubscribe = window.kunGui.startup.onState(applyPhase)
  applyPhase(await window.kunGui.startup.getState())
}
