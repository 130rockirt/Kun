import {
  MAX_PRESENTATION_HTML_BYTES,
  PresentationParseError,
  type PresentationElement,
  type PresentationFontFamily,
  type PresentationProject
} from './presentation-model.js'
import {
  normalizePresentationProject,
  parsePresentationProject,
  stableStringify
} from './presentation-parser.js'

function issue(code: string, path: string, message: string) {
  return { code, path, message }
}

function fail(code: string, path: string, message: string): never {
  throw new PresentationParseError(message, [issue(code, path, message)])
}

const MODEL_MARKER_START = '<script id="kun-presentation-model" type="application/json">'
const MODEL_MARKER_END = '</script>'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeEmbeddedJson(value: string): string {
  return value
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003C')
    .replaceAll('>', '\\u003E')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

function cssNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
}

function fontStack(font: PresentationFontFamily): string {
  if (font === 'serif') return 'Georgia,Times New Roman,serif'
  if (font === 'mono') return 'SFMono-Regular,Consolas,Liberation Mono,monospace'
  return 'system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif'
}

function elementCss(element: PresentationElement, className: string, index: number): string {
  const declarations = [
    `left:${cssNumber(element.x)}%`,
    `top:${cssNumber(element.y)}%`,
    `width:${cssNumber(element.width)}%`,
    `height:${cssNumber(element.height)}%`,
    `opacity:${cssNumber(element.opacity)}`,
    `transform:rotate(${cssNumber(element.rotation)}deg)`,
    `z-index:${index + 1}`
  ]
  if (element.type === 'text') {
    declarations.push(
      `color:${element.color}`,
      `font-size:${cssNumber(element.fontSize / 16)}cqw`,
      `font-weight:${element.fontWeight}`,
      ...(element.fontFamily ? [`font-family:${fontStack(element.fontFamily)}`] : []),
      `text-align:${element.align}`,
      `justify-content:${element.verticalAlign === 'top' ? 'flex-start' : element.verticalAlign === 'bottom' ? 'flex-end' : 'center'}`
    )
  } else if (element.type === 'shape') {
    if (element.shape === 'line') {
      declarations.push(
        'background:transparent',
        `border-top:${cssNumber(Math.max(1, element.strokeWidth))}px solid ${element.strokeColor}`
      )
    } else {
      declarations.push(
        `background:${element.fillColor}`,
        `border:${cssNumber(element.strokeWidth)}px solid ${element.strokeColor}`,
        `border-radius:${element.shape === 'ellipse' ? '50%' : `${cssNumber(element.cornerRadius)}px`}`
      )
    }
  } else {
    declarations.push(`object-fit:${element.fit}`)
  }
  return `.${className}{${declarations.join(';')}}`
}

function renderElement(
  element: PresentationElement,
  className: string,
  slideId: string
): string {
  const attributes = `class="kun-element ${className} kun-${element.type}" data-kun-slide-id="${escapeHtml(slideId)}" data-kun-element-id="${escapeHtml(element.id)}"`
  if (element.type === 'text') return `<div ${attributes}>${escapeHtml(element.text)}</div>`
  if (element.type === 'shape') {
    return `<div ${attributes} role="img" aria-label="${escapeHtml(`${element.shape} shape`)}"></div>`
  }
  return `<img ${attributes} src="${escapeHtml(element.src)}" alt="${escapeHtml(element.alt)}">`
}

export function serializePresentationHtml(value: PresentationProject): string {
  const project = normalizePresentationProject(value)
  const dynamicCss: string[] = []
  const slides = project.slides.map((slide, slideIndex) => {
    const slideClass = `kun-slide-${slideIndex}`
    dynamicCss.push(`.${slideClass}{background:${slide.backgroundColor ?? project.theme.backgroundColor}}`)
    const elements = slide.elements.map((element, elementIndex) => {
      const className = `kun-element-${slideIndex}-${elementIndex}`
      dynamicCss.push(elementCss(element, className, elementIndex))
      return renderElement(element, className, slide.id)
    }).join('\n')
    return `<section class="kun-slide ${slideClass}" data-kun-slide-id="${escapeHtml(slide.id)}" aria-label="${escapeHtml(slide.title)}">
${elements}
</section>`
  }).join('\n')
  const embeddedJson = escapeEmbeddedJson(stableStringify(project))
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: file:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'">
<title>${escapeHtml(project.title)}</title>
${MODEL_MARKER_START}${embeddedJson}${MODEL_MARKER_END}
<style>
:root{color-scheme:dark;font-family:${fontStack(project.theme.fontFamily)};background:#0B0F19}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:#0B0F19}
.kun-deck{display:grid;gap:5vh;justify-items:center;padding:5vh 3vw;scroll-snap-type:y mandatory}
.kun-slide{position:relative;container-type:inline-size;width:min(94vw,calc(90vh * 16 / 9));aspect-ratio:16/9;overflow:hidden;scroll-snap-align:center;box-shadow:0 1rem 3rem #0008}
.kun-element{position:absolute;margin:0;box-sizing:border-box;overflow:hidden}
.kun-text{display:flex;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.15}
.kun-image{display:block}
${dynamicCss.join('\n')}
@media print{@page{size:13.333in 7.5in;margin:0}html,body{background:#fff}.kun-deck{display:block;padding:0}.kun-slide{width:13.333in;height:7.5in;break-after:page;box-shadow:none}.kun-slide:last-child{break-after:auto}}
</style>
</head>
<body>
<main class="kun-deck" data-kun-presentation-id="${escapeHtml(project.id)}">
${slides}
</main>
</body>
</html>
`
  if (new TextEncoder().encode(html).byteLength > MAX_PRESENTATION_HTML_BYTES) {
    throw new PresentationParseError(`Rendered HTML exceeds ${MAX_PRESENTATION_HTML_BYTES} bytes`, [
      issue('html_too_large', '$', `Rendered HTML exceeds ${MAX_PRESENTATION_HTML_BYTES} bytes`)
    ])
  }
  return html
}

export const renderStandalonePresentation = serializePresentationHtml

export function parsePresentationHtml(html: string): PresentationProject {
  if (typeof html !== 'string') fail('invalid_type', '$html', 'Expected an HTML string')
  if (new TextEncoder().encode(html).byteLength > MAX_PRESENTATION_HTML_BYTES) {
    fail('html_too_large', '$html', `HTML exceeds ${MAX_PRESENTATION_HTML_BYTES} bytes`)
  }
  const start = html.indexOf(MODEL_MARKER_START)
  if (start < 0) fail('missing_model_marker', '$html', 'Presentation model marker is missing')
  if (html.indexOf(MODEL_MARKER_START, start + MODEL_MARKER_START.length) >= 0) {
    fail('duplicate_model_marker', '$html', 'Presentation contains multiple model markers')
  }
  const jsonStart = start + MODEL_MARKER_START.length
  const end = html.indexOf(MODEL_MARKER_END, jsonStart)
  if (end < 0) fail('unterminated_model_marker', '$html', 'Presentation model marker is not closed')
  return parsePresentationProject(html.slice(jsonStart, end))
}

export const extractPresentationFromHtml = parsePresentationHtml
