import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import ts from 'typescript'

const root = new URL('../', import.meta.url)
const contractsUrl = new URL('src/host/tool-contracts.ts', root)
const manifestUrl = new URL('kun-extension.json', root)

async function loadContributions() {
  const source = await readFile(contractsUrl, 'utf8')
  const { outputText, diagnostics = [] } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    },
    fileName: 'tool-contracts.ts',
    reportDiagnostics: true
  })
  assert.equal(diagnostics.length, 0, 'tool-contracts.ts must transpile without diagnostics')
  const encoded = Buffer.from(outputText).toString('base64')
  return import(`data:text/javascript;base64,${encoded}`)
}

function createManifest(contracts) {
  return {
    $schema: 'https://kun.dev/schemas/extensions/manifest/v1.json',
    manifestVersion: 1,
    apiVersion: '1.0.0',
    name: 'presentation-studio',
    publisher: 'kun-examples',
    version: '0.1.10',
    displayName: 'Kun PPT',
    description: 'A revision-aware Kun PPT display HTML workspace for people and the main Kun Agent.',
    license: 'MIT',
    engines: { kun: '>=0.1.0' },
    main: 'dist/host/extension.js',
    browser: 'dist/webview/index.html',
    activationEvents: [
      'onView:studio',
      'onCommand:presentation-create',
      'onCommand:presentation-load',
      'onCommand:presentation-save',
      'onCommand:presentation-export-copy',
      'onTool:presentation-create',
      'onTool:presentation-read',
      'onTool:presentation-apply',
      'onTool:presentation-validate',
      'onTool:presentation-export-copy'
    ],
    contributes: {
      commands: contracts.presentationCommandContributions,
      'views.rightSidebar': [contracts.presentationSidebarViewContribution],
      tools: contracts.presentationToolDeclarations
    },
    permissions: [
      'commands.register',
      'ui.views',
      'webview',
      'tools.register',
      'workspace.read',
      'workspace.write'
    ],
    stateSchemaVersion: 1
  }
}

const manifest = createManifest(await loadContributions())
const serialized = `${JSON.stringify(manifest)}\n`

if (process.argv.includes('--check')) {
  const current = await readFile(manifestUrl, 'utf8')
  if (current !== serialized) {
    console.error('kun-extension.json is stale; run npm run generate:manifest')
    process.exitCode = 1
  }
} else {
  await writeFile(manifestUrl, serialized)
  console.log(`Wrote ${manifestUrl.pathname}`)
}
