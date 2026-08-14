import { resolveInitialDevPreviewUrl } from './dev-preview-state'

export function resolveInitialDevBrowserUrl(input: {
  normalizedPreferredUrl?: string | null
  storedUrl?: string | null
  latestDetectedUrl?: string | null
}): string | null {
  return resolveInitialDevPreviewUrl({
    preferredUrl: input.normalizedPreferredUrl,
    workspaceUrl: input.storedUrl,
    detectedUrl: input.latestDetectedUrl
  })
}

export function canUseElectronWebviewEnvironment(input: {
  openExternalAvailable: boolean
  userAgent: string
}): boolean {
  return input.openExternalAvailable && /\bElectron\//.test(input.userAgent)
}

export function mapPreviewPointerToViewport(input: {
  clientX: number
  clientY: number
  bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>
  viewportWidth: number
  viewportHeight: number
}): { x: number; y: number } | null {
  if (input.bounds.width <= 0 || input.bounds.height <= 0) return null
  const x = (input.clientX - input.bounds.left) * (input.viewportWidth / input.bounds.width)
  const y = (input.clientY - input.bounds.top) * (input.viewportHeight / input.bounds.height)
  if (x < 0 || y < 0 || x > input.viewportWidth || y > input.viewportHeight) return null
  return { x, y }
}

export function buildDevPreviewElementInspectionScript(x: number, y: number): string {
  const point = JSON.stringify({ x, y })
  return `(() => {
    const point = ${point};
    const element = document.elementFromPoint(point.x, point.y);
    if (!(element instanceof Element)) return null;
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') || '').toLowerCase();
    const sensitive = tag === 'script' || tag === 'style' || tag === 'noscript' ||
      (tag === 'input' && ['password', 'hidden', 'file'].includes(type));
    if (sensitive) return { sensitive: true };
    if (tag === 'iframe') {
      try {
        if (!element.contentDocument || element.contentDocument.location.origin !== location.origin) {
          return { crossOriginFrame: true };
        }
      } catch { return { crossOriginFrame: true }; }
    }
    const escapeCss = (value) => {
      if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') return globalThis.CSS.escape(value);
      return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => '\\\\' + char);
    };
    const selectorParts = [];
    let cursor = element;
    while (cursor && selectorParts.length < 5) {
      let part = cursor.tagName.toLowerCase();
      if (cursor.id) { part += '#' + escapeCss(cursor.id); selectorParts.unshift(part); break; }
      const testId = cursor.getAttribute('data-testid');
      if (testId) part += '[data-testid="' + String(testId).replace(/["\\\\]/g, '\\\\$&').slice(0, 120) + '"]';
      else {
        const siblings = cursor.parentElement ? Array.from(cursor.parentElement.children).filter((item) => item.tagName === cursor.tagName) : [];
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(cursor) + 1) + ')';
      }
      selectorParts.unshift(part);
      cursor = cursor.parentElement;
    }
    const allowedAttributes = ['id','class','role','aria-label','aria-labelledby','aria-describedby','name','title','alt','href','src','type','data-testid'];
    const attributes = {};
    for (const name of allowedAttributes) {
      const value = element.getAttribute(name);
      if (value && name !== 'value') attributes[name] = value.slice(0, 512);
    }
    const computed = getComputedStyle(element);
    const allowedStyles = ['display','position','color','background-color','font-family','font-size','font-weight','line-height','text-align','border-radius','opacity','overflow'];
    const styles = {};
    for (const name of allowedStyles) {
      const value = computed.getPropertyValue(name).trim();
      if (value) styles[name] = value.slice(0, 128);
    }
    const rect = element.getBoundingClientRect();
    const visibleText = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
      ? ''
      : (element.innerText || element.textContent || '');
    return {
      url: location.href,
      tag,
      selector: selectorParts.join(' > ').slice(0, 512),
      text: visibleText.replace(/\\s+/g, ' ').trim().slice(0, 1024),
      attributes,
      styles,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight }
    };
  })()`
}
