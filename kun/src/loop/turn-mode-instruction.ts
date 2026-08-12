import { GRAPH_LEAD_MODE_INSTRUCTION } from '../prompt/graph-lead-mode.js'
import {
  DESIGN_MODE_INSTRUCTION,
  SVG_ARTIFACT_MODE_INSTRUCTION
} from './design-mode.js'
import { PLAN_MODE_INSTRUCTION } from './plan-mode.js'
import { WORK_MODE_INSTRUCTION } from './work-mode.js'

type TurnModeState = {
  agentSurface?: 'code' | 'write' | 'design'
  orchestration: 'direct' | 'graph'
  guiDesignArtifact?: { kind: string }
  guiDesignMode?: boolean
  designProfile?: unknown
}

export function buildTurnModeInstruction(
  turn: TurnModeState,
  planTurnActive: boolean
): string {
  return [
    ...(turn.agentSurface === 'write' ? [WORK_MODE_INSTRUCTION] : []),
    ...(turn.orchestration === 'graph' ? [GRAPH_LEAD_MODE_INSTRUCTION] : []),
    ...(planTurnActive ? [PLAN_MODE_INSTRUCTION] : []),
    ...(turn.guiDesignArtifact?.kind === 'svg'
      ? [SVG_ARTIFACT_MODE_INSTRUCTION]
      : turn.guiDesignMode === true || Boolean(turn.designProfile)
        ? [DESIGN_MODE_INSTRUCTION]
        : [])
  ].join('\n\n')
}
