import { describe, expect, it, vi } from 'vitest'
import {
  isLowRiskAutomaticAction,
  type BrowserTarget
} from './browser-use-manager-support'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  WebContentsView: class {}
}))

function target(role: string, name: string): BrowserTarget {
  return {
    ref: 'opaque-ref',
    tabId: 'tab-1',
    documentGeneration: 1,
    backendNodeId: 7,
    role,
    name,
    sensitive: false,
    disabled: false,
    rect: { x: 10, y: 10, width: 100, height: 40 },
    fingerprint: 'fingerprint'
  }
}

describe('Browser Use automatic interaction classification', () => {
  it('never treats a target-focused key press as an automatic interaction', () => {
    expect(isLowRiskAutomaticAction(
      { action: 'press', key: 'Escape' } as never,
      target('button', 'Continue')
    )).toBe(false)
  })

  it.each([
    ['link', 'Account'],
    ['link', ''],
    ['tab', 'Billing'],
    ['tab', '   ']
  ])('requires consent for an unallowlisted %s named %j', (role, name) => {
    expect(isLowRiskAutomaticAction(
      { action: 'click' } as never,
      target(role, name)
    )).toBe(false)
  })

  it.each([
    ['button', 'Expand'],
    ['tab', 'Show more']
  ])('retains the narrow non-empty page-control allowlist for %s %j', (role, name) => {
    expect(isLowRiskAutomaticAction(
      { action: 'click' } as never,
      target(role, name)
    )).toBe(true)
  })

  it.each([
    ['link', 'Learn more'],
    ['checkbox', 'Close'],
    ['radio', 'Dismiss'],
    ['button', 'Close'],
    ['button', 'Dismiss'],
    ['button', 'Cancel'],
    ['button', 'Next page']
  ])('requires consent outside the narrow page-control allowlist for %s %j', (role, name) => {
    expect(isLowRiskAutomaticAction(
      { action: 'click' } as never,
      target(role, name)
    )).toBe(false)
  })
})
