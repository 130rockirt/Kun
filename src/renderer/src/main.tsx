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

document.documentElement.dataset.platform = window.kunGui?.platform ?? 'unknown'
applyCursorSpotlight(true)
installCursorSpotlightTracking()
const storageRelocationMode = new URLSearchParams(window.location.search).get('storageRelocation') === '1'
const runtimeMigrationRecoveryMode = new URLSearchParams(window.location.search).get('runtimeMigrationRecovery') === '1'
if (!storageRelocationMode && !runtimeMigrationRecoveryMode) installDataMigrationRendererRpc()

void bootstrap()

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
  await installSharedBusinessStorage()
  const { default: App } = await import('./App')
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
