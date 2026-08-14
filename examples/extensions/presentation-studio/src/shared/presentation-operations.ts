import { applyEditableElementCss } from './presentation-css.js'
import {
  PresentationOperationError,
  type ApplyPresentationOperationsResult,
  type PresentationDocumentPatch,
  type PresentationOperation,
  type PresentationProject,
  type PresentationSlide,
  type PresentationSlidePatch,
  type PresentationTheme
} from './presentation-model.js'
import {
  collectWarnings,
  normalizePresentationProject,
  parsePresentationOperations
} from './presentation-parser.js'

function findSlide(project: PresentationProject, slideId: string, operationIndex: number): PresentationSlide {
  const slide = project.slides.find((candidate) => candidate.id === slideId)
  if (!slide) throw new PresentationOperationError(`Slide not found: ${slideId}`, operationIndex)
  return slide
}

function addChanged(changedIds: string[], ...ids: string[]): void {
  for (const id of ids) if (!changedIds.includes(id)) changedIds.push(id)
}

export function applyPresentationOperations(
  source: PresentationProject,
  inputOperations: readonly PresentationOperation[]
): ApplyPresentationOperationsResult {
  const operations = parsePresentationOperations(inputOperations)
  let project = normalizePresentationProject(source)
  const changedIds: string[] = []
  const inverseOperations: PresentationOperation[] = []

  operations.forEach((operation, operationIndex) => {
    try {
      switch (operation.kind) {
        case 'document.update': {
          const inversePatch: PresentationDocumentPatch = {}
          if (operation.patch.title !== undefined) {
            inversePatch.title = project.title
            project.title = operation.patch.title
          }
          if (operation.patch.theme !== undefined) {
            inversePatch.theme = {}
            for (const key of Object.keys(operation.patch.theme) as Array<keyof PresentationTheme>) {
              ;(inversePatch.theme as Record<string, unknown>)[key] = project.theme[key]
            }
            project.theme = { ...project.theme, ...operation.patch.theme }
          }
          inverseOperations.unshift({ kind: 'document.update', patch: inversePatch })
          addChanged(changedIds, project.id)
          break
        }
        case 'slide.insert': {
          const index = operation.index ?? project.slides.length
          if (index > project.slides.length) {
            throw new PresentationOperationError('Slide insert index is out of range', operationIndex)
          }
          project.slides.splice(index, 0, operation.slide)
          inverseOperations.unshift({ kind: 'slide.delete', slideId: operation.slide.id })
          addChanged(changedIds, operation.slide.id, ...operation.slide.elements.map((element) => element.id))
          break
        }
        case 'slide.update': {
          const slide = findSlide(project, operation.slideId, operationIndex)
          const inversePatch: PresentationSlidePatch = {}
          if (operation.patch.title !== undefined) {
            inversePatch.title = slide.title
            slide.title = operation.patch.title
          }
          if (operation.patch.backgroundColor !== undefined) {
            inversePatch.backgroundColor = slide.backgroundColor
            slide.backgroundColor = operation.patch.backgroundColor
          }
          inverseOperations.unshift({ kind: 'slide.update', slideId: slide.id, patch: inversePatch })
          addChanged(changedIds, slide.id)
          break
        }
        case 'slide.delete': {
          if (project.slides.length === 1) {
            throw new PresentationOperationError('Cannot delete the last slide', operationIndex)
          }
          const index = project.slides.findIndex((slide) => slide.id === operation.slideId)
          if (index < 0) throw new PresentationOperationError(`Slide not found: ${operation.slideId}`, operationIndex)
          const [slide] = project.slides.splice(index, 1)
          inverseOperations.unshift({ kind: 'slide.insert', slide, index })
          addChanged(changedIds, slide.id, ...slide.elements.map((element) => element.id))
          break
        }
        case 'slide.reorder': {
          const index = project.slides.findIndex((slide) => slide.id === operation.slideId)
          if (index < 0) throw new PresentationOperationError(`Slide not found: ${operation.slideId}`, operationIndex)
          if (operation.index >= project.slides.length) {
            throw new PresentationOperationError('Slide reorder index is out of range', operationIndex)
          }
          const [slide] = project.slides.splice(index, 1)
          project.slides.splice(operation.index, 0, slide)
          inverseOperations.unshift({ kind: 'slide.reorder', slideId: slide.id, index })
          addChanged(changedIds, slide.id)
          break
        }
        case 'element.upsert': {
          const slide = findSlide(project, operation.slideId, operationIndex)
          const previousIndex = slide.elements.findIndex((element) => element.id === operation.element.id)
          if (previousIndex >= 0) {
            const previous = slide.elements[previousIndex]
            slide.elements.splice(previousIndex, 1)
            const index = operation.index ?? previousIndex
            if (index > slide.elements.length) {
              throw new PresentationOperationError('Element upsert index is out of range', operationIndex)
            }
            slide.elements.splice(index, 0, operation.element)
            inverseOperations.unshift({
              kind: 'element.upsert',
              slideId: slide.id,
              element: previous,
              index: previousIndex
            })
          } else {
            const index = operation.index ?? slide.elements.length
            if (index > slide.elements.length) {
              throw new PresentationOperationError('Element insert index is out of range', operationIndex)
            }
            slide.elements.splice(index, 0, operation.element)
            inverseOperations.unshift({ kind: 'element.delete', slideId: slide.id, elementId: operation.element.id })
          }
          addChanged(changedIds, slide.id, operation.element.id)
          break
        }
        case 'element.style': {
          const slide = findSlide(project, operation.slideId, operationIndex)
          const index = slide.elements.findIndex((element) => element.id === operation.elementId)
          if (index < 0) {
            throw new PresentationOperationError(`Element not found: ${operation.elementId}`, operationIndex)
          }
          const previous = slide.elements[index]!
          const styled = applyEditableElementCss(previous, operation.css)
          slide.elements.splice(index, 1, styled)
          inverseOperations.unshift({
            kind: 'element.upsert',
            slideId: slide.id,
            element: previous,
            index
          })
          addChanged(changedIds, slide.id, styled.id)
          break
        }
        case 'element.delete': {
          const slide = findSlide(project, operation.slideId, operationIndex)
          const index = slide.elements.findIndex((element) => element.id === operation.elementId)
          if (index < 0) {
            throw new PresentationOperationError(`Element not found: ${operation.elementId}`, operationIndex)
          }
          const [element] = slide.elements.splice(index, 1)
          inverseOperations.unshift({ kind: 'element.upsert', slideId: slide.id, element, index })
          addChanged(changedIds, slide.id, element.id)
          break
        }
      }
      project = normalizePresentationProject(project)
    } catch (error) {
      if (error instanceof PresentationOperationError) throw error
      const message = error instanceof Error ? error.message : 'Operation is invalid'
      throw new PresentationOperationError(message, operationIndex)
    }
  })

  return {
    project,
    changedIds,
    inverseOperations,
    warnings: collectWarnings(project)
  }
}
