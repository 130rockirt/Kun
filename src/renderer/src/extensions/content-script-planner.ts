import type { HostSurfaceMatcher } from '@kun/extension-api'
import type { AppRoute } from '../store/chat-store-types'
import type { ChatBlock } from '../agent/types'
import {
  extensionResourceUrl,
  type RegisteredContribution
} from './contribution-registry'

export type WorkbenchSurfaceToken = Exclude<HostSurfaceMatcher, 'workbench:*'>
export type WorkbenchTaskSurface = 'code' | 'design'

export type ProtectedSurfaceKind =
  | 'extension-install'
  | 'extension-permissions'
  | 'workspace-trust'
  | 'account-credentials'
  | 'secret-reveal'
  | 'tool-approval'
  | 'external-effect-consent'

export type HostContentScriptInjectionDescriptor = {
  extensionId: string
  extensionVersion: string
  contributionId: string
  surface: WorkbenchSurfaceToken
  worldId: number
  worldName: string
  isolatedWorld: true
  runAt: 'documentStart' | 'documentEnd'
  scripts: string[]
  styles: string[]
  contentSecurityPolicy: string
  cleanupKey: string
  api: {
    version: 1
    globalName: 'kunHost'
    methods: readonly ['getContext', 'reportDiagnostic', 'dispose']
    excludes: readonly ['window.kunGui', 'electron', 'node', 'reactInternals']
  }
  compatibility: {
    stable: false
    warning: string
  }
}

export type HostContentScriptDiagnostic = {
  code:
    | 'HOST_DOM_PROTECTED_SURFACE_EXCLUDED'
    | 'HOST_DOM_ROUTE_NOT_MATCHED'
    | 'HOST_DOM_WORLD_COLLISION_RESOLVED'
    | 'HOST_DOM_UNSUPPORTED_CONTRACT'
  extensionId: string
  extensionVersion: string
  contributionId: string
  message: string
}

export type HostContentScriptPlan = {
  surface: WorkbenchSurfaceToken | null
  protectedSurface?: ProtectedSurfaceKind
  descriptors: HostContentScriptInjectionDescriptor[]
  diagnostics: HostContentScriptDiagnostic[]
}

const UNSUPPORTED_DOM_WARNING =
  'Direct host DOM selectors and layout are unsupported compatibility dependencies and may change in any Kun release.'
const CONTENT_SCRIPT_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

export function workbenchSurfaceForRoute(
  route: AppRoute,
  taskSurface: WorkbenchTaskSurface = 'code'
): WorkbenchSurfaceToken | null {
  if (route === 'chat') return taskSurface === 'design' ? 'workbench:design' : 'workbench:code'
  if (route === 'design') return 'workbench:design'
  if (route === 'write') return 'workbench:write'
  if (route === 'claw') return 'workbench:connect'
  return null
}

export function protectedSurfaceForWorkbench(input: {
  route: AppRoute
  blocks: readonly ChatBlock[]
  initialSetupOpen: boolean
}): ProtectedSurfaceKind | undefined {
  // Settings and onboarding render API keys, runtime credentials, provider
  // endpoints, and execution-policy controls. They are protected as a whole;
  // attempting to partition individual panels would leave future fields easy
  // to expose accidentally.
  if (input.route === 'settings' || input.initialSetupOpen) return 'account-credentials'
  return protectedSurfaceForChatBlocks(input.blocks)
}

export function protectedSurfaceForChatBlocks(
  blocks: readonly ChatBlock[]
): ProtectedSurfaceKind | undefined {
  return blocks.some((block) =>
    block.kind === 'approval' && (block.status === 'pending' || block.status === 'submitting'))
    ? 'tool-approval'
    : undefined
}

function initialWorldId(extensionId: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < extensionId.length; index += 1) {
    hash ^= extensionId.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  // Electron reserves low world IDs; keep extension worlds deterministic in a
  // broad positive range and resolve the unlikely collision within each plan.
  return 10_000 + (hash >>> 0) % 2_000_000_000
}

function matchesSurface(matches: readonly HostSurfaceMatcher[], surface: WorkbenchSurfaceToken): boolean {
  return matches.includes('workbench:*') || matches.includes(surface)
}

export function buildHostContentScriptPlan({
  contributions,
  route,
  taskSurface,
  protectedSurface
}: {
  contributions: readonly RegisteredContribution<'hostContentScripts'>[]
  route: AppRoute
  taskSurface?: WorkbenchTaskSurface
  protectedSurface?: ProtectedSurfaceKind
}): HostContentScriptPlan {
  const surface = workbenchSurfaceForRoute(route, taskSurface)
  const descriptors: HostContentScriptInjectionDescriptor[] = []
  const diagnostics: HostContentScriptDiagnostic[] = []
  const usedWorlds = new Map<number, string>()

  for (const contribution of contributions) {
    if (contribution.owner.kind !== 'extension') continue
    const base = {
      extensionId: contribution.owner.extensionId,
      extensionVersion: contribution.owner.extensionVersion,
      contributionId: contribution.id
    }
    if (protectedSurface) {
      diagnostics.push({
        ...base,
        code: 'HOST_DOM_PROTECTED_SURFACE_EXCLUDED',
        message: `Content scripts are excluded from protected surface: ${protectedSurface}`
      })
      continue
    }
    if (!surface || !matchesSurface(contribution.payload.matches, surface)) {
      diagnostics.push({
        ...base,
        code: 'HOST_DOM_ROUTE_NOT_MATCHED',
        message: surface
          ? `Contribution does not match ${surface}`
          : 'Current route is not a supported host content-script surface'
      })
      continue
    }

    let worldId = initialWorldId(contribution.owner.extensionId)
    while (usedWorlds.has(worldId) && usedWorlds.get(worldId) !== contribution.owner.extensionId) {
      worldId += 1
      diagnostics.push({
        ...base,
        code: 'HOST_DOM_WORLD_COLLISION_RESOLVED',
        message: 'An isolated-world ID collision was resolved without sharing a world.'
      })
    }
    usedWorlds.set(worldId, contribution.owner.extensionId)
    const resource = (path: string): string => extensionResourceUrl(contribution.owner.kind === 'extension' ? contribution.owner.extensionId : '', path)
    descriptors.push({
      ...base,
      surface,
      worldId,
      worldName: `kun-extension:${contribution.owner.extensionId}`,
      isolatedWorld: true,
      runAt: contribution.payload.runAt,
      scripts: contribution.payload.scripts.map(resource),
      styles: contribution.payload.styles.map(resource),
      contentSecurityPolicy: CONTENT_SCRIPT_CSP,
      cleanupKey: `${contribution.owner.extensionId}:${contribution.id}:${surface}`,
      api: {
        version: 1,
        globalName: 'kunHost',
        methods: ['getContext', 'reportDiagnostic', 'dispose'],
        excludes: ['window.kunGui', 'electron', 'node', 'reactInternals']
      },
      compatibility: {
        stable: false,
        warning: UNSUPPORTED_DOM_WARNING
      }
    })
    diagnostics.push({
      ...base,
      code: 'HOST_DOM_UNSUPPORTED_CONTRACT',
      message: UNSUPPORTED_DOM_WARNING
    })
  }

  return {
    surface,
    ...(protectedSurface ? { protectedSurface } : {}),
    descriptors: descriptors.sort((left, right) => left.contributionId.localeCompare(right.contributionId)),
    diagnostics
  }
}

/** Main performs the actual isolated-world execution and revalidates the bound
 * principal. The renderer only supplies a closed, declarative plan. */
export async function syncHostContentScriptPlan(
  plan: HostContentScriptPlan,
  workspaceRoot?: string
): Promise<boolean> {
  const result = await window.kunGui.extensionSyncHostContentScripts({
    surface: plan.surface,
    ...(plan.protectedSurface ? { protectedSurface: plan.protectedSurface } : {}),
    ...(workspaceRoot ? { workspaceRoot } : {}),
    // Main ignores all renderer-computed world/resource/API metadata and
    // resolves the package, workspace grant and declaration again. Send only
    // the identities needed to request that resolution.
    descriptors: plan.descriptors.map(({ extensionId, contributionId }) => ({
      extensionId,
      contributionId
    }))
  })
  return result.ok
}

export { UNSUPPORTED_DOM_WARNING }
