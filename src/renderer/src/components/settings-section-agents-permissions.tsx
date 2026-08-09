import type {
  KunToolPermissionMode
} from '@shared/app-settings'
import {
  kunToolPermissionModeSettings
} from '@shared/app-settings'
import {
  Bot,
  Check,
  Hand,
  LockKeyholeOpen,
  Palette,
  ShieldCheck
} from 'lucide-react'
import { type ReactElement } from 'react'
import { runTrustedUserActivation } from '../extensions/protected-user-activation'
import {
  InlineNoticeView,
  SettingRow,
  SettingsCard,
  SettingsSubTabs,
  SettingsTabPanel
} from './settings-controls'
import {
  DesignQualitySettingsPanel
} from './settings-section-agent-panels'
type PermissionsSettingsPanel = 'policy' | 'quality'

const TOOL_PERMISSION_OPTIONS: Array<{ value: KunToolPermissionMode; labelKey: string; descriptionKey: string; Icon: typeof Hand; iconClass: string }> = [
  { value: 'ask-for-approval', labelKey: 'toolPermissionAskForApproval', descriptionKey: 'toolPermissionAskForApprovalDesc', Icon: Hand, iconClass: 'border-sky-400/30 bg-sky-500/10 text-sky-700 dark:text-sky-200' },
  { value: 'approve-for-me', labelKey: 'toolPermissionApproveForMe', descriptionKey: 'toolPermissionApproveForMeDesc', Icon: Bot, iconClass: 'border-teal-400/30 bg-teal-500/10 text-teal-700 dark:text-teal-200' },
  { value: 'full-access', labelKey: 'toolPermissionFullAccess', descriptionKey: 'toolPermissionFullAccessDesc', Icon: LockKeyholeOpen, iconClass: 'border-orange-400/35 bg-orange-500/10 text-orange-700 dark:text-orange-200' }
]

export function AgentsPermissionsSettingsPanel({ view }: { view: Record<string, any> }): ReactElement {
  const { t, updateKun, selectControlClass, permissionsSectionRef, activePanel, activePermissionsPanel, setActivePermissionsPanel, quality, updateQuality, toolPermissionMode } = view
  return (
    <>
              <div
                id="agents-settings-panel-permissions"
                role="tabpanel"
                aria-labelledby="agents-settings-tab-permissions"
                className={activePanel === 'permissions' ? 'grid gap-4' : 'hidden'}
              >
                <div ref={permissionsSectionRef} className="grid gap-4">
                  <SettingsSubTabs<PermissionsSettingsPanel>
                    baseId="agents-permissions"
                    ariaLabel={t('permissions')}
                    items={[
                      { id: 'policy', label: t('toolPermissionMode'), icon: ShieldCheck },
                      { id: 'quality', label: t('designQualityTitle'), icon: Palette }
                    ]}
                    value={activePermissionsPanel}
                    onChange={setActivePermissionsPanel}
                  />

                  <SettingsTabPanel<PermissionsSettingsPanel>
                    baseId="agents-permissions"
                    tabId="policy"
                    active={activePermissionsPanel === 'policy'}
                  >
                    <SettingsCard title={t('permissions')}>
                      <div className="px-3 py-4">
                        <InlineNoticeView notice={{ tone: 'info', message: t('permissionsBehaviorHint') }} />
                      </div>
                      <SettingRow
                        title={t('toolPermissionMode')}
                        description={t('toolPermissionModeDesc')}
                        wideControl
                        control={
                          <div
                            role="radiogroup"
                            aria-label={t('toolPermissionMode')}
                            className="grid gap-2 lg:grid-cols-3"
                          >
                            {TOOL_PERMISSION_OPTIONS.map((option) => {
                              const selected = toolPermissionMode === option.value
                              const PermissionIcon = option.Icon
                              return (
                                <button
                                  key={option.value}
                                  type="button"
                                  role="radio"
                                  aria-checked={selected}
                                  onClick={(event) => runTrustedUserActivation(
                                    event,
                                    () => updateKun(kunToolPermissionModeSettings(option.value))
                                  )}
                                  className={`min-h-[72px] rounded-lg border px-3 py-2.5 text-left transition ${
                                    selected
                                      ? 'border-accent/55 bg-accent/10 text-ds-ink'
                                      : 'border-ds-border-muted bg-ds-card/70 text-ds-ink hover:bg-ds-hover/70'
                                  }`}
                                >
                                  <span className="flex items-start gap-2">
                                    <span
                                      className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${option.iconClass}`}
                                    >
                                      <PermissionIcon className="h-4 w-4" strokeWidth={1.9} />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                      <span className="block text-[13px] font-semibold">{t(option.labelKey)}</span>
                                      <span className="mt-1 block text-[12px] leading-snug text-ds-muted">
                                        {t(option.descriptionKey)}
                                      </span>
                                    </span>
                                    {selected ? (
                                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" strokeWidth={2} />
                                    ) : null}
                                  </span>
                                </button>
                              )
                            })}
                          </div>
                        }
                      />
                    </SettingsCard>
                  </SettingsTabPanel>

                  <SettingsTabPanel<PermissionsSettingsPanel>
                    baseId="agents-permissions"
                    tabId="quality"
                    active={activePermissionsPanel === 'quality'}
                    className="[&>div]:mt-0"
                  >
                    <DesignQualitySettingsPanel
                      t={t}
                      value={quality}
                      selectControlClass={selectControlClass}
                      onChange={updateQuality}
                    />
                  </SettingsTabPanel>
                </div>
              </div>

    </>
  )
}
