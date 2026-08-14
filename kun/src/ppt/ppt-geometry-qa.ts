import {
  parsePptxGeometryParts,
  type PptGeometryDocument,
  type PptxGeometryParts
} from './ppt-geometry-qa-ooxml.js'
import { readPptxGeometryParts } from './ppt-geometry-qa-archive.js'
import {
  auditPptGeometryDocument,
  type PptGeometryQaOptions
} from './ppt-geometry-qa-rules.js'
import type { PptGeometryQaReportV1 } from './ppt-geometry-qa-report.js'

export async function auditPptxGeometry(
  path: string,
  options: PptGeometryQaOptions = {}
): Promise<PptGeometryQaReportV1> {
  return auditPptGeometryParts(await readPptxGeometryParts(path), options)
}

export function auditPptGeometryParts(
  parts: PptxGeometryParts,
  options: PptGeometryQaOptions = {}
): PptGeometryQaReportV1 {
  return auditPptGeometryDocument(parsePptxGeometryParts(parts), options)
}

export function auditParsedPptGeometry(
  document: PptGeometryDocument,
  options: PptGeometryQaOptions = {}
): PptGeometryQaReportV1 {
  return auditPptGeometryDocument(document, options)
}

export * from './ppt-geometry-qa-ooxml.js'
export * from './ppt-geometry-qa-archive.js'
export * from './ppt-geometry-qa-report.js'
export * from './ppt-geometry-qa-rules.js'
