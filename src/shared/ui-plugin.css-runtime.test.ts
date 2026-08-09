import { describe, expect, it } from 'vitest'
import {
  buildUiPluginBackgroundCss,
  buildUiPluginPresentationCss,
  buildUiPluginSceneCss,
  buildUiPluginTokenCss,
  isSafeUiPluginBackgroundPath,
  isSafeUiPluginFigurePath,
  normalizeUiPluginManifest,
  resolveUiPluginFigure,
  UI_PLUGIN_LIMITS
} from './ui-plugin'

const validManifest = {
  id: 'starlight',
  name: '星夜模式',
  version: '1.0.0',
  author: 'tester',
  description: 'demo pack',
  figures: {
    swim: 'img/swim.png',
    greet: 'img/greet.webp'
  },
  labels: { zh: { working: '巡航中…' }, en: { working: 'Cruising…' } },
  tokens: { light: { '--ds-accent': '#8a63e8' }, dark: { '--ds-accent': '#b39df2' } },
  features: { cameos: true }
}

const validPresentationManifest = {
  ...validManifest,
  figures: {
    ...validManifest.figures,
    portrait: 'img/portrait.png'
  },
  presentation: {
    character: {
      anchor: 'right',
      size: 'hero',
      offsetX: 4,
      offsetY: -2,
      opacity: 0.94,
      frame: 'hologram',
      motion: 'float',
      contentReserve: 'wide'
    },
    readability: {
      scrim: 'opposite-character',
      strength: 'strong'
    },
    surfaces: {
      sidebar: 'strong-glass',
      topbar: 'glass',
      composer: 'strong-glass',
      cards: 'translucent'
    }
  }
}

const sceneMotion = {
  preset: 'float',
  speed: 'slow',
  phase: 'b'
} as const

const dedicatedCharacterChromeRecipes = [
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

const validSceneManifest = {
  ...validPresentationManifest,
  scene: {
    apiVersion: '1.6',
    layout: 'rail-left',
    character: {
      scale: 'hero',
      fit: 'contain',
      focalPoint: 'bottom',
      mask: 'arch',
      offsetX: 3,
      offsetY: -2,
      opacity: 0.96,
      flipX: false,
      motion: {
        preset: 'sway',
        speed: 'slow',
        phase: 'b'
      }
    },
    artwork: {
      backdrop: {
        path: 'scene/backdrop.webp',
        darkPath: 'scene/backdrop-dark.webp',
        anchor: 'center',
        size: 'full',
        fit: 'cover',
        offsetX: 0,
        offsetY: 0,
        opacity: 0.72,
        blend: 'screen',
        motion: { ...sceneMotion, preset: 'drift-x' }
      },
      frame: {
        path: 'scene/frame.png',
        anchor: 'center',
        size: 'large',
        fit: 'contain',
        offsetX: 1,
        offsetY: -1,
        opacity: 1,
        blend: 'normal',
        motion: { ...sceneMotion, preset: 'none', speed: 'normal', phase: 'a' }
      }
    },
    chrome: {
      sidebar: 'paper',
      topbar: 'editorial',
      composer: 'hologram',
      cards: 'ticket'
    }
  }
} as const

describe('isSafeUiPluginFigurePath', () => {
  it('accepts nested relative image paths', () => {
    expect(isSafeUiPluginFigurePath('img/a/b/figure.png')).toBe(true)
    expect(isSafeUiPluginFigurePath('cover.webp')).toBe(true)
  })
})

describe('isSafeUiPluginBackgroundPath', () => {
  it('allows raster background formats but not animated or executable formats', () => {
    for (const path of ['bg/app.png', 'bg/app.webp', 'bg/app.jpg', 'bg/app.jpeg']) {
      expect(isSafeUiPluginBackgroundPath(path), path).toBe(true)
    }
    for (const path of ['bg/app.gif', 'bg/app.svg', 'bg/app.html', '../app.png']) {
      expect(isSafeUiPluginBackgroundPath(path), path).toBe(false)
    }
  })
})

describe('buildUiPluginTokenCss', () => {
  it('scopes light tokens away from dark theme and dark tokens to it', () => {
    const result = normalizeUiPluginManifest(validManifest)
    if (!result.ok) throw new Error('expected valid manifest')
    const css = buildUiPluginTokenCss(result.manifest)
    expect(css).toContain("html[data-ui-plugin='starlight']:not([data-theme='dark'])")
    expect(css).toContain("html[data-ui-plugin='starlight'][data-theme='dark']")
    expect(css).toContain('--ds-accent: #8a63e8;')
    expect(css).not.toContain('url(')
    // 同时覆盖 .ds-workbench-shell 子作用域,否则 dark 下对话区会就地重声明
    // palette token 而遮蔽插件 token(本次修复的核心)。
    expect(css).toContain("html[data-ui-plugin='starlight'][data-theme='dark'] .ds-workbench-shell")
    expect(css).toContain(
      "html[data-ui-plugin='starlight']:not([data-theme='dark']) .ds-workbench-shell"
    )
  })

  it('returns empty string when no tokens declared', () => {
    const result = normalizeUiPluginManifest({ ...validManifest, tokens: undefined })
    if (!result.ok) throw new Error('expected valid manifest')
    expect(buildUiPluginTokenCss(result.manifest)).toBe('')
  })
})

describe('buildUiPluginPresentationCss', () => {
  it('emits only scoped host numeric variables', () => {
    const result = normalizeUiPluginManifest(validPresentationManifest)
    if (!result.ok) throw new Error(result.errors.join('\n'))
    const css = buildUiPluginPresentationCss(result.manifest)
    expect(css).toBe(
      "html[data-ui-plugin='starlight'] {\n" +
        '  --kun-ui-plugin-character-offset-x: 4%;\n' +
        '  --kun-ui-plugin-character-offset-y: -2%;\n' +
        '  --kun-ui-plugin-character-opacity: 0.94;\n' +
        '}'
    )
    expect(css).not.toContain('hologram')
    expect(css).not.toContain('opposite-character')
    expect(css).not.toContain('url(')
  })

  it('returns no CSS for a manifest without presentation', () => {
    const result = normalizeUiPluginManifest(validManifest)
    if (!result.ok) throw new Error(result.errors.join('\n'))
    expect(buildUiPluginPresentationCss(result.manifest)).toBe('')
  })

  it('keeps gradient stage tokens separate from presentation numeric CSS', () => {
    const result = normalizeUiPluginManifest({
      ...validPresentationManifest,
      tokens: {
        light: {
          '--ds-bg-main': 'linear-gradient(180deg,#fff 0%,#eef2ff 100%)'
        }
      }
    })
    if (!result.ok) throw new Error(result.errors.join('\n'))
    expect(buildUiPluginTokenCss(result.manifest)).toContain(
      '--ds-bg-main: linear-gradient(180deg,#fff 0%,#eef2ff 100%);'
    )
    expect(buildUiPluginPresentationCss(result.manifest)).not.toContain('--ds-bg-main')
  })

  it('defensively rejects unnormalized numeric presentation values', () => {
    const result = normalizeUiPluginManifest(validPresentationManifest)
    if (!result.ok) throw new Error(result.errors.join('\n'))
    expect(
      buildUiPluginPresentationCss({
        ...result.manifest,
        presentation: {
          ...result.manifest.presentation!,
          character: {
            ...result.manifest.presentation!.character,
            offsetX: 99
          }
        }
      })
    ).toBe('')
  })
})

describe('buildUiPluginSceneCss', () => {
  it('emits only scoped bounded numeric scene variables', () => {
    const result = normalizeUiPluginManifest(validSceneManifest)
    if (!result.ok) throw new Error(result.errors.join('\n'))
    const css = buildUiPluginSceneCss(result.manifest)
    expect(css).toContain("html[data-ui-plugin='starlight']")
    expect(css).toContain('--kun-ui-plugin-scene-character-offset-x: 3%;')
    expect(css).toContain('--kun-ui-plugin-scene-character-offset-y: -2%;')
    expect(css).toContain('--kun-ui-plugin-scene-character-opacity: 0.96;')
    expect(css).toContain('--kun-ui-plugin-scene-frame-offset-x: 1%;')
    expect(css).toContain('--kun-ui-plugin-scene-backdrop-opacity: 0.72;')
    expect(css).not.toContain('scene/frame.png')
    expect(css).not.toContain('rail-left')
    expect(css).not.toContain('sway')
  })

  it('returns no CSS without scene and rejects unnormalized scene numbers', () => {
    const legacy = normalizeUiPluginManifest(validPresentationManifest)
    if (!legacy.ok) throw new Error(legacy.errors.join('\n'))
    expect(buildUiPluginSceneCss(legacy.manifest)).toBe('')

    const scene = normalizeUiPluginManifest(validSceneManifest)
    if (!scene.ok) throw new Error(scene.errors.join('\n'))
    expect(buildUiPluginSceneCss({
      ...scene.manifest,
      scene: {
        ...scene.manifest.scene!,
        artwork: {
          ...scene.manifest.scene!.artwork,
          frame: { ...scene.manifest.scene!.artwork.frame!, offsetX: 99 }
        }
      }
    })).toBe('')
  })
})

describe('buildUiPluginBackgroundCss', () => {
  const pngDataUrl = 'data:image/png;base64,aW1hZ2U='
  const jpegDataUrl = 'data:image/jpeg;base64,AAAA'

  it('isolates light/dark themes, maps layouts, and never emits raw asset paths', () => {
    const result = normalizeUiPluginManifest({
      ...validManifest,
      backgrounds: {
        light: {
          app: {
            path: 'private/raw-app.png',
            fit: 'contain',
            position: 'top-left',
            opacity: 0.25
          },
          composer: 'private/raw-composer.png',
          stage: 'private/raw-stage.png',
          write: 'private/raw-write.png',
          design: 'private/raw-design.png'
        },
        dark: { sidebar: 'private/raw-sidebar.jpg' }
      }
    })
    if (!result.ok) throw new Error(result.errors.join('\n'))

    const css = buildUiPluginBackgroundCss(result.manifest, {
      assets: {
        'private/raw-app.png': pngDataUrl,
        'private/raw-composer.png': pngDataUrl,
        'private/raw-stage.png': pngDataUrl,
        'private/raw-write.png': pngDataUrl,
        'private/raw-design.png': pngDataUrl,
        'private/raw-sidebar.jpg': jpegDataUrl
      }
    })
    expect(css).toContain(
      "html[data-ui-plugin='starlight']:not([data-theme='dark']) .ds-workbench-shell::after"
    )
    expect(css).toContain(
      "html[data-ui-plugin='starlight']:not([data-theme='dark']) .ds-settings-surface::after"
    )
    expect(css).toContain(
      "html[data-ui-plugin='starlight']:not([data-theme='dark']) .ds-stage-surface::after"
    )
    expect(css).toContain(
      "html[data-ui-plugin='starlight']:not([data-theme='dark']) .ds-settings-stage::after"
    )
    expect(css).toContain(
      "html[data-ui-plugin='starlight']:not([data-theme='dark']) .write-workspace-view::after"
    )
    expect(css).toContain(
      "html[data-ui-plugin='starlight']:not([data-theme='dark']) .design-workspace-view .ds-stage-design-canvas::after"
    )
    expect(css).toContain(
      "html[data-ui-plugin='starlight'][data-theme='dark'] .ds-sidebar-shell::after"
    )
    expect(css).toContain(
      "html[data-ui-plugin='starlight'][data-theme='dark'] .ds-settings-sidebar::after"
    )
    expect(css).toContain(
      "html[data-ui-plugin='starlight']:not([data-theme='dark']) .ds-composer-shell.ds-chat-composer::after"
    )
    expect(css).toContain('background-size: contain;')
    expect(css).toContain('background-position: left top;')
    expect(css).toContain('opacity: 0.25;')
    expect(css).toContain('z-index: -1;')
    expect(css).toContain('.ds-stage-route-host > *')
    expect(css).toContain('.ds-stage-design-canvas')
    expect(css).toContain('.ds-stage-design-canvas-fill')
    expect(css).toContain('background-color: transparent !important;')
    expect(css).toContain('background: var(--ds-stage-gradient);')
    expect(css).toContain(pngDataUrl)
    expect(css).toContain(jpegDataUrl)
    expect(css.split(pngDataUrl)).toHaveLength(2)
    expect(css.split(jpegDataUrl)).toHaveLength(2)
    expect(css).not.toContain('private/raw-')
    expect(css).not.toContain('.ds-stage-surface > *')
    expect(css).not.toContain('.ds-workbench-shell > *')
  })

  it('does not generate rules for missing slots', () => {
    const result = normalizeUiPluginManifest({
      ...validManifest,
      backgrounds: { light: { app: 'bg/app.png' } }
    })
    if (!result.ok) throw new Error(result.errors.join('\n'))
    const css = buildUiPluginBackgroundCss(result.manifest, { light: { app: pngDataUrl } })
    expect(css).toContain('.ds-sidebar-shell')
    expect(css).toContain('.ds-stage-surface')
    expect(css).not.toContain('.ds-sidebar-shell::after')
    expect(css).not.toContain('.ds-stage-surface::after')
    expect(css).toContain('background: transparent;')
  })

  it('keeps the legacy theme-slot runtime shape readable', () => {
    const result = normalizeUiPluginManifest({
      ...validManifest,
      backgrounds: { light: { stage: 'bg/stage.png' } }
    })
    if (!result.ok) throw new Error(result.errors.join('\n'))
    const css = buildUiPluginBackgroundCss(result.manifest, {
      light: { stage: pngDataUrl }
    })
    expect(css).toContain(pngDataUrl)
    expect(css).toContain('background-image: var(--kun-ui-plugin-background-0);')
  })

  it('rejects non-base64, active, malformed, and unsupported runtime URLs', () => {
    const result = normalizeUiPluginManifest({
      ...validManifest,
      tokens: undefined,
      backgrounds: { light: { app: 'bg/app.png' } }
    })
    if (!result.ok) throw new Error(result.errors.join('\n'))
    const invalidUrls = [
      'https://host/app.png',
      'data:image/png,AAAA',
      'data:image/svg+xml;base64,AAAA',
      'data:image/jpg;base64,AAAA',
      'data:text/html;base64,AAAA',
      'data:image/png;base64,AAA',
      'data:image/png;base64,AAAA");}body{color:red}/*'
    ]
    for (const dataUrl of invalidUrls) {
      expect(
        buildUiPluginBackgroundCss(result.manifest, { light: { app: dataUrl } }),
        dataUrl
      ).toBe('')
    }
  })

  it('emits a theme-scoped topbar rule only when the theme declares its token', () => {
    const result = normalizeUiPluginManifest({
      ...validManifest,
      tokens: {
        light: { '--ds-topbar-bg': 'rgba(255,255,255,.72)' },
        dark: { '--ds-accent': '#b39df2' }
      }
    })
    if (!result.ok) throw new Error(result.errors.join('\n'))
    const css = buildUiPluginBackgroundCss(result.manifest, {})
    expect(css).toContain(
      "html[data-ui-plugin='starlight']:not([data-theme='dark']) .ds-topbar-surface"
    )
    expect(css).toContain('background: var(--ds-topbar-bg);')
    expect(css).not.toContain(
      "html[data-ui-plugin='starlight'][data-theme='dark'] .ds-topbar-surface"
    )
  })
})

describe('resolveUiPluginFigure', () => {
  it('walks the fallback chain and returns null when nothing matches', () => {
    const figures = { sit: 'data:image/png;base64,sit' }
    expect(resolveUiPluginFigure(figures, ['run', 'sit'])).toBe('data:image/png;base64,sit')
    expect(resolveUiPluginFigure(figures, ['run', 'swim'])).toBeNull()
    expect(resolveUiPluginFigure(null, ['swim'])).toBeNull()
  })
})
