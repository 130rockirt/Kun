import kunAvatarCastUrl from '../../assets/startup/kun-startup-avatar-cast.webp'
import kunAvatarDashUrl from '../../assets/startup/kun-startup-avatar-dash.webp'
import kunAvatarFocusUrl from '../../assets/startup/kun-startup-avatar-focus.webp'
import kunAvatarUrl from '../../assets/startup/kun-startup-avatar.webp'
import kunAvatarWaveUrl from '../../assets/startup/kun-startup-avatar-wave.webp'

export const KUN_STARTUP_VARIANTS = [
  'signal',
  'wave',
  'dash',
  'focus',
  'cast'
] as const

export type KunStartupVariant = (typeof KUN_STARTUP_VARIANTS)[number]

export type KunStartupVariantConfig = Readonly<{
  avatarUrl: string
}>

export const KUN_STARTUP_VARIANT_CONFIG: Readonly<
  Record<KunStartupVariant, KunStartupVariantConfig>
> = {
  signal: { avatarUrl: kunAvatarUrl },
  wave: { avatarUrl: kunAvatarWaveUrl },
  dash: { avatarUrl: kunAvatarDashUrl },
  focus: { avatarUrl: kunAvatarFocusUrl },
  cast: { avatarUrl: kunAvatarCastUrl }
}

/** Selects one evenly weighted variant from a Math.random-compatible value. */
export function selectKunStartupVariant(randomValue: number = Math.random()): KunStartupVariant {
  if (!Number.isFinite(randomValue)) return KUN_STARTUP_VARIANTS[0]
  const boundedValue = Math.min(Math.max(randomValue, 0), 1 - Number.EPSILON)
  const index = Math.floor(boundedValue * KUN_STARTUP_VARIANTS.length)
  return KUN_STARTUP_VARIANTS[index]
}
