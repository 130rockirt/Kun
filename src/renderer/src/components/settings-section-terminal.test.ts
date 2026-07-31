import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { defaultTerminalColors } from '@shared/app-settings'
import { TerminalSettingsSection } from './settings-section-terminal'

describe('TerminalSettingsSection', () => {
  it('keeps the kun command and terminal appearance settings together', () => {
    const html = renderToStaticMarkup(createElement(TerminalSettingsSection, {
      ctx: {
        t: (key: string) => key,
        form: {
          locale: 'zh-CN',
          terminal: { colors: defaultTerminalColors() }
        },
        update: () => undefined,
        selectControlClass: 'select'
      }
    }))

    expect(html).toContain('终端命令')
    expect(html).toContain('TUI 已随 Kun 桌面应用提供')
    expect(html).toContain('sectionTerminal')
    expect(html).toContain('terminalColorMode')
  })
})
