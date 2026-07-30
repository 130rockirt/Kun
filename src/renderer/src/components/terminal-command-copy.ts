import type { CliInstallState } from '@shared/cli-install'

export type TerminalCommandCopy = {
  stateLabel: string
  description: string
  primaryAction: string
  removeAction: string
}

export function terminalCommandCopy(
  locale: string,
  state: CliInstallState | undefined
): TerminalCommandCopy {
  const zh = locale.toLowerCase().startsWith('zh')
  const stateLabel = state === 'installed'
    ? (zh ? '已启用' : 'Enabled')
    : state === 'stale'
      ? (zh ? '需要修复' : 'Needs repair')
      : state === 'conflict'
        ? (zh ? '存在冲突' : 'Conflict')
        : (zh ? '未启用' : 'Not enabled')

  return {
    stateLabel,
    description: zh
      ? `TUI 已随 Kun 桌面应用提供。启用终端命令后，可在新终端中输入 kun 启动。当前状态：${stateLabel}`
      : `The TUI is included with the Kun desktop app. Enable the terminal command to launch it by running kun in a new terminal. Current status: ${stateLabel}`,
    primaryAction: state === 'stale'
      ? (zh ? '修复命令' : 'Repair command')
      : (zh ? '启用命令' : 'Enable command'),
    removeAction: zh ? '移除命令' : 'Remove command'
  }
}
