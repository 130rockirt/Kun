import { createHash } from 'node:crypto'
import { engineError } from './errors.js'
import {
  MutationReceiptSchema,
  VideoProjectSchema,
  validateProjectRoundTrip,
  type MediaAsset,
  type MutationReceipt,
  type VideoProject
} from './schema.js'
import { containsNullOrLineBreak, replaceNullOrLineBreaks } from '../text-safety.js'
import {
  PROJECT_PACKAGE_LIMITS,
  type ProjectPackageBuildOptions,
  type ProjectPackageChatProvenance,
  type ProjectPackageGenerationLineage,
  type ProjectPackageJobOwner,
  type ProjectPackageJobRecord,
  type ProjectPackageJobState,
  type ProjectPackageMediaManifestEntry,
  type ProjectPackageMissingMediaPolicy,
  type SelfContainedProjectPackageBody
} from './project-package.js'

export function sanitizeProject(project: VideoProject): VideoProject {
  const result = structuredClone(project)
  result.assets = result.assets.map((asset) => {
    const safe = { ...asset }
    delete safe.workspaceRelativePath
    // The package manifest resolves this namespaced offline placeholder during
    // import. It is not a reusable Host media grant and contains no source path.
    safe.mediaHandleId = `package_offline_${asset.id}`
    safe.availability = 'offline'
    safe.recovery = safe.recovery
      ? { reason: safe.recovery.reason, lastVerifiedAt: safe.recovery.lastVerifiedAt }
      : undefined
    return safe
  })
  return validateProjectRoundTrip(result)
}

export function handleMissing(
  asset: MediaAsset,
  logicalName: string,
  reason: NonNullable<ProjectPackageMediaManifestEntry['missingReason']>,
  policy: ProjectPackageMissingMediaPolicy,
  manifest: ProjectPackageMediaManifestEntry[],
  missing: SelfContainedProjectPackageBody['missingMedia']
): void {
  if (policy === 'fail') {
    throw engineError(
      'render_unsupported',
      `Self-contained package cannot include media ${asset.id}: ${reason}`,
      { assetId: asset.id, reason }
    )
  }
  if (missing.length >= PROJECT_PACKAGE_LIMITS.missingMedia) invalid('Missing-media manifest exceeds its limit')
  manifest.push({
    assetId: asset.id,
    logicalName,
    kind: asset.kind,
    selection: 'embedded',
    status: 'missing',
    missingReason: reason
  })
  missing.push({ assetId: asset.id, reason })
}

export function validateBuildOptions(project: VideoProject, options: ProjectPackageBuildOptions): void {
  if (options.missingMediaPolicy !== 'fail' && options.missingMediaPolicy !== 'record-incomplete') {
    invalid('Project-package missing-media policy is invalid')
  }
  if (options.includeMedia !== 'all') {
    if (!Array.isArray(options.includeMedia) || options.includeMedia.length > PROJECT_PACKAGE_LIMITS.mediaAssets) {
      invalid('Project-package media selection exceeds its limit')
    }
    const available = new Set(project.assets.map(({ id }) => id))
    const selected = new Set<string>()
    for (const assetId of options.includeMedia) {
      boundedId(assetId, 'includeMedia assetId')
      if (!available.has(assetId)) invalid(`Project-package media selection contains unknown asset ${assetId}`)
      if (selected.has(assetId)) invalid(`Project-package media selection duplicates asset ${assetId}`)
      selected.add(assetId)
    }
  }
  if ((options.receipts?.length ?? 0) > PROJECT_PACKAGE_LIMITS.receipts) invalid('Project-package receipt limit exceeded')
  if ((options.chatProvenance?.length ?? 0) > PROJECT_PACKAGE_LIMITS.chatProvenance) invalid('Project-package chat provenance limit exceeded')
  if ((options.generationLineage?.length ?? 0) > PROJECT_PACKAGE_LIMITS.generationLineage) invalid('Project-package generation lineage limit exceeded')
}

export function validateChatProvenance(value: ProjectPackageChatProvenance): ProjectPackageChatProvenance {
  boundedId(value.threadId, 'chat.threadId')
  boundedId(value.messageId, 'chat.messageId')
  if (!['user', 'assistant', 'tool'].includes(value.role)) invalid('Chat provenance role is invalid')
  isoTimestamp(value.createdAt, 'chat.createdAt')
  sha256(value.contentDigest, 'chat.contentDigest')
  return structuredClone(value)
}

export function validateGenerationLineage(value: ProjectPackageGenerationLineage): ProjectPackageGenerationLineage {
  boundedId(value.assetId, 'lineage.assetId')
  boundedId(value.jobId, 'lineage.jobId')
  boundedId(value.providerId, 'lineage.providerId')
  boundedId(value.modelId, 'lineage.modelId')
  sha256(value.promptDigest, 'lineage.promptDigest')
  if (!Array.isArray(value.referenceAssetIds) || value.referenceAssetIds.length > 64) invalid('Lineage references exceed their limit')
  value.referenceAssetIds.forEach((id) => boundedId(id, 'lineage.referenceAssetId'))
  if (value.parentAssetId !== undefined) boundedId(value.parentAssetId, 'lineage.parentAssetId')
  return { ...structuredClone(value), referenceAssetIds: [...new Set(value.referenceAssetIds)].sort() }
}

export function validateOwner(owner: ProjectPackageJobOwner): void {
  boundedId(owner.extensionId, 'owner.extensionId')
  boundedString(owner.extensionVersion, 'owner.extensionVersion', 64)
  boundedId(owner.workspaceId, 'owner.workspaceId')
  boundedId(owner.projectId, 'owner.projectId')
  boundedId(owner.sequenceId, 'owner.sequenceId')
  if (!Number.isSafeInteger(owner.revision) || owner.revision < 0) invalid('owner.revision must be a non-negative integer')
  boundedString(owner.idempotencyKey, 'owner.idempotencyKey', 256)
  opaqueHandle(owner.targetHandle, 'owner.targetHandle')
}

export function assertJobState(record: ProjectPackageJobRecord, expected: readonly ProjectPackageJobState[]): void {
  if (!expected.includes(record.state)) invalid(`Project-package job state ${record.state} cannot perform this operation`)
}

export function assertPackageMetadataSafe(body: SelfContainedProjectPackageBody): void {
  for (const asset of body.project.snapshot.assets) {
    if (
      asset.workspaceRelativePath !== undefined ||
      asset.recovery?.previousMediaHandleId !== undefined ||
      !asset.mediaHandleId?.startsWith('package_offline_')
    ) {
      invalid(`Project-package snapshot leaks a reusable media reference for ${asset.id}`)
    }
  }
  const inspect = {
    ...body,
    objects: body.objects.map(({ dataBase64: _dataBase64, ...metadata }) => metadata)
  }
  visitStrings(inspect, (value) => {
    if (looksLikePath(value)) invalid('Project-package metadata contains a filesystem path')
  })
}

export function sanitizeMetadata<T>(value: T): { value: T; redacted: number } {
  let redacted = 0
  const walk = (entry: unknown): unknown => {
    if (typeof entry === 'string') {
      const next = redactPaths(entry)
      if (next !== entry) redacted += 1
      return next
    }
    if (Array.isArray(entry)) return entry.map(walk)
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
        .map(([key, child]) => [key, walk(child)]))
    }
    return entry
  }
  return { value: walk(structuredClone(value)) as T, redacted }
}

export function redactPaths(value: string): string {
  return value
    .replace(/file:\/\/[^\s]+/giu, '[redacted-path]')
    .replace(/[A-Za-z]:[\\/][^\s]+/gu, '[redacted-path]')
    .replace(/(^|\s)\/(?:Users|home|private|var|tmp|Volumes|mnt|opt|etc)\/[^\s]+/gu, '$1[redacted-path]')
}

export function looksLikePath(value: string): boolean {
  return /file:\/\//iu.test(value) || /[A-Za-z]:[\\/]/u.test(value) ||
    /(^|\s)\/(?:Users|home|private|var|tmp|Volumes|mnt|opt|etc)\//u.test(value)
}

export function safeLogicalName(value: string, fallback: string): string {
  const leaf = value.split(/[\\/]/u).filter(Boolean).at(-1) ?? fallback
  const safe = replaceNullOrLineBreaks(leaf, '').trim().slice(0, 255)
  return safe || fallback
}

export function safeMime(value: string | undefined, kind: MediaAsset['kind']): string {
  if (value === undefined) return kind === 'video' ? 'video/octet-stream' : 'audio/octet-stream'
  if (!/^(?:video|audio|application)\/[A-Za-z0-9.+-]{1,64}$/u.test(value)) invalid('Resolved media MIME type is invalid')
  return value
}

export function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw engineError('render_unsupported', 'Project-package work was cancelled', { code: 'cancelled' })
  }
}

export function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && /cancel/iu.test(error.message))
}

export function opaqueHandle(value: unknown, label: string): asserts value is string {
  boundedString(value, label, 256)
  if (/^(?:[A-Za-z]:[\\/]|\/|\\\\|file:|https?:)/iu.test(value)) invalid(`${label} must be an opaque handle`)
}

export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

export function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]))
  }
  return value
}

export function visitStrings(value: unknown, callback: (value: string) => void): void {
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const current = stack.pop()
    if (typeof current === 'string') callback(current)
    else if (Array.isArray(current)) stack.push(...current)
    else if (current && typeof current === 'object') stack.push(...Object.values(current as Record<string, unknown>))
  }
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function boundedId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,191}$/u.test(value)) {
    invalid(`${label} must be a bounded identifier`)
  }
}

export function boundedString(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || containsNullOrLineBreak(value)) {
    invalid(`${label} must be a bounded string`)
  }
}

export function sha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/iu.test(value)) invalid(`${label} must be a SHA-256 digest`)
}

export function isoTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid(`${label} must be an ISO timestamp`)
}

export function invalid(message: string): never {
  throw engineError('render_unsupported', message)
}
