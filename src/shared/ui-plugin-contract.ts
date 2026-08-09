/**
 * UI 插件(形象工坊)规范 v1。
 *
 * 一个 UI 插件 = 一个文件夹:manifest.json + 若干图片。
 * 纯声明式 —— 不允许任何 JS / HTML / 自定义 CSS 执行;
 * 图片由主进程读取并校验,主题 token 仅允许 --ds-* 白名单。
 * 主题样式只能由宿主生成,再由主进程通过短生命周期 CDP 会话注入;
 * 插件本身不能提供或执行 CSS / JS。
 */

export const UI_PLUGIN_MANIFEST_FILENAME = 'manifest.json'

/** 形象槽位:缺失的槽位回退默认 Kun 美术(允许"半皮肤") */
export const UI_PLUGIN_FIGURE_SLOTS = [
  'portrait',
  'swim',
  'surf',
  'greet',
  'sleep',
  'sit',
  'run',
  'toggleIcon'
] as const

export type UiPluginFigureSlot = (typeof UI_PLUGIN_FIGURE_SLOTS)[number]

/**
 * 人物主题舞台只接受宿主枚举。插件不能提供选择器、CSS 或任意布局字符串。
 */
export const UI_PLUGIN_CHARACTER_ANCHORS = ['top-right', 'right', 'bottom-right'] as const

export type UiPluginCharacterAnchor = (typeof UI_PLUGIN_CHARACTER_ANCHORS)[number]

export const UI_PLUGIN_CHARACTER_SIZES = ['medium', 'large', 'hero'] as const

export type UiPluginCharacterSize = (typeof UI_PLUGIN_CHARACTER_SIZES)[number]

export const UI_PLUGIN_CHARACTER_FRAMES = [
  'soft-card',
  'paper',
  'crystal',
  'hologram',
  'backstage',
  'portal',
  'polaroid',
  'ticket',
  'seal'
] as const

export type UiPluginCharacterFrame = (typeof UI_PLUGIN_CHARACTER_FRAMES)[number]

export const UI_PLUGIN_CHARACTER_MOTIONS = ['none', 'breathe', 'float'] as const

export type UiPluginCharacterMotion = (typeof UI_PLUGIN_CHARACTER_MOTIONS)[number]

export const UI_PLUGIN_CONTENT_RESERVES = ['none', 'narrow', 'wide'] as const

export type UiPluginContentReserve = (typeof UI_PLUGIN_CONTENT_RESERVES)[number]

export const UI_PLUGIN_READABILITY_SCRIMS = ['none', 'opposite-character', 'full'] as const

export type UiPluginReadabilityScrim = (typeof UI_PLUGIN_READABILITY_SCRIMS)[number]

export const UI_PLUGIN_READABILITY_STRENGTHS = ['soft', 'medium', 'strong'] as const

export type UiPluginReadabilityStrength = (typeof UI_PLUGIN_READABILITY_STRENGTHS)[number]

export const UI_PLUGIN_SURFACE_MATERIALS = [
  'solid',
  'translucent',
  'glass',
  'strong-glass'
] as const

export type UiPluginSurfaceMaterial = (typeof UI_PLUGIN_SURFACE_MATERIALS)[number]

export type UiPluginPresentation = {
  character: {
    anchor: UiPluginCharacterAnchor
    size: UiPluginCharacterSize
    offsetX: number
    offsetY: number
    opacity: number
    frame: UiPluginCharacterFrame
    motion: UiPluginCharacterMotion
    contentReserve: UiPluginContentReserve
  }
  readability: {
    scrim: UiPluginReadabilityScrim
    strength: UiPluginReadabilityStrength
  }
  surfaces: {
    sidebar: UiPluginSurfaceMaterial
    topbar: UiPluginSurfaceMaterial
    composer: UiPluginSurfaceMaterial
    cards: UiPluginSurfaceMaterial
  }
}

/**
 * UI Plugin scene v1.6 is an additive, host-rendered scene description.
 * `presentation` remains the v1.5 fallback; older hosts can ignore this
 * top-level object without accepting plugin markup, CSS, or executable code.
 */
export const UI_PLUGIN_SCENE_API_VERSION = '1.6' as const

export const UI_PLUGIN_SCENE_LAYOUTS = [
  'rail-right',
  'rail-left',
  'card-right',
  'card-left',
  'backdrop-right',
  'backdrop-center'
] as const

export type UiPluginSceneLayout = (typeof UI_PLUGIN_SCENE_LAYOUTS)[number]

export const UI_PLUGIN_SCENE_CHARACTER_SCALES = ['compact', 'standard', 'hero'] as const

export type UiPluginSceneCharacterScale = (typeof UI_PLUGIN_SCENE_CHARACTER_SCALES)[number]

export const UI_PLUGIN_SCENE_CHARACTER_MASKS = [
  'none',
  'soft-card',
  'circle',
  'arch',
  'diamond',
  'hologram',
  'portal',
  'polaroid',
  'ticket'
] as const

export type UiPluginSceneCharacterMask = (typeof UI_PLUGIN_SCENE_CHARACTER_MASKS)[number]

export const UI_PLUGIN_SCENE_CHARACTER_MOTIONS = ['none', 'breathe', 'float', 'sway'] as const

export type UiPluginSceneCharacterMotion = (typeof UI_PLUGIN_SCENE_CHARACTER_MOTIONS)[number]

export const UI_PLUGIN_SCENE_ARTWORK_SLOTS = [
  'backdrop',
  'ambient',
  'frame',
  'foreground',
  'emblem'
] as const

export type UiPluginSceneArtworkSlot = (typeof UI_PLUGIN_SCENE_ARTWORK_SLOTS)[number]

export const UI_PLUGIN_SCENE_ARTWORK_SIZES = ['small', 'medium', 'large', 'full'] as const

export type UiPluginSceneArtworkSize = (typeof UI_PLUGIN_SCENE_ARTWORK_SIZES)[number]

export const UI_PLUGIN_SCENE_ARTWORK_BLENDS = ['normal', 'screen', 'soft-light'] as const

export type UiPluginSceneArtworkBlend = (typeof UI_PLUGIN_SCENE_ARTWORK_BLENDS)[number]

export const UI_PLUGIN_SCENE_ARTWORK_MOTIONS = [
  'none',
  'float',
  'drift-x',
  'drift-y',
  'pulse',
  'orbit',
  'twinkle',
  'scan'
] as const

export type UiPluginSceneArtworkMotion = (typeof UI_PLUGIN_SCENE_ARTWORK_MOTIONS)[number]

export const UI_PLUGIN_SCENE_MOTION_SPEEDS = ['slow', 'normal', 'fast'] as const

export type UiPluginSceneMotionSpeed = (typeof UI_PLUGIN_SCENE_MOTION_SPEEDS)[number]

export const UI_PLUGIN_SCENE_MOTION_PHASES = ['a', 'b', 'c'] as const

export type UiPluginSceneMotionPhase = (typeof UI_PLUGIN_SCENE_MOTION_PHASES)[number]

export const UI_PLUGIN_SCENE_CHROME_RECIPES = [
  'inherit',
  'soft',
  'editorial',
  'paper',
  'crystal',
  'hologram',
  'backstage',
  'portal',
  'polaroid',
  'ticket',
  'seal',
  'botanical',
  'fortune-ledger',
  'dream-gate',
  'washi',
  'scrapbook',
  'aurora',
  'synth',
  'midnight-pass',
  'nautical',
  'grand-line',
  'arc-reactor',
  'dimension-lab',
  'starlight'
] as const

export type UiPluginSceneChromeRecipe = (typeof UI_PLUGIN_SCENE_CHROME_RECIPES)[number]

export type UiPluginSceneMotion<TPreset extends string> = {
  preset: TPreset
  speed: UiPluginSceneMotionSpeed
  phase: UiPluginSceneMotionPhase
}

export type UiPluginSceneArtworkLayer = {
  path: string
  darkPath?: string
  anchor: UiPluginBackgroundPosition
  size: UiPluginSceneArtworkSize
  fit: UiPluginBackgroundFit
  offsetX: number
  offsetY: number
  opacity: number
  blend: UiPluginSceneArtworkBlend
  motion: UiPluginSceneMotion<UiPluginSceneArtworkMotion>
}

export type UiPluginSceneV16 = {
  apiVersion: typeof UI_PLUGIN_SCENE_API_VERSION
  layout: UiPluginSceneLayout
  character: {
    scale: UiPluginSceneCharacterScale
    fit: UiPluginBackgroundFit
    focalPoint: UiPluginBackgroundPosition
    mask: UiPluginSceneCharacterMask
    offsetX: number
    offsetY: number
    opacity: number
    flipX: boolean
    motion: UiPluginSceneMotion<UiPluginSceneCharacterMotion>
  }
  artwork: Partial<Record<UiPluginSceneArtworkSlot, UiPluginSceneArtworkLayer>>
  chrome: {
    sidebar: UiPluginSceneChromeRecipe
    topbar: UiPluginSceneChromeRecipe
    composer: UiPluginSceneChromeRecipe
    cards: UiPluginSceneChromeRecipe
  }
}

/** 可换肤的应用表面:整窗、侧栏、输入框、通用舞台，以及写作/设计专用工作面 */
export const UI_PLUGIN_BACKGROUND_SLOTS = [
  'app',
  'sidebar',
  'composer',
  'stage',
  'write',
  'design'
] as const

export type UiPluginBackgroundSlot = (typeof UI_PLUGIN_BACKGROUND_SLOTS)[number]

export const UI_PLUGIN_BACKGROUND_THEMES = ['light', 'dark'] as const

export type UiPluginBackgroundTheme = (typeof UI_PLUGIN_BACKGROUND_THEMES)[number]

export const UI_PLUGIN_BACKGROUND_FITS = ['cover', 'contain'] as const

export type UiPluginBackgroundFit = (typeof UI_PLUGIN_BACKGROUND_FITS)[number]

export const UI_PLUGIN_BACKGROUND_POSITIONS = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right'
] as const

export type UiPluginBackgroundPosition = (typeof UI_PLUGIN_BACKGROUND_POSITIONS)[number]

export type UiPluginBackgroundLayer = {
  /** 插件目录内的相对图片路径 */
  path: string
  fit: UiPluginBackgroundFit
  position: UiPluginBackgroundPosition
  opacity: number
}

export type UiPluginBackgrounds = Partial<
  Record<
    UiPluginBackgroundTheme,
    Partial<Record<UiPluginBackgroundSlot, UiPluginBackgroundLayer>>
  >
>

export const UI_PLUGIN_LABEL_KEYS = [
  'working',
  'workingSprint',
  'workingDive',
  'workingSurf'
] as const

export type UiPluginLabelKey = (typeof UI_PLUGIN_LABEL_KEYS)[number]

export type UiPluginLabelLocale = 'zh' | 'en'

export type UiPluginManifestV1 = {
  id: string
  name: string
  version: string
  author?: string
  description?: string
  /** 槽位 → 插件目录内的相对图片路径 */
  figures: Partial<Record<UiPluginFigureSlot, string>>
  /** 可选:按明暗主题和应用表面声明背景层 */
  backgrounds?: UiPluginBackgrounds
  /** 可选:由宿主固定组件渲染的人物主题舞台 */
  presentation?: UiPluginPresentation
  /** 可选:UI Plugin v1.6 固定图层人物场景;presentation 仍是旧宿主 fallback */
  scene?: UiPluginSceneV16
  /** 可选:进行中状态文案(按语言、按泳姿键) */
  labels?: Partial<Record<UiPluginLabelLocale, Partial<Record<UiPluginLabelKey, string>>>>
  /** 可选:主题 token 覆盖(仅 --ds-*) */
  tokens?: {
    light?: Record<string, string>
    dark?: Record<string, string>
  }
  features?: {
    /** 是否启用主会话两侧的出没彩蛋 */
    cameos?: boolean
  }
}

export type UiPluginListItem = {
  manifest: UiPluginManifestV1
  /** 列表预览 data URL:形象槽位优先,否则仅回退到满足严格预览预算的小型背景 */
  previewDataUrl: string | null
}

export type UiPluginRuntimeFigures = Partial<Record<UiPluginFigureSlot, string>>

/**
 * 主进程验证、读取后提供给渲染层的背景资源。
 *
 * 新运行时把同一路径的 data URL 只放入 assets 一次，避免 IPC 在多个槽位复用图片时
 * 重复序列化大字符串。light/dark 保留为旧运行时 shape 的兼容读取入口。
 */
export type UiPluginRuntimeBackgrounds = {
  assets?: Record<string, string>
  light?: Partial<Record<UiPluginBackgroundSlot, string>>
  dark?: Partial<Record<UiPluginBackgroundSlot, string>>
}

/** 主进程验证后的 v1.6 scene 图片，按 manifest 相对路径去重。 */
export type UiPluginRuntimeSceneAssets = {
  assets?: Record<string, string>
}

export type UiPluginValidationResult =
  | { ok: true; manifest: UiPluginManifestV1 }
  | { ok: false; errors: string[] }

export const UI_PLUGIN_LIMITS = {
  manifestBytes: 64 * 1024,
  figureBytes: 2 * 1024 * 1024,
  totalFigureBytes: 24 * 1024 * 1024,
  figureMaxDimension: 4096,
  figureMaxPixels: 12_000_000,
  totalFigurePixels: 48_000_000,
  portraitPreviewBytes: 96 * 1024,
  portraitPreviewMaxDimension: 256,
  backgroundBytes: 8 * 1024 * 1024,
  totalBackgroundBytes: 32 * 1024 * 1024,
  totalAssetBytes: 48 * 1024 * 1024,
  backgroundMaxDimension: 8192,
  backgroundMaxPixels: 24_000_000,
  totalBackgroundPixels: 64_000_000,
  sceneAssetBytes: 4 * 1024 * 1024,
  totalSceneAssetBytes: 16 * 1024 * 1024,
  sceneAssetMaxDimension: 4096,
  sceneAssetMaxPixels: 12_000_000,
  totalSceneAssetPixels: 40_000_000,
  tokenEntries: 60,
  labelChars: 24
} as const

export const UI_PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/

/**
 * 与内置模式、DOM 属性值保留字互斥。
 * 注意:'ikun' 不在保留字里 —— 内置的 iKun 模式本身就是一个预装 UI 插件
 * (见 src/main/ui-plugin-bundled.ts),id 为 'ikun' 时额外点亮
 * data-ikun-mode 的手工 CSS 机制。
 */
export const UI_PLUGIN_RESERVED_IDS = new Set(['default', 'kun', 'on', 'off', 'none'])

/** 预装示例插件(iKun)的 id:激活时会同时启用 data-ikun-mode 手工动画机制 */
export const UI_PLUGIN_BUNDLED_IKUN_ID = 'ikun'

export const UI_PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][\w.-]{0,40})?$/

export const UI_PLUGIN_ASSET_PATH_PATTERN = /^[\w][\w./-]{0,200}$/

export const UI_PLUGIN_FIGURE_EXTENSIONS = new Set(['png', 'webp', 'jpg', 'jpeg', 'gif'])

export const UI_PLUGIN_BACKGROUND_EXTENSIONS = new Set(['png', 'webp', 'jpg', 'jpeg'])

export const UI_PLUGIN_TOKEN_NAME_PATTERN = /^--ds-[a-z][a-z0-9-]{0,60}$/

/** 颜色/渐变等安全值:禁分号、花括号、url()、反斜杠 */
export const UI_PLUGIN_TOKEN_VALUE_PATTERN = /^[#a-zA-Z0-9(),.%\s/-]{1,120}$/
