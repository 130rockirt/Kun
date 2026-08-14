import {
  Bot,
  KeyRound,
  Link2,
  RefreshCw,
  ShieldAlert,
  UserRound
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type {
  AccountSession,
  AuthenticationProviderDeclaration,
  ModelProviderDeclaration
} from '@kun/extension-api'
import {
  extensionWorkbenchClient,
  type ExtensionAccountList,
  type ExtensionManagementVersion,
  type ExtensionProviderCatalogEntry
} from './extension-workbench-client'
import { boundedPlainText } from './safe-text'
import {
  AccountRow,
  AccountSessionCard,
  authenticationLabel
} from './ExtensionAccountRows'

export {
  AccountSessionCard,
  safeAccountVerificationUrl
} from './ExtensionAccountRows'

type Copy = (chinese: string, english: string) => string

export type ExtensionAccountProvider = {
  provider: ModelProviderDeclaration
  authentication: AuthenticationProviderDeclaration
  canRead: boolean
  canManage: boolean
}

export function extensionAccountProviders(
  version: ExtensionManagementVersion
): ExtensionAccountProvider[] {
  const permissions = new Set(version.grantedPermissions)
  const canRead = permissions.has('accounts.read')
  const authentication = new Map(
    (version.authentication ?? []).map((declaration) => [declaration.id, declaration])
  )
  return (version.modelProviders ?? []).flatMap((provider) => {
    if (!provider.authenticationProviderId) return []
    const authenticationProvider = authentication.get(provider.authenticationProviderId)
    if (!authenticationProvider) return []
    const localPermission = `accounts.manage:${provider.id}`
    const canManage = permissions.has(localPermission)
    if (!canRead && !canManage) return []
    return [{
      provider,
      authentication: authenticationProvider,
      canRead,
      canManage
    }]
  })
}

export function ExtensionAccountManagement({
  extensionId,
  version,
  workspaceRoot,
  disabled,
  copy
}: {
  extensionId: string
  version: ExtensionManagementVersion
  workspaceRoot: string
  disabled: boolean
  copy: Copy
}): ReactElement | null {
  const providers = useMemo(
    () => extensionAccountProviders(version),
    [version]
  )
  const [accountLists, setAccountLists] = useState<Record<string, ExtensionAccountList>>({})
  const [providerErrors, setProviderErrors] = useState<Record<string, string>>({})
  const [sessions, setSessions] = useState<Record<string, AccountSession>>({})
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [catalog, setCatalog] = useState<Record<string, ExtensionProviderCatalogEntry>>({})
  const [bindingAccounts, setBindingAccounts] = useState<Record<string, string>>({})
  const [bindingModels, setBindingModels] = useState<Record<string, string>>({})
  const [providerModels, setProviderModels] = useState<Record<string, ExtensionProviderCatalogEntry['models']>>({})
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const canReadAccounts = version.grantedPermissions.includes('accounts.read')

  const loadCatalog = useCallback(async (): Promise<void> => {
    const entries = await extensionWorkbenchClient.listModelProviders(workspaceRoot || undefined)
    const owned = entries.filter((entry) =>
      entry.extensionId === extensionId && entry.extensionVersion === version.version
    )
    const nextCatalog: Record<string, ExtensionProviderCatalogEntry> = {}
    const nextModels: Record<string, ExtensionProviderCatalogEntry['models']> = {}
    const nextAccounts: Record<string, string> = {}
    const nextBindingModels: Record<string, string> = {}
    for (const entry of owned) {
      nextCatalog[entry.localProviderId] = entry
      nextModels[entry.localProviderId] = entry.models
      const connected = entry.accounts.filter((account) => account.status === 'connected')
      const accountId = entry.binding?.accountId ?? connected[0]?.id ?? ''
      const modelId = entry.binding?.modelId ?? entry.models[0]?.id ?? ''
      if (accountId) nextAccounts[entry.localProviderId] = accountId
      if (modelId) nextBindingModels[entry.localProviderId] = modelId
    }
    setCatalog(nextCatalog)
    setProviderModels(nextModels)
    setBindingAccounts(nextAccounts)
    setBindingModels(nextBindingModels)
  }, [extensionId, version.version, workspaceRoot])

  const loadProvider = useCallback(async (providerId: string): Promise<void> => {
    if (!canReadAccounts) return
    try {
      const result = await extensionWorkbenchClient.listAccounts(extensionId, providerId, true)
      setAccountLists((current) => ({ ...current, [providerId]: result }))
      setProviderErrors((current) => {
        if (!(providerId in current)) return current
        const next = { ...current }
        delete next[providerId]
        return next
      })
    } catch (error) {
      setProviderErrors((current) => ({
        ...current,
        [providerId]: boundedPlainText(error instanceof Error ? error.message : String(error), 4_096)
      }))
    }
  }, [canReadAccounts, extensionId])

  useEffect(() => {
    if (providers.length === 0) return
    let active = true
    const readableProviders = providers.filter(({ canRead }) => canRead)
    if (readableProviders.length === 0) {
      setAccountLists({})
      setProviderErrors({})
      setLoading(false)
      return
    }
    setLoading(true)
    void Promise.all(readableProviders.map(async ({ provider }) => {
      try {
        const result = await extensionWorkbenchClient.listAccounts(extensionId, provider.id, true)
        return { ok: true as const, providerId: provider.id, result }
      } catch (error) {
        return {
          ok: false as const,
          providerId: provider.id,
          error: boundedPlainText(error instanceof Error ? error.message : String(error), 4_096)
        }
      }
    })).then((results) => {
      if (!active) return
      const nextLists: Record<string, ExtensionAccountList> = {}
      const nextErrors: Record<string, string> = {}
      for (const result of results) {
        if (result.ok) nextLists[result.providerId] = result.result
        else nextErrors[result.providerId] = result.error
      }
      setAccountLists(nextLists)
      setProviderErrors(nextErrors)
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => {
      active = false
    }
  }, [extensionId, providers])

  useEffect(() => {
    if (providers.length === 0 || !canReadAccounts) return
    let active = true
    void loadCatalog().catch((error) => {
      if (active) {
        setNotice(boundedPlainText(error instanceof Error ? error.message : String(error), 4_096))
      }
    })
    return () => {
      active = false
    }
  }, [canReadAccounts, loadCatalog, providers.length])

  if (providers.length === 0) return null

  const perform = async (
    key: string,
    operation: () => Promise<void>,
    success: string
  ): Promise<void> => {
    setBusyKey(key)
    setNotice(null)
    try {
      await operation()
      setNotice(success)
    } catch (error) {
      setNotice(boundedPlainText(error instanceof Error ? error.message : String(error), 4_096))
    } finally {
      setBusyKey(null)
    }
  }

  const createApiKey = async (descriptor: ExtensionAccountProvider): Promise<void> => {
    const providerId = descriptor.provider.id
    await perform(`create:${providerId}`, async () => {
      await extensionWorkbenchClient.createApiKeyAccount({
        extensionId,
        extensionVersion: version.version,
        providerId,
        authenticationProviderId: descriptor.authentication.id,
        ...(labels[providerId]?.trim() ? { label: labels[providerId].trim() } : {}),
        ...(workspaceRoot ? { workspaceRoot } : {})
      })
      await Promise.all([loadProvider(providerId), loadCatalog()])
    }, copy('账号已安全保存。', 'Account saved securely.'))
  }

  const createSession = async (descriptor: ExtensionAccountProvider): Promise<void> => {
    const providerId = descriptor.provider.id
    await perform(`session:${providerId}`, async () => {
      const session = await extensionWorkbenchClient.createAccountSession({
        extensionId,
        extensionVersion: version.version,
        providerId,
        authenticationProviderId: descriptor.authentication.id,
        ...(labels[providerId]?.trim() ? { label: labels[providerId].trim() } : {}),
        ...(descriptor.authentication.scopes?.length
          ? { scopes: descriptor.authentication.scopes }
          : {}),
        ...(workspaceRoot ? { workspaceRoot } : {})
      })
      setSessions((current) => ({ ...current, [providerId]: session }))
    }, copy('授权会话已创建。', 'Authorization session created.'))
  }

  const refreshSession = async (providerId: string, sessionId: string): Promise<void> => {
    await perform(`refresh:${providerId}`, async () => {
      const session = await extensionWorkbenchClient.getAccountSession(extensionId, sessionId)
      setSessions((current) => ({ ...current, [providerId]: session }))
      if (session.status === 'completed') await Promise.all([loadProvider(providerId), loadCatalog()])
    }, copy('授权状态已刷新。', 'Authorization status refreshed.'))
  }

  const completeSession = async (providerId: string, sessionId: string): Promise<void> => {
    await perform(`complete:${providerId}`, async () => {
      const session = await extensionWorkbenchClient.completeAccountSession({
        extensionId,
        extensionVersion: version.version,
        sessionId,
        ...(workspaceRoot ? { workspaceRoot } : {})
      })
      setSessions((current) => ({ ...current, [providerId]: session }))
      if (session.status === 'completed') await Promise.all([loadProvider(providerId), loadCatalog()])
    }, copy('受保护授权流程已处理。', 'Protected authorization flow processed.'))
  }

  const cancelSession = async (providerId: string, sessionId: string): Promise<void> => {
    await perform(`cancel:${providerId}`, async () => {
      await extensionWorkbenchClient.cancelAccountSession(extensionId, sessionId)
      setSessions((current) => ({
        ...current,
        [providerId]: { ...current[providerId], status: 'cancelled' }
      }))
    }, copy('授权已取消。', 'Authorization cancelled.'))
  }

  const deleteAccount = async (providerId: string, accountId: string): Promise<void> => {
    await perform(`delete:${accountId}`, async () => {
      await extensionWorkbenchClient.deleteAccount({
        extensionId,
        extensionVersion: version.version,
        accountId,
        providerId,
        ...(workspaceRoot ? { workspaceRoot } : {})
      })
      await Promise.all([loadProvider(providerId), loadCatalog()])
    }, copy('账号及其受保护凭据已删除。', 'Account and its protected credential were deleted.'))
  }

  const renameAccount = async (providerId: string, accountId: string): Promise<void> => {
    await perform(`rename:${accountId}`, async () => {
      await extensionWorkbenchClient.renameAccount({
        extensionId,
        extensionVersion: version.version,
        accountId,
        providerId,
        ...(workspaceRoot ? { workspaceRoot } : {})
      })
      await Promise.all([loadProvider(providerId), loadCatalog()])
    }, copy('账号名称已更新，现有绑定保持不变。', 'Account label updated; existing bindings are unchanged.'))
  }

  const replaceApiKeyAccount = async (providerId: string, accountId: string): Promise<void> => {
    await perform(`replace-key:${accountId}`, async () => {
      await extensionWorkbenchClient.replaceApiKeyAccount({
        extensionId,
        extensionVersion: version.version,
        accountId,
        providerId,
        ...(workspaceRoot ? { workspaceRoot } : {})
      })
      await Promise.all([loadProvider(providerId), loadCatalog()])
    }, copy('API Key 已原子替换，账号引用保持不变。', 'API key replaced atomically; the account reference is unchanged.'))
  }

  const selectBindingAccount = async (
    descriptor: ExtensionAccountProvider,
    accountId: string
  ): Promise<void> => {
    const providerId = descriptor.provider.id
    setBindingAccounts((current) => ({ ...current, [providerId]: accountId }))
    setBindingModels((current) => ({ ...current, [providerId]: '' }))
    if (!accountId) {
      setProviderModels((current) => ({ ...current, [providerId]: [] }))
      return
    }
    await perform(`models:${providerId}`, async () => {
      const models = await extensionWorkbenchClient.listProviderModels({
        extensionId,
        extensionVersion: version.version,
        providerId,
        accountId,
        ...(workspaceRoot ? { workspaceRoot } : {})
      })
      setProviderModels((current) => ({ ...current, [providerId]: models }))
      setBindingModels((current) => ({ ...current, [providerId]: models[0]?.id ?? '' }))
    }, copy('模型目录已刷新。', 'Model catalog refreshed.'))
  }

  const bindProvider = async (descriptor: ExtensionAccountProvider): Promise<void> => {
    const providerId = descriptor.provider.id
    const accountId = bindingAccounts[providerId]?.trim()
    const modelId = bindingModels[providerId]?.trim()
    if (!accountId || !modelId) {
      setNotice(copy('请选择已连接账号和模型。', 'Select a connected account and model.'))
      return
    }
    await perform(`bind:${providerId}`, async () => {
      await extensionWorkbenchClient.setProviderBinding({
        extensionId,
        extensionVersion: version.version,
        providerId,
        accountId,
        modelId,
        ...(workspaceRoot ? { workspaceRoot } : {})
      })
      await loadCatalog()
    }, copy(
      'Provider 绑定已保存；Kun 不会在不可用时静默切换供应商。',
      'Provider binding saved; Kun will not silently switch providers if it becomes unavailable.'
    ))
  }

  return (
    <section className="mt-3 border-t border-ds-border-muted pt-3" data-extension-account-management={extensionId}>
      <div className="flex items-start gap-2">
        <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-ds-faint" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold text-ds-ink">
            {copy('Provider 账号', 'Provider accounts')}
          </div>
          <p className="mt-0.5 text-[10.5px] leading-5 text-ds-faint">
            {copy('这里只显示脱敏账号元数据。API Key 输入、授权确认与删除确认都由 Main 的受保护窗口持有。', 'Only redacted account metadata appears here. API-key entry, authorization consent, and deletion confirmation stay in Main-owned protected windows.')}
          </p>
        </div>
        {loading ? <RefreshCw className="h-3.5 w-3.5 animate-spin text-ds-faint" aria-label={copy('正在加载账号', 'Loading accounts')} /> : null}
      </div>

      {notice ? (
        <div role="status" className="mt-2 rounded-lg border border-ds-border bg-ds-main px-2.5 py-2 text-[10.5px] text-ds-muted">
          {boundedPlainText(notice, 4_096)}
        </div>
      ) : null}

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {providers.map((descriptor) => {
          const { provider, authentication } = descriptor
          const list = accountLists[provider.id]
          const session = sessions[provider.id]
          const catalogEntry = catalog[provider.id]
          const connectedAccounts = (list?.accounts ?? []).filter((account) => account.status === 'connected')
          const models = providerModels[provider.id] ?? catalogEntry?.models ?? provider.models
          const canBind = descriptor.canRead &&
            version.grantedPermissions.includes('providers.register') &&
            version.grantedPermissions.includes(`accounts.use:${provider.id}`)
          const providerBusy = disabled || busyKey !== null
          const isApiKey = authentication.type === 'api-key'
          const isSessionAuth = authentication.type === 'oauth2-pkce' || authentication.type === 'device-code'
          return (
            <section key={provider.id} className="rounded-xl border border-ds-border bg-ds-main p-3" data-provider-id={provider.id}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] font-semibold text-ds-ink">
                    {boundedPlainText(provider.displayName, 256)}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[9.5px] text-ds-faint">
                    {boundedPlainText(provider.id, 128)} · {authenticationLabel(authentication.type, copy)}
                  </div>
                </div>
                <span className={`rounded-md px-2 py-1 text-[9px] font-semibold ${descriptor.canManage ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-ds-subtle text-ds-faint'}`}>
                  {descriptor.canManage ? copy('可管理', 'manageable') : copy('只读', 'read only')}
                </span>
              </div>

              {list?.protection.degraded ? (
                <div className="mt-2 flex gap-1.5 rounded-lg bg-amber-500/10 px-2 py-1.5 text-[9.5px] leading-4 text-amber-800 dark:text-amber-200">
                  <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
                  {copy('系统凭据设施不可用，Kun 正使用认证加密的降级存储。', 'System credential storage is unavailable; Kun is using authenticated encrypted fallback storage.')}
                </div>
              ) : null}

              {providerErrors[provider.id] ? (
                <div role="alert" className="mt-2 rounded-lg bg-red-500/8 px-2 py-1.5 text-[9.5px] leading-4 text-red-700 dark:text-red-200">
                  {boundedPlainText(providerErrors[provider.id], 4_096)}
                </div>
              ) : null}

              {!descriptor.canRead ? (
                <div className="mt-2 rounded-lg border border-dashed border-ds-border px-2 py-2 text-[9.5px] leading-4 text-ds-faint">
                  {copy('此扩展未获 accounts.read；Kun 不会向 renderer 返回账号元数据，但仍可在受保护窗口创建新账号。', 'This extension has no accounts.read grant. Kun will not return account metadata to the renderer, but a new account can still be created in a protected window.')}
                </div>
              ) : null}

              {descriptor.canRead ? (
                <div className="mt-2 space-y-1.5">
                  {(list?.accounts ?? []).map((account) => (
                    <AccountRow
                      key={account.id}
                      account={account}
                      canManage={descriptor.canManage}
                      disabled={providerBusy}
                      copy={copy}
                      onRename={() => void renameAccount(provider.id, account.id)}
                      onReplaceApiKey={() => void replaceApiKeyAccount(provider.id, account.id)}
                      onDelete={() => void deleteAccount(provider.id, account.id)}
                    />
                  ))}
                  {list && list.accounts.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-ds-border px-2 py-3 text-center text-[9.5px] text-ds-faint">
                      {copy('尚未连接账号。', 'No connected accounts yet.')}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {canBind ? (
                <div className="mt-2 space-y-2 border-t border-ds-border-muted pt-2" data-provider-binding={provider.id}>
                  <div className="flex items-start gap-1.5">
                    <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] font-semibold text-ds-ink">
                        {copy('用于 Kun / 扩展 Agent', 'Use for Kun / extension Agents')}
                      </div>
                      <p className="mt-0.5 text-[9.5px] leading-4 text-ds-faint">
                        {copy(
                          '绑定会把 Provider、账号引用和模型作为一个整体保存。首次保存会打开受保护披露窗口。',
                          'The provider, opaque account reference, and model are saved as one binding. First save opens a protected disclosure window.'
                        )}
                      </p>
                    </div>
                  </div>
                  <select
                    aria-label={`${provider.displayName} ${copy('绑定账号', 'binding account')}`}
                    value={bindingAccounts[provider.id] ?? ''}
                    onChange={(event) => void selectBindingAccount(descriptor, event.currentTarget.value)}
                    disabled={providerBusy || connectedAccounts.length === 0}
                    className="w-full rounded-lg border border-ds-border bg-ds-card px-2.5 py-1.5 text-[10px] text-ds-ink disabled:opacity-50"
                  >
                    <option value="">{copy('选择已连接账号', 'Select connected account')}</option>
                    {connectedAccounts.map((account) => (
                      <option key={account.id} value={account.id}>{boundedPlainText(account.label, 128)}</option>
                    ))}
                  </select>
                  <select
                    aria-label={`${provider.displayName} ${copy('绑定模型', 'binding model')}`}
                    value={bindingModels[provider.id] ?? ''}
                    onChange={(event) => setBindingModels((current) => ({
                      ...current,
                      [provider.id]: event.currentTarget.value
                    }))}
                    disabled={providerBusy || !bindingAccounts[provider.id] || models.length === 0}
                    className="w-full rounded-lg border border-ds-border bg-ds-card px-2.5 py-1.5 text-[10px] text-ds-ink disabled:opacity-50"
                  >
                    <option value="">{copy('选择模型', 'Select model')}</option>
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {boundedPlainText(model.displayName || model.id, 256)}
                      </option>
                    ))}
                  </select>
                  <div className="rounded-lg bg-amber-500/8 px-2 py-1.5 text-[9px] leading-4 text-amber-800 dark:text-amber-200">
                    {copy(
                      '该 Node Provider 可接收完整对话历史、系统/模式指令、附件和工具 Schema。Kun 不会把凭据写入绑定，也不会在失败时改用其他 Provider。',
                      'This Node provider can receive complete conversation history, system/mode instructions, attachments, and tool schemas. Kun never writes credentials into the binding or falls back to another provider.'
                    )}
                  </div>
                  {catalogEntry?.binding ? (
                    <div className={`text-[9px] ${catalogEntry.binding.valid ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>
                      {catalogEntry.binding.valid
                        ? copy(
                            `当前绑定：${catalogEntry.binding.modelId}（已确认）`,
                            `Current binding: ${catalogEntry.binding.modelId} (acknowledged)`
                          )
                        : copy(
                            '已有绑定当前不可用；Kun 会显式报错，不会自动替换账号或 Provider。',
                            'The saved binding is currently unavailable; Kun fails explicitly instead of substituting an account or provider.'
                          )}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    disabled={providerBusy || !catalogEntry?.selectable || !bindingAccounts[provider.id] || !bindingModels[provider.id]}
                    onClick={() => void bindProvider(descriptor)}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[10px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
                  >
                    <Bot className="h-3.5 w-3.5" />
                    {copy('审阅并保存绑定', 'Review and save binding')}
                  </button>
                  {catalogEntry?.unavailableReason ? (
                    <div className="text-[9px] text-ds-faint">
                      {copy('当前不可选择：', 'Not selectable: ')}{boundedPlainText(catalogEntry.unavailableReason, 128)}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {descriptor.canManage ? (
                <div className="mt-2 space-y-2 border-t border-ds-border-muted pt-2">
                  <input
                    aria-label={`${provider.displayName} ${copy('账号名称', 'account label')}`}
                    value={labels[provider.id] ?? ''}
                    onChange={(event) => setLabels((current) => ({
                      ...current,
                      [provider.id]: event.currentTarget.value.slice(0, 128)
                    }))}
                    placeholder={copy('账号名称（可选）', 'Account label (optional)')}
                    disabled={providerBusy}
                    className="w-full rounded-lg border border-ds-border bg-ds-card px-2.5 py-1.5 text-[10px] text-ds-ink disabled:opacity-50"
                  />
                  {isApiKey ? (
                    <button
                      type="button"
                      disabled={providerBusy}
                      onClick={() => void createApiKey(descriptor)}
                      className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-ds-border px-2.5 py-1.5 text-[10px] font-semibold text-ds-muted hover:bg-ds-hover disabled:opacity-50"
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      {copy('在受保护窗口添加 API Key', 'Add API key in protected window')}
                    </button>
                  ) : isSessionAuth ? (
                    <button
                      type="button"
                      disabled={providerBusy || session?.status === 'pending'}
                      onClick={() => void createSession(descriptor)}
                      className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-ds-border px-2.5 py-1.5 text-[10px] font-semibold text-ds-muted hover:bg-ds-hover disabled:opacity-50"
                    >
                      <Link2 className="h-3.5 w-3.5" />
                      {copy('开始受保护授权', 'Start protected authorization')}
                    </button>
                  ) : (
                    <div className="text-[9.5px] leading-4 text-ds-faint">
                      {copy('自定义认证需要扩展提供受支持的核心账号流程。', 'Custom authentication requires an extension-provided supported core account flow.')}
                    </div>
                  )}
                </div>
              ) : null}

              {session ? (
                <AccountSessionCard
                  session={session}
                  authenticationType={authentication.type}
                  disabled={providerBusy}
                  copy={copy}
                  onComplete={() => void completeSession(provider.id, session.id)}
                  onRefresh={() => void refreshSession(provider.id, session.id)}
                  onCancel={() => void cancelSession(provider.id, session.id)}
                />
              ) : null}
            </section>
          )
        })}
      </div>
    </section>
  )
}
