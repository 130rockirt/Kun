import type { DesignTaskProfile } from '../contracts/design-task-profile.js'

function presetInstruction(profile: DesignTaskProfile): string {
  switch (profile.presetSource) {
    case 'root-design-md':
      return profile.styleSnapshot
        ? [
            `Use the immutable root DESIGN.md snapshot captured at admission (name: ${profile.styleSnapshot.sourceName}; hash: ${profile.styleSnapshot.sourceHash}).`,
            'Do not re-read the current workspace file; later edits must not restyle this task.',
            `Locked parsed style snapshot: ${profile.styleSnapshot.content}`
          ].join('\n')
        : 'This legacy task selected root DESIGN.md but has no captured snapshot; do not layer a conflicting preset.'
    case 'workspace-default':
      return `Use the workspace-default preset captured at admission: ${profile.preset}.`
    case 'explicit':
      return `Use the explicitly selected preset: ${profile.preset}.`
    default:
      return profile.preset === 'none'
        ? 'No design-system preset was selected.'
        : `Use the legacy locked preset: ${profile.preset}.`
  }
}

/** Model-visible runtime block derived only from the immutable thread snapshot. */
export function buildDesignTaskProfileInstruction(profile: DesignTaskProfile): string {
  const frame = profile.target === 'app' ? '390x844 mobile-first' : '1280x800 desktop-first'
  const output = profile.outputMedium === 'image'
    ? 'The primary deliverable is a generated raster image. Do not silently substitute HTML.'
    : 'The primary deliverable is an interactive HTML interface. Raster images may only support it.'
  return [
    'Immutable Design task profile:',
    `- Locked at turn: ${profile.lockedAtTurnId}`,
    `- Bound document: ${profile.documentTarget.documentId}`,
    `- Bound board artifact: ${profile.documentTarget.boardArtifactId}`,
    `- Output medium: ${profile.outputMedium}. ${output}`,
    `- Target: ${profile.target}; use ${frame} defaults when dimensions are omitted.`,
    `- Preset: ${profile.preset}; source: ${profile.presetSource ?? 'legacy'}.`,
    `- ${presetInstruction(profile)}`,
    `- Visual context snapshot: ${JSON.stringify(profile.context)}`,
    'Use this snapshot for every prompt interpretation, frame default, and visual decision in this thread. Do not inherit mutable settings from another Design task.'
  ].join('\n')
}
