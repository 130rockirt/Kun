declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string)
    readonly window: Window & {
      close(): void
      Element: typeof Element
      HTMLElement: typeof HTMLElement
    }
  }
}
