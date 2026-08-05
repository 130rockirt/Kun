import { looksLikeStandaloneImageAssetPrompt } from './design-image-intent'
import type { DesignArtifact, DesignIntentMode } from './design-types'

export type DesignMultiPageGateInput = {
  text: string
  artifacts: readonly DesignArtifact[]
  activeArtifactId: string | null
  designIntentMode: DesignIntentMode
  multiPageMode: boolean
  selectedCount: number
  attachmentCount: number
  pagesRunActive: boolean
}

export type DesignMultiPageGateDecision =
  | { route: 'multi-page'; reason: 'explicit-toggle' | 'default-design-pages' }
  | { route: 'single-turn'; reason: string }

export function shouldRouteDesignPromptToMultiPage(
  input: DesignMultiPageGateInput
): DesignMultiPageGateDecision {
  const text = input.text.trim()
  if (!text) return { route: 'single-turn', reason: 'empty-brief' }
  if (input.attachmentCount > 0) return { route: 'single-turn', reason: 'has-attachments' }
  if (input.pagesRunActive) return { route: 'single-turn', reason: 'pages-run-active' }
  if (input.designIntentMode !== 'generate') return { route: 'single-turn', reason: 'not-generate-mode' }
  if (input.selectedCount > 0) return { route: 'single-turn', reason: 'canvas-selection' }
  if (looksLikeStandaloneImageAssetPrompt(text)) return { route: 'single-turn', reason: 'standalone-image-asset' }

  if (input.multiPageMode) return { route: 'multi-page', reason: 'explicit-toggle' }

  const activeArtifact = input.artifacts.find((artifact) => artifact.id === input.activeArtifactId) ?? null
  if (activeArtifact?.kind === 'html') return { route: 'single-turn', reason: 'active-html-artifact' }
  if (input.artifacts.some((artifact) => artifact.kind === 'html')) {
    return { route: 'single-turn', reason: 'existing-html-artifacts' }
  }

  return { route: 'multi-page', reason: 'default-design-pages' }
}
