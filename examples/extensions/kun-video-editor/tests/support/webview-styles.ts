import { readFileSync } from 'node:fs'

export function webviewStyles(): string {
  return [
    '../../src/webview/styles.css',
    '../../src/webview/styles/base.css',
    '../../src/webview/styles/workbench.css',
    '../../src/webview/styles/workspaces.css',
    '../../src/webview/styles/fidelity.css'
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n')
}
