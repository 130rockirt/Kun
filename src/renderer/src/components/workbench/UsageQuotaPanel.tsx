import { Gauge, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ProviderQuotaPanel,
  type ProviderQuotaPanelStatus
} from './ProviderQuotaPanel'
import {
  SidebarUsagePanel,
  type SidebarUsagePanelStatus
} from './SidebarUsagePanel'

type UsageQuotaTab = 'usage' | 'quota'

type Props = {
  activeThreadId: string | null
}

type TabStatus = {
  loading: boolean
  refreshedAt?: string
}

const EMPTY_STATUS: TabStatus = { loading: false }

export function UsageQuotaPanel({ activeThreadId }: Props): ReactElement {
  const { t, i18n } = useTranslation('common')
  const [activeTab, setActiveTab] = useState<UsageQuotaTab>('usage')
  const [usageRefreshKey, setUsageRefreshKey] = useState(0)
  const [quotaRefreshKey, setQuotaRefreshKey] = useState(0)
  const [usageStatus, setUsageStatus] = useState<TabStatus>(EMPTY_STATUS)
  const [quotaStatus, setQuotaStatus] = useState<TabStatus>(EMPTY_STATUS)
  const activeStatus = activeTab === 'usage' ? usageStatus : quotaStatus

  const handleUsageStatus = useCallback((status: SidebarUsagePanelStatus): void => {
    setUsageStatus(status)
  }, [])
  const handleQuotaStatus = useCallback((status: ProviderQuotaPanelStatus): void => {
    setQuotaStatus(status)
  }, [])

  const refresh = (): void => {
    if (activeTab === 'usage') setUsageRefreshKey((value) => value + 1)
    else setQuotaRefreshKey((value) => value + 1)
  }

  return (
    <section
      aria-label={t('usageQuotaTitle')}
      className="ds-no-drag flex h-full min-h-0 flex-col overflow-hidden bg-ds-sidebar"
      data-usage-quota-panel
    >
      <header className="shrink-0 border-b border-ds-border-muted px-4 py-3.5">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-ds-border-muted bg-ds-card text-accent shadow-sm">
            <Gauge className="h-4.5 w-4.5" strokeWidth={1.8} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-ds-ink">
              {t('usageQuotaTitle')}
            </h2>
            <p className="mt-0.5 text-[11px] leading-4 text-ds-muted">
              {t('usageQuotaDescription')}
            </p>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={activeStatus.loading}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-ds-border-muted bg-ds-card px-2.5 text-[11px] font-semibold text-ds-muted transition hover:border-ds-border-strong hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-55"
            aria-label={t(activeStatus.loading ? 'usageQuotaRefreshing' : 'usageQuotaRefresh')}
          >
            {activeStatus.loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.9} />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.9} />
            )}
            <span>
              {t(activeStatus.loading ? 'usageQuotaRefreshing' : 'usageQuotaRefresh')}
            </span>
          </button>
        </div>
        {activeStatus.refreshedAt ? (
          <p className="mt-2 text-[10.5px] text-ds-faint">
            {t('usageQuotaLastRefreshed', {
              time: formatRefreshTime(activeStatus.refreshedAt, i18n.resolvedLanguage)
            })}
          </p>
        ) : null}
        <div
          role="tablist"
          aria-label={t('usageQuotaTitle')}
          className="mt-3 grid grid-cols-2 rounded-xl border border-ds-border-muted bg-ds-surface-subtle p-1 text-[11.5px] font-semibold text-ds-muted"
        >
          <TabButton
            active={activeTab === 'usage'}
            id="usage"
            label={t('usageQuotaTabUsage')}
            onClick={() => setActiveTab('usage')}
          />
          <TabButton
            active={activeTab === 'quota'}
            id="quota"
            label={t('usageQuotaTabQuota')}
            onClick={() => setActiveTab('quota')}
          />
        </div>
      </header>

      <div
        id={`usage-quota-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`usage-quota-tab-${activeTab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {activeTab === 'usage' ? (
          <SidebarUsagePanel
            activeThreadId={activeThreadId}
            refreshKey={usageRefreshKey}
            onStatusChange={handleUsageStatus}
          />
        ) : (
          <ProviderQuotaPanel
            embedded
            refreshKey={quotaRefreshKey}
            onStatusChange={handleQuotaStatus}
          />
        )}
      </div>
    </section>
  )
}

function TabButton({
  active,
  id,
  label,
  onClick
}: {
  active: boolean
  id: UsageQuotaTab
  label: string
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      id={`usage-quota-tab-${id}`}
      role="tab"
      aria-selected={active}
      aria-controls={`usage-quota-panel-${id}`}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={`min-h-7 rounded-lg px-2 transition ${
        active
          ? 'bg-ds-card text-accent shadow-sm dark:bg-white/10'
          : 'hover:bg-ds-hover hover:text-ds-ink'
      }`}
    >
      {label}
    </button>
  )
}

function formatRefreshTime(value: string, locale?: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date)
}
