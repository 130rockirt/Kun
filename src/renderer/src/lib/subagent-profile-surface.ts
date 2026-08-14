import type { KunSubagentProfileV1, KunSubagentSurfaceV1 } from '@shared/app-settings'

type ProductSurface = Exclude<KunSubagentSurfaceV1, 'shared'>

export function composerAgentPickerSurface(
  route: string,
  taskSurface?: ProductSurface
): ProductSurface {
  if (route === 'write' || route === 'design') return route
  return taskSurface ?? 'code'
}

/** Missing surface metadata is the documented legacy shared-pool behavior. */
export function primaryAgentAvailableOnSurface(
  profile: KunSubagentProfileV1,
  surface: ProductSurface
): boolean {
  if (!profile.enabled || (profile.mode !== 'primary' && profile.mode !== 'all')) return false
  const surfaces = profile.surfaces ?? ['shared']
  return surfaces.includes('shared') || surfaces.includes(surface)
}
