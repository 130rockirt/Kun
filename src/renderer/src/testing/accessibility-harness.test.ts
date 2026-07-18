import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RuntimeBanner } from '../components/RuntimeBanner'
import { auditStaticMarkup } from './accessibility-harness'

describe('structured accessibility harness', () => {
  it('accepts structured names, labels, and modal dialog semantics', () => {
    expect(auditStaticMarkup(`
      <button aria-label="Save > close"><span aria-hidden="true">x</span></button>
      <label for="email">Email <strong>address</strong></label><input id="email">
      <label>Notes <textarea></textarea></label>
      <div role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">Settings</h2>
      </div>
      <div role="button" tabindex="0">Open details</div>
    `)).toEqual([])
  })

  it('reports every missing aria-labelledby target before using it as a name', () => {
    const issues = auditStaticMarkup(`
      <span id="save-label">Save</span>
      <button aria-labelledby="save-label missing-label"></button>
      <input aria-labelledby="">
    `)

    expect(issues).toContainEqual(expect.objectContaining({
      rule: 'aria-labelledby-reference',
      element: '<button>',
      message: expect.stringContaining('missing-label')
    }))
    expect(issues).toContainEqual(expect.objectContaining({
      rule: 'aria-labelledby-reference',
      element: '<input>',
      message: expect.stringContaining('(empty)')
    }))
    expect(issues.map((issue) => issue.rule)).toContain('interactive-name')
    expect(issues.map((issue) => issue.rule)).toContain('form-label')
  })

  it('requires keyboard semantics for role buttons and roles for custom focus targets', () => {
    const issues = auditStaticMarkup(`
      <div role="button">Open</div>
      <div tabindex="0">Focusable custom control</div>
      <button>Native control</button>
    `)

    expect(issues.filter((issue) => issue.rule === 'interactive-semantics')).toEqual([
      expect.objectContaining({ element: '<div>', message: expect.stringContaining('tabindex="0"') }),
      expect.objectContaining({ element: '<div>', message: expect.stringContaining('interactive role') })
    ])
  })

  it('detects duplicate ids and ignores hidden implementation details', () => {
    const issues = auditStaticMarkup(`
      <span id="same"></span><span id="same"></span>
      <div aria-hidden="true"><button></button><input></div>
      <input type="hidden">
    `)

    expect(issues).toEqual([
      expect.objectContaining({ rule: 'duplicate-id', message: 'duplicate id: same' })
    ])
  })

  it('audits server-rendered production component markup', () => {
    const markup = renderToStaticMarkup(createElement(RuntimeBanner, {
      message: 'Runtime unavailable',
      detail: 'Connection failed',
      code: 'CONNECTION_FAILED',
      onOpenSettings: () => undefined,
      onRetryConnection: () => undefined,
      runtimeReady: false,
      stageInsetClass: '',
      t: (key: string) => key
    }))

    expect(auditStaticMarkup(markup)).toEqual([])
  })
})
