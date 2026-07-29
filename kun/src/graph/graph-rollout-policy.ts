import type { GraphRuntimeConfig } from '../config/kun-config.js'

export function graphAllowsLoops(config: GraphRuntimeConfig): boolean {
  return config.enabled
}

export function graphSupervisionEnabled(config: GraphRuntimeConfig): boolean {
  return config.enabled &&
    config.supervision.enabled
}

export function graphAutomaticSupervisionEnabled(config: GraphRuntimeConfig): boolean {
  return graphSupervisionEnabled(config) && config.supervision.autoStart
}

/**
 * The original source Lead owns Graph delivery at every rollout stage.
 * Optional reviewer/learning features remain gated by their existing policy.
 */
export function graphLeadLifecycleSupervisionEnabled(config: GraphRuntimeConfig): boolean {
  return config.enabled
}

export function effectiveGraphLearningMode(
  config: GraphRuntimeConfig
): GraphRuntimeConfig['learning']['mode'] {
  return config.enabled ? config.learning.mode : 'off'
}
