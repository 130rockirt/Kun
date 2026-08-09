'use strict'

const { writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const sharp = require('sharp')

const OVERFLOW_TOLERANCE_PX = 1
const CONTENT_COLUMN_CLEARANCE_PX = 32
const SCENE_CONTENT_CLEARANCE_PX = 16

async function readLayoutSnapshot(workbench) {
  return workbench.evaluate(() => {
    const root = document.documentElement
    const rect = (element) => {
      if (!(element instanceof Element)) return null
      const value = element.getBoundingClientRect()
      return {
        x: round(value.x),
        y: round(value.y),
        width: round(value.width),
        height: round(value.height),
        right: round(value.right),
        bottom: round(value.bottom)
      }
    }
    const style = (element) => {
      if (!(element instanceof Element)) return null
      const value = getComputedStyle(element)
      return {
        display: value.display,
        visibility: value.visibility,
        opacity: value.opacity,
        overflowX: value.overflowX,
        pointerEvents: value.pointerEvents,
        zIndex: value.zIndex,
        translate: value.translate,
        transform: value.transform
      }
    }
    const elementSnapshot = (selector) => {
      const element = document.querySelector(selector)
      return { selector, rect: rect(element), style: style(element) }
    }
    const overflow = (selector, element) => ({
      selector,
      clientWidth: element ? element.clientWidth : 0,
      scrollWidth: element ? element.scrollWidth : 0,
      excess: element ? Math.max(0, element.scrollWidth - element.clientWidth) : 0
    })
    const character = document.querySelector('.ds-ui-plugin-character')
    const characterLayer = document.querySelector(
      '.ds-ui-plugin-scene-visual-zone, .ds-ui-plugin-character-layer'
    )
    const sceneArtwork = [...document.querySelectorAll('.ds-ui-plugin-scene-artwork')]
    const sceneForeground = document.querySelector(
      ".ds-ui-plugin-scene-artwork-foreground[data-scene-variant='default']"
    )
    const stage = document.querySelector('.ds-chat-stage')
    const composer = document.querySelector('.ds-floating-composer')
    const composerInput = document.querySelector('.ds-composer-textarea')
    const composerPrimaryAction = document.querySelector('.ds-composer-primary-action')
    const cdpStyle = document.querySelector('#kun-ui-plugin-theme-cdp')
    const attributes = Object.fromEntries(
      root.getAttributeNames()
        .filter((name) => name.startsWith('data-ui-plugin') || name === 'data-focus-mode')
        .sort()
        .map((name) => [name, root.getAttribute(name)])
    )

    return {
      viewport: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      },
      attributes,
      cdpStyle: {
        present: cdpStyle instanceof HTMLStyleElement,
        pluginId: cdpStyle?.getAttribute('data-ui-plugin-id') ?? null,
        textLength: cdpStyle?.textContent?.length ?? 0
      },
      character: {
        ...elementSnapshot('.ds-ui-plugin-character'),
        complete: character instanceof HTMLImageElement ? character.complete : false,
        naturalWidth: character instanceof HTMLImageElement ? character.naturalWidth : 0,
        naturalHeight: character instanceof HTMLImageElement ? character.naturalHeight : 0,
        sourceKind: character instanceof HTMLImageElement
          ? character.currentSrc.startsWith('data:image/') ? 'data-image' : 'other'
          : 'missing',
        visible: character instanceof HTMLElement
          ? character.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
          : false,
        topmostAtCenter: character instanceof HTMLElement && characterLayer instanceof HTMLElement
          ? characterIsTopmostAtCenter(character, characterLayer)
          : false
      },
      sceneArtwork: {
        count: sceneArtwork.length,
        decoded: sceneArtwork.filter((candidate) => (
          candidate instanceof HTMLImageElement &&
          candidate.complete &&
          candidate.naturalWidth > 0 &&
          candidate.naturalHeight > 0
        )).length
      },
      sceneForeground: {
        ...elementSnapshot(
          ".ds-ui-plugin-scene-artwork-foreground[data-scene-variant='default']"
        ),
        complete: sceneForeground instanceof HTMLImageElement
          ? sceneForeground.complete
          : false,
        naturalWidth: sceneForeground instanceof HTMLImageElement
          ? sceneForeground.naturalWidth
          : 0,
        naturalHeight: sceneForeground instanceof HTMLImageElement
          ? sceneForeground.naturalHeight
          : 0,
        visible: sceneForeground instanceof HTMLElement
          ? sceneForeground.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
          : false
      },
      stage: elementSnapshot('.ds-chat-stage'),
      layers: {
        decor: elementSnapshot('.ds-ui-plugin-decor-layer'),
        character: elementSnapshot('.ds-ui-plugin-character-layer'),
        scrim: elementSnapshot('.ds-ui-plugin-readability-scrim'),
        sceneStage: elementSnapshot('.ds-ui-plugin-scene-stage-layer'),
        sceneVisual: elementSnapshot('.ds-ui-plugin-scene-visual-zone')
      },
      content: {
        stageContent: elementSnapshot('.ds-ui-plugin-stage-content'),
        timeline: elementSnapshot('.ds-message-timeline-content'),
        composer: {
          ...elementSnapshot('.ds-floating-composer'),
          topmostAtCenter: elementOwnsTopmostAtCenter(composer)
        },
        composerInput: {
          ...elementSnapshot('.ds-composer-textarea'),
          topmostAtCenter: elementOwnsTopmostAtCenter(composerInput)
        },
        composerPrimaryAction: {
          ...elementSnapshot('.ds-composer-primary-action'),
          topmostAtCenter: elementOwnsTopmostAtCenter(composerPrimaryAction)
        },
        sidebar: elementSnapshot('.ds-sidebar-shell'),
        topbar: elementSnapshot('.ds-topbar-surface')
      },
      overflow: [
        overflow('html', document.documentElement),
        overflow('body', document.body),
        overflow('.ds-workbench-shell', document.querySelector('.ds-workbench-shell')),
        overflow('.ds-chat-stage', stage),
        overflow('.ds-ui-plugin-stage-content', document.querySelector('.ds-ui-plugin-stage-content'))
      ]
    }

    function round(value) {
      return Math.round(value * 100) / 100
    }

    function characterIsTopmostAtCenter(image, layer) {
      const bounds = image.getBoundingClientRect()
      const previousImagePointerEvents = image.style.pointerEvents
      const previousLayerPointerEvents = layer.style.pointerEvents
      image.style.pointerEvents = 'auto'
      layer.style.pointerEvents = 'auto'
      const topmost = document.elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + bounds.height / 2
      )
      image.style.pointerEvents = previousImagePointerEvents
      layer.style.pointerEvents = previousLayerPointerEvents
      return topmost === image
    }

    function elementOwnsTopmostAtCenter(element) {
      if (!(element instanceof HTMLElement)) return false
      const bounds = element.getBoundingClientRect()
      const topmost = document.elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + bounds.height / 2
      )
      return topmost instanceof Element && element.contains(topmost)
    }
  })
}

function assertWidePresentation(id, snapshot) {
  assertThemeIdentity(id, snapshot)
  const sceneEnabled = snapshot.attributes['data-ui-plugin-scene'] === 'on'
  const sceneLayout = snapshot.attributes['data-ui-plugin-scene-layout']
  const sceneForeground = sceneEnabled && (
    sceneLayout === 'rail-right' ||
    sceneLayout === 'rail-left' ||
    sceneLayout === 'card-right' ||
    sceneLayout === 'card-left'
  )
  if (snapshot.attributes['data-ui-plugin-presentation'] !== 'on') {
    throw new Error(`${id}: data-ui-plugin-presentation is not on`)
  }
  if (!snapshot.cdpStyle.present || snapshot.cdpStyle.pluginId !== id || snapshot.cdpStyle.textLength <= 0) {
    throw new Error(`${id}: host CDP theme style is missing or empty`)
  }
  if (
    !snapshot.character.complete ||
    snapshot.character.naturalWidth <= 0 ||
    snapshot.character.naturalHeight <= 0 ||
    snapshot.character.sourceKind !== 'data-image'
  ) {
    throw new Error(`${id}: portrait image did not decode from a validated data-image source`)
  }
  const foregroundOwnsSubject = sceneEnabled && (
    snapshot.sceneForeground.complete &&
    snapshot.sceneForeground.naturalWidth > 0 &&
    snapshot.sceneForeground.naturalHeight > 0 &&
    snapshot.sceneForeground.visible &&
    hasArea(snapshot.sceneForeground.rect)
  )
  if (
    (!snapshot.character.visible || !hasArea(snapshot.character.rect)) &&
    !foregroundOwnsSubject
  ) {
    throw new Error(
      `${id}: neither the portrait nor a decoded visible foreground subject is ` +
      'visible in the wide Kun workbench'
    )
  }
  if (!sceneEnabled && !snapshot.character.topmostAtCenter) {
    throw new Error(`${id}: portrait is geometrically visible but occluded at its center`)
  }

  if (sceneEnabled) {
    if (!sceneLayout) throw new Error(`${id}: declarative scene layout marker is missing`)
    if (snapshot.sceneArtwork.count <= 0 || snapshot.sceneArtwork.decoded !== snapshot.sceneArtwork.count) {
      throw new Error(
        `${id}: declarative scene artwork did not decode ` +
        `(${snapshot.sceneArtwork.decoded}/${snapshot.sceneArtwork.count})`
      )
    }
    for (const name of ['sceneStage', 'sceneVisual']) {
      const layer = snapshot.layers[name]
      if (layer.style?.display === 'none' || !hasArea(layer.rect)) {
        throw new Error(`${id}: ${name} layer is hidden in the wide Kun workbench`)
      }
    }
    if (sceneForeground) {
      assertSceneContentClearance(id, sceneLayout, snapshot)
    }
  } else {
    const reserve = snapshot.attributes['data-ui-plugin-content-reserve']
    if (
      reserve !== 'none' &&
      rectanglesOverlap(snapshot.character.rect, snapshot.content.composer.rect)
    ) {
      throw new Error(`${id}: ${reserve} content reserve still overlaps the Composer`)
    }
    if (
      reserve !== 'none' &&
      snapshot.character.rect.x - snapshot.content.composer.rect.right < CONTENT_COLUMN_CLEARANCE_PX
    ) {
      throw new Error(
        `${id}: ${reserve} content reserve leaves less than ` +
        `${CONTENT_COLUMN_CLEARANCE_PX}px between the Kun content column and portrait`
      )
    }
    if (snapshot.layers.character.style?.display === 'none' || !hasArea(snapshot.layers.character.rect)) {
      throw new Error(`${id}: character layer is hidden in the wide Kun workbench`)
    }
  }

  const contentZIndex = numericZIndex(snapshot.content.stageContent.style?.zIndex)
  const layersBelowContent = sceneEnabled
    ? ['sceneStage', 'sceneVisual', 'scrim']
    : ['decor', 'scrim']
  for (const name of layersBelowContent) {
    const layer = snapshot.layers[name]
    if (
      !hasArea(layer.rect) ||
      layer.style?.display === 'none' ||
      Number(layer.style?.opacity) === 0
    ) {
      continue
    }
    const layerZIndex = numericZIndex(layer.style?.zIndex)
    if (layerZIndex === null || contentZIndex === null || layerZIndex >= contentZIndex) {
      throw new Error(
        `${id}: ${name} presentation z-index ${layer.style?.zIndex ?? 'missing'} must stay below ` +
        `Kun content z-index ${snapshot.content.stageContent.style?.zIndex ?? 'missing'}`
      )
    }
  }
  for (const [name, layer] of Object.entries(snapshot.layers)) {
    if (layer.style && layer.style.pointerEvents !== 'none') {
      throw new Error(`${id}: ${name} presentation layer can intercept pointer input`)
    }
  }
  if (!snapshot.content.composer.topmostAtCenter) {
    throw new Error(`${id}: Composer does not own the topmost hit target at its center`)
  }
  if (!snapshot.content.composerInput.topmostAtCenter) {
    throw new Error(`${id}: Composer input is covered at its center`)
  }
  if (snapshot.content.composerInput.style?.pointerEvents === 'none') {
    throw new Error(`${id}: Composer input cannot receive pointer input`)
  }
  if (!snapshot.content.composerPrimaryAction.topmostAtCenter) {
    throw new Error(`${id}: Composer primary action is covered at its center`)
  }
  const topbarCollisionBounds = sceneEnabled
    ? snapshot.layers.sceneVisual.rect
    : snapshot.character.rect
  if (rectanglesOverlap(topbarCollisionBounds, snapshot.content.topbar.rect)) {
    throw new Error(`${id}: portrait overlaps the Kun top bar`)
  }
  if (!hasArea(snapshot.stage.rect)) throw new Error(`${id}: Kun chat stage is unavailable`)
  const widthRatio = snapshot.character.rect.width / snapshot.stage.rect.width
  if ((!sceneEnabled || sceneForeground) && widthRatio > 0.8) {
    throw new Error(`${id}: portrait occupies ${formatPercent(widthRatio)} of stage width (maximum 80%)`)
  }
  assertNoHorizontalOverflow(id, 'wide', snapshot)
}

function assertNarrowPresentation(id, snapshot) {
  assertThemeIdentity(id, snapshot)
  for (const [name, layer] of Object.entries(snapshot.layers)) {
    if (layer.style && (layer.style.display !== 'none' || hasArea(layer.rect))) {
      throw new Error(`${id}: ${name} presentation layer remains visible in narrow mode`)
    }
  }
  if (snapshot.character.visible || hasArea(snapshot.character.rect)) {
    throw new Error(`${id}: portrait remains visible in narrow mode`)
  }
  assertNoHorizontalOverflow(id, 'narrow', snapshot)
}

function assertSceneContentClearance(id, layout, snapshot) {
  const visual = snapshot.layers.sceneVisual.rect
  if (!visual) throw new Error(`${id}: scene visual zone geometry is unavailable`)
  for (const [name, content] of [
    ['message timeline', snapshot.content.timeline.rect],
    ['Composer', snapshot.content.composer.rect]
  ]) {
    // The empty/new-conversation route may not mount timeline content yet;
    // Composer geometry is always authoritative for the interactive column.
    if (!content && name === 'message timeline') continue
    if (!content) throw new Error(`${id}: ${name} geometry is unavailable`)
    if (rectanglesOverlap(visual, content)) {
      throw new Error(`${id}: ${layout} scene visual zone overlaps the ${name}`)
    }
    const horizontalClearance = layout.endsWith('-left')
      ? content.x - visual.right
      : visual.x - content.right
    const verticalClearance = Math.max(
      content.y - visual.bottom,
      visual.y - content.bottom
    )
    const clearance = Math.max(horizontalClearance, verticalClearance)
    if (clearance < SCENE_CONTENT_CLEARANCE_PX) {
      throw new Error(
        `${id}: ${layout} leaves ${Math.round(clearance)}px effective clearance between the ` +
        'scene visual zone and ' +
        `${name} (minimum ${SCENE_CONTENT_CLEARANCE_PX}px)`
      )
    }
  }
}

function assertThemeIdentity(id, snapshot) {
  if (snapshot.attributes['data-ui-plugin'] !== id) {
    throw new Error(`${id}: renderer active plugin attribute is ${snapshot.attributes['data-ui-plugin'] ?? 'missing'}`)
  }
  if (snapshot.attributes['data-ui-plugin-cdp'] !== id) {
    throw new Error(`${id}: CDP plugin marker is ${snapshot.attributes['data-ui-plugin-cdp'] ?? 'missing'}`)
  }
  if (snapshot.attributes['data-focus-mode'] !== 'off') {
    throw new Error(`${id}: focus mode must be off during visual layout smoke`)
  }
}

function assertNoHorizontalOverflow(id, viewport, snapshot) {
  const offenders = snapshot.overflow.filter((entry) => (
    entry.clientWidth > 0 && entry.excess > OVERFLOW_TOLERANCE_PX
  ))
  if (offenders.length > 0) {
    throw new Error(
      `${id}: ${viewport} horizontal overflow: ` +
      offenders.map((entry) => `${entry.selector} +${entry.excess}px`).join(', ')
    )
  }
}

function hasArea(rect) {
  return Boolean(rect && rect.width > 0 && rect.height > 0)
}

function numericZIndex(value) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function rectanglesOverlap(left, right) {
  if (!left || !right) return false
  return (
    left.x < right.right - OVERFLOW_TOLERANCE_PX &&
    left.right > right.x + OVERFLOW_TOLERANCE_PX &&
    left.y < right.bottom - OVERFLOW_TOLERANCE_PX &&
    left.bottom > right.y + OVERFLOW_TOLERANCE_PX
  )
}

async function captureWorkbench(electronApplication, outputPath) {
  const pngBase64 = await electronApplication.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
    if (!window) throw new Error('Kun development workbench BrowserWindow is unavailable for capture')
    return (await window.capturePage()).toPNG().toString('base64')
  })
  await writeFile(outputPath, Buffer.from(pngBase64, 'base64'))
}

async function writeReport(evidenceRoot, report) {
  const reportPath = join(evidenceRoot, 'kun-ui-plugin-layout-report.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  return reportPath
}

async function writeOverview(evidenceRoot, plugins) {
  const columns = 3
  const cardWidth = 560
  const cardHeight = 330
  const gap = 20
  const pagePadding = 40
  const headerHeight = 112
  const rows = Math.ceil(plugins.length / columns)
  const width = pagePadding * 2 + columns * cardWidth + (columns - 1) * gap
  const height = headerHeight + rows * cardHeight + Math.max(0, rows - 1) * gap + 48
  const cards = plugins.map((plugin, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const x = pagePadding + column * (cardWidth + gap)
    const y = headerHeight + row * (cardHeight + gap)
    return (
      `<g><rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="22" ` +
      'fill="#fff" fill-opacity=".9" stroke="#d9d2dc"/>' +
      `<text x="${x + cardWidth / 2}" y="${y + 310}" fill="#352d38" ` +
      'font-family="Arial, sans-serif" font-size="17" font-weight="700" ' +
      `text-anchor="middle">${plugin.id}</text></g>`
    )
  }).join('')
  const frame = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}"><defs><linearGradient id="page" x1="0" y1="0" ` +
    'x2="1" y2="1"><stop stop-color="#fffafa"/><stop offset=".52" stop-color="#f7f2fb"/>' +
    '<stop offset="1" stop-color="#edf8f7"/></linearGradient></defs>' +
    `<rect width="${width}" height="${height}" fill="url(#page)"/>` +
    '<text x="40" y="52" fill="#2f2832" font-family="Arial, sans-serif" font-size="34" ' +
    'font-weight="800">11 REAL KUN UI PLUGIN WORKBENCH CAPTURES</text>' +
    '<text x="42" y="83" fill="#7d727f" font-family="Arial, sans-serif" font-size="14" ' +
    'font-weight="700" letter-spacing="2">HOST CDP · DECLARATIVE UI PLUGIN · WIDE + NARROW VERIFIED</text>' +
    `${cards}</svg>`
  )
  const layers = await Promise.all(plugins.map(async (plugin, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const input = await sharp(join(evidenceRoot, `${plugin.id}-kun-ui-plugin.png`))
      .resize(520, 252, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer()
    return {
      input,
      left: pagePadding + column * (cardWidth + gap) + 20,
      top: headerHeight + row * (cardHeight + gap) + 20
    }
  }))
  const outputPath = join(evidenceRoot, 'kun-ui-plugin-real-overview.png')
  await sharp(frame, { density: 72 })
    .composite(layers)
    .png({ compressionLevel: 9, palette: true, quality: 95 })
    .toFile(outputPath)
  return outputPath
}

function formatThemeResult(id, wide, narrow, screenshotPath) {
  const scene = wide.attributes['data-ui-plugin-scene-layout']
  const frame = scene
    ? `scene:${scene}`
    : wide.attributes['data-ui-plugin-character-frame'] ?? 'unknown'
  const stage = wide.stage.rect
  const character = wide.character.rect
  const narrowExcess = Math.max(...narrow.overflow.map((entry) => entry.excess))
  return (
    `[${id}] frame=${frame}; ` +
    `wide stage=${formatRect(stage)} portrait=${formatRect(character)}; ` +
    `narrow hidden=${!narrow.character.visible} overflow=${narrowExcess}px; ` +
    `screenshot=${screenshotPath}\n`
  )
}

function formatRect(rect) {
  if (!rect) return 'missing'
  return `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.x)},${Math.round(rect.y)}`
}

function formatPercent(ratio) {
  return `${Math.round(ratio * 1_000) / 10}%`
}


module.exports = {
  readLayoutSnapshot,
  assertWidePresentation,
  assertNarrowPresentation,
  assertSceneContentClearance,
  assertThemeIdentity,
  assertNoHorizontalOverflow,
  hasArea,
  numericZIndex,
  rectanglesOverlap,
  captureWorkbench,
  writeReport,
  writeOverview,
  formatThemeResult,
  formatRect,
  formatPercent
}
