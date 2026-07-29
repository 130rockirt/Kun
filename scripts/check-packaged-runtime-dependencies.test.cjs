'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  packageNameFromSpecifier,
  sourceSpecifiers,
  isProductionPackage
} = require('./check-packaged-runtime-dependencies.cjs')

test('normalizes compiled external specifiers to package names', () => {
  assert.equal(packageNameFromSpecifier('@google/design.md/linter'), '@google/design.md')
  assert.equal(packageNameFromSpecifier('pdfjs-dist/legacy/build/pdf.mjs'), 'pdfjs-dist')
  assert.equal(packageNameFromSpecifier('node:fs'), undefined)
  assert.equal(packageNameFromSpecifier('./local-module.js'), undefined)
})

test('collects static ESM, dynamic import, and CommonJS dependencies', () => {
  assert.deepEqual(
    sourceSpecifiers(`
      import value from 'alpha'
      const lazy = import('@scope/bravo/subpath')
      const legacy = require("charlie")
      import 'delta/register'
      const resolution = require.resolve('echo/package.json')
      export { value } from 'foxtrot'
    `),
    ['alpha', '@scope/bravo/subpath', 'charlie', 'delta/register', 'echo/package.json', 'foxtrot']
  )
})

test('accepts only non-dev package-lock entries as packaged dependencies', () => {
  const lockfile = {
    packages: {
      'node_modules/runtime': { version: '1.0.0' },
      'node_modules/dev-only': { version: '1.0.0', dev: true }
    }
  }
  assert.equal(isProductionPackage(lockfile, 'runtime'), true)
  assert.equal(isProductionPackage(lockfile, 'dev-only'), false)
  assert.equal(isProductionPackage(lockfile, 'missing'), false)
})
