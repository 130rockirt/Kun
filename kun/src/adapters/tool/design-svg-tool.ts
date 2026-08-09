import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import { withToolBoundary } from './builtin-tool-utils.js'
import { withFileMutationQueue } from './file-mutation-queue.js'
import { assertCanWritePath } from './sandbox-policy.js'
import {
  safeSvgId as safeId,
  svgElementName as elementName,
  validateSvgDocument as validateDocument
} from './design-svg-validation.js'
import {
  DESIGN_SVG_EDIT_MAX_BATCH_OPS,
  DESIGN_SVG_EDIT_MAX_ARGUMENT_BYTES,
  DESIGN_SVG_EDIT_MAX_ELEMENT_DEPTH,
  DESIGN_SVG_EDIT_MAX_ELEMENTS,
  DESIGN_SVG_EDIT_MAX_STRUCTURED_NODES,
  MAX_INSPECT_ELEMENTS,
  advertised,
  animationElement,
  applyEditOperation,
  assertExpectedRevision,
  assertFileUnchanged,
  atomicWrite,
  diagnosticEnvelope,
  expectedRevision,
  findUniqueById,
  inspectDocument,
  prepareEditOperations,
  readSvg,
  revision,
  serializeValidatedSvg,
  svgFileContext,
  toolError
} from './design-svg-runtime.js'
import { validateStructuredArgumentBudget } from './structured-argument-budget.js'

export {
  DESIGN_SVG_EDIT_MAX_BATCH_OPS,
  DESIGN_SVG_EDIT_MAX_ELEMENT_DEPTH,
  DESIGN_SVG_EDIT_MAX_ELEMENTS
} from './design-svg-runtime.js'

export const DESIGN_SVG_INSPECT_TOOL_NAME = 'design_svg_inspect'
export const DESIGN_SVG_EDIT_TOOL_NAME = 'design_svg_edit'
export const DESIGN_SVG_ANIMATE_TOOL_NAME = 'design_svg_animate'
export const DESIGN_SVG_VALIDATE_TOOL_NAME = 'design_svg_validate'
export const DESIGN_SVG_STRUCTURED_TOOL_NAMES = [
  DESIGN_SVG_INSPECT_TOOL_NAME,
  DESIGN_SVG_EDIT_TOOL_NAME,
  DESIGN_SVG_ANIMATE_TOOL_NAME,
  DESIGN_SVG_VALIDATE_TOOL_NAME
] as const

export type DesignSvgMutationToolOptions = {
  /** Test/integration seam invoked after serialization and before compare-and-write. */
  beforeCommit?: (path: string) => Promise<void>
}

export function createDesignSvgInspectTool(): LocalTool {
  return LocalToolHost.defineTool({
    name: DESIGN_SVG_INSPECT_TOOL_NAME,
    description: 'Inspect the active SVG artifact as a compact element tree with ids, attributes, animations, and validation findings.',
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0, maximum: 5_000 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_INSPECT_ELEMENTS }
      },
      additionalProperties: false
    },
    toolKind: 'tool_call',
    policy: 'auto',
    shouldAdvertise: advertised,
    execute: async (args, context) => withToolBoundary(async () => {
      try {
        const offset = args.offset === undefined ? 0 : Number(args.offset)
        const limit = args.limit === undefined ? MAX_INSPECT_ELEMENTS : Number(args.limit)
        if (!Number.isInteger(offset) || offset < 0 || offset > 5_000) throw new Error('offset must be an integer from 0 to 5000')
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_INSPECT_ELEMENTS) throw new Error(`limit must be an integer from 1 to ${MAX_INSPECT_ELEMENTS}`)
        const current = await readSvg(context)
        const diagnostics = validateDocument(current.document, current.errors)
        return { output: { ok: true, path: current.relativePath, revision: revision(current.source), ...inspectDocument(current.document, { offset, limit }), ...diagnosticEnvelope(diagnostics) } }
      } catch (error) {
        return toolError(error)
      }
    })
  })
}

export function createDesignSvgEditTool(options: DesignSvgMutationToolOptions = {}): LocalTool {
  return LocalToolHost.defineTool({
    name: DESIGN_SVG_EDIT_TOOL_NAME,
    description: 'Atomically set document geometry or add, update, delete, reparent, and reorder SVG elements in the active SVG artifact. Use stable element ids, prefer revision-safe batches of 20-50 related operations, and after each batch run design_svg_inspect again before using new revision-bound handles.',
    inputSchema: {
      type: 'object',
      properties: {
        expectedRevision: {
          type: 'string',
          description: 'Revision returned by design_svg_inspect. Required whenever an op uses handle or parentHandle; recommended for every edit to prevent lost updates.'
        },
        ops: {
          type: 'array', minItems: 1, maxItems: DESIGN_SVG_EDIT_MAX_BATCH_OPS,
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: ['set-document', 'add', 'update', 'delete', 'reparent', 'reorder'],
                description: 'set-document changes viewBox/size; add creates a child; update changes attributes/text; delete removes a subtree; reparent moves an element; reorder moves it to front/back.'
              },
              id: { type: 'string', description: 'Stable id of an existing element for update/delete/reparent/reorder. Use either id or a fresh inspect handle.' },
              handle: { type: 'string', description: 'Version-local structural handle returned by design_svg_inspect, used to repair an element that has no usable id.' },
              parentId: { type: 'string', description: 'Existing parent id. Add defaults to the #artwork group.' },
              parentHandle: { type: 'string', description: 'Structural handle returned by a fresh inspect result for an id-less parent.' },
              position: { type: 'string', enum: ['front', 'back'] },
              attributes: {
                type: 'object',
                description: 'SVG attributes. For set-document use viewBox, width, height, preserveAspectRatio, role, aria-labelledby, or the standard SVG xmlns. Null removes an attribute during update.',
                additionalProperties: {
                  anyOf: [
                    { type: 'string' },
                    { type: 'number' },
                    { type: 'boolean' },
                    { type: 'null' }
                  ]
                }
              },
              removeAttributes: { type: 'array', items: { type: 'string' } },
              text: { type: 'string' },
              element: {
                type: 'object',
                description: 'Element spec for add: {tag,id?,attributes?,text?,children?}. Give editable visual layers stable ids.',
                properties: {
                  tag: { type: 'string' },
                  id: { type: 'string' },
                  attributes: { type: 'object', additionalProperties: true },
                  text: { type: 'string' },
                  children: { type: 'array', items: { type: 'object', additionalProperties: true } }
                },
                required: ['tag'],
                additionalProperties: false
              }
            },
            required: ['op'],
            additionalProperties: false
          }
        }
      },
      required: ['ops'],
      additionalProperties: false
    },
    toolKind: 'file_change',
    policy: 'auto',
    shouldAdvertise: advertised,
    execute: async (args, context) => withToolBoundary(async () => {
      try {
        const complexityError = svgEditComplexityError(args)
        if (complexityError) throw new Error(complexityError)
        const file = await svgFileContext(context, true)
        return await withFileMutationQueue(file.absolutePath, async () => {
          if (context.abortSignal.aborted) throw new Error('SVG edit aborted before start')
          const current = await readSvg(context)
          if (current.errors.length) throw new Error(`cannot edit invalid SVG: ${current.errors[0]}`)
          const expected = expectedRevision(args.expectedRevision)
          const ops = Array.isArray(args.ops) ? args.ops : []
          if (ops.length === 0 || ops.length > DESIGN_SVG_EDIT_MAX_BATCH_OPS) {
            throw new Error(`ops must contain 1-${DESIGN_SVG_EDIT_MAX_BATCH_OPS} operations; split larger edits into revision-safe batches of 20-50`)
          }
          const operationRecords: Record<string, unknown>[] = []
          let usesStructuralHandle = false
          for (const value of ops) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('every SVG op must be an object')
            const operation = value as Record<string, unknown>
            if (typeof operation.handle === 'string' || typeof operation.parentHandle === 'string') usesStructuralHandle = true
            operationRecords.push(operation)
          }
          if (usesStructuralHandle && !expected) {
            throw new Error('expectedRevision is required when using handle or parentHandle')
          }
          assertExpectedRevision(current.source, expected)
          // Resolve all references against the inspected version before applying
          // structural changes, so an earlier delete/reorder cannot retarget a
          // later handle in the same batch.
          const preparedOperations = prepareEditOperations(current.document, operationRecords)
          const affectedIds = new Set<string>()
          for (const prepared of preparedOperations) {
            for (const id of applyEditOperation(current.document, prepared)) affectedIds.add(id)
          }
          const { content, diagnostics } = serializeValidatedSvg(current.document)
          await options.beforeCommit?.(file.absolutePath)
          await assertFileUnchanged(file.absolutePath, current.source)
          await atomicWrite(file.absolutePath, content, context.abortSignal)
          return { output: { ok: true, path: file.relativePath, revision: revision(content), affectedIds: [...affectedIds], diagnostics } }
        })
      } catch (error) {
        return toolError(error)
      }
    })
  })
}

function svgEditComplexityError(args: Record<string, unknown>): string | null {
  const budget = validateStructuredArgumentBudget(args, {
    label: DESIGN_SVG_EDIT_TOOL_NAME,
    maxBytes: DESIGN_SVG_EDIT_MAX_ARGUMENT_BYTES,
    maxNodes: DESIGN_SVG_EDIT_MAX_STRUCTURED_NODES,
    // `specFrom` applies the authoritative 32-level SVG element-tree limit.
    // This generic ceiling only protects unrelated argument object nesting.
    maxDepth: 128
  })
  if (!budget.ok) return budget.error

  const ops = Array.isArray(args.ops) ? args.ops : []
  if (ops.length > DESIGN_SVG_EDIT_MAX_BATCH_OPS) {
    return `design_svg_edit accepts at most ${DESIGN_SVG_EDIT_MAX_BATCH_OPS} operations; split larger edits into revision-safe batches of 20-50`
  }
  return null
}

export function createDesignSvgAnimateTool(options: DesignSvgMutationToolOptions = {}): LocalTool {
  return LocalToolHost.defineTool({
    name: DESIGN_SVG_ANIMATE_TOOL_NAME,
    description: 'Add declarative SVG animations to existing element ids: attribute, transform, motion-path, or path-draw effects. The result remains a standalone animated SVG with no scripts.',
    inputSchema: {
      type: 'object',
      properties: {
        expectedRevision: {
          type: 'string',
          description: 'Optional current artifact revision from design_svg_inspect, used to reject stale animation edits.'
        },
        animations: {
          type: 'array', minItems: 1, maxItems: 100,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' }, targetId: { type: 'string' },
              kind: { type: 'string', enum: ['attribute', 'transform', 'motion', 'path-draw'] },
              attributeName: { type: 'string' }, transformType: { type: 'string', enum: ['translate', 'scale', 'rotate', 'skewX', 'skewY'] },
              from: { anyOf: [{ type: 'string' }, { type: 'number' }] },
              to: { anyOf: [{ type: 'string' }, { type: 'number' }] },
              values: { type: 'array', minItems: 2, items: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
              durationMs: { type: 'number', minimum: 1, maximum: 600000 },
              delayMs: { type: 'number', minimum: 0, maximum: 600000 },
              iterations: { anyOf: [{ type: 'integer', minimum: 1, maximum: 1000 }, { type: 'string', enum: ['infinite'] }] },
              keyTimes: { type: 'array', items: { type: 'number' } },
              keySplines: { type: 'array', items: { type: 'string' } },
              path: { type: 'string' }, rotate: { type: 'string' }, fill: { type: 'string', enum: ['freeze', 'remove'] }
            },
            required: ['targetId', 'kind'],
            additionalProperties: false
          }
        }
      },
      required: ['animations'],
      additionalProperties: false
    },
    toolKind: 'file_change',
    policy: 'auto',
    shouldAdvertise: advertised,
    execute: async (args, context) => withToolBoundary(async () => {
      try {
        const file = await svgFileContext(context, true)
        return await withFileMutationQueue(file.absolutePath, async () => {
          if (context.abortSignal.aborted) throw new Error('SVG animation edit aborted before start')
          const current = await readSvg(context)
          if (current.errors.length) throw new Error(`cannot animate invalid SVG: ${current.errors[0]}`)
          assertExpectedRevision(current.source, expectedRevision(args.expectedRevision))
          const inputs = Array.isArray(args.animations) ? args.animations : []
          if (inputs.length === 0 || inputs.length > 100) throw new Error('animations must contain 1-100 entries')
          const affectedIds = new Set<string>()
          for (const value of inputs) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('every animation must be an object')
            // path-draw is normalized below; clone so tool execution never
            // mutates the model arguments retained in history/journaling.
            const input = { ...(value as Record<string, unknown>) }
            if (input.kind === 'path-draw') {
              input.attributeName = 'stroke-dashoffset'
              input.from = input.from ?? 1
              input.to = input.to ?? 0
              const targetId = safeId(input.targetId)
              const target = targetId ? findUniqueById(current.document, targetId, 'animation target') : null
              if (!target) throw new Error(`animation target not found: ${String(input.targetId ?? '')}`)
              if (elementName(target) !== 'path') throw new Error('path-draw animation requires a <path> target')
              target.setAttribute('pathLength', '1')
              target.setAttribute('stroke-dasharray', '1')
              target.setAttribute('stroke-dashoffset', '1')
              input.kind = 'attribute'
            }
            const created = animationElement(current.document, input)
            for (const id of created.ids) affectedIds.add(id)
          }
          const { content, diagnostics } = serializeValidatedSvg(current.document)
          await options.beforeCommit?.(file.absolutePath)
          await assertFileUnchanged(file.absolutePath, current.source)
          await atomicWrite(file.absolutePath, content, context.abortSignal)
          return { output: { ok: true, path: file.relativePath, revision: revision(content), affectedIds: [...affectedIds], diagnostics } }
        })
      } catch (error) {
        return toolError(error)
      }
    })
  })
}

export function createDesignSvgValidateTool(): LocalTool {
  return LocalToolHost.defineTool({
    name: DESIGN_SVG_VALIDATE_TOOL_NAME,
    description: 'Validate the active SVG artifact for XML structure, unsafe content, broken references, duplicate ids, accessibility, and animation compatibility.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    toolKind: 'tool_call',
    policy: 'auto',
    shouldAdvertise: advertised,
    execute: async (_args, context) => withToolBoundary(async () => {
      try {
        const current = await readSvg(context)
        const diagnostics = validateDocument(current.document, current.errors)
        const inspected = inspectDocument(current.document, { limit: 1 })
        const summary = {
          viewBox: inspected.viewBox,
          width: inspected.width,
          height: inspected.height,
          elementCount: inspected.elementCount,
          animationCount: inspected.animationCount
        }
        return { output: { ok: !diagnostics.some((item) => item.severity === 'error'), path: current.relativePath, revision: revision(current.source), ...diagnosticEnvelope(diagnostics), ...summary }, isError: diagnostics.some((item) => item.severity === 'error') }
      } catch (error) {
        return toolError(error)
      }
    })
  })
}

export function buildDesignSvgLocalTools(): LocalTool[] {
  return [
    createDesignSvgInspectTool(),
    createDesignSvgEditTool(),
    createDesignSvgAnimateTool(),
    createDesignSvgValidateTool()
  ]
}
