import { describe, expect, it } from 'vitest'
import { parseTuiKeymapConfig } from './keymap.js'

describe('TuiKeymap', () => {
  it('uses OpenCode-compatible navigation plus Kimi-aligned direct-action defaults', () => {
    const { keymap, warnings } = parseTuiKeymapConfig({})

    expect(warnings).toEqual([])
    expect(keymap.matchesLeader('\x18')).toBe(true)
    expect(keymap.leaderAction('l')).toBe('session_list')
    expect(keymap.matches('variant_cycle', '\x14')).toBe(true)
    expect(keymap.matches('tool_details_toggle', '\x0f')).toBe(true)
    expect(keymap.matches('subagent_detach', '\x02')).toBe(true)
    expect(keymap.matches('input_editor', '\x07')).toBe(true)
    expect(keymap.matches('input_steer', '\x13')).toBe(true)
    expect(keymap.matches('input_paste', '\x16')).toBe(true)
    expect(keymap.matches('input_paste', '\x1bv')).toBe(true)
    expect(keymap.matches('input_paste', '\x1b[118;6u')).toBe(true)
    expect(keymap.matches('input_paste', '\x1b[118;9u')).toBe(true)
    expect(keymap.leaderAction('v')).toBe('input_paste')
    expect(keymap.leaderAction('p')).toBe('pointer_mode_toggle')
    expect(keymap.leaderTimeoutMs).toBe(2_000)
  })

  it('expands a configured leader and supports arrays and comma alternatives', () => {
    const { keymap } = parseTuiKeymapConfig({
      leader_timeout: 750,
      keybinds: {
        leader: 'ctrl+g',
        session_list: '<leader>s',
        variant_cycle: ['ctrl+t', 'f3'],
        command_list: 'ctrl+p,f4'
      }
    })

    expect(keymap.matchesLeader('\x07')).toBe(true)
    expect(keymap.leaderAction('s')).toBe('session_list')
    expect(keymap.matches('variant_cycle', '\x14')).toBe(true)
    expect(keymap.matches('variant_cycle', '\x1bOR')).toBe(true)
    expect(keymap.matches('command_list', '\x10')).toBe(true)
    expect(keymap.leaderTimeoutMs).toBe(750)
  })

  it('allows bindings and the leader to be disabled', () => {
    const { keymap } = parseTuiKeymapConfig({
      keybinds: { leader: false, variant_cycle: 'none', command_list: false }
    })

    expect(keymap.matchesLeader('\x18')).toBe(false)
    expect(keymap.leaderAction('l')).toBeUndefined()
    expect(keymap.matches('variant_cycle', '\x14')).toBe(false)
    expect(keymap.matches('command_list', '\x10')).toBe(false)
  })

  it('accepts advanced bindings and reports invalid/unavailable configuration', () => {
    const { keymap, warnings } = parseTuiKeymapConfig({
      leader_timeout: 5,
      keybinds: {
        variant_cycle: { key: 'f4', event: 'press', preventDefault: false, fallthrough: true },
        session_list: 'not-a-key',
        sidebar_toggle: '<leader>b',
        made_up_action: 'ctrl+k'
      }
    })

    expect(keymap.matches('variant_cycle', '\x1bOS')).toBe(true)
    expect(keymap.match('variant_cycle', '\x1bOS')).toMatchObject({
      event: 'press', preventDefault: false, fallthrough: true
    })
    expect(keymap.matches('session_list', 'not-a-key')).toBe(false)
    expect(warnings.join('\n')).toMatch(/leader_timeout/)
    expect(keymap.leaderAction('b')).toBe('sidebar_toggle')
    expect(warnings.join('\n')).toMatch(/made_up_action.*ignored/)
  })
})
