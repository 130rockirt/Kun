import {
  UI_PLUGIN_BACKGROUND_FITS,
  UI_PLUGIN_BACKGROUND_POSITIONS,
  UI_PLUGIN_BACKGROUND_SLOTS,
  UI_PLUGIN_BACKGROUND_THEMES,
  UI_PLUGIN_FIGURE_SLOTS,
  UI_PLUGIN_ID_PATTERN,
  UI_PLUGIN_LABEL_KEYS,
  UI_PLUGIN_LIMITS,
  UI_PLUGIN_RESERVED_IDS,
  UI_PLUGIN_SCENE_API_VERSION,
  UI_PLUGIN_SCENE_ARTWORK_SLOTS,
  UI_PLUGIN_SCENE_CHARACTER_MASKS,
  UI_PLUGIN_SCENE_CHARACTER_MOTIONS,
  UI_PLUGIN_SCENE_CHARACTER_SCALES,
  UI_PLUGIN_SCENE_CHROME_RECIPES,
  UI_PLUGIN_SCENE_LAYOUTS,
  UI_PLUGIN_TOKEN_NAME_PATTERN,
  UI_PLUGIN_TOKEN_VALUE_PATTERN,
  UI_PLUGIN_VERSION_PATTERN,
  UiPluginBackgroundLayer,
  UiPluginBackgroundSlot,
  UiPluginBackgroundTheme,
  UiPluginBackgrounds,
  UiPluginFigureSlot,
  UiPluginLabelKey,
  UiPluginManifestV1,
  UiPluginSceneArtworkSlot,
  UiPluginSceneV16,
  UiPluginValidationResult
} from './ui-plugin-contract'
import {
  isPlainObject,
  isSafeUiPluginFigurePath,
  normalizeUiPluginBackgroundLayer,
  normalizeUiPluginPresentation,
  normalizeUiPluginSceneArtworkLayer,
  normalizeUiPluginSceneMotion,
  readRequiredEnum,
  readRequiredInteger,
  readRequiredUnitNumber,
  readTrimmedString,
  rejectUnknownKeys
} from './ui-plugin-presentation'

export function normalizeUiPluginScene(raw: unknown, errors: string[]): UiPluginSceneV16 | null {
  if (!isPlainObject(raw)) {
    errors.push('scene 需为对象')
    return null
  }
  let valid = rejectUnknownKeys(
    raw,
    ['apiVersion', 'layout', 'character', 'artwork', 'chrome'],
    'scene',
    errors
  )
  if (raw.apiVersion !== UI_PLUGIN_SCENE_API_VERSION) {
    errors.push(`scene.apiVersion 仅支持 ${UI_PLUGIN_SCENE_API_VERSION}`)
    valid = false
  }
  const layout = readRequiredEnum(raw.layout, UI_PLUGIN_SCENE_LAYOUTS, 'scene.layout', errors)

  const character = raw.character
  if (!isPlainObject(character)) {
    errors.push('scene.character 需为对象')
    valid = false
  }
  const artwork = raw.artwork
  if (!isPlainObject(artwork)) {
    errors.push('scene.artwork 需为对象')
    valid = false
  }
  const chrome = raw.chrome
  if (!isPlainObject(chrome)) {
    errors.push('scene.chrome 需为对象')
    valid = false
  }
  if (!isPlainObject(character) || !isPlainObject(artwork) || !isPlainObject(chrome)) {
    return null
  }

  valid = rejectUnknownKeys(
    character,
    [
      'scale',
      'fit',
      'focalPoint',
      'mask',
      'offsetX',
      'offsetY',
      'opacity',
      'flipX',
      'motion'
    ],
    'scene.character',
    errors
  ) && valid
  const scale = readRequiredEnum(
    character.scale,
    UI_PLUGIN_SCENE_CHARACTER_SCALES,
    'scene.character.scale',
    errors
  )
  const fit = readRequiredEnum(
    character.fit,
    UI_PLUGIN_BACKGROUND_FITS,
    'scene.character.fit',
    errors
  )
  const focalPoint = readRequiredEnum(
    character.focalPoint,
    UI_PLUGIN_BACKGROUND_POSITIONS,
    'scene.character.focalPoint',
    errors
  )
  const mask = readRequiredEnum(
    character.mask,
    UI_PLUGIN_SCENE_CHARACTER_MASKS,
    'scene.character.mask',
    errors
  )
  const offsetX = readRequiredInteger(
    character.offsetX,
    -12,
    12,
    'scene.character.offsetX',
    errors
  )
  const offsetY = readRequiredInteger(
    character.offsetY,
    -12,
    12,
    'scene.character.offsetY',
    errors
  )
  const opacity = readRequiredUnitNumber(
    character.opacity,
    'scene.character.opacity',
    errors
  )
  const flipX = character.flipX
  if (typeof flipX !== 'boolean') {
    errors.push('scene.character.flipX 需为 boolean')
    valid = false
  }
  const characterMotion = normalizeUiPluginSceneMotion(
    character.motion,
    UI_PLUGIN_SCENE_CHARACTER_MOTIONS,
    'scene.character.motion',
    errors
  )

  valid = rejectUnknownKeys(
    artwork,
    UI_PLUGIN_SCENE_ARTWORK_SLOTS,
    'scene.artwork',
    errors
  ) && valid
  const normalizedArtwork: UiPluginSceneV16['artwork'] = {}
  for (const [slot, layerRaw] of Object.entries(artwork)) {
    if (!(UI_PLUGIN_SCENE_ARTWORK_SLOTS as readonly string[]).includes(slot)) continue
    const layer = normalizeUiPluginSceneArtworkLayer(
      layerRaw,
      slot as UiPluginSceneArtworkSlot,
      errors
    )
    if (layer) normalizedArtwork[slot as UiPluginSceneArtworkSlot] = layer
  }
  if (Object.keys(normalizedArtwork).length === 0) {
    errors.push('scene.artwork 至少需要声明一个专属图片槽位')
    valid = false
  }

  valid = rejectUnknownKeys(
    chrome,
    ['sidebar', 'topbar', 'composer', 'cards'],
    'scene.chrome',
    errors
  ) && valid
  const sidebar = readRequiredEnum(
    chrome.sidebar,
    UI_PLUGIN_SCENE_CHROME_RECIPES,
    'scene.chrome.sidebar',
    errors
  )
  const topbar = readRequiredEnum(
    chrome.topbar,
    UI_PLUGIN_SCENE_CHROME_RECIPES,
    'scene.chrome.topbar',
    errors
  )
  const composer = readRequiredEnum(
    chrome.composer,
    UI_PLUGIN_SCENE_CHROME_RECIPES,
    'scene.chrome.composer',
    errors
  )
  const cards = readRequiredEnum(
    chrome.cards,
    UI_PLUGIN_SCENE_CHROME_RECIPES,
    'scene.chrome.cards',
    errors
  )

  if (
    !valid ||
    layout === null ||
    scale === null ||
    fit === null ||
    focalPoint === null ||
    mask === null ||
    offsetX === null ||
    offsetY === null ||
    opacity === null ||
    typeof flipX !== 'boolean' ||
    characterMotion === null ||
    sidebar === null ||
    topbar === null ||
    composer === null ||
    cards === null
  ) {
    return null
  }

  return {
    apiVersion: UI_PLUGIN_SCENE_API_VERSION,
    layout,
    character: {
      scale,
      fit,
      focalPoint,
      mask,
      offsetX,
      offsetY,
      opacity,
      flipX,
      motion: characterMotion
    },
    artwork: normalizedArtwork,
    chrome: { sidebar, topbar, composer, cards }
  }
}

export function normalizeUiPluginManifest(raw: unknown): UiPluginValidationResult {
  const errors: string[] = []
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['manifest.json 必须是 JSON 对象'] }
  }

  const id = readTrimmedString(raw.id, 40)
  if (!id || !UI_PLUGIN_ID_PATTERN.test(id)) {
    errors.push('id 需为 2-40 位小写字母/数字/连字符,且以字母或数字开头')
  } else if (UI_PLUGIN_RESERVED_IDS.has(id)) {
    errors.push(`id "${id}" 是保留字`)
  }

  const name = readTrimmedString(raw.name, 60)
  if (!name) errors.push('name 必填(≤60 字符)')

  const version = readTrimmedString(raw.version, 60)
  if (!version || !UI_PLUGIN_VERSION_PATTERN.test(version)) {
    errors.push('version 需为语义化版本号,如 1.0.0')
  }

  const author = readTrimmedString(raw.author, 80) ?? undefined
  if (raw.author !== undefined && author === undefined) errors.push('author 过长(≤80 字符)')
  const description = readTrimmedString(raw.description, 240) ?? undefined
  if (raw.description !== undefined && description === undefined) {
    errors.push('description 过长(≤240 字符)')
  }

  const figures: Partial<Record<UiPluginFigureSlot, string>> = {}
  if (raw.figures !== undefined && !isPlainObject(raw.figures)) {
    errors.push('figures 需为形象槽位对象')
  } else if (isPlainObject(raw.figures)) {
    for (const [slot, value] of Object.entries(raw.figures)) {
      if (!(UI_PLUGIN_FIGURE_SLOTS as readonly string[]).includes(slot)) {
        errors.push(`未知形象槽位 "${slot}"`)
        continue
      }
      if (typeof value !== 'string' || !isSafeUiPluginFigurePath(value.trim())) {
        errors.push(`槽位 "${slot}" 的图片路径不合法(需为插件内相对路径,png/webp/jpg/gif)`)
        continue
      }
      figures[slot as UiPluginFigureSlot] = value.trim()
    }
  }

  const backgrounds: UiPluginBackgrounds = {}
  if (raw.backgrounds !== undefined) {
    if (!isPlainObject(raw.backgrounds)) {
      errors.push('backgrounds 需为对象,如 { "light": { "app": "img/bg.png" } }')
    } else {
      for (const [theme, entries] of Object.entries(raw.backgrounds)) {
        if (!(UI_PLUGIN_BACKGROUND_THEMES as readonly string[]).includes(theme)) {
          errors.push(`backgrounds 不支持主题 "${theme}"`)
          continue
        }
        if (!isPlainObject(entries)) {
          errors.push(`backgrounds.${theme} 需为对象`)
          continue
        }
        const normalized: Partial<Record<UiPluginBackgroundSlot, UiPluginBackgroundLayer>> = {}
        for (const [slot, layerRaw] of Object.entries(entries)) {
          if (!(UI_PLUGIN_BACKGROUND_SLOTS as readonly string[]).includes(slot)) {
            errors.push(`backgrounds.${theme} 不支持槽位 "${slot}"`)
            continue
          }
          const layer = normalizeUiPluginBackgroundLayer(
            layerRaw,
            theme as UiPluginBackgroundTheme,
            slot as UiPluginBackgroundSlot,
            errors
          )
          if (layer) normalized[slot as UiPluginBackgroundSlot] = layer
        }
        if (Object.keys(normalized).length > 0) {
          backgrounds[theme as UiPluginBackgroundTheme] = normalized
        }
      }
    }
  }

  const backgroundCount = Object.values(backgrounds).reduce(
    (count, theme) => count + Object.keys(theme ?? {}).length,
    0
  )
  if (Object.keys(figures).length === 0 && backgroundCount === 0) {
    errors.push('figures 与 backgrounds 至少需要声明一个合法图片资源')
  }

  let presentation: UiPluginManifestV1['presentation']
  if (raw.presentation !== undefined) {
    presentation = normalizeUiPluginPresentation(raw.presentation, errors) ?? undefined
    if (!figures.portrait) {
      errors.push('presentation 需要同时声明 figures.portrait 人物图片')
    }
  }

  let scene: UiPluginManifestV1['scene']
  if (raw.scene !== undefined) {
    scene = normalizeUiPluginScene(raw.scene, errors) ?? undefined
    if (!figures.portrait) {
      errors.push('scene 需要同时声明 figures.portrait 人物图片')
    }
    if (!presentation) {
      errors.push('scene 需要同时声明 presentation 作为 v1.5 fallback')
    }
  }

  let labels: UiPluginManifestV1['labels']
  if (raw.labels !== undefined) {
    if (!isPlainObject(raw.labels)) {
      errors.push('labels 需为对象,如 { "zh": { "working": "巡航中…" } }')
    } else {
      labels = {}
      for (const [locale, entries] of Object.entries(raw.labels)) {
        if (locale !== 'zh' && locale !== 'en') {
          errors.push(`labels 不支持语言 "${locale}"`)
          continue
        }
        if (!isPlainObject(entries)) {
          errors.push(`labels.${locale} 需为对象`)
          continue
        }
        const normalized: Partial<Record<UiPluginLabelKey, string>> = {}
        for (const [key, text] of Object.entries(entries)) {
          if (!(UI_PLUGIN_LABEL_KEYS as readonly string[]).includes(key)) {
            errors.push(`labels.${locale} 不支持键 "${key}"`)
            continue
          }
          const label = readTrimmedString(text, UI_PLUGIN_LIMITS.labelChars)
          if (!label) {
            errors.push(`labels.${locale}.${key} 需为 1-${UI_PLUGIN_LIMITS.labelChars} 字符文本`)
            continue
          }
          normalized[key as UiPluginLabelKey] = label
        }
        labels[locale] = normalized
      }
    }
  }

  let tokens: UiPluginManifestV1['tokens']
  if (raw.tokens !== undefined) {
    if (!isPlainObject(raw.tokens)) {
      errors.push('tokens 需为对象,如 { "light": { "--ds-accent": "#8a63e8" } }')
    } else {
      tokens = {}
      let tokenCount = 0
      for (const [theme, entries] of Object.entries(raw.tokens)) {
        if (theme !== 'light' && theme !== 'dark') {
          errors.push(`tokens 不支持主题 "${theme}"`)
          continue
        }
        if (!isPlainObject(entries)) {
          errors.push(`tokens.${theme} 需为对象`)
          continue
        }
        const normalized: Record<string, string> = {}
        for (const [tokenName, tokenValue] of Object.entries(entries)) {
          tokenCount += 1
          if (tokenCount > UI_PLUGIN_LIMITS.tokenEntries) {
            errors.push(`tokens 数量超过上限 ${UI_PLUGIN_LIMITS.tokenEntries}`)
            break
          }
          if (!UI_PLUGIN_TOKEN_NAME_PATTERN.test(tokenName)) {
            errors.push(`token "${tokenName}" 不在 --ds-* 白名单内`)
            continue
          }
          if (
            typeof tokenValue !== 'string' ||
            /url\s*\(/i.test(tokenValue) ||
            !UI_PLUGIN_TOKEN_VALUE_PATTERN.test(tokenValue.trim())
          ) {
            errors.push(`token "${tokenName}" 的值包含不允许的字符`)
            continue
          }
          normalized[tokenName] = tokenValue.trim()
        }
        tokens[theme] = normalized
      }
    }
  }

  let features: UiPluginManifestV1['features']
  if (raw.features !== undefined) {
    if (!isPlainObject(raw.features)) {
      errors.push('features 需为对象')
    } else {
      features = { cameos: raw.features.cameos === true }
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    manifest: {
      id: id as string,
      name: name as string,
      version: version as string,
      ...(author ? { author } : {}),
      ...(description ? { description } : {}),
      figures,
      ...(Object.keys(backgrounds).length > 0 ? { backgrounds } : {}),
      ...(presentation ? { presentation } : {}),
      ...(scene ? { scene } : {}),
      ...(labels && Object.keys(labels).length > 0 ? { labels } : {}),
      ...(tokens && Object.keys(tokens).length > 0 ? { tokens } : {}),
      ...(features ? { features } : {})
    }
  }
}
