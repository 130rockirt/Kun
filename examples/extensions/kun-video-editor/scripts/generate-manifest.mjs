import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import ts from 'typescript'

const root = new URL('../', import.meta.url)
const contractsUrl = new URL('src/host/tool-contracts.ts', root)
const manifestUrl = new URL('kun-extension.json', root)

async function json(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, root), 'utf8'))
}

async function loadToolDeclarations() {
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
  const contracts = await import(`data:text/javascript;base64,${encoded}`)
  return contracts.VIDEO_TOOL_DECLARATIONS
}

async function createManifest() {
  const [metadata, localizations, contributions, tools] = await Promise.all([
    json('manifest/metadata.json'),
    json('manifest/localizations.json'),
    json('manifest/contributions.json'),
    loadToolDeclarations()
  ])
  return {
    ...metadata,
    localizations,
    contributes: { ...contributions, tools }
  }
}

const serialized = `${JSON.stringify(await createManifest())}\n`
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
