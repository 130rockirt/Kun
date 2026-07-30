import { describe, expect, it } from 'vitest'
import {
  CODE_PANEL_PREFERRED,
  captureResizePointer,
  fitWorkbenchWidths,
  GRAPH_PANEL_PREFERRED,
  initialCodeRightTabsForLaunch,
  normalizeStoredCodeRightWidthsRegistry,
  PANEL_RESIZE_HANDLE_WIDTH,
  RAIL_WIDTH,
  transientRightPanelModeForWorkspaceChange,
  WORKBENCH_RESIZE_CLASS,
  workbenchWidthConstraintsForRightPanel
} from './workbench-layout'
import { BUILTIN_RIGHT_PANEL_IDS } from '../extensions/contribution-ids'

describe('fitWorkbenchWidths', () => {
  it('lets ordinary Code tabs use the available workspace width', () => {
    const next = fitWorkbenchWidths(
      1800,
      304,
      1400,
      { leftPanelVisible: true, rightPanelVisible: true },
      workbenchWidthConstraintsForRightPanel('chat', BUILTIN_RIGHT_PANEL_IDS.browser)
    )

    expect(next.left).toBe(304)
    expect(next.right).toBe(870)
  })

  it('uses the same wide workspace constraints for the code canvas', () => {
    const next = fitWorkbenchWidths(
      1800,
      304,
      1400,
      { leftPanelVisible: true, rightPanelVisible: true },
      workbenchWidthConstraintsForRightPanel('chat', BUILTIN_RIGHT_PANEL_IDS.canvas)
    )

    expect(next.left).toBe(304)
    expect(next.right).toBeGreaterThan(760)
    expect(next.right).toBe(870)
  })

  it.each([1280, 1440, 2048])(
    'keeps at least 560px for chat at a %dpx workbench width',
    (containerWidth) => {
      const next = fitWorkbenchWidths(
        containerWidth,
        304,
        560,
        { leftPanelVisible: true, rightPanelVisible: true },
        workbenchWidthConstraintsForRightPanel('chat', BUILTIN_RIGHT_PANEL_IDS.files)
      )
      const handleWidth = PANEL_RESIZE_HANDLE_WIDTH * 2
      expect(containerWidth - handleWidth - RAIL_WIDTH - next.left - next.right).toBeGreaterThanOrEqual(560)
      expect(next.right).toBeGreaterThanOrEqual(280)
    }
  )
})

describe('code right workspace widths', () => {
  it('opens Graph with a wider preferred workspace than ordinary code tabs', () => {
    expect(GRAPH_PANEL_PREFERRED).toBeGreaterThan(CODE_PANEL_PREFERRED)
  })

  it('normalizes isolated workspace widths and ignores invalid entries', () => {
    expect(normalizeStoredCodeRightWidthsRegistry({
      version: 1,
      workspaces: { alpha: 640.4, beta: 'wide', gamma: 120 }
    })).toEqual({
      version: 1,
      workspaces: { alpha: 640, gamma: 280 }
    })
    expect(normalizeStoredCodeRightWidthsRegistry({ version: 2 })).toEqual({
      version: 1,
      workspaces: {}
    })
  })
})

describe('code right workspace startup', () => {
  it('keeps restored tabs but starts with the sidebar collapsed', () => {
    const restored = initialCodeRightTabsForLaunch({
      version: 1,
      tabs: [BUILTIN_RIGHT_PANEL_IDS.browser],
      activeId: BUILTIN_RIGHT_PANEL_IDS.browser,
      expanded: true
    }, null)

    expect(restored).toEqual({
      version: 1,
      tabs: [BUILTIN_RIGHT_PANEL_IDS.browser],
      activeId: BUILTIN_RIGHT_PANEL_IDS.browser,
      expanded: false
    })
  })

  it('does not expand a migrated legacy panel on launch', () => {
    expect(initialCodeRightTabsForLaunch(undefined, BUILTIN_RIGHT_PANEL_IDS.files)).toEqual({
      version: 1,
      tabs: [BUILTIN_RIGHT_PANEL_IDS.files],
      activeId: BUILTIN_RIGHT_PANEL_IDS.files,
      expanded: false
    })
  })
})

describe('transient right panel workspace changes', () => {
  it('keeps Requirement AI open while its first thread changes the workspace scope', () => {
    expect(
      transientRightPanelModeForWorkspaceChange(BUILTIN_RIGHT_PANEL_IDS.sddAi)
    ).toBe(BUILTIN_RIGHT_PANEL_IDS.sddAi)
  })

  it('clears other transient panel modes on a workspace scope change', () => {
    expect(
      transientRightPanelModeForWorkspaceChange(BUILTIN_RIGHT_PANEL_IDS.browser)
    ).toBeNull()
    expect(transientRightPanelModeForWorkspaceChange(null)).toBeNull()
  })
})

describe('captureResizePointer', () => {
  it('keeps a divider drag in the Host while the pointer crosses an embedded Webview', () => {
    let capturedPointer: number | null = null
    const target = {
      setPointerCapture(pointerId: number) {
        capturedPointer = pointerId
      },
      hasPointerCapture(pointerId: number) {
        return capturedPointer === pointerId
      },
      releasePointerCapture(pointerId: number) {
        if (capturedPointer === pointerId) capturedPointer = null
      }
    }

    const release = captureResizePointer(target, 17)
    expect(capturedPointer).toBe(17)

    release()
    expect(capturedPointer).toBeNull()
    expect(WORKBENCH_RESIZE_CLASS).toBe('ds-workbench-resizing')
  })
})
