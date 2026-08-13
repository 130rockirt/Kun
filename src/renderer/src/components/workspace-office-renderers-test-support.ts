import { vi } from 'vitest'

export type MockPptxPreviewer = {
  host: HTMLElement
  slideCount: number
  load: ReturnType<typeof vi.fn>
  renderSingleSlide: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

export function createMockPptxPreviewer(
  host: HTMLElement,
  slideCount: number,
  previewError?: Error
): MockPptxPreviewer {
  const wrapper = document.createElement('div')
  wrapper.className = 'pptx-preview-wrapper'
  host.append(wrapper)
  const renderSlide = (slideIndex: number): void => {
    wrapper.querySelector('.pptx-preview-slide-wrapper')?.remove()
    const slide = document.createElement('div')
    slide.className = `pptx-preview-slide-wrapper pptx-preview-slide-wrapper-${slideIndex}`
    const anchor = document.createElement('a')
    anchor.href = `https://example.test/slide-${slideIndex + 1}`
    anchor.target = '_blank'
    anchor.setAttribute('ping', 'https://example.test/ping')
    anchor.textContent = `Slide ${slideIndex + 1}`
    slide.append(anchor)
    wrapper.append(slide)
  }
  return {
    host,
    slideCount,
    load: vi.fn(async () => {
      if (previewError) throw previewError
      const master = { background: { type: 'none' } }
      const layout = { background: { type: 'none' }, slideMaster: master }
      return {
        slides: Array.from({ length: slideCount }, () => ({
          background: { type: 'none' },
          slideLayout: layout
        }))
      }
    }),
    renderSingleSlide: vi.fn(renderSlide),
    destroy: vi.fn()
  }
}
