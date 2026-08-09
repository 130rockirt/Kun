import {
  UI_PLUGIN_BACKGROUND_FITS,
  UI_PLUGIN_BACKGROUND_POSITIONS,
  UI_PLUGIN_BACKGROUND_SLOTS,
  UI_PLUGIN_BACKGROUND_THEMES,
  UI_PLUGIN_ID_PATTERN,
  UI_PLUGIN_SCENE_API_VERSION,
  UI_PLUGIN_SCENE_ARTWORK_SLOTS,
  UiPluginBackgroundPosition,
  UiPluginBackgroundSlot,
  UiPluginBackgroundTheme,
  UiPluginFigureSlot,
  UiPluginManifestV1,
  UiPluginRuntimeBackgrounds,
  UiPluginRuntimeFigures
} from './ui-plugin-contract'

/**
 * 这些容器会在 dark 下的嵌套作用域里整体重声明 palette token
 * (base-shell.css 的 `[data-theme='dark'] .ds-workbench-shell`),从而遮蔽
 * 注入在 <html> 上的插件 token —— 这正是对话区(Workbench)在 dark 下不吃
 * 插件配色的根因。对应 iKun 既有的
 * `[data-theme='dark'][data-ikun-mode='on'] .ds-workbench-shell` 处理。
 * '' = <html> 根自身;日后若有新容器整体重声明 token,在此追加后缀即可。
 */
export const TOKEN_SCOPE_ROOTS = ['', ' .ds-workbench-shell'] as const

/** 把单一锚点扩成「根 + 各重声明子作用域」的逗号选择器列表 */
export function scopedSelector(base: string): string {
  return TOKEN_SCOPE_ROOTS.map((suffix) => `${base}${suffix}`).join(',\n')
}

/**
 * 生成插件 token 的样式文本。选择器锚定 html[data-ui-plugin='<id>'],
 * light 块用 :not([data-theme='dark']) 守卫,避免在暗色下错误覆盖。
 * 选择器同时覆盖 .ds-workbench-shell 子作用域,确保对话区(dark 下会就地
 * 重声明 palette token)也能采纳插件 token。
 */
export function buildUiPluginTokenCss(manifest: UiPluginManifestV1): string {
  const blocks: string[] = []
  const lightEntries = Object.entries(manifest.tokens?.light ?? {})
  const darkEntries = Object.entries(manifest.tokens?.dark ?? {})
  if (lightEntries.length > 0) {
    const body = lightEntries.map(([key, value]) => `  ${key}: ${value};`).join('\n')
    const selector = scopedSelector(`html[data-ui-plugin='${manifest.id}']:not([data-theme='dark'])`)
    blocks.push(`${selector} {\n${body}\n}`)
  }
  if (darkEntries.length > 0) {
    const body = darkEntries.map(([key, value]) => `  ${key}: ${value};`).join('\n')
    const selector = scopedSelector(`html[data-ui-plugin='${manifest.id}'][data-theme='dark']`)
    blocks.push(`${selector} {\n${body}\n}`)
  }
  return blocks.join('\n\n')
}

/**
 * 只把已经归一化的数值布局参数变成宿主私有变量。枚举值始终由渲染层受控
 * data 属性和固定 CSS 消费，插件不能借此注入声明、选择器或 URL。
 */
export function buildUiPluginPresentationCss(manifest: UiPluginManifestV1): string {
  const presentation = manifest.presentation
  if (
    !presentation ||
    !UI_PLUGIN_ID_PATTERN.test(manifest.id) ||
    !Number.isInteger(presentation.character.offsetX) ||
    presentation.character.offsetX < -12 ||
    presentation.character.offsetX > 12 ||
    !Number.isInteger(presentation.character.offsetY) ||
    presentation.character.offsetY < -12 ||
    presentation.character.offsetY > 12 ||
    !Number.isFinite(presentation.character.opacity) ||
    presentation.character.opacity < 0 ||
    presentation.character.opacity > 1
  ) {
    return ''
  }

  return (
    `html[data-ui-plugin='${manifest.id}'] {\n` +
    `  --kun-ui-plugin-character-offset-x: ${presentation.character.offsetX}%;\n` +
    `  --kun-ui-plugin-character-offset-y: ${presentation.character.offsetY}%;\n` +
    `  --kun-ui-plugin-character-opacity: ${formatCssNumber(presentation.character.opacity)};\n` +
    `}`
  )
}

/**
 * Emits only bounded numeric variables for scene v1.6. Enum choices remain
 * host-owned data attributes/classes and scene image data stays out of CDP CSS.
 */
export function buildUiPluginSceneCss(manifest: UiPluginManifestV1): string {
  const scene = manifest.scene
  if (
    !scene ||
    !UI_PLUGIN_ID_PATTERN.test(manifest.id) ||
    scene.apiVersion !== UI_PLUGIN_SCENE_API_VERSION ||
    !Number.isInteger(scene.character.offsetX) ||
    scene.character.offsetX < -12 ||
    scene.character.offsetX > 12 ||
    !Number.isInteger(scene.character.offsetY) ||
    scene.character.offsetY < -12 ||
    scene.character.offsetY > 12 ||
    !Number.isFinite(scene.character.opacity) ||
    scene.character.opacity < 0 ||
    scene.character.opacity > 1
  ) {
    return ''
  }

  const declarations = [
    `  --kun-ui-plugin-scene-character-offset-x: ${scene.character.offsetX}%;`,
    `  --kun-ui-plugin-scene-character-offset-y: ${scene.character.offsetY}%;`,
    `  --kun-ui-plugin-scene-character-opacity: ${formatCssNumber(scene.character.opacity)};`
  ]
  for (const slot of UI_PLUGIN_SCENE_ARTWORK_SLOTS) {
    const layer = scene.artwork[slot]
    if (!layer) continue
    if (
      !Number.isInteger(layer.offsetX) ||
      layer.offsetX < -12 ||
      layer.offsetX > 12 ||
      !Number.isInteger(layer.offsetY) ||
      layer.offsetY < -12 ||
      layer.offsetY > 12 ||
      !Number.isFinite(layer.opacity) ||
      layer.opacity < 0 ||
      layer.opacity > 1
    ) {
      return ''
    }
    declarations.push(
      `  --kun-ui-plugin-scene-${slot}-offset-x: ${layer.offsetX}%;`,
      `  --kun-ui-plugin-scene-${slot}-offset-y: ${layer.offsetY}%;`,
      `  --kun-ui-plugin-scene-${slot}-opacity: ${formatCssNumber(layer.opacity)};`
    )
  }
  return `html[data-ui-plugin='${manifest.id}'] {\n${declarations.join('\n')}\n}`
}

export const UI_PLUGIN_BACKGROUND_DATA_URL_PATTERN =
  /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/

export function isSafeUiPluginBackgroundDataUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = UI_PLUGIN_BACKGROUND_DATA_URL_PATTERN.exec(value)
  return match !== null && match[1].length > 0 && match[1].length % 4 === 0
}

export function runtimeBackgroundDataUrl(
  runtimeBackgrounds: UiPluginRuntimeBackgrounds | null | undefined,
  theme: UiPluginBackgroundTheme,
  slot: UiPluginBackgroundSlot,
  relativePath: string
): string | undefined {
  const assets = runtimeBackgrounds?.assets
  if (assets && Object.prototype.hasOwnProperty.call(assets, relativePath)) {
    return assets[relativePath]
  }
  return runtimeBackgrounds?.[theme]?.[slot]
}

export const UI_PLUGIN_BACKGROUND_CSS_POSITION: Readonly<Record<UiPluginBackgroundPosition, string>> = {
  'top-left': 'left top',
  top: 'center top',
  'top-right': 'right top',
  left: 'left center',
  center: 'center center',
  right: 'right center',
  'bottom-left': 'left bottom',
  bottom: 'center bottom',
  'bottom-right': 'right bottom'
}

export const UI_PLUGIN_BACKGROUND_HOSTS: Readonly<
  Record<UiPluginBackgroundSlot, { selectors: readonly string[]; baseBackground: string }>
> = {
  app: {
    selectors: ['.ds-workbench-shell', '.ds-settings-surface'],
    baseBackground: 'var(--ds-bg-main)'
  },
  sidebar: {
    selectors: ['.ds-sidebar-shell', '.ds-settings-sidebar'],
    baseBackground: 'var(--ds-sidebar-gradient)'
  },
  composer: {
    selectors: ['.ds-composer-shell.ds-chat-composer'],
    baseBackground: 'var(--ds-surface-elevated)'
  },
  stage: {
    selectors: ['.ds-stage-surface', '.ds-settings-stage'],
    baseBackground: 'var(--ds-stage-gradient)'
  },
  write: {
    selectors: ['.write-workspace-view'],
    baseBackground: 'var(--ds-stage-gradient)'
  },
  design: {
    selectors: ['.design-workspace-view .ds-stage-design-canvas'],
    baseBackground: 'var(--ds-stage-gradient)'
  }
}

export const UI_PLUGIN_APP_CHILD_SURFACES = [
  '.ds-sidebar-shell',
  '.ds-stage-surface',
  '.ds-settings-sidebar',
  '.ds-settings-stage'
] as const

export const UI_PLUGIN_STAGE_REVEAL_SURFACES = [
  '.ds-stage-route-host > *',
  '.ds-stage-design-canvas',
  '.ds-stage-design-canvas-fill'
] as const

export function uiPluginThemeSelector(id: string, theme: UiPluginBackgroundTheme): string {
  return theme === 'dark'
    ? `html[data-ui-plugin='${id}'][data-theme='dark']`
    : `html[data-ui-plugin='${id}']:not([data-theme='dark'])`
}

export function formatCssNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000)
}

/**
 * 生成背景层样式。manifest 只提供布局参数,图片来源只能是主进程验证后传入的
 * base64 data URL;因此不会把插件提供的原始路径拼入 CSS。
 *
 * 图片放在各表面的独立 ::after 层并直接使用 layer.opacity。这样可以保留宿主
 * 原有渐变，也不会要求插件 token 中的 --ds-bg-* 必须是 color-mix 可接受的纯色。
 */
export function buildUiPluginBackgroundCss(
  manifest: UiPluginManifestV1,
  runtimeBackgrounds: UiPluginRuntimeBackgrounds | null | undefined
): string {
  if (!UI_PLUGIN_ID_PATTERN.test(manifest.id)) return ''

  const blocks: string[] = []
  const assetVariables = new Map<string, string>()
  const layerVariables = new Map<string, string>()
  for (const theme of UI_PLUGIN_BACKGROUND_THEMES) {
    for (const slot of UI_PLUGIN_BACKGROUND_SLOTS) {
      const layer = manifest.backgrounds?.[theme]?.[slot]
      if (
        !layer ||
        !(UI_PLUGIN_BACKGROUND_FITS as readonly string[]).includes(layer.fit) ||
        !(UI_PLUGIN_BACKGROUND_POSITIONS as readonly string[]).includes(layer.position) ||
        !Number.isFinite(layer.opacity) ||
        layer.opacity < 0 ||
        layer.opacity > 1
      ) {
        continue
      }
      const dataUrl = runtimeBackgroundDataUrl(
        runtimeBackgrounds,
        theme,
        slot,
        layer.path
      )
      if (!isSafeUiPluginBackgroundDataUrl(dataUrl)) continue
      let variable = assetVariables.get(dataUrl)
      if (!variable) {
        variable = `--kun-ui-plugin-background-${assetVariables.size}`
        assetVariables.set(dataUrl, variable)
      }
      layerVariables.set(`${theme}.${slot}`, variable)
    }
  }

  if (assetVariables.size > 0) {
    const declarations = [...assetVariables]
      .map(([dataUrl, variable]) => `  ${variable}: url("${dataUrl}");`)
      .join('\n')
    blocks.push(`html[data-ui-plugin='${manifest.id}'] {\n${declarations}\n}`)
  }

  for (const theme of UI_PLUGIN_BACKGROUND_THEMES) {
    const rootSelector = uiPluginThemeSelector(manifest.id, theme)
    let revealStageRoute = false
    for (const slot of UI_PLUGIN_BACKGROUND_SLOTS) {
      const layer = manifest.backgrounds?.[theme]?.[slot]
      const assetVariable = layerVariables.get(`${theme}.${slot}`)
      if (
        !layer ||
        !(UI_PLUGIN_BACKGROUND_FITS as readonly string[]).includes(layer.fit) ||
        !(UI_PLUGIN_BACKGROUND_POSITIONS as readonly string[]).includes(layer.position) ||
        !Number.isFinite(layer.opacity) ||
        layer.opacity < 0 ||
        layer.opacity > 1 ||
        !assetVariable
      ) {
        continue
      }

      const host = UI_PLUGIN_BACKGROUND_HOSTS[slot]
      const selectors = host.selectors
        .map((selector) => `${rootSelector} ${selector}`)
        .join(',\n')
      const pseudoSelectors = host.selectors
        .map((selector) => `${rootSelector} ${selector}::after`)
        .join(',\n')
      blocks.push(
        `${selectors} {\n` +
          `  position: relative;\n` +
          `  isolation: isolate;\n` +
          `  background: ${host.baseBackground};\n` +
          `}\n\n` +
          `${pseudoSelectors} {\n` +
          `  content: '';\n` +
          `  position: absolute;\n` +
          `  inset: 0;\n` +
          `  z-index: -1;\n` +
          `  pointer-events: none;\n` +
          `  background-image: var(${assetVariable});\n` +
          `  background-size: ${layer.fit};\n` +
          `  background-position: ${UI_PLUGIN_BACKGROUND_CSS_POSITION[layer.position]};\n` +
          `  background-repeat: no-repeat;\n` +
          `  opacity: ${formatCssNumber(layer.opacity)};\n` +
          `}`
      )

      if (slot === 'app') {
        const childSurfaceSelectors = UI_PLUGIN_APP_CHILD_SURFACES
          .map((selector) => `${rootSelector} ${selector}`)
          .join(',\n')
        blocks.push(`${childSurfaceSelectors} {\n  background: transparent;\n}`)
        revealStageRoute = true
      } else if (slot === 'stage') {
        revealStageRoute = true
      }
    }

    if (revealStageRoute) {
      const revealSelectors = UI_PLUGIN_STAGE_REVEAL_SURFACES
        .map((selector) => `${rootSelector} ${selector}`)
        .join(',\n')
      blocks.push(
        `${revealSelectors} {\n` +
          `  background-color: transparent !important;\n` +
          `}`
      )
    }

    if (Object.prototype.hasOwnProperty.call(manifest.tokens?.[theme] ?? {}, '--ds-topbar-bg')) {
      blocks.push(
        `${rootSelector} .ds-topbar-surface {\n` +
          `  background: var(--ds-topbar-bg);\n` +
          `}`
      )
    }
  }
  return blocks.join('\n\n')
}

/** 按槽位回退链取形象:返回第一个有值的槽位 data URL */
export function resolveUiPluginFigure(
  figures: UiPluginRuntimeFigures | null | undefined,
  slots: readonly UiPluginFigureSlot[]
): string | null {
  if (!figures) return null
  for (const slot of slots) {
    const value = figures[slot]
    if (value) return value
  }
  return null
}
