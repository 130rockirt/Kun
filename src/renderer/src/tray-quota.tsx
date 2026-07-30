import React from 'react'
import ReactDOM from 'react-dom/client'
import './i18n'
import './styles/tray-provider-quota.css'
import { TrayProviderQuotaPopover } from './components/tray/TrayProviderQuotaPopover'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TrayProviderQuotaPopover />
  </React.StrictMode>
)
