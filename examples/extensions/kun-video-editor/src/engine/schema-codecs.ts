import { engineError } from './errors.js'
import {
  PROJECT_SCHEMA_VERSION,
  type Caption,
  type DerivedReference,
  type LinkGroup,
  type MediaAsset,
  type MediaFolder,
  type MutationReceipt,
  type ProjectSelection,
  type Rational,
  type RenderPreset,
  type Revision,
  type RuntimeSchema,
  type Sequence,
  type TimelineItem,
  type TimelineOperation,
  type Track,
  type Transcript,
  type TranscriptSegment,
  type VideoProject
} from './schema-model.js'
import { array, object, positiveInteger } from './schema-primitives.js'
import {
  validateProjectShape,
  validateMutationReceipt,
  validateRenderPreset,
  validateRevision,
  validateV1ProjectShape
} from './schema-project-validation.js'
import { validateOperation } from './schema-operation-validation.js'
import {
  validateAsset,
  validateCanvas,
  validateCaption,
  validateDerivedReference,
  validateItem,
  validateLinkGroup,
  validateMediaFolder,
  validateSelection,
  validateSequence,
  validateTrack,
  validateTranscript,
  validateTranscriptSegment
} from './schema-value-validation.js'

export const RationalSchema = runtimeSchema<Rational>((value) => {
  const rational = object(value, 'rational')
  positiveInteger(rational.numerator, 'rational.numerator')
  positiveInteger(rational.denominator, 'rational.denominator')
})

export const CanvasSettingsSchema = runtimeSchema<CanvasSettings>(validateCanvas)
export const MediaAssetSchema = runtimeSchema<MediaAsset>((value) => validateAsset(value, 0))
export const MediaFolderSchema = runtimeSchema<MediaFolder>((value) => validateMediaFolder(value, 0))
export const TrackSchema = runtimeSchema<Track>((value) => validateTrack(value, 0))
export const TimelineItemSchema = runtimeSchema<TimelineItem>((value) => validateItem(value, 0))
export const CaptionSchema = runtimeSchema<Caption>((value) => validateCaption(value, 0))
export const TranscriptSegmentSchema = runtimeSchema<TranscriptSegment>((value) =>
  validateTranscriptSegment(value, 'segment')
)
export const TranscriptSchema = runtimeSchema<Transcript>((value) => validateTranscript(value, 0))
export const RevisionSchema = runtimeSchema<Revision>((value) => validateRevision(value, 0))
export const SequenceSchema = runtimeSchema<Sequence>((value) => validateSequence(value, 0))
export const LinkGroupSchema = runtimeSchema<LinkGroup>((value) => validateLinkGroup(value, 0))
export const ProjectSelectionSchema = runtimeSchema<ProjectSelection>(validateSelection)
export const DerivedReferenceSchema = runtimeSchema<DerivedReference>((value) =>
  validateDerivedReference(value, 0)
)
export const MutationReceiptSchema = runtimeSchema<MutationReceipt>(validateMutationReceipt)
export const TimelineOperationSchema = runtimeSchema<TimelineOperation>(validateOperation)
export const RenderPresetSchema = runtimeSchema<RenderPreset>(validateRenderPreset)
export const VideoProjectSchema = runtimeSchema<VideoProject>(validateProjectShape)

export type ProjectMigration = (value: Record<string, unknown>) => unknown
export const PROJECT_MIGRATIONS: Readonly<Record<number, ProjectMigration>> = Object.freeze({
  1: migrateV1Project
})

export type ProjectMigrationResult = {
  project: VideoProject
  sourceVersion: number
  migrated: boolean
}

export function migrateProject(
  value: unknown,
  migrations: Readonly<Record<number, ProjectMigration>> = PROJECT_MIGRATIONS
): VideoProject {
  let candidate = object(value, 'project')
  let version = candidate.schemaVersion
  if (!Number.isSafeInteger(version) || Number(version) < 0) {
    throw engineError('invalid_project', 'project.schemaVersion must be a non-negative integer')
  }
  while (version !== PROJECT_SCHEMA_VERSION) {
    if (Number(version) > PROJECT_SCHEMA_VERSION || migrations[Number(version)] === undefined) {
      throw engineError(
        'unsupported_schema_version',
        `Project schema ${String(version)} is not supported`,
        { schemaVersion: version, supportedSchemaVersion: PROJECT_SCHEMA_VERSION }
      )
    }
    candidate = object(migrations[Number(version)]!(candidate), 'migrated project')
    version = candidate.schemaVersion
  }
  return VideoProjectSchema.parse(candidate)
}

export function migrateProjectWithReport(
  value: unknown,
  migrations: Readonly<Record<number, ProjectMigration>> = PROJECT_MIGRATIONS
): ProjectMigrationResult {
  const source = object(value, 'project')
  const sourceVersion = Number(source.schemaVersion)
  const project = migrateProject(value, migrations)
  return {
    project,
    sourceVersion,
    migrated: sourceVersion !== PROJECT_SCHEMA_VERSION
  }
}

/**
 * The active timeline projection is retained while the public 0.3.x Host/Webview
 * moves to sequence-aware reads. This helper is the only supported place to
 * synchronize the compatibility fields.
 */
export function syncActiveSequenceProjection(
  project: VideoProject,
  direction: 'projection-to-sequence' | 'sequence-to-projection' = 'projection-to-sequence'
): VideoProject {
  const next = structuredClone(project)
  const sequence = next.sequences.find(({ id }) => id === next.activeSequenceId)
  if (!sequence) {
    throw engineError('invalid_project', 'The active sequence does not exist', {
      activeSequenceId: next.activeSequenceId
    })
  }
  if (direction === 'projection-to-sequence') {
    sequence.tracks = structuredClone(next.tracks)
    sequence.items = structuredClone(next.items)
    sequence.captions = structuredClone(next.captions)
  } else {
    next.tracks = structuredClone(sequence.tracks)
    next.items = structuredClone(sequence.items)
    next.captions = structuredClone(sequence.captions)
  }
  return next
}

export function activeSequence(project: VideoProject): Sequence {
  const sequence = project.sequences.find(({ id }) => id === project.activeSequenceId)
  if (!sequence) {
    throw engineError('invalid_project', 'The active sequence does not exist', {
      activeSequenceId: project.activeSequenceId
    })
  }
  // Until every public projection has moved to sequence-aware reads, callers
  // may have edited the 0.3.x active timeline fields in memory. Treat those
  // compatibility fields as the active sequence view; commits synchronize the
  // durable sequence document through syncActiveSequenceProjection().
  return {
    ...sequence,
    tracks: project.tracks,
    items: project.items,
    captions: project.captions
  }
}

export function validateProjectRoundTrip(project: VideoProject): VideoProject {
  const encoded = JSON.stringify(VideoProjectSchema.parse(project))
  const decoded = VideoProjectSchema.parse(JSON.parse(encoded))
  if (JSON.stringify(decoded) !== encoded) {
    throw engineError('invalid_project', 'Project is not stable across a JSON round trip')
  }
  return decoded
}

function migrateV1Project(value: Record<string, unknown>): unknown {
  validateV1ProjectShape(value)
  const project = structuredClone(value)
  const sequenceId = 'sequence-main'
  const tracks = structuredClone(array(project.tracks, 'project.tracks'))
  const items = structuredClone(array(project.items, 'project.items'))
  const captions = structuredClone(array(project.captions, 'project.captions'))
  const currentRevision = Number(project.currentRevision)
  return {
    ...project,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    tracks,
    items,
    captions,
    mediaFolders: [],
    sequences: [{
      id: sequenceId,
      name: String(project.name),
      tracks: structuredClone(tracks),
      items: structuredClone(items),
      captions: structuredClone(captions),
      viewState: { zoom: 1, scrollFrame: 0, open: true }
    }],
    activeSequenceId: sequenceId,
    linkGroups: [],
    selection: {
      generation: 0,
      revision: currentRevision,
      sequenceId,
      playheadFrame: 0,
      selectedAssetIds: [],
      selectedItemIds: [],
      selectedCaptionIds: [],
      selectedWordIds: []
    },
    derivedReferences: [],
    multicamGroups: [],
    eventGeneration: currentRevision,
    agentUndoStack: [],
    recovery: {
      mode: 'healthy',
      unreadableManifestKinds: [],
      interruptedJobIds: [],
      notes: []
    }
  }
}

function runtimeSchema<T>(validate: (value: unknown) => void): RuntimeSchema<T> {
  return {
    parse(value: unknown): T {
      validate(value)
      return structuredClone(value as T)
    },
    safeParse(value: unknown) {
      try {
        return { success: true as const, data: this.parse(value) }
      } catch (error) {
        return {
          success: false as const,
          error: error instanceof Error ? error : new Error(String(error))
        }
      }
    }
  }
}
