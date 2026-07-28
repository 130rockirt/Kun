import type { KunTrayProviderQuotaApi } from '@shared/tray-provider-quota'

declare global {
  interface Window {
    kunTrayQuota: KunTrayProviderQuotaApi
  }
}

export {}
