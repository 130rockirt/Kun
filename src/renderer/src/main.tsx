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
import { resolveDesktopTitleBarMode } from '@shared/desktop-title-bar'
import { StartupGate } from './StartupGate'

document.documentElement.dataset.platform = window.kunGui?.platform ?? 'unknown'
document.documentElement.dataset.desktopTitleBar = window.kunGui?.desktopTitleBarMode
  ?? resolveDesktopTitleBarMode(window.kunGui?.platform ?? 'unknown', false)
applyCursorSpotlight(true)
installCursorSpotlightTracking()
const storageRelocationMode = new URLSearchParams(window.location.search).get('storageRelocation') === '1'
const runtimeMigrationRecoveryMode = new URLSearchParams(window.location.search).get('runtimeMigrationRecovery') === '1'
if (!storageRelocationMode && !runtimeMigrationRecoveryMode) installDataMigrationRendererRpc()

// The renderer owns exactly one React root for the whole app lifecycle.
// Startup phases, boot views, and the workbench all render through StartupGate.
const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing root element')
const reactRoot = ReactDOM.createRoot(rootElement)

void bootstrap()

async function bootstrap(): Promise<void> {
  await import('./i18n')
  reactRoot.render(
    <React.StrictMode>
      <StartupGate
        storageRelocationMode={storageRelocationMode}
        runtimeMigrationRecoveryMode={runtimeMigrationRecoveryMode}
      />
    </React.StrictMode>
  )
}
