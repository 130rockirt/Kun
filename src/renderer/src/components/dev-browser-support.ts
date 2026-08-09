import type { DevPreviewElementContext } from '@shared/dev-preview-context'
import {
  DEV_PREVIEW_VIEWPORTS,
  type DevPreviewViewportPreset
} from '../lib/dev-preview-state'

export function formatAddressInput(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return `${parsed.host}${path}${parsed.search}${parsed.hash}`
  } catch {
    return url
  }
}

export function contextTitle(element: DevPreviewElementContext): string {
  const text = element.text.slice(0, 48)
  return text ? `${element.tag}: ${text}` : `${element.tag}: ${element.selector.slice(0, 64)}`
}

export function viewportLabel(preset: DevPreviewViewportPreset): string {
  if (preset === 'fit') return 'Fit'
  const size = DEV_PREVIEW_VIEWPORTS[preset]
  return `${size.width}×${size.height}`
}

export function iconButtonClass(active = false): string {
  return `inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition disabled:cursor-default disabled:opacity-30 ${
    active
      ? 'bg-accent/12 text-accent dark:bg-accent/20'
      : 'text-ds-faint hover:bg-ds-hover hover:text-ds-ink'
  }`
}
