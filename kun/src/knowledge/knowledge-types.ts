import type { KnowledgeBaseIndexStatus, KnowledgeBaseMount } from '../contracts/threads.js'

export const KNOWLEDGE_INDEX_SCHEMA_VERSION = 1

export type KnowledgeNodeKind = 'root' | 'directory' | 'document' | 'section' | 'range' | 'page'

export type KnowledgeTextLocation = {
  kind: 'text'
  lineStart: number
  lineEnd: number
}

export type KnowledgePdfLocation = {
  kind: 'pdf'
  pageStart: number
  pageEnd: number
}

export type KnowledgeSourceLocation = KnowledgeTextLocation | KnowledgePdfLocation

export type KnowledgeNode = {
  id: string
  kind: KnowledgeNodeKind
  title: string
  summary: string
  parentId: string | null
  childIds: string[]
  relativePath?: string
  location?: KnowledgeSourceLocation
}

export type KnowledgeReferenceEdge = {
  fromId: string
  toId: string
  label: string
}

export type KnowledgeDocument = {
  nodeId: string
  relativePath: string
  size: number
  mtimeMs: number
  available: boolean
  error?: string
}

export type StoredKnowledgeIndex = {
  version: typeof KNOWLEDGE_INDEX_SCHEMA_VERSION
  root: string
  fingerprint: string
  builtAt: string
  rootNodeId: string
  documents: KnowledgeDocument[]
  nodes: Record<string, KnowledgeNode>
  references: KnowledgeReferenceEdge[]
  diagnostics: string[]
}

export type KnowledgeSourceFile = {
  absolutePath: string
  relativePath: string
  size: number
  mtimeMs: number
}

export type KnowledgeSourceScan = {
  root: string
  fingerprint: string
  files: KnowledgeSourceFile[]
  diagnostics: string[]
}

export type KnowledgeCatalogResult = {
  mounts: Array<Omit<KnowledgeBaseMount, 'root'> & {
    status: KnowledgeBaseIndexStatus
    rootNodeId?: string
  }>
  matches: Array<{
    mountId: string
    node: KnowledgeNode
    structuralPath: string[]
    score: number
  }>
}

export type KnowledgeBrowseResult = {
  mountId: string
  node: KnowledgeNode
  children: KnowledgeNode[]
  references: Array<KnowledgeReferenceEdge & { target?: KnowledgeNode }>
  nextCursor: number | null
}

export type KnowledgeEvidence = {
  mountId: string
  mountName: string
  nodeId: string
  structuralPath: string[]
  relativePath: string
  location: KnowledgeSourceLocation
  text: string
  truncated: boolean
}

export type KnowledgeReadResult = {
  notice: string
  evidence: KnowledgeEvidence[]
}
