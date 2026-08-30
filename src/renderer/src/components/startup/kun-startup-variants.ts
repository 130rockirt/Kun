import kunAvatarCastUrl from '../../assets/startup/kun-startup-avatar-cast.webp'
import kunAvatarDashUrl from '../../assets/startup/kun-startup-avatar-dash.webp'
import kunAvatarFocusUrl from '../../assets/startup/kun-startup-avatar-focus.webp'
import kunAvatarUrl from '../../assets/startup/kun-startup-avatar.webp'
import kunAvatarWaveUrl from '../../assets/startup/kun-startup-avatar-wave.webp'
import kunBirdCastUrl from '../../assets/startup/kun-startup-bird-cast.webp'
import kunBirdDashUrl from '../../assets/startup/kun-startup-bird-dash.webp'
import kunBirdFocusUrl from '../../assets/startup/kun-startup-bird-focus.webp'
import kunBirdUrl from '../../assets/startup/kun-startup-bird.webp'
import kunBirdWaveUrl from '../../assets/startup/kun-startup-bird-wave.webp'

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
  birdUrl: string
}>

export const KUN_STARTUP_VARIANT_CONFIG: Readonly<
  Record<KunStartupVariant, KunStartupVariantConfig>
> = {
  signal: { avatarUrl: kunAvatarUrl, birdUrl: kunBirdUrl },
  wave: { avatarUrl: kunAvatarWaveUrl, birdUrl: kunBirdWaveUrl },
  dash: { avatarUrl: kunAvatarDashUrl, birdUrl: kunBirdDashUrl },
  focus: { avatarUrl: kunAvatarFocusUrl, birdUrl: kunBirdFocusUrl },
  cast: { avatarUrl: kunAvatarCastUrl, birdUrl: kunBirdCastUrl }
}

/** Selects one evenly weighted variant from a Math.random-compatible value. */
export function selectKunStartupVariant(randomValue: number = Math.random()): KunStartupVariant {
  if (!Number.isFinite(randomValue)) return KUN_STARTUP_VARIANTS[0]
  const boundedValue = Math.min(Math.max(randomValue, 0), 1 - Number.EPSILON)
  const index = Math.floor(boundedValue * KUN_STARTUP_VARIANTS.length)
  return KUN_STARTUP_VARIANTS[index]
}
