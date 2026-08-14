import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import i18n from '../../i18n'
import { ThreadHydrationLoading } from './ThreadHydrationLoading'

describe('ThreadHydrationLoading', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders an accessible full-area loading status', async () => {
    await i18n.changeLanguage('en')
    const html = renderToStaticMarkup(createElement(ThreadHydrationLoading))

    expect(html).toContain('data-testid="thread-hydration-loading"')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('absolute inset-0')
    expect(html).toContain('Loading conversation…')
    expect(html).toContain('Reading messages and restoring the latest conversation state.')
  })

  it('uses the Chinese loading copy', async () => {
    await i18n.changeLanguage('zh')
    const html = renderToStaticMarkup(createElement(ThreadHydrationLoading))

    expect(html).toContain('正在加载会话…')
    expect(html).toContain('正在读取消息并恢复最新会话状态，请稍候。')
  })
})
