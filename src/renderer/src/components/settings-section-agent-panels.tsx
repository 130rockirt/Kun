import type { ReactElement, ReactNode } from 'react'
import { InlineNoticeView, SettingsCard, SettingRow, Toggle } from './settings-controls'
import type { KunBrowserUseSettingsV1 } from '@shared/app-settings'

type Translate = (key: string) => string

export function ComputerUseSettingsPanel({
  t, value, selectControlClass, permissionRow, onChange
}: {
  t: Translate
  value: { enabled: boolean; mode: string }
  selectControlClass: string
  permissionRow: ReactNode
  onChange: (patch: Record<string, unknown>) => void
}): ReactElement {
  return <SettingsCard title={t('computerUseTitle')}>
    <div className="space-y-4 px-3 py-4">
      <InlineNoticeView notice={{ tone: 'info', message: t('computerUseHint') }} />
      <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[12px] leading-5 text-amber-700 dark:text-amber-200">
        <div className="font-semibold">{t('computerUseModelQualityTitle')}</div>
        <div className="mt-1">{t('computerUseModelQualityBody')}</div>
      </div>
    </div>
    <SettingRow title={t('computerUseEnable')} description={t('computerUseEnableDesc')}
      control={<Toggle checked={value.enabled} onChange={(enabled) => onChange({ enabled })} />} />
    {value.enabled ? <>
      <SettingRow title={t('computerUseMode')} description={t('computerUseModeDesc')} control={
        <select className={selectControlClass} value={value.mode} onChange={(event) => onChange({ mode: event.target.value })}>
          <option value="auto">{t('computerUseModeAuto')}</option>
          <option value="always">{t('computerUseModeAlways')}</option>
          <option value="off">{t('computerUseModeOff')}</option>
        </select>} />
      {permissionRow}
    </> : null}
  </SettingsCard>
}

export function BrowserUseSettingsPanel({
  t,
  value,
  selectControlClass,
  onChange
}: {
  t: Translate
  value: KunBrowserUseSettingsV1
  selectControlClass: string
  onChange: (patch: Partial<KunBrowserUseSettingsV1>) => void
}): ReactElement {
  const snapshotPreset = value.maxSnapshotNodes <= 120
    ? 'compact'
    : value.maxSnapshotNodes >= 400
      ? 'detailed'
      : 'standard'

  return <SettingsCard title={t('browserUseSettingsTitle')}>
    <div className="space-y-3 px-3 py-4">
      <InlineNoticeView notice={{ tone: 'info', message: t('browserUseSettingsHint') }} />
      <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-[12px] leading-5 text-emerald-800 dark:text-emerald-200">
        <div className="font-semibold">{t('browserUseZeroTrustTitle')}</div>
        <div className="mt-1">{t('browserUseZeroTrustBody')}</div>
      </div>
    </div>
    <SettingRow
      title={t('browserUseSettingsEnable')}
      description={t('browserUseSettingsEnableDesc')}
      control={<Toggle checked={value.enabled} onChange={(enabled) => onChange({ enabled })} />}
    />
    {value.enabled ? <>
      <SettingRow
        title={t('browserUseSettingsMode')}
        description={value.mode === 'public'
          ? t('browserUseSettingsPublicDesc')
          : t('browserUseSettingsLocalDesc')}
        control={
          <select
            className={selectControlClass}
            value={value.mode}
            onChange={(event) => onChange({
              mode: event.target.value === 'local-development' ? 'local-development' : 'public'
            })}
          >
            <option value="public">{t('browserUseSettingsPublic')}</option>
            <option value="local-development">{t('browserUseSettingsLocal')}</option>
          </select>
        }
      />
      <SettingRow
        title={t('browserUseSettingsApprovalMode')}
        description={value.approvalMode === 'auto-safe'
          ? t('browserUseSettingsApprovalModeDesc')
          : t('browserUseSettingsApprovalAlwaysAskDesc')}
        control={
          <select
            className={selectControlClass}
            value={value.approvalMode}
            onChange={(event) => onChange({
              approvalMode: event.target.value === 'always-ask' ? 'always-ask' : 'auto-safe'
            })}
          >
            <option value="auto-safe">{t('browserUseSettingsApprovalAutoSafe')}</option>
            <option value="always-ask">{t('browserUseSettingsApprovalAlwaysAsk')}</option>
          </select>
        }
      />
      <SettingRow
        title={t('browserUseSettingsMaxTabs')}
        description={t('browserUseSettingsMaxTabsDesc')}
        control={
          <select
            className={selectControlClass}
            value={value.maxTabs}
            onChange={(event) => onChange({ maxTabs: Number(event.target.value) })}
          >
            {[1, 2, 3].map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        }
      />
      <SettingRow
        title={t('browserUseSettingsObservationBudget')}
        description={t('browserUseSettingsObservationBudgetDesc')}
        control={
          <select
            className={selectControlClass}
            value={value.maxObservationActionsPerTurn}
            onChange={(event) => onChange({
              maxObservationActionsPerTurn: Number(event.target.value)
            })}
          >
            {[10, 20, 30, 50].map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        }
      />
      <SettingRow
        title={t('browserUseSettingsInteractionBudget')}
        description={t('browserUseSettingsInteractionBudgetDesc')}
        control={
          <select
            className={selectControlClass}
            value={value.maxInteractionActionsPerTurn}
            onChange={(event) => onChange({
              maxInteractionActionsPerTurn: Number(event.target.value)
            })}
          >
            {[4, 8, 12, 20].map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        }
      />
      <SettingRow
        title={t('browserUseSettingsSnapshotDetail')}
        description={t('browserUseSettingsSnapshotDetailDesc')}
        control={
          <select
            className={selectControlClass}
            value={snapshotPreset}
            onChange={(event) => {
              const preset = event.target.value
              onChange(preset === 'compact'
                ? { maxSnapshotNodes: 120, maxSnapshotTextChars: 10_000, maxImageDimension: 960 }
                : preset === 'detailed'
                  ? { maxSnapshotNodes: 400, maxSnapshotTextChars: 40_000, maxImageDimension: 1600 }
                  : { maxSnapshotNodes: 250, maxSnapshotTextChars: 20_000, maxImageDimension: 1280 })
            }}
          >
            <option value="compact">{t('browserUseSettingsSnapshotCompact')}</option>
            <option value="standard">{t('browserUseSettingsSnapshotStandard')}</option>
            <option value="detailed">{t('browserUseSettingsSnapshotDetailed')}</option>
          </select>
        }
      />
      <SettingRow
        title={t('browserUseSettingsIdleTimeout')}
        description={t('browserUseSettingsIdleTimeoutDesc')}
        control={
          <select
            className={selectControlClass}
            value={value.idleTimeoutMs}
            onChange={(event) => onChange({ idleTimeoutMs: Number(event.target.value) })}
          >
            <option value={60_000}>{t('browserUseSettingsOneMinute')}</option>
            <option value={300_000}>{t('browserUseSettingsFiveMinutes')}</option>
            <option value={900_000}>{t('browserUseSettingsFifteenMinutes')}</option>
            <option value={1_800_000}>{t('browserUseSettingsThirtyMinutes')}</option>
          </select>
        }
      />
    </> : null}
  </SettingsCard>
}

export function DesignQualitySettingsPanel({
  t, value, selectControlClass, onChange
}: {
  t: Translate
  value: { enabled: boolean; strictness: string }
  selectControlClass: string
  onChange: (patch: Record<string, unknown>) => void
}): ReactElement {
  return <SettingsCard title={t('designQualityTitle')}>
    <div className="px-3 py-4"><InlineNoticeView notice={{ tone: 'info', message: t('designQualityHint') }} /></div>
    <SettingRow title={t('designQualityEnable')} description={t('designQualityEnableDesc')}
      control={<Toggle checked={value.enabled} onChange={(enabled) => onChange({ enabled })} />} />
    {value.enabled ? <SettingRow title={t('designQualityStrictness')} description={t('designQualityStrictnessDesc')} control={
      <select className={selectControlClass} value={value.strictness} onChange={(event) => onChange({ strictness: event.target.value })}>
        <option value="relaxed">{t('designQualityStrictnessRelaxed')}</option>
        <option value="standard">{t('designQualityStrictnessStandard')}</option>
        <option value="strict">{t('designQualityStrictnessStrict')}</option>
      </select>} /> : null}
  </SettingsCard>
}
