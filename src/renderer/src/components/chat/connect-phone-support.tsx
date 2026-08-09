import type { ReactElement } from 'react'
import { Send } from 'lucide-react'
import type {
  ClawImAgentProfileV1,
  ClawImChannelV1,
  ClawImPlatformCredentialV1,
  ClawImProvider,
  ClawImSettingsV1,
  ClawModel
} from '@shared/app-settings'
import type { ClawImInstallPollResult } from '@shared/kun-gui-api'
import {
  type ClawInstallQrState,
  type ClawInstallTarget,
  clawInstallTargetLabel
} from './SidebarClawDialogHelpers'
import { ClawProviderLogo } from './SidebarClaw'

export type AddClawPhoneChannel = (
  provider: ClawImProvider,
  agentProfile: ClawImAgentProfileV1,
  platformCredential: ClawImPlatformCredentialV1,
  options: {
    model: ClawModel
    enabled: boolean
    im: Partial<ClawImSettingsV1>
    preserveRoute?: boolean
  }
) => Promise<void>

export type Props = {
  channels: ClawImChannelV1[]
  onAddProvider: AddClawPhoneChannel
  leftSidebarCollapsed: boolean
  onToggleSidebar: () => void
}

export type FeishuInstallRequest = {
  provider: 'feishu'
  options: { isLark: boolean }
}

export type WeixinInstallRequest = {
  provider: 'weixin'
  options?: { isLark?: boolean }
}

export type ConnectPhoneInstallRequest = FeishuInstallRequest | WeixinInstallRequest

export const CONNECT_PHONE_TARGETS: readonly ClawInstallTarget[] = ['feishu', 'lark', 'weixin', 'telegram']

export const INITIAL_QR_STATE: ClawInstallQrState = {
  status: 'idle',
  url: '',
  deviceCode: '',
  userCode: '',
  timeLeft: 0,
  error: ''
}

export function connectPhoneProviderForTarget(target: ClawInstallTarget): ClawImProvider {
  if (target === 'telegram') return 'telegram'
  return target === 'weixin' ? 'weixin' : 'feishu'
}

export function hasEnabledClawPhoneChannel(
  channels: ClawImChannelV1[],
  provider?: ClawImProvider
): boolean {
  return channels.some((channel) =>
    (provider ? channel.provider === provider : true) && channel.enabled
  )
}

export function hasClawPhoneChannel(
  channels: ClawImChannelV1[],
  provider?: ClawImProvider
): boolean {
  return provider
    ? channels.some((channel) => channel.provider === provider)
    : channels.length > 0
}

export function connectPhoneInstallRequestOptions(
  target: ClawInstallTarget
): ConnectPhoneInstallRequest {
  if (target === 'weixin') {
    return { provider: 'weixin' }
  }
  return {
    provider: 'feishu',
    options: { isLark: target === 'lark' }
  }
}

export function createTelegramCredential(
  botToken: string,
  allowedChatIds: string,
  botUsername?: string,
  createdAt: string = new Date().toISOString()
): ClawImPlatformCredentialV1 {
  return {
    kind: 'telegram',
    botToken,
    allowedChatIds,
    ...(botUsername ? { botUsername } : {}),
    createdAt
  }
}

export function createConnectPhoneAgentProfile(): ClawImAgentProfileV1 {
  return {
    name: 'kun',
    description: '',
    identity: '',
    personality: '',
    userContext: '',
    replyRules: ''
  }
}

export function createConnectPhoneChannelOptions(provider: ClawImProvider = 'feishu'): {
  model: ClawModel
  enabled: boolean
  im: Partial<ClawImSettingsV1>
} {
  return {
    model: 'auto',
    enabled: true,
    im: {
      enabled: true,
      provider
    }
  }
}

export function createConnectPhoneCredential(
  poll: Extract<ClawImInstallPollResult, { done: true }>,
  createdAt: string = new Date().toISOString()
): ClawImPlatformCredentialV1 {
  if (poll.kind === 'weixin') {
    return {
      kind: poll.kind,
      accountId: poll.accountId,
      sessionKey: poll.sessionKey,
      createdAt
    }
  }
  return {
    kind: poll.kind,
    appId: poll.appId,
    appSecret: poll.appSecret,
    domain: poll.domain,
    createdAt
  }
}

export function surfaceButtonClass(extra = ''): string {
  return `inline-flex items-center justify-center gap-2 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[12.5px] font-semibold text-ds-ink shadow-sm transition hover:bg-ds-hover disabled:cursor-not-allowed disabled:opacity-55 ${extra}`
}

export function connectPhoneTargetIcon(provider: ClawImProvider, className = 'h-4 w-4'): ReactElement {
  if (provider === 'telegram') {
    return (
      <span className={`inline-flex shrink-0 items-center justify-center rounded-full bg-[#27A7E7] text-white ${className}`}>
        <Send className="h-[65%] w-[65%] -translate-x-[6%]" strokeWidth={2.4} />
      </span>
    )
  }
  return <ClawProviderLogo provider={provider} className={className} />
}

export function connectPhoneTopTargetLabel(
  t: (key: string, values?: Record<string, unknown>) => string,
  target: ClawInstallTarget
): string {
  if (target === 'telegram') return 'TELE'
  return clawInstallTargetLabel(t, target)
}

export function formatConnectPhoneUserCode(userCode: string, deviceCode: string): string {
  const source = userCode.trim() || deviceCode
  const compact = source.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8)
  if (compact.length <= 4) return compact
  return `${compact.slice(0, 4)}-${compact.slice(4)}`
}
