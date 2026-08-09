import {
  UI_PLUGIN_ASSET_PATH_PATTERN,
  UI_PLUGIN_BACKGROUND_EXTENSIONS,
  UI_PLUGIN_BACKGROUND_FITS,
  UI_PLUGIN_BACKGROUND_POSITIONS,
  UI_PLUGIN_CHARACTER_ANCHORS,
  UI_PLUGIN_CHARACTER_FRAMES,
  UI_PLUGIN_CHARACTER_MOTIONS,
  UI_PLUGIN_CHARACTER_SIZES,
  UI_PLUGIN_CONTENT_RESERVES,
  UI_PLUGIN_FIGURE_EXTENSIONS,
  UI_PLUGIN_READABILITY_SCRIMS,
  UI_PLUGIN_READABILITY_STRENGTHS,
  UI_PLUGIN_SCENE_ARTWORK_BLENDS,
  UI_PLUGIN_SCENE_ARTWORK_MOTIONS,
  UI_PLUGIN_SCENE_ARTWORK_SIZES,
  UI_PLUGIN_SCENE_MOTION_PHASES,
  UI_PLUGIN_SCENE_MOTION_SPEEDS,
  UI_PLUGIN_SURFACE_MATERIALS,
  UiPluginBackgroundFit,
  UiPluginBackgroundLayer,
  UiPluginBackgroundPosition,
  UiPluginBackgroundSlot,
  UiPluginBackgroundTheme,
  UiPluginPresentation,
  UiPluginSceneArtworkLayer,
  UiPluginSceneArtworkSlot,
  UiPluginSceneMotion
} from './ui-plugin-contract'

export function isSafeUiPluginAssetPath(value: string, extensions: ReadonlySet<string>): boolean {
  if (!UI_PLUGIN_ASSET_PATH_PATTERN.test(value)) return false
  if (value.includes('\\')) return false
  const segments = value.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return false
  }
  const extension = segments[segments.length - 1]?.split('.').pop()?.toLowerCase() ?? ''
  return extensions.has(extension)
}

export function isSafeUiPluginFigurePath(value: string): boolean {
  return isSafeUiPluginAssetPath(value, UI_PLUGIN_FIGURE_EXTENSIONS)
}

export function isSafeUiPluginBackgroundPath(value: string): boolean {
  return isSafeUiPluginAssetPath(value, UI_PLUGIN_BACKGROUND_EXTENSIONS)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readTrimmedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

export const UI_PLUGIN_BACKGROUND_DEFAULT_OPACITY: Readonly<
  Record<UiPluginBackgroundSlot, number>
> = {
  app: 0.22,
  sidebar: 0.18,
  composer: 1,
  stage: 0.32,
  write: 0.5,
  design: 0.5
}

export function normalizeUiPluginBackgroundLayer(
  raw: unknown,
  theme: UiPluginBackgroundTheme,
  slot: UiPluginBackgroundSlot,
  errors: string[]
): UiPluginBackgroundLayer | null {
  const prefix = `backgrounds.${theme}.${slot}`
  if (typeof raw === 'string') {
    const path = raw.trim()
    if (!isSafeUiPluginBackgroundPath(path)) {
      errors.push(`${prefix} 的图片路径不合法(需为插件内相对路径,png/webp/jpg/jpeg)`)
      return null
    }
    return {
      path,
      fit: 'cover',
      position: 'center',
      opacity: UI_PLUGIN_BACKGROUND_DEFAULT_OPACITY[slot]
    }
  }

  if (!isPlainObject(raw)) {
    errors.push(`${prefix} 需为图片路径字符串或背景层对象`)
    return null
  }

  let valid = true
  const allowedKeys = new Set(['path', 'fit', 'position', 'opacity'])
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      errors.push(`${prefix} 不支持键 "${key}"`)
      valid = false
    }
  }

  const path = typeof raw.path === 'string' ? raw.path.trim() : ''
  if (!isSafeUiPluginBackgroundPath(path)) {
    errors.push(`${prefix}.path 不合法(需为插件内相对路径,png/webp/jpg/jpeg)`)
    valid = false
  }

  let fit: UiPluginBackgroundFit = 'cover'
  if (raw.fit !== undefined) {
    if (!(UI_PLUGIN_BACKGROUND_FITS as readonly unknown[]).includes(raw.fit)) {
      errors.push(`${prefix}.fit 仅支持 cover 或 contain`)
      valid = false
    } else {
      fit = raw.fit as UiPluginBackgroundFit
    }
  }

  let position: UiPluginBackgroundPosition = 'center'
  if (raw.position !== undefined) {
    if (!(UI_PLUGIN_BACKGROUND_POSITIONS as readonly unknown[]).includes(raw.position)) {
      errors.push(`${prefix}.position 不是支持的九宫格位置`)
      valid = false
    } else {
      position = raw.position as UiPluginBackgroundPosition
    }
  }

  let opacity = UI_PLUGIN_BACKGROUND_DEFAULT_OPACITY[slot]
  if (raw.opacity !== undefined) {
    if (typeof raw.opacity !== 'number' || !Number.isFinite(raw.opacity) || raw.opacity < 0 || raw.opacity > 1) {
      errors.push(`${prefix}.opacity 需为 0-1 的有限数字`)
      valid = false
    } else {
      opacity = raw.opacity
    }
  }

  return valid ? { path, fit, position, opacity } : null
}

export function rejectUnknownKeys(
  raw: Record<string, unknown>,
  allowedKeys: readonly string[],
  prefix: string,
  errors: string[]
): boolean {
  let valid = true
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push(`${prefix} 不支持键 "${key}"`)
      valid = false
    }
  }
  return valid
}

export function readRequiredEnum<T extends string>(
  raw: unknown,
  values: readonly T[],
  path: string,
  errors: string[]
): T | null {
  if (typeof raw !== 'string' || !values.includes(raw as T)) {
    errors.push(`${path} 仅支持 ${values.join('、')}`)
    return null
  }
  return raw as T
}

export function readRequiredInteger(
  raw: unknown,
  min: number,
  max: number,
  path: string,
  errors: string[]
): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    errors.push(`${path} 需为 ${min} 到 ${max} 的整数`)
    return null
  }
  return raw
}

export function readRequiredUnitNumber(
  raw: unknown,
  path: string,
  errors: string[]
): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    errors.push(`${path} 需为 0-1 的有限数字`)
    return null
  }
  return raw
}

export function normalizeUiPluginPresentation(
  raw: unknown,
  errors: string[]
): UiPluginPresentation | null {
  if (!isPlainObject(raw)) {
    errors.push('presentation 需为对象')
    return null
  }

  let valid = rejectUnknownKeys(raw, ['character', 'readability', 'surfaces'], 'presentation', errors)
  const character = raw.character
  const readability = raw.readability
  const surfaces = raw.surfaces

  if (!isPlainObject(character)) {
    errors.push('presentation.character 需为对象')
    valid = false
  }
  if (!isPlainObject(readability)) {
    errors.push('presentation.readability 需为对象')
    valid = false
  }
  if (!isPlainObject(surfaces)) {
    errors.push('presentation.surfaces 需为对象')
    valid = false
  }
  if (!isPlainObject(character) || !isPlainObject(readability) || !isPlainObject(surfaces)) {
    return null
  }

  valid =
    rejectUnknownKeys(
      character,
      ['anchor', 'size', 'offsetX', 'offsetY', 'opacity', 'frame', 'motion', 'contentReserve'],
      'presentation.character',
      errors
    ) && valid
  valid =
    rejectUnknownKeys(readability, ['scrim', 'strength'], 'presentation.readability', errors) &&
    valid
  valid =
    rejectUnknownKeys(
      surfaces,
      ['sidebar', 'topbar', 'composer', 'cards'],
      'presentation.surfaces',
      errors
    ) && valid

  const anchor = readRequiredEnum(
    character.anchor,
    UI_PLUGIN_CHARACTER_ANCHORS,
    'presentation.character.anchor',
    errors
  )
  const size = readRequiredEnum(
    character.size,
    UI_PLUGIN_CHARACTER_SIZES,
    'presentation.character.size',
    errors
  )
  const offsetX = readRequiredInteger(
    character.offsetX,
    -12,
    12,
    'presentation.character.offsetX',
    errors
  )
  const offsetY = readRequiredInteger(
    character.offsetY,
    -12,
    12,
    'presentation.character.offsetY',
    errors
  )
  const opacity = readRequiredUnitNumber(
    character.opacity,
    'presentation.character.opacity',
    errors
  )
  const frame = readRequiredEnum(
    character.frame,
    UI_PLUGIN_CHARACTER_FRAMES,
    'presentation.character.frame',
    errors
  )
  const motion = readRequiredEnum(
    character.motion,
    UI_PLUGIN_CHARACTER_MOTIONS,
    'presentation.character.motion',
    errors
  )
  const contentReserve = readRequiredEnum(
    character.contentReserve,
    UI_PLUGIN_CONTENT_RESERVES,
    'presentation.character.contentReserve',
    errors
  )
  const scrim = readRequiredEnum(
    readability.scrim,
    UI_PLUGIN_READABILITY_SCRIMS,
    'presentation.readability.scrim',
    errors
  )
  const strength = readRequiredEnum(
    readability.strength,
    UI_PLUGIN_READABILITY_STRENGTHS,
    'presentation.readability.strength',
    errors
  )
  const sidebar = readRequiredEnum(
    surfaces.sidebar,
    UI_PLUGIN_SURFACE_MATERIALS,
    'presentation.surfaces.sidebar',
    errors
  )
  const topbar = readRequiredEnum(
    surfaces.topbar,
    UI_PLUGIN_SURFACE_MATERIALS,
    'presentation.surfaces.topbar',
    errors
  )
  const composer = readRequiredEnum(
    surfaces.composer,
    UI_PLUGIN_SURFACE_MATERIALS,
    'presentation.surfaces.composer',
    errors
  )
  const cards = readRequiredEnum(
    surfaces.cards,
    UI_PLUGIN_SURFACE_MATERIALS,
    'presentation.surfaces.cards',
    errors
  )

  if (
    !valid ||
    anchor === null ||
    size === null ||
    offsetX === null ||
    offsetY === null ||
    opacity === null ||
    frame === null ||
    motion === null ||
    contentReserve === null ||
    scrim === null ||
    strength === null ||
    sidebar === null ||
    topbar === null ||
    composer === null ||
    cards === null
  ) {
    return null
  }

  return {
    character: { anchor, size, offsetX, offsetY, opacity, frame, motion, contentReserve },
    readability: { scrim, strength },
    surfaces: { sidebar, topbar, composer, cards }
  }
}

export function normalizeUiPluginSceneMotion<TPreset extends string>(
  raw: unknown,
  presets: readonly TPreset[],
  path: string,
  errors: string[]
): UiPluginSceneMotion<TPreset> | null {
  if (!isPlainObject(raw)) {
    errors.push(`${path} 需为对象`)
    return null
  }
  let valid = rejectUnknownKeys(raw, ['preset', 'speed', 'phase'], path, errors)
  const preset = readRequiredEnum(raw.preset, presets, `${path}.preset`, errors)
  const speed = readRequiredEnum(raw.speed, UI_PLUGIN_SCENE_MOTION_SPEEDS, `${path}.speed`, errors)
  const phase = readRequiredEnum(raw.phase, UI_PLUGIN_SCENE_MOTION_PHASES, `${path}.phase`, errors)
  valid = valid && preset !== null && speed !== null && phase !== null
  return valid && preset && speed && phase ? { preset, speed, phase } : null
}

export function normalizeUiPluginSceneArtworkLayer(
  raw: unknown,
  slot: UiPluginSceneArtworkSlot,
  errors: string[]
): UiPluginSceneArtworkLayer | null {
  const prefix = `scene.artwork.${slot}`
  if (!isPlainObject(raw)) {
    errors.push(`${prefix} 需为对象`)
    return null
  }
  let valid = rejectUnknownKeys(
    raw,
    [
      'path',
      'darkPath',
      'anchor',
      'size',
      'fit',
      'offsetX',
      'offsetY',
      'opacity',
      'blend',
      'motion'
    ],
    prefix,
    errors
  )

  const path = typeof raw.path === 'string' ? raw.path.trim() : ''
  if (!isSafeUiPluginBackgroundPath(path)) {
    errors.push(`${prefix}.path 不合法(需为插件内静态 png/webp/jpg/jpeg 相对路径)`)
    valid = false
  }
  let darkPath: string | undefined
  if (raw.darkPath !== undefined) {
    darkPath = typeof raw.darkPath === 'string' ? raw.darkPath.trim() : ''
    if (!isSafeUiPluginBackgroundPath(darkPath)) {
      errors.push(`${prefix}.darkPath 不合法(需为插件内静态 png/webp/jpg/jpeg 相对路径)`)
      valid = false
    }
  }

  const anchor = readRequiredEnum(
    raw.anchor,
    UI_PLUGIN_BACKGROUND_POSITIONS,
    `${prefix}.anchor`,
    errors
  )
  const size = readRequiredEnum(raw.size, UI_PLUGIN_SCENE_ARTWORK_SIZES, `${prefix}.size`, errors)
  const fit = readRequiredEnum(raw.fit, UI_PLUGIN_BACKGROUND_FITS, `${prefix}.fit`, errors)
  const offsetX = readRequiredInteger(raw.offsetX, -12, 12, `${prefix}.offsetX`, errors)
  const offsetY = readRequiredInteger(raw.offsetY, -12, 12, `${prefix}.offsetY`, errors)
  const opacity = readRequiredUnitNumber(raw.opacity, `${prefix}.opacity`, errors)
  const blend = readRequiredEnum(
    raw.blend,
    UI_PLUGIN_SCENE_ARTWORK_BLENDS,
    `${prefix}.blend`,
    errors
  )
  if (blend && blend !== 'normal' && slot !== 'backdrop' && slot !== 'ambient') {
    errors.push(`${prefix}.blend 仅 backdrop/ambient 可使用 screen 或 soft-light`)
    valid = false
  }
  const motion = normalizeUiPluginSceneMotion(
    raw.motion,
    UI_PLUGIN_SCENE_ARTWORK_MOTIONS,
    `${prefix}.motion`,
    errors
  )

  if (
    !valid ||
    !path ||
    anchor === null ||
    size === null ||
    fit === null ||
    offsetX === null ||
    offsetY === null ||
    opacity === null ||
    blend === null ||
    motion === null
  ) {
    return null
  }

  return {
    path,
    ...(darkPath ? { darkPath } : {}),
    anchor,
    size,
    fit,
    offsetX,
    offsetY,
    opacity,
    blend,
    motion
  }
}
