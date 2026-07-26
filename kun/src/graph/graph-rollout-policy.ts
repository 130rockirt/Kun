import type { GraphRuntimeConfig } from '../config/kun-config.js'

const STAGE_RANK: Record<GraphRuntimeConfig['rolloutStage'], number> = {
  experimental: 0,
  alpha: 1,
  beta: 2,
  'learning-preview': 3,
  stable: 4
}

export function graphStageAtLeast(
  config: GraphRuntimeConfig,
  stage: GraphRuntimeConfig['rolloutStage']
): boolean {
  return STAGE_RANK[config.rolloutStage] >= STAGE_RANK[stage]
}

export function graphAllowsLoops(config: GraphRuntimeConfig): boolean {
  return config.enabled && graphStageAtLeast(config, 'beta')
}

export function graphSupervisionEnabled(config: GraphRuntimeConfig): boolean {
  return config.enabled &&
    config.supervision.enabled &&
    graphStageAtLeast(config, 'alpha')
}

export function graphAutomaticSupervisionEnabled(config: GraphRuntimeConfig): boolean {
  return graphSupervisionEnabled(config) && config.supervision.autoStart
}

export function effectiveGraphLearningMode(
  config: GraphRuntimeConfig
): GraphRuntimeConfig['learning']['mode'] {
  if (!config.enabled || !graphStageAtLeast(config, 'learning-preview')) return 'off'
  if (config.rolloutStage === 'learning-preview' && config.learning.mode === 'auto_candidate') {
    return 'suggest'
  }
  return config.learning.mode
}
