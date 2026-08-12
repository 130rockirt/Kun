import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WriteWorkspaceToolbar } from './WriteWorkspaceToolbar'

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key })
}))

const noop = (): void => undefined

describe('WriteWorkspaceToolbar code preview', () => {
  it('shows read-only source status without writing or export controls', () => {
    const html = renderToStaticMarkup(createElement(WriteWorkspaceToolbar, {
      embedded: true,
      showSidebarToggle: false,
      activeFileIsImage: false,
      activeFileIsPdf: false,
      activeFileIsOffice: false,
      activeFileIsCode: true,
      activeFileIsText: false,
      activeFileLabel: 'src/main.ts',
      activeFileName: 'main.ts',
      activeFilePath: '/repo/src/main.ts',
      documentStatsLabel: null,
      inlineCompletionEnabled: false,
      exportInFlight: false,
      exportMenuOpen: false,
      exportMenuRef: createRef<HTMLDivElement>(),
      leftSidebarCollapsed: false,
      liveModeActive: false,
      modeMenuItems: [],
      modeMenuOpen: false,
      modeMenuRef: createRef<HTMLDivElement>(),
      onCopyRichText: noop,
      onExportFile: noop,
      onGeneratePresentation: noop,
      onSave: noop,
      onToggleInlineCompletion: noop,
      onToggleLeftSidebar: noop,
      previewMode: 'source',
      presentationEnabled: false,
      presentationInFlight: false,
      readOnly: true,
      saveLabel: 'writeSaved',
      saveStatus: 'saved',
      setExportMenuOpen: noop,
      setModeMenuOpen: noop,
      setPreviewMode: noop
    }))

    expect(html).toContain('writeModeSource')
    expect(html).toContain('writeReadOnly')
    expect(html).not.toContain('writeSaveFile')
    expect(html).not.toContain('writeExport')
    expect(html).not.toContain('writeInlineCompletion')
  })
})
