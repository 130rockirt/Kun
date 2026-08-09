import { KeyRound, Pencil, RefreshCw, Trash2, X } from 'lucide-react'
import type { ReactElement } from 'react'
import type { Account, AccountSession, AuthenticationProviderDeclaration } from '@kun/extension-api'
import { boundedPlainText } from './safe-text'

type Copy = (chinese: string, english: string) => string

export function safeAccountVerificationUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'https:') return parsed.toString()
    if (
      parsed.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
    ) return parsed.toString()
  } catch {
    // Invalid or unsafe URLs stay visible as text but are never opened.
  }
  return null
}

export function AccountRow({
  account,
  canManage,
  disabled,
  copy,
  onRename,
  onReplaceApiKey,
  onDelete
}: {
  account: Account
  canManage: boolean
  disabled: boolean
  copy: Copy
  onRename: () => void
  onReplaceApiKey: () => void
  onDelete: () => void
}): ReactElement {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-ds-border bg-ds-card px-2.5 py-2" data-account-id={account.id}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[10px] font-semibold text-ds-ink">{boundedPlainText(account.label, 128)}</div>
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[9px] text-ds-faint">
          <span>{accountStatusLabel(account.status, copy)}</span>
          <span>{authenticationLabel(account.authenticationType, copy)}</span>
          {account.expiresAt ? <span>{copy('到期', 'expires')} {boundedPlainText(account.expiresAt, 64)}</span> : null}
        </div>
      </div>
      {canManage ? (
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            disabled={disabled}
            onClick={onRename}
            aria-label={`${copy('重命名账号', 'Rename account')} ${boundedPlainText(account.label, 128)}`}
            className="rounded-md p-1.5 text-ds-faint hover:bg-ds-hover hover:text-ds-ink disabled:opacity-50"
            title={copy('在受保护窗口修改名称', 'Rename in a protected window')}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          {account.authenticationType === 'api-key' ? (
            <button
              type="button"
              disabled={disabled}
              onClick={onReplaceApiKey}
              aria-label={`${copy('替换 API Key', 'Replace API key')} ${boundedPlainText(account.label, 128)}`}
              className="rounded-md p-1.5 text-ds-faint hover:bg-ds-hover hover:text-ds-ink disabled:opacity-50"
              title={copy('在受保护窗口原子替换 Key', 'Replace the key atomically in a protected window')}
            >
              <KeyRound className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            disabled={disabled}
            onClick={onDelete}
            aria-label={`${copy('删除账号', 'Delete account')} ${boundedPlainText(account.label, 128)}`}
            className="rounded-md p-1.5 text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-300"
            title={copy('在受保护窗口确认删除', 'Confirm deletion in protected window')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function AccountSessionCard({
  session,
  authenticationType,
  disabled,
  copy,
  onComplete,
  onRefresh,
  onCancel
}: {
  session: AccountSession
  authenticationType: AuthenticationProviderDeclaration['type']
  disabled: boolean
  copy: Copy
  onComplete: () => void
  onRefresh: () => void
  onCancel: () => void
}): ReactElement {
  const openableUrl = safeAccountVerificationUrl(session.verificationUrl)
  const terminal = session.status !== 'pending'
  return (
    <div className="mt-2 rounded-lg border border-accent/30 bg-accent/5 p-2.5" data-account-session={session.id}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold text-ds-ink">
          {copy('授权状态', 'Authorization status')}: {sessionStatusLabel(session.status, copy)}
        </span>
        <div className="flex gap-1">
          <button type="button" disabled={disabled} onClick={onRefresh} className="rounded-md p-1 text-ds-muted hover:bg-ds-hover disabled:opacity-50" aria-label={copy('刷新授权状态', 'Refresh authorization status')}>
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          {!terminal ? (
            <button type="button" disabled={disabled} onClick={onCancel} className="rounded-md p-1 text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-300" aria-label={copy('取消授权', 'Cancel authorization')}>
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>
      {session.verificationUrl ? (
        <div className="mt-2">
          <div className="text-[9px] font-semibold text-ds-faint">{copy('验证地址', 'Verification URL')}</div>
          <div className="mt-0.5 break-all font-mono text-[9px] leading-4 text-ds-muted">{boundedPlainText(session.verificationUrl, 2_048)}</div>
          {openableUrl ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => void window.kunGui.openExternal(openableUrl).catch(() => undefined)}
              className="mt-1 rounded-md border border-ds-border px-2 py-1 text-[9px] font-semibold text-ds-muted hover:bg-ds-hover disabled:opacity-50"
            >
              {copy('在浏览器打开', 'Open in browser')}
            </button>
          ) : null}
        </div>
      ) : null}
      {authenticationType === 'oauth2-pkce' && session.status === 'pending' ? (
        <button
          type="button"
          disabled={disabled}
          onClick={onComplete}
          className="mt-2 w-full rounded-md bg-accent px-2 py-1.5 text-[9.5px] font-semibold text-white disabled:opacity-50"
        >
          {copy('在受保护窗口完成 OAuth 回调', 'Complete OAuth callback in protected window')}
        </button>
      ) : null}
      {session.userCode ? (
        <div className="mt-2">
          <div className="text-[9px] font-semibold text-ds-faint">{copy('用户代码', 'User code')}</div>
          <div className="mt-0.5 inline-block rounded-md bg-ds-card px-2 py-1 font-mono text-[11px] font-semibold tracking-wider text-ds-ink">{boundedPlainText(session.userCode, 128)}</div>
        </div>
      ) : null}
      {session.expiresAt ? <div className="mt-2 text-[9px] text-ds-faint">{copy('会话到期', 'Session expires')}: {boundedPlainText(session.expiresAt, 64)}</div> : null}
      {session.message ? <div className="mt-1 text-[9.5px] leading-4 text-ds-muted">{boundedPlainText(session.message, 1_024)}</div> : null}
    </div>
  )
}

export function authenticationLabel(type: Account['authenticationType'], copy: Copy): string {
  if (type === 'api-key') return 'API key'
  if (type === 'oauth2-pkce') return 'OAuth PKCE'
  if (type === 'device-code') return copy('设备授权', 'Device authorization')
  return copy('自定义认证', 'Custom authentication')
}

function accountStatusLabel(status: Account['status'], copy: Copy): string {
  switch (status) {
    case 'connected': return copy('已连接', 'connected')
    case 'expired': return copy('已过期', 'expired')
    case 'interaction-required': return copy('需要交互', 'interaction required')
    case 'error': return copy('错误', 'error')
    case 'unavailable': return copy('不可用', 'unavailable')
  }
}

function sessionStatusLabel(status: AccountSession['status'], copy: Copy): string {
  switch (status) {
    case 'pending': return copy('等待用户完成', 'pending')
    case 'completed': return copy('已完成', 'completed')
    case 'cancelled': return copy('已取消', 'cancelled')
    case 'expired': return copy('已过期', 'expired')
    case 'failed': return copy('失败', 'failed')
  }
}
