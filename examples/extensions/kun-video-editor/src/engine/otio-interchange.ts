import { createHash } from 'node:crypto'
import { engineError } from './errors.js'
import {
  VideoProjectSchema,
  validateProjectRoundTrip,
  type Caption,
  type EffectInstance,
  type KeyframeTrack,
  type Rational,
  type Sequence,
  type TimelineItem,
  type Track,
  type VideoProject
} from './schema.js'
import { framesToMicroseconds, microsecondsToFrames, rescaleFrames } from './time.js'
import { containsNullOrLineBreak, replaceNullOrLineBreaks } from '../text-safety.js'
export { frameTimecode } from './otio-export-support.js'
import {
  collectTimecodeMappings,
  otioTimeline,
  parseDocument,
  sanitizeProject,
  validateKunMediaReferences
} from './otio-export-support.js'
import { importPortableOtio } from './otio-import-support.js'
import {
  addLoss,
  assertDocumentBounds,
  canonicalDigest,
  invalid,
  lossCollector,
  lossManifest,
  metadataLoss,
  optionalRecord,
  parseLossManifest,
  record,
  stableStringify,
  stringValue
} from './otio-validation-support.js'

export const OTIO_ADAPTER_ID = 'kun.otio-json' as const
export const OTIO_ADAPTER_VERSION = '1.0.0' as const

export const OTIO_LIMITS = Object.freeze({
  documentBytes: 4 * 1024 * 1024,
  lossEntries: 128,
  timecodeMappings: 20_000,
  objectNodes: 100_000
})

export type InterchangeLossEntry = {
  code: string
  severity: 'info' | 'warning'
  feature: string
  nodeId: string
  preservation: 'otio-standard' | 'kun-metadata'
  message: string
}

export type InterchangeLossManifest = {
  adapterId: typeof OTIO_ADAPTER_ID
  adapterVersion: typeof OTIO_ADAPTER_VERSION
  portableLossless: boolean
  kunRoundTripLossless: boolean
  entries: InterchangeLossEntry[]
  truncated: number
}

export type OtioTimecodeMapping = {
  id: string
  sequenceId: string
  startFrame: number
  endFrame: number
  startTimecode: string
  endTimecode: string
  frameRate: Rational
}

export type OtioInterchangeExport = {
  adapterId: typeof OTIO_ADAPTER_ID
  adapterVersion: typeof OTIO_ADAPTER_VERSION
  projectId: string
  projectRevision: number
  document: Record<string, unknown>
  documentDigest: string
  projectDigest: string
  timecodeMappings: OtioTimecodeMapping[]
  lossManifest: InterchangeLossManifest
}

export type OtioInterchangeImport = {
  adapterId: typeof OTIO_ADAPTER_ID
  adapterVersion: typeof OTIO_ADAPTER_VERSION
  project: VideoProject
  sourceDocumentDigest: string
  fidelity: 'kun-metadata' | 'portable-otio'
  mediaRelinkRequired: string[]
  timecodeMappings: OtioTimecodeMapping[]
  lossManifest: InterchangeLossManifest
}

type LossCollector = {
  entries: InterchangeLossEntry[]
  truncated: number
  keys: Set<string>
}
export function exportProjectToOtio(project: VideoProject): OtioInterchangeExport {
  const validated = validateProjectRoundTrip(project)
  const portableProject = sanitizeProject(validated)
  const projectDigest = canonicalDigest(portableProject)
  const loss = lossCollector()
  const timecodeMappings: OtioTimecodeMapping[] = []
  const children = validated.sequences
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((sequence) => otioTimeline(validated, sequence, loss, timecodeMappings))
  if (validated.sequences.length > 1) {
    addLoss(loss, {
      code: 'multiple-sequences-collection',
      severity: 'info',
      feature: 'multiple-sequences',
      nodeId: validated.id,
      preservation: 'otio-standard',
      message: 'Sequences are represented as Timeline children of an OTIO SerializableCollection.'
    })
  }
  if (validated.linkGroups.length > 0) {
    addLoss(loss, metadataLoss(
      'link-groups-custom-metadata', 'link-groups', validated.id,
      'A/V and sync link groups are preserved in Kun metadata because OTIO has no portable link-group contract.'
    ))
  }
  if (validated.transcripts.length > 0) {
    addLoss(loss, metadataLoss(
      'transcripts-custom-metadata', 'transcripts', validated.id,
      'Timed transcripts are preserved in Kun metadata and are not portable OTIO timeline objects.'
    ))
  }
  if (validated.derivedReferences.length > 0) {
    addLoss(loss, metadataLoss(
      'derived-media-custom-metadata', 'derived-media', validated.id,
      'Derived-media provenance is preserved in Kun metadata; cache payloads are not exported through OTIO.'
    ))
  }
  const manifest = lossManifest(loss)
  const document: Record<string, unknown> = {
    OTIO_SCHEMA: 'SerializableCollection.1',
    name: validated.name,
    metadata: {
      kun: {
        adapterId: OTIO_ADAPTER_ID,
        adapterVersion: OTIO_ADAPTER_VERSION,
        projectId: validated.id,
        projectRevision: validated.currentRevision,
        frameRate: structuredClone(validated.fps),
        projectDigest,
        project: portableProject,
        lossManifest: manifest
      }
    },
    children
  }
  assertDocumentBounds(document)
  const documentDigest = canonicalDigest(document)
  return {
    adapterId: OTIO_ADAPTER_ID,
    adapterVersion: OTIO_ADAPTER_VERSION,
    projectId: validated.id,
    projectRevision: validated.currentRevision,
    document,
    documentDigest,
    projectDigest,
    timecodeMappings,
    lossManifest: manifest
  }
}

export function serializeOtioInterchange(value: OtioInterchangeExport): Uint8Array {
  if (value.adapterId !== OTIO_ADAPTER_ID || value.adapterVersion !== OTIO_ADAPTER_VERSION) {
    invalid('Unsupported OTIO adapter identity')
  }
  assertDocumentBounds(value.document)
  if (canonicalDigest(value.document) !== value.documentDigest) invalid('OTIO document digest does not match its content')
  return Buffer.from(`${stableStringify(value.document)}\n`, 'utf8')
}

export function importProjectFromOtio(value: unknown): OtioInterchangeImport {
  const document = parseDocument(value)
  assertDocumentBounds(document)
  const documentDigest = canonicalDigest(document)
  validateKunMediaReferences(document)
  const metadata = optionalRecord(document.metadata)
  const kun = optionalRecord(metadata?.kun)
  if (!kun || kun.adapterId !== OTIO_ADAPTER_ID || kun.adapterVersion !== OTIO_ADAPTER_VERSION) {
    return importPortableOtio(document, documentDigest)
  }
  const projectDigest = stringValue(kun.projectDigest, 'metadata.kun.projectDigest', 64)
  const rawProject = structuredClone(record(kun.project, 'metadata.kun.project'))
  if (canonicalDigest(rawProject) !== projectDigest) invalid('OTIO project metadata digest does not match its content')
  const project = validateProjectRoundTrip(VideoProjectSchema.parse(rawProject))
  if (project.id !== kun.projectId || project.currentRevision !== kun.projectRevision) {
    invalid('OTIO project identity or revision metadata is inconsistent')
  }
  const loss = parseLossManifest(kun.lossManifest)
  const mappings = collectTimecodeMappings(document, project.fps)
  return {
    adapterId: OTIO_ADAPTER_ID,
    adapterVersion: OTIO_ADAPTER_VERSION,
    project,
    sourceDocumentDigest: documentDigest,
    fidelity: 'kun-metadata',
    mediaRelinkRequired: project.assets.map(({ id }) => id).sort(),
    timecodeMappings: mappings,
    lossManifest: loss
  }
}
