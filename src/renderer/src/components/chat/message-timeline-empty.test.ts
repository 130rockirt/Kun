import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import i18n from '../../i18n'
import { MessageTimelineEmptyHero } from './message-timeline-empty'

type EmptyHeroProps = Parameters<typeof MessageTimelineEmptyHero>[0]

/**
 * Tests for the "runtime offline" hero (`RuntimeWakeHero` inside
 * `MessageTimelineEmptyHero`). See issue #78 — when the user-reported port
 * conflict occurred, the hero only showed a vague "正在唤醒本地智能体" title
 * while the specific error lived in a faint detail paragraph below. Users
 * skimmed the title, thought the app was still loading, and never opened
 * Settings. The fix: when `runtimeError` is present, surface the localized
 * error in the title slot so the user sees the real cause immediately.
 */

function renderEmptyHero(patch: Partial<EmptyHeroProps> = {}): string {
  return renderToStaticMarkup(
    createElement(MessageTimelineEmptyHero, {
      route: 'chat',
      ready: true,
      hasWorkspace: true,
      runtimeError: null,
      activeClawChannel: null,
      onPickWorkspace: () => undefined,
      onRetry: () => undefined,
      onOpenSettings: () => undefined,
      onSelectSuggestion: () => undefined,
      ...patch
    })
  )
}

function renderOfflineHero(runtimeError: string | null = null): string {
  return renderEmptyHero({ ready: false, runtimeError })
}

describe('MessageTimelineEmptyHero — chat init welcome', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders only the minimal welcome copy for a ready workspace chat', () => {
    const html = renderEmptyHero()

    expect(html).toContain('ds-chat-empty-hero')
    expect(html).toContain('What would you like to do with Kun today?')
    expect(html).toContain('Open a terminal and run kun to use the TUI.')
    expect(html).toContain('Settings in the bottom-left, then General → Desktop &amp; system → Terminal')
    expect(html).not.toContain('ds-runtime-wake-stage')
    expect(html).not.toContain('ds-kun-state-')
    expect(html).not.toContain('ds-initial-usage-heatmap')
    expect(html).not.toContain('Expand calendar')
    expect(html).not.toContain('Explain this project&#x27;s structure')
    expect(html).not.toContain('<button')
  })

  it('keeps the static welcome copy visible in focus mode without restoring the usage panel', () => {
    const html = renderEmptyHero({ focusModeEnabled: true })

    expect(html).toContain('ds-chat-empty-hero')
    expect(html).toContain('What would you like to do with Kun today?')
    expect(html).toContain('Open a terminal and run kun to use the TUI.')
    expect(html).toContain('Settings in the bottom-left, then General → Desktop &amp; system → Terminal')
    expect(html).not.toContain('aria-hidden="true"')
    expect(html).not.toContain('ds-kun-state-')
    expect(html).not.toContain('ds-initial-usage-heatmap')
  })
})

describe('MessageTimelineEmptyHero — runtime offline hero (issue #78)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('uses the waking title when no runtime error is available', () => {
    const html = renderOfflineHero(null)
    expect(html).toContain('Kun is waking the local agent')
    expect(html).not.toContain('Cannot connect to the local runtime')
  })

  it('switches to the error title and surfaces the localized error when a runtime error is provided', () => {
    const portConflict = i18n.t('common:runtimePortConflict')
    const html = renderOfflineHero(portConflict)
    // New error title should appear (so users see the failure immediately)
    expect(html).toContain('Cannot connect to the local runtime')
    // The old "waking" title must NOT appear — that's the bug we're fixing
    expect(html).not.toContain('Kun is waking the local agent')
    // The specific localized port-conflict message should appear in the body
    expect(html).toContain(portConflict)
  })

  it('treats whitespace-only runtimeError as no error', () => {
    const html = renderOfflineHero('   \n  ')
    // Falls back to the generic waking hero
    expect(html).toContain('Kun is waking the local agent')
    expect(html).not.toContain('Cannot connect to the local runtime')
  })

  it('keeps both the retry and open-settings actions visible on the error hero', () => {
    const html = renderOfflineHero(i18n.t('common:runtimePortConflict'))
    expect(html).toContain('Retry')
    expect(html).toContain('Open Settings')
  })

  it('does not render the animated Kun stage while loading or after an error', () => {
    const waking = renderOfflineHero(null)
    expect(waking).not.toContain('ds-runtime-wake-stage')
    expect(waking).not.toContain('is-waking')
    expect(waking).not.toContain('ds-runtime-wake-zzz')
    expect(waking).not.toContain('ds-runtime-wake-sonar')
    expect(waking).not.toContain('ds-runtime-wake-caret')
    expect(waking).not.toContain('ds-kun-state-')

    const errored = renderOfflineHero(i18n.t('common:runtimePortConflict'))
    expect(errored).not.toContain('ds-runtime-wake-stage')
    expect(errored).not.toContain('is-waking')
    expect(errored).not.toContain('ds-runtime-wake-zzz')
    expect(errored).not.toContain('ds-runtime-wake-sonar')
    expect(errored).not.toContain('ds-runtime-wake-caret')
    expect(errored).not.toContain('ds-kun-state-')
  })
})

describe('MessageTimelineEmptyHero — runtime offline hero (issue #78, zh-CN)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN')
  })

  it('uses 正在唤醒 title when no runtime error is available', () => {
    const html = renderOfflineHero(null)
    expect(html).toContain('正在唤醒本地智能体')
    expect(html).not.toContain('无法连接到本地运行时')
  })

  it('switches to 无法连接到本地运行时 title and surfaces the localized port-conflict error', () => {
    const portConflict = i18n.t('common:runtimePortConflict')
    const html = renderOfflineHero(portConflict)
    expect(html).toContain('无法连接到本地运行时')
    expect(html).not.toContain('正在唤醒本地智能体')
    expect(html).toContain(portConflict)
  })

  it('uses the approved text-only init copy when the runtime is ready', () => {
    const html = renderEmptyHero()

    expect(html).toContain('今天想和 Kun 一起做什么？')
    expect(html).toContain('打开终端，输入 kun 即可使用 TUI。')
    expect(html).toContain('左下角「设置」→「通用」→「桌面与系统」→「终端」')
    expect(html).not.toContain('ds-kun-state-')
    expect(html).not.toContain('ds-initial-usage-heatmap')
  })
})
