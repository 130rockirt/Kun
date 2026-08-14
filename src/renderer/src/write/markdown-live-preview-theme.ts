import { HighlightStyle } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

export const writeMarkdownHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.875em', fontWeight: '700', letterSpacing: '-0.02em' },
  { tag: tags.heading2, fontSize: '1.5em', fontWeight: '650', letterSpacing: '-0.015em' },
  { tag: tags.heading3, fontSize: '1.25em', fontWeight: '650' },
  { tag: tags.heading4, fontSize: '1.06em', fontWeight: '650' },
  { tag: tags.heading5, fontSize: '1em', fontWeight: '650' },
  { tag: tags.heading6, fontSize: '0.95em', fontWeight: '650', color: 'var(--ds-text-muted)' },
  { tag: tags.processingInstruction, color: 'var(--ds-text-faint)', opacity: '0.58' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  {
    tag: tags.monospace,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: '0.9em',
    backgroundColor: 'color-mix(in srgb, var(--ds-text) 6%, transparent)',
    borderRadius: '5px'
  },
  { tag: tags.link, color: 'var(--ds-accent)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--ds-text-faint)', fontSize: '0.86em' },
  { tag: tags.quote, color: 'var(--ds-text-muted)' },
  { tag: tags.meta, color: 'var(--ds-text-faint)' }
])

export const writeMarkdownLiveTheme = EditorView.theme({
  '&.cm-write-live-preview .cm-activeLine': {
    backgroundColor: 'transparent'
  },
  '&.cm-write-live-preview .cm-line': {
    boxSizing: 'border-box',
    width: '100%',
    minWidth: '0',
    maxWidth: '720px',
    marginLeft: 'auto',
    marginRight: 'auto',
    paddingTop: '0.18rem',
    paddingBottom: '0.18rem'
  },
  '&.cm-write-live-preview .cm-write-md-center-line': {
    textAlign: 'center'
  },
  '&.cm-write-live-preview .cm-write-md-blockquote-line': {
    borderLeft: '3px solid color-mix(in srgb, var(--ds-text) 78%, transparent)',
    color: 'var(--ds-text)',
    paddingLeft: '1em'
  },
  '&.cm-write-live-preview .cm-write-md-link-text': {
    color: 'var(--ds-accent)',
    textDecoration: 'underline',
    textUnderlineOffset: '3px'
  },
  '&.cm-write-live-preview .cm-write-md-mark': {
    borderRadius: '4px',
    backgroundColor: 'color-mix(in srgb, #f7d154 48%, transparent)',
    padding: '0 2px'
  }
})
