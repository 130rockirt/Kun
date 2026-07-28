import { z } from 'zod'

const GraphRelativePathInputSchema = z.string().trim().min(1).max(4_096)
  .transform((value) => value.replaceAll('\\', '/'))
  .refine((value) =>
    !value.startsWith('/') &&
    !/^[A-Za-z]:/.test(value) &&
    !value.split('/').includes('..') &&
    !value.includes('\0'), {
    message: 'path must be normalized and repository relative'
  })

/**
 * Durable Graph paths are logical Git/workspace paths, not host filesystem
 * paths. Accept native Windows separators at process boundaries and persist
 * one slash-separated representation on every platform.
 */
export const GraphRelativePathSchema = GraphRelativePathInputSchema.transform((value) => {
  const segments = value.split('/').filter((segment) => segment && segment !== '.')
  return segments.length ? segments.join('/') : '.'
})

export type GraphRelativePath = z.infer<typeof GraphRelativePathSchema>

export function normalizeGraphRelativePath(value: string): GraphRelativePath {
  return GraphRelativePathSchema.parse(value)
}

export function graphRelativePathCovers(
  parentInput: string,
  childInput: string,
  caseInsensitive: boolean
): boolean {
  let parent = normalizeGraphRelativePath(parentInput)
  let child = normalizeGraphRelativePath(childInput)
  if (caseInsensitive) {
    parent = parent.toLocaleLowerCase('en-US')
    child = child.toLocaleLowerCase('en-US')
  }
  return parent === '.' || child === parent || child.startsWith(`${parent}/`)
}

export function graphRelativePathsOverlap(
  left: readonly string[],
  right: readonly string[],
  caseInsensitive: boolean
): boolean {
  return left.some((a) => right.some((b) =>
    graphRelativePathCovers(a, b, caseInsensitive) ||
    graphRelativePathCovers(b, a, caseInsensitive)))
}
