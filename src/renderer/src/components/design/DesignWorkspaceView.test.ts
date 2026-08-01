import { describe, expect, it } from 'vitest'
import { designWorkspaceStageMode } from './DesignWorkspaceView'

describe('DesignWorkspaceView stage mode', () => {
  it('keeps a stable loading surface until design data is ready', () => {
    expect(designWorkspaceStageMode({
      settingsLoaded: false,
      drawingCreationOpen: false,
      drawingCreationSubmitting: false,
      documentCount: 0,
      activeDocumentId: null
    })).toBe('loading')
  })

  it('shows the drawing launcher for a fresh workspace or explicit new drawing', () => {
    expect(designWorkspaceStageMode({
      settingsLoaded: true,
      drawingCreationOpen: false,
      drawingCreationSubmitting: false,
      documentCount: 0,
      activeDocumentId: null
    })).toBe('start')
    expect(designWorkspaceStageMode({
      settingsLoaded: true,
      drawingCreationOpen: true,
      drawingCreationSubmitting: false,
      documentCount: 1,
      activeDocumentId: null
    })).toBe('start')
  })

  it('switches immediately to a stable canvas preparation surface after submit', () => {
    expect(designWorkspaceStageMode({
      settingsLoaded: true,
      drawingCreationOpen: true,
      drawingCreationSubmitting: true,
      documentCount: 1,
      activeDocumentId: 'doc_pending'
    })).toBe('submitting')
  })

  it('mounts the canvas only for a committed active drawing', () => {
    expect(designWorkspaceStageMode({
      settingsLoaded: true,
      drawingCreationOpen: false,
      drawingCreationSubmitting: false,
      documentCount: 1,
      activeDocumentId: 'doc_1'
    })).toBe('canvas')
  })
})
