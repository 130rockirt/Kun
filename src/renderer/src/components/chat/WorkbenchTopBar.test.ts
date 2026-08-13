import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create as createRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { WorkbenchSideRail, WorkbenchTopActions } from './WorkbenchTopBar'
import { ExtensionContributionsSchema } from '@kun/extension-api'
import {
  ContributionRegistry,
  ExtensionWorkbenchSnapshotSchema
} from '../../extensions/contribution-registry'

describe('WorkbenchTopActions', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders restart, editor, terminal, and right workspace actions for the top bar', () => {
    const html = renderToStaticMarkup(
      createElement(WorkbenchTopActions, {
        terminalOpen: false,
        onToggleTerminal: vi.fn(),
        rightWorkspaceExpanded: false,
        onToggleRightWorkspace: vi.fn()
      })
    )

    expect(html).toContain(`data-tooltip="Stop all old Kun runtimes and restart the desktop app"`)
    expect(html).toContain(`aria-label="Restart Kun"`)
    expect(html).toContain('rounded-full bg-amber-500')
    expect(html).toContain(`data-tooltip="Choose default editor"`)
    expect(html).toContain(`aria-label="Choose default editor"`)
    expect(html).toContain(`data-tooltip="Terminal"`)
    expect(html).toContain(`aria-label="Terminal"`)
    expect(html).toContain(`data-tooltip="Toggle right workspace"`)
    expect(html).toContain(`aria-label="Toggle right workspace"`)
    expect(html).not.toContain(`title="Choose default editor"`)
    expect(html).not.toContain(`title="Toggle right workspace"`)
    expect(html.indexOf('data-tooltip="Choose default editor"')).toBeLessThan(
      html.indexOf('data-tooltip="Terminal"')
    )
    expect(html.indexOf('data-tooltip="Terminal"')).toBeLessThan(
      html.indexOf('data-tooltip="Toggle right workspace"')
    )
    expect(html.indexOf('data-tooltip="Toggle right workspace"')).toBeLessThan(
      html.indexOf('aria-label="Restart Kun"')
    )
  })

  it('routes the explicit restart-all action through the preload bridge', async () => {
    const restartAllKunProcesses = vi.fn(async () => ({ accepted: false }))
    vi.stubGlobal('window', { kunGui: { restartAllKunProcesses } })
    let renderer!: ReturnType<typeof createRenderer>

    await act(async () => {
      renderer = createRenderer(createElement(WorkbenchTopActions, {}))
    })
    const button = renderer.root.findByProps({ 'aria-label': 'Restart Kun' })
    await act(async () => {
      button.props.onClick()
      await Promise.resolve()
    })

    expect(restartAllKunProcesses).toHaveBeenCalledOnce()
    act(() => renderer.unmount())
  })

  it('keeps the running badge left of the right-aligned top actions', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const [stageSource, shellCss] = await Promise.all([
      readFile(new URL('../workbench/WorkbenchChatStage.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../styles/base-shell/session-sidebar-shell.css', import.meta.url), 'utf8')
    ])
    const actionsStart = stageSource.indexOf('<div className="chat-topbar-actions')
    const actionsEnd = stageSource.indexOf('</div>', actionsStart)
    const actionsSource = stageSource.slice(actionsStart, actionsEnd)
    const topActionsCss = shellCss.match(/\.ds-workbench-top-actions\s*\{([^}]*)\}/)?.[1] ?? ''

    expect(actionsSource.indexOf("{t('running')}")).toBeLessThan(
      actionsSource.indexOf('<WorkbenchTopActions')
    )
    expect(topActionsCss).not.toContain('margin-right')
  })
})

describe('WorkbenchSideRail', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders visible tooltip labels for right rail icon buttons', () => {
    const registry = new ContributionRegistry()
    registry.replaceExtensions(ExtensionWorkbenchSnapshotSchema.parse({
      schemaVersion: 1,
      revision: 1,
      extensions: [{
        id: 'acme.issues',
        version: '1.0.0',
        workspaceTrusted: true,
        grantedPermissions: ['ui.views', 'webview'],
        contributes: ExtensionContributionsSchema.parse({
          'views.rightSidebar': [{
            id: 'issues',
            title: 'Issues',
            entry: 'dist/index.html',
            icon: 'assets/issues.svg',
            order: 20
          }, {
            id: 'summary',
            title: 'Summary',
            entry: 'dist/summary.html',
            order: 10
          }],
          'views.fullPage': [{
            id: 'dashboard',
            title: 'Dashboard',
            entry: 'dist/dashboard.html'
          }]
        })
      }]
    }))
    const html = renderToStaticMarkup(
      createElement(WorkbenchSideRail, {
        rightPanelMode: 'extension:acme.issues/issues',
        onToggleRightPanelMode: vi.fn(),
        planPanelEnabled: true,
        canvasEnabled: true,
        graphEnabled: false,
        sideChatRunningCount: 0,
        sideChatOpen: false,
        sideChatEnabled: true,
        fileTreeOpen: false,
        fileTreeEnabled: true,
        onToggleFileTree: vi.fn(),
        onOpenSideChat: vi.fn(),
        extensionItems: registry.list('views.rightSidebar').filter((item) => item.owner.kind === 'extension')
      })
    )

    for (const label of [
      'Open branch conversation',
      'Agent Perspective',
      'Plan',
      'Changes',
      'Preview',
      'Whiteboard',
      'Subagents',
      'Files'
    ]) {
      expect(html).toContain(`data-tooltip="${label}"`)
      expect(html).toContain(`aria-label="${label}"`)
      expect(html).not.toContain(`title="${label}"`)
    }

    expect(html).not.toContain('data-tooltip="Todo"')
    expect(html).not.toContain('data-tooltip="Graph"')

    expect(html).toContain('data-tooltip="Usage &amp; quota"')
    expect(html).toContain('aria-label="Usage &amp; quota"')
    expect(html).toContain('data-tooltip="Issues"')
    expect(html).toContain('data-tooltip="MCP &amp; Skills"')
    expect(html).toContain('aria-label="MCP &amp; Skills"')
    expect(html).toContain('data-contribution-id="extension:acme.issues/issues"')
    expect(html).toContain(
      'src="kun-extension://acme.issues/assets/issues.svg?kunHostResource=icon"'
    )
    expect(html).toContain('data-tooltip="Summary"')
    expect(html).toContain('data-contribution-id="extension:acme.issues/summary"')
    expect(html.indexOf('data-contribution-id="extension:acme.issues/summary"')).toBeLessThan(
      html.indexOf('data-contribution-id="extension:acme.issues/issues"')
    )
    expect(html.indexOf('data-tooltip="MCP &amp; Skills"')).toBeLessThan(
      html.indexOf('data-tooltip="Usage &amp; quota"')
    )
    expect(html.indexOf('data-tooltip="Usage &amp; quota"')).toBeLessThan(
      html.indexOf('data-contribution-id="extension:acme.issues/summary"')
    )
    expect(html.indexOf('data-tooltip="MCP &amp; Skills"')).toBeLessThan(
      html.indexOf('data-tooltip="Files"')
    )
    expect(html.indexOf('data-tooltip="Files"')).toBeLessThan(
      html.indexOf('data-contribution-id="extension:acme.issues/summary"')
    )
    expect(html).toContain('ds-extension-side-rail-group')
    expect(html).not.toContain('data-tooltip="Extension Views"')
    expect(html).not.toContain('aria-label="Open extension Views"')
    expect(html).not.toContain('data-contribution-id="extension:acme.issues/dashboard"')

    expect(html).not.toContain(`data-tooltip="Choose default editor"`)
    expect(html).not.toContain(`data-tooltip="Terminal"`)

    expect(html.match(/ds-side-rail-button/g)?.length).toBeGreaterThanOrEqual(8)
  })

  it('shows the Graph launcher only after Graph is enabled', () => {
    const disabledHtml = renderToStaticMarkup(createElement(WorkbenchSideRail, {
      rightPanelMode: null,
      onToggleRightPanelMode: vi.fn(),
      graphEnabled: false
    }))
    const enabledHtml = renderToStaticMarkup(createElement(WorkbenchSideRail, {
      rightPanelMode: null,
      onToggleRightPanelMode: vi.fn(),
      graphEnabled: true
    }))

    expect(disabledHtml).not.toContain('data-tooltip="Graph"')
    expect(enabledHtml).toContain('data-tooltip="Graph"')
  })

  it('disables Agent Perspective until a Code conversation is selected', () => {
    let renderer!: ReturnType<typeof createRenderer>
    act(() => {
      renderer = createRenderer(createElement(WorkbenchSideRail, {
        rightPanelMode: null,
        onToggleRightPanelMode: vi.fn(),
        agentPerspectiveEnabled: false
      }))
    })
    const button = renderer.root.findByProps({ 'aria-label': 'Agent Perspective' })
    expect(button.props.disabled).toBe(true)
    act(() => renderer.unmount())
  })

  it('keeps the branch rail launcher free of a numeric count badge', () => {
    let renderer!: ReturnType<typeof createRenderer>
    act(() => {
      renderer = createRenderer(createElement(WorkbenchSideRail, {
        rightPanelMode: null,
        onToggleRightPanelMode: vi.fn(),
        onOpenSideChat: vi.fn(),
        sideChatRunningCount: 0
      }))
    })

    const button = renderer.root.findByProps({ 'aria-label': 'Open branch conversation' })
    expect(button.findAllByType('span')).toHaveLength(0)
    act(() => renderer.unmount())
  })

  it('routes an untrusted rail launcher to permission review without opening a panel', () => {
    const registry = new ContributionRegistry()
    registry.replaceExtensions(ExtensionWorkbenchSnapshotSchema.parse({
      schemaVersion: 1,
      revision: 1,
      extensions: [{
        id: 'acme.review',
        version: '1.0.0',
        workspaceTrusted: false,
        grantedPermissions: [],
        contributes: ExtensionContributionsSchema.parse({}),
        rightRailDiscovery: {
          views: [{ id: 'review', title: 'Review me', order: 20 }],
          containers: []
        }
      }]
    }))
    const entry = registry.listRightRailViewEntries()[0]!
    const onSelectExtension = vi.fn()
    const onToggleRightPanelMode = vi.fn()
    let renderer!: ReturnType<typeof createRenderer>
    act(() => {
      renderer = createRenderer(createElement(WorkbenchSideRail, {
        rightPanelMode: null,
        onToggleRightPanelMode,
        extensionItems: [entry],
        onSelectExtension
      }))
    })
    const button = renderer.root.find((node) =>
      node.type === 'button' &&
      node.props['data-contribution-id'] === 'extension:acme.review/review')
    expect(button.props['data-extension-trusted']).toBe('false')
    expect(button.props['aria-label']).toBe('Review permissions to open Review me')
    act(() => button.props.onClick())
    expect(onSelectExtension).toHaveBeenCalledWith(entry)
    expect(onToggleRightPanelMode).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })
})
