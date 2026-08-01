import type { ImgHTMLAttributes, ReactElement } from 'react'
import { Cable } from 'lucide-react'
import feishuUrl from '../../assets/connectors/feishu.svg?url'
import dingtalkUrl from '../../assets/connectors/dingtalk.svg?url'
import wecomUrl from '../../assets/connectors/wecom.svg?url'
import qqMailUrl from '../../assets/connectors/qq-mail.svg?url'
import neteaseMailUrl from '../../assets/connectors/netease-mail.svg?url'

const LOGO_URLS: Record<string, string> = {
  feishu: feishuUrl,
  dingtalk: dingtalkUrl,
  wecom: wecomUrl,
  wecom_bot: wecomUrl,
  'qq-mail': qqMailUrl,
  qq_mail: qqMailUrl,
  'netease-mail': neteaseMailUrl,
  netease_mail: neteaseMailUrl
}

export function ConnectorLogo({
  assetKey,
  alt,
  className = 'h-10 w-10'
}: {
  assetKey: string
  alt: string
  className?: string
}): ReactElement {
  const src = LOGO_URLS[assetKey]
  if (!src) {
    return (
      <span
        className={`flex shrink-0 items-center justify-center rounded-xl bg-ds-subtle text-ds-muted ${className}`}
        role="img"
        aria-label={alt}
      >
        <Cable className="h-1/2 w-1/2" aria-hidden="true" />
      </span>
    )
  }
  const imageProps: ImgHTMLAttributes<HTMLImageElement> = {
    src,
    alt,
    draggable: false,
    className: `shrink-0 rounded-xl object-contain ${className}`
  }
  return <img {...imageProps} />
}

export function connectorLogoAssetKey(service: string): string {
  if (service === 'wecom_bot') return 'wecom'
  if (service === 'qq_mail') return 'qq-mail'
  if (service === 'netease_mail') return 'netease-mail'
  return service
}
