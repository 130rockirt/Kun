'use strict'

// Shared pure-JS runtimes that the root app and Kun resolve identically.
// after-pack removes the Kun copy from app.asar.unpacked/kun/node_modules; the
// packaged Kun child process then resolves these upward into
// app.asar.unpacked/node_modules, which electron-builder.config.cjs keeps on
// disk via asarUnpack.
//
// Every entry here must also appear in KUN_ROOT_HOISTED_VERSION_ANCHORS so the
// pack fails loudly whenever the root and Kun copies stop matching.
const KUN_ROOT_HOISTED_SHARED_JS_PACKAGES = [
  'pdfjs-dist',
  'xlsx',
  'diff',
  'ipaddr.js',
  'proxy-agent',
  'agent-base',
  'http-proxy-agent',
  'https-proxy-agent',
  'pac-proxy-agent',
  'pac-resolver',
  'proxy-from-env',
  'socks-proxy-agent',
  'socks',
  'smart-buffer',
  'ip-address',
  'netmask',
  'degenerator',
  'ast-types',
  'escodegen',
  'esprima',
  'estraverse',
  'esutils',
  'get-uri',
  'data-uri-to-buffer',
  'basic-ftp',
  'debug',
  'ms',
  'semver',
  'yaml',
  'yauzl',
  // yazl's buffer-crc32 and yauzl's pend transitive deps are deliberately NOT
  // hoisted: electron-builder resolves yazl's buffer-crc32 against extract-zip's
  // nested 0.2.13 copy, so that version anchor can never match. Their nested
  // copies under kun/node_modules stay packaged so Kun keeps resolving the
  // matching 1.0.0; only the package bodies are deduplicated here.
  'yazl',
  'zod'
]

module.exports = {
  KUN_ROOT_HOISTED_SHARED_JS_PACKAGES
}
