import { describe, expect, it } from 'vitest'
import { imagePreviewDisplaySize, imagePreviewStageStyle } from './ImagePreviewLightbox'

describe('ImagePreviewLightbox', () => {
  const portrait = { width: 1_000, height: 2_000 }
  const viewport = { width: 816, height: 616 }

  it('fits the complete portrait image inside the viewport at 100%', () => {
    expect(imagePreviewDisplaySize(portrait, viewport, 1)).toEqual({
      width: 300,
      height: 600
    })
  })

  it('makes zoom controls resize the fitted image in both directions', () => {
    expect(imagePreviewDisplaySize(portrait, viewport, 0.75)).toEqual({
      width: 225,
      height: 450
    })
    expect(imagePreviewDisplaySize(portrait, viewport, 1.25)).toEqual({
      width: 375,
      height: 750
    })
  })

  it('clamps zoom sizing to the supported min and max bounds', () => {
    expect(imagePreviewDisplaySize(portrait, viewport, 0.1)).toEqual({
      width: 75,
      height: 150
    })
    expect(imagePreviewDisplaySize(portrait, viewport, 9)).toEqual({
      width: 900,
      height: 1_800
    })
  })

  it('sizes the stage from the image plus padding instead of copying the viewport', () => {
    expect(imagePreviewStageStyle({ width: 375, height: 750 })).toEqual({
      minWidth: '100%',
      minHeight: '100%',
      width: '391px',
      height: '766px'
    })
    expect(imagePreviewStageStyle(null)).toEqual({
      minWidth: '100%',
      minHeight: '100%'
    })
  })

  it('does not create horizontal overflow when a portrait image only needs vertical scrolling', () => {
    const imageSize = imagePreviewDisplaySize(portrait, viewport, 1.25)
    const stageStyle = imagePreviewStageStyle(imageSize)

    expect(imageSize).toEqual({ width: 375, height: 750 })
    expect(Number.parseFloat(String(stageStyle.width))).toBeLessThan(viewport.width)
    expect(Number.parseFloat(String(stageStyle.height))).toBeGreaterThan(viewport.height)
    expect(stageStyle.minWidth).toBe('100%')
  })

  it('keeps small images at their natural size until the user zooms in', () => {
    expect(imagePreviewDisplaySize({ width: 200, height: 100 }, viewport, 1)).toEqual({
      width: 200,
      height: 100
    })
    expect(imagePreviewDisplaySize({ width: 200, height: 100 }, viewport, 2)).toEqual({
      width: 400,
      height: 200
    })
  })
})
