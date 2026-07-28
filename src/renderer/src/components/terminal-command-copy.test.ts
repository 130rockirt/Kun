import { describe, expect, it } from 'vitest'
import { terminalCommandCopy } from './terminal-command-copy'

describe('terminalCommandCopy', () => {
  it('explains in Chinese that the TUI is bundled and enables only the command', () => {
    expect(terminalCommandCopy('zh-CN', 'not-installed')).toEqual({
      stateLabel: '未启用',
      description: 'TUI 已随 Kun 桌面应用提供。启用终端命令后，可在新终端中输入 kun 启动。当前状态：未启用',
      primaryAction: '启用命令',
      removeAction: '移除命令'
    })
  })

  it('uses repair terminology for a stale English command', () => {
    expect(terminalCommandCopy('en', 'stale')).toEqual({
      stateLabel: 'Needs repair',
      description: 'The TUI is included with the Kun desktop app. Enable the terminal command to launch it by running kun in a new terminal. Current status: Needs repair',
      primaryAction: 'Repair command',
      removeAction: 'Remove command'
    })
  })
})
