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

describe('normalizeUiPluginManifest', () => {
  it('accepts a fully-featured valid manifest', () => {
    const result = normalizeUiPluginManifest(validManifest)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.id).toBe('starlight')
    expect(result.manifest.figures.swim).toBe('img/swim.png')
    expect(result.manifest.labels?.zh?.working).toBe('巡航中…')
    expect(result.manifest.features?.cameos).toBe(true)
    expect(result.manifest.backgrounds).toBeUndefined()
  })

  it('strictly normalizes the host-rendered portrait presentation', () => {
    const result = normalizeUiPluginManifest(validPresentationManifest)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.figures.portrait).toBe('img/portrait.png')
    expect(result.manifest.presentation).toEqual(validPresentationManifest.presentation)
  })

  it('strictly normalizes a complete host-rendered scene v1.6', () => {
    const result = normalizeUiPluginManifest(validSceneManifest)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.scene).toEqual(validSceneManifest.scene)
    expect(result.manifest.presentation).toEqual(validPresentationManifest.presentation)
    expect(result.manifest.figures.portrait).toBe('img/portrait.png')
  })

  it('accepts every host-owned per-character chrome recipe on all four surfaces', () => {
    for (const recipe of dedicatedCharacterChromeRecipes) {
      const chrome = {
        sidebar: recipe,
        topbar: recipe,
        composer: recipe,
        cards: recipe
      }
      const result = normalizeUiPluginManifest({
        ...validSceneManifest,
        scene: { ...validSceneManifest.scene, chrome }
      })
      expect(result.ok, recipe).toBe(true)
      if (result.ok) expect(result.manifest.scene?.chrome).toEqual(chrome)
    }
  })

  it('rejects unlisted chrome recipes on each scene surface', () => {
    for (const surface of ['sidebar', 'topbar', 'composer', 'cards'] as const) {
      const result = normalizeUiPluginManifest({
        ...validSceneManifest,
        scene: {
          ...validSceneManifest.scene,
          chrome: {
            ...validSceneManifest.scene.chrome,
            [surface]: 'user-supplied-css'
          }
        }
      })
      expect(result.ok, surface).toBe(false)
    }
  })

  it('requires portrait, v1.5 fallback, and at least one artwork layer for scene v1.6', () => {
    const noPortrait = normalizeUiPluginManifest({
      ...validSceneManifest,
      figures: validManifest.figures
    })
    expect(noPortrait.ok).toBe(false)
    if (!noPortrait.ok) expect(noPortrait.errors).toContain('scene 需要同时声明 figures.portrait 人物图片')

    const noFallback = normalizeUiPluginManifest({
      ...validSceneManifest,
      presentation: undefined
    })
    expect(noFallback.ok).toBe(false)
    if (!noFallback.ok) expect(noFallback.errors).toContain('scene 需要同时声明 presentation 作为 v1.5 fallback')

    const noArtwork = normalizeUiPluginManifest({
      ...validSceneManifest,
      scene: { ...validSceneManifest.scene, artwork: {} }
    })
    expect(noArtwork.ok).toBe(false)
    if (!noArtwork.ok) expect(noArtwork.errors).toContain('scene.artwork 至少需要声明一个专属图片槽位')
  })

  it('rejects unknown scene keys, active assets, invalid blend roles, and arbitrary motion', () => {
    const invalidScenes = [
      { ...validSceneManifest.scene, selector: '.ds-chat-stage' },
      {
        ...validSceneManifest.scene,
        character: { ...validSceneManifest.scene.character, easing: 'linear' }
      },
      {
        ...validSceneManifest.scene,
        artwork: {
          frame: { ...validSceneManifest.scene.artwork.frame, path: 'scene/frame.gif' }
        }
      },
      {
        ...validSceneManifest.scene,
        artwork: {
          frame: { ...validSceneManifest.scene.artwork.frame, blend: 'screen' }
        }
      },
      {
        ...validSceneManifest.scene,
        artwork: {
          frame: {
            ...validSceneManifest.scene.artwork.frame,
            motion: { ...sceneMotion, preset: 'spring(1,2)' }
          }
        }
      }
    ]
    for (const scene of invalidScenes) {
      expect(normalizeUiPluginManifest({ ...validSceneManifest, scene }).ok).toBe(false)
    }
  })

  it('enforces bounded scene numeric fields and a boolean flip flag', () => {
    for (const [key, value] of [
      ['offsetX', 13],
      ['offsetY', -13],
      ['opacity', Number.NaN],
      ['opacity', 1.01],
      ['flipX', 'yes']
    ] as const) {
      expect(normalizeUiPluginManifest({
        ...validSceneManifest,
        scene: {
          ...validSceneManifest.scene,
          character: { ...validSceneManifest.scene.character, [key]: value }
        }
      }).ok, `${key}=${String(value)}`).toBe(false)
    }
  })

  it('requires a portrait whenever presentation is declared', () => {
    const result = normalizeUiPluginManifest({
      ...validPresentationManifest,
      figures: validManifest.figures
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toContain('presentation 需要同时声明 figures.portrait 人物图片')
  })

  it('rejects unknown presentation keys and arbitrary strings', () => {
    const invalidPresentations = [
      {
        ...validPresentationManifest.presentation,
        selector: '.ds-chat-stage'
      },
      {
        ...validPresentationManifest.presentation,
        character: {
          ...validPresentationManifest.presentation.character,
          css: 'position:fixed',
          anchor: 'center'
        }
      },
      {
        ...validPresentationManifest.presentation,
        readability: {
          ...validPresentationManifest.presentation.readability,
          scrim: 'linear-gradient(red, blue)'
        }
      },
      {
        ...validPresentationManifest.presentation,
        surfaces: {
          ...validPresentationManifest.presentation.surfaces,
          composer: 'url(https://example.test/x)'
        }
      }
    ]
    for (const presentation of invalidPresentations) {
      expect(
        normalizeUiPluginManifest({ ...validPresentationManifest, presentation }).ok
      ).toBe(false)
    }
  })

  it('enforces integer offsets and finite 0-1 presentation opacity', () => {
    for (const [key, value] of [
      ['offsetX', 12.5],
      ['offsetX', 13],
      ['offsetY', -13],
      ['opacity', Number.NaN],
      ['opacity', Number.POSITIVE_INFINITY],
      ['opacity', -0.01],
      ['opacity', 1.01]
    ] as const) {
      const presentation = {
        ...validPresentationManifest.presentation,
        character: {
          ...validPresentationManifest.presentation.character,
          [key]: value
        }
      }
      expect(
        normalizeUiPluginManifest({ ...validPresentationManifest, presentation }).ok,
        `${key}=${String(value)}`
      ).toBe(false)
    }
  })

  it('accepts a background-only plugin and keeps normalized figures compatible', () => {
    const result = normalizeUiPluginManifest({
      id: 'background-only',
      name: 'Background only',
      version: '1.0.0',
      backgrounds: { light: { app: 'img/app.png' } }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.figures).toEqual({})
    expect(result.manifest.backgrounds?.light?.app).toEqual({
      path: 'img/app.png',
      fit: 'cover',
      position: 'center',
      opacity: 0.22
    })
  })

  it('normalizes shorthand and per-slot background defaults', () => {
    const result = normalizeUiPluginManifest({
      ...validManifest,
      figures: {},
      backgrounds: {
        dark: {
          app: 'bg/app.jpeg',
          sidebar: 'bg/sidebar.webp',
          stage: 'bg/stage.jpg',
          write: 'bg/write.webp',
          design: 'bg/design.webp'
        }
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.backgrounds?.dark).toEqual({
      app: { path: 'bg/app.jpeg', fit: 'cover', position: 'center', opacity: 0.22 },
      sidebar: { path: 'bg/sidebar.webp', fit: 'cover', position: 'center', opacity: 0.18 },
      stage: { path: 'bg/stage.jpg', fit: 'cover', position: 'center', opacity: 0.32 },
      write: { path: 'bg/write.webp', fit: 'cover', position: 'center', opacity: 0.5 },
      design: { path: 'bg/design.webp', fit: 'cover', position: 'center', opacity: 0.5 }
    })
  })

  it('normalizes an explicit background layer without replacing supplied values', () => {
    const result = normalizeUiPluginManifest({
      ...validManifest,
      backgrounds: {
        light: {
          stage: {
            path: 'bg/stage.png',
            fit: 'contain',
            position: 'bottom-right',
            opacity: 0
          }
        }
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.backgrounds?.light?.stage).toEqual({
      path: 'bg/stage.png',
      fit: 'contain',
      position: 'bottom-right',
      opacity: 0
    })
  })

  it('rejects reserved and malformed ids', () => {
    for (const id of ['default', 'kun', 'ON', 'a', 'Has Space', '../x']) {
      const result = normalizeUiPluginManifest({ ...validManifest, id })
      expect(result.ok).toBe(false)
    }
  })

  it('allows the bundled ikun id (iKun ships as a pre-installed plugin)', () => {
    expect(normalizeUiPluginManifest({ ...validManifest, id: 'ikun' }).ok).toBe(true)
  })

  it('rejects traversal, absolute paths, and non-image extensions in figures', () => {
    for (const path of [
      '../escape.png',
      '/abs.png',
      'img/../../x.png',
      'img/script.svg',
      'img/run.js',
      'img\\win.png'
    ]) {
      const result = normalizeUiPluginManifest({
        ...validManifest,
        figures: { swim: path }
      })
      expect(result.ok, path).toBe(false)
    }
  })

  it('rejects unknown slots, locales, label keys, and oversized labels', () => {
    expect(normalizeUiPluginManifest({ ...validManifest, figures: { hat: 'img/h.png' } }).ok).toBe(false)
    expect(
      normalizeUiPluginManifest({ ...validManifest, labels: { fr: { working: 'oui' } } }).ok
    ).toBe(false)
    expect(
      normalizeUiPluginManifest({ ...validManifest, labels: { zh: { bogus: 'x' } } }).ok
    ).toBe(false)
    expect(
      normalizeUiPluginManifest({
        ...validManifest,
        labels: { zh: { working: 'x'.repeat(25) } }
      }).ok
    ).toBe(false)
  })

  it('rejects non-whitelisted token names and unsafe values', () => {
    expect(
      normalizeUiPluginManifest({
        ...validManifest,
        tokens: { light: { '--evil': 'red' } }
      }).ok
    ).toBe(false)
    for (const value of [
      'red; background: url(x)',
      'url(http://x)',
      'URL(//host/x)',
      'url (//host/x)',
      'uRl\n\t(//host/x)',
      'a}b{',
      'x\\65 xpression'
    ]) {
      const result = normalizeUiPluginManifest({
        ...validManifest,
        tokens: { light: { '--ds-accent': value } }
      })
      expect(result.ok, value).toBe(false)
    }
  })

  it('requires at least one figure or background resource', () => {
    expect(normalizeUiPluginManifest({ ...validManifest, figures: {} }).ok).toBe(false)
    expect(
      normalizeUiPluginManifest({
        id: 'no-assets',
        name: 'No assets',
        version: '1.0.0'
      }).ok
    ).toBe(false)
  })

  it('strictly rejects unknown background themes, slots, and layer keys', () => {
    const invalidBackgrounds = [
      { system: { app: 'bg/app.png' } },
      { light: { dialog: 'bg/dialog.png' } },
      { light: { app: { path: 'bg/app.png', blendMode: 'multiply' } } }
    ]
    for (const backgrounds of invalidBackgrounds) {
      expect(normalizeUiPluginManifest({ ...validManifest, backgrounds }).ok).toBe(false)
    }
  })

  it('strictly rejects invalid background layer values', () => {
    const invalidLayers = [
      null,
      42,
      {},
      { path: 'bg/app.gif' },
      { path: 'bg/app.svg' },
      { path: '../app.png' },
      { path: '/app.png' },
      { path: 'bg\\app.png' },
      { path: 'bg/app.png', fit: 'fill' },
      { path: 'bg/app.png', position: '25% 30%' },
      { path: 'bg/app.png', opacity: Number.NaN },
      { path: 'bg/app.png', opacity: Number.POSITIVE_INFINITY },
      { path: 'bg/app.png', opacity: -0.01 },
      { path: 'bg/app.png', opacity: 1.01 },
      { path: 'bg/app.png', opacity: '0.5' }
    ]
    for (const layer of invalidLayers) {
      const result = normalizeUiPluginManifest({
        ...validManifest,
        backgrounds: { light: { app: layer } }
      })
      expect(result.ok, JSON.stringify(layer)).toBe(false)
    }
  })

  it('exposes the background and aggregate limits used by the host', () => {
    expect(UI_PLUGIN_LIMITS).toMatchObject({
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
      totalSceneAssetPixels: 40_000_000
    })
  })
})
