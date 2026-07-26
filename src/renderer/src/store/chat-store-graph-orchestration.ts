import { readBrowserStorageItem, writeBrowserStorageItem } from '../lib/browser-storage'

const GRAPH_ORCHESTRATION_STORAGE_KEY = 'kun.graphOrchestration.v1'

export type ComposerOrchestrationMode = 'direct' | 'graph'

export function readStoredGraphOrchestration(): ComposerOrchestrationMode {
  return readBrowserStorageItem(GRAPH_ORCHESTRATION_STORAGE_KEY) === 'graph'
    ? 'graph'
    : 'direct'
}

export function hasStoredGraphOrchestration(): boolean {
  return readBrowserStorageItem(GRAPH_ORCHESTRATION_STORAGE_KEY) !== null
}

export function persistGraphOrchestration(mode: ComposerOrchestrationMode): void {
  writeBrowserStorageItem(GRAPH_ORCHESTRATION_STORAGE_KEY, mode)
}
