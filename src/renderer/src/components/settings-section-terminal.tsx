import { useEffect, useState, type ReactElement } from 'react'
import { defaultTerminalColors, type TerminalColorSettingsV1 } from '@shared/app-settings'
import type { CliInstallAction, CliInstallStatus } from '@shared/cli-install'
import { Loader2, RefreshCw } from 'lucide-react'
import { SettingsCard, SettingRow } from './settings-controls'
import { terminalCommandCopy } from './terminal-command-copy'

type ColorField = {
  key: keyof TerminalColorSettingsV1
  labelKey: string
}

const SURFACE_FIELDS: ColorField[] = [
  { key: 'foreground', labelKey: 'terminalColorForeground' },
  { key: 'background', labelKey: 'terminalColorBackground' },
  { key: 'cursor', labelKey: 'terminalColorCursor' },
  { key: 'selectionBackground', labelKey: 'terminalColorSelection' }
]

const ANSI_FIELDS: ColorField[] = [
  { key: 'black', labelKey: 'terminalColorBlack' },
  { key: 'red', labelKey: 'terminalColorRed' },
  { key: 'green', labelKey: 'terminalColorGreen' },
  { key: 'yellow', labelKey: 'terminalColorYellow' },
  { key: 'blue', labelKey: 'terminalColorBlue' },
  { key: 'magenta', labelKey: 'terminalColorMagenta' },
  { key: 'cyan', labelKey: 'terminalColorCyan' },
  { key: 'white', labelKey: 'terminalColorWhite' },
  { key: 'brightBlack', labelKey: 'terminalColorBrightBlack' },
  { key: 'brightRed', labelKey: 'terminalColorBrightRed' },
  { key: 'brightGreen', labelKey: 'terminalColorBrightGreen' },
  { key: 'brightYellow', labelKey: 'terminalColorBrightYellow' },
  { key: 'brightBlue', labelKey: 'terminalColorBrightBlue' },
  { key: 'brightMagenta', labelKey: 'terminalColorBrightMagenta' },
  { key: 'brightCyan', labelKey: 'terminalColorBrightCyan' },
  { key: 'brightWhite', labelKey: 'terminalColorBrightWhite' }
]

function CliCommandSettingsCard({ locale }: { locale: string }): ReactElement {
  const zh = locale.toLowerCase().startsWith('zh')
  const [status, setStatus] = useState<CliInstallStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const refresh = (): void => {
    void window.kunGui.cliInstallStatus().then(setStatus).catch((error) => {
      setMessage(error instanceof Error ? error.message : String(error))
    })
  }
  useEffect(refresh, [])
  const act = (action: CliInstallAction): void => {
    setBusy(true)
    setMessage('')
    void window.kunGui.cliInstallAction(action).then((result) => {
      setStatus(result.status)
      setMessage(result.message ?? (result.ok
        ? (zh ? '终端命令已更新。请新开一个终端后输入 kun。' : 'Terminal command updated. Open a new terminal and run kun.')
        : (zh ? '终端命令更新失败。' : 'Could not update the terminal command.')))
    }).finally(() => setBusy(false))
  }
  const copy = terminalCommandCopy(locale, status?.state)
  return (
    <SettingsCard title={zh ? '终端命令' : 'Terminal command'}>
      <SettingRow
        title="kun"
        description={copy.description}
        wideControl
        control={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || status?.state === 'installed' || status?.state === 'conflict'}
              onClick={() => act(status?.state === 'stale' ? 'repair' : 'install')}
              className="rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink disabled:opacity-50"
            >
              {busy ? <Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> : null}
              {copy.primaryAction}
            </button>
            <button
              type="button"
              disabled={busy || status?.state === 'not-installed' || status?.state === 'conflict'}
              onClick={() => act('uninstall')}
              className="rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] text-ds-muted disabled:opacity-50"
            >
              {copy.removeAction}
            </button>
            <button type="button" disabled={busy} onClick={refresh} className="p-2 text-ds-muted" title={zh ? '刷新' : 'Refresh'}>
              <RefreshCw className="h-4 w-4" />
            </button>
            {status?.commandPath ? <code className="break-all text-[11px] text-ds-faint">{status.commandPath}</code> : null}
            {message ? <div className="w-full text-[12px] text-ds-muted">{message}</div> : null}
          </div>
        }
      />
    </SettingsCard>
  )
}

function ColorInput({
  value,
  onChange,
  label
}: {
  value: string
  onChange: (v: string) => void
  label: string
}): ReactElement {
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-8 shrink-0 cursor-pointer rounded-md border border-ds-border bg-ds-card p-0.5"
        aria-label={label}
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-24 min-w-0 rounded-lg border border-ds-border bg-ds-card px-2 py-1 font-mono text-[12px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
        spellCheck={false}
        aria-label={label}
      />
    </div>
  )
}

export function TerminalSettingsSection({ ctx }: { ctx: Record<string, any> }): ReactElement {
  const { t, form, update } = ctx
  const colors: TerminalColorSettingsV1 = form.terminal.colors

  const updateColors = (patch: Partial<TerminalColorSettingsV1>): void => {
    update({ terminal: { colors: patch } })
  }

  return (
    <>
      <CliCommandSettingsCard locale={form.locale} />
      <SettingsCard title={t('sectionTerminal')}>
        <SettingRow
          title={t('terminalColorMode')}
          description={t('terminalColorModeDesc')}
          control={
            <select
              className={ctx.selectControlClass}
              value={colors.colorMode}
              onChange={(e) => updateColors({ colorMode: e.target.value as TerminalColorSettingsV1['colorMode'] })}
            >
              <option value="native">{t('terminalColorModeNative')}</option>
              <option value="none">{t('terminalColorModeNone')}</option>
              <option value="custom">{t('terminalColorModeCustom')}</option>
            </select>
          }
        />

        {colors.colorMode === 'native' ? (
          <SettingRow
            title={t('terminalColorModeNativeHint')}
            description={t('terminalColorModeNativeDesc')}
            control={<span />}
          />
        ) : colors.colorMode === 'none' ? (
          <SettingRow
            title={t('terminalColorModeNoneHint')}
            description={t('terminalColorModeNoneDesc')}
            control={<span />}
          />
        ) : (
          <>
            <SettingRow
              title={t('terminalColorSurface')}
              description={t('terminalColorSurfaceDesc')}
              wideControl
              control={
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-2">
                  {SURFACE_FIELDS.map((field) => (
                    <div key={field.key} className="flex items-center justify-between gap-2">
                      <span className="text-[13px] text-ds-muted">{t(field.labelKey)}</span>
                      <ColorInput
                        value={colors[field.key] as string}
                        onChange={(v) => updateColors({ [field.key]: v })}
                        label={t(field.labelKey)}
                      />
                    </div>
                  ))}
                </div>
              }
            />
            <SettingRow
              title={t('terminalColorAnsi')}
              description={t('terminalColorAnsiDesc')}
              wideControl
              control={
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {ANSI_FIELDS.map((field) => (
                    <div key={field.key} className="flex flex-col gap-1">
                      <span className="text-[12px] text-ds-muted">{t(field.labelKey)}</span>
                      <ColorInput
                        value={colors[field.key] as string}
                        onChange={(v) => updateColors({ [field.key]: v })}
                        label={t(field.labelKey)}
                      />
                    </div>
                  ))}
                </div>
              }
            />
            <SettingRow
              title={t('terminalColorReset')}
              description={t('terminalColorResetDesc')}
              control={
                <button
                  type="button"
                  onClick={() => updateColors(defaultTerminalColors())}
                  className="rounded-full border border-ds-border bg-ds-card px-3 py-1.5 text-[12px] font-medium text-ds-muted shadow-sm transition hover:bg-ds-hover hover:text-ds-ink"
                >
                  {t('terminalColorResetButton')}
                </button>
              }
            />
          </>
        )}
      </SettingsCard>
    </>
  )
}
