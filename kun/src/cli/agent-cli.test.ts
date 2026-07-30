import { describe, expect, it } from 'vitest'
import { KUN_CLI_USAGE, splitKunCliCommand } from './agent-cli.js'

describe('Kun CLI TUI dispatch', () => {
  it('uses the TUI by default and requires explicit serve mode', () => {
    expect(splitKunCliCommand([])).toEqual({ command: 'tui', args: [] })
    expect(splitKunCliCommand(['tui', '--continue'])).toEqual({ command: 'tui', args: ['--continue'] })
    expect(splitKunCliCommand(['chat'])).toEqual({ command: 'chat', args: [] })
    expect(splitKunCliCommand(['--continue'])).toEqual({ command: 'tui', args: ['--continue'] })
    expect(splitKunCliCommand(['--graph', 'implement the board'])).toEqual({
      command: 'tui',
      args: ['--graph', 'implement the board']
    })
    expect(splitKunCliCommand(['-graph', 'implement the board'])).toEqual({
      command: 'tui',
      args: ['-graph', 'implement the board']
    })
    expect(splitKunCliCommand(['serve', '--port', '18899'])).toEqual({ command: 'serve', args: ['--port', '18899'] })
    expect(splitKunCliCommand(['runtime', 'status'])).toEqual({ command: 'runtime', args: ['status'] })
    expect(splitKunCliCommand(['update', '--check'])).toEqual({ command: 'update', args: ['--check'] })
    expect(KUN_CLI_USAGE).toContain('tui [options]')
    expect(KUN_CLI_USAGE).toContain('update [--check|--yes]')
  })
})
