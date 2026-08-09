import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

async function loadYaml() {
  const configuredModule = process.env.KUN_PPT_YAML_MODULE;
  if (configuredModule) {
    const yaml = await import(pathToFileURL(configuredModule).href);
    return yaml.parse;
  }
  try {
    const yaml = await import('yaml');
    return yaml.parse;
  } catch {
    try {
      const yaml = require('js-yaml');
      return (s) => yaml.load(s);
    } catch {
      // fallback: python3 + PyYAML
      return (text) => {
        const { spawnSync } = require('node:child_process');
        const r = spawnSync(
          'python3',
          ['-c', 'import sys,yaml,json; print(json.dumps(yaml.safe_load(sys.stdin.read()), ensure_ascii=False))'],
          { input: text, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
        );
        if (r.status !== 0) throw new Error('python yaml failed: ' + (r.stderr || r.stdout));
        return JSON.parse(r.stdout);
      };
    }
  }
}

/** Canonical patched WASM lives in the editor mirror; skill install copies it here. */
export const CANONICAL_WASM_NAME = 'pptd_wasm_bg-DPPWdROu.wasm';

function resolveDefaultWasmPath() {
  const candidates = [
    path.join(__dirname, 'pptd_wasm_bg.wasm'), // installed skill copy
    path.join(__dirname, CANONICAL_WASM_NAME),
    // monorepo / npm package: scripts/local-export → package root
    path.join(__dirname, '..', '..', '..', '..', 'editor', 'neo-ppt', 'assets', CANONICAL_WASM_NAME),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

// ---------- CLI ----------
function parseArgs(argv) {
  const args = {
    input: null,
    output: null,
    cookie: process.env.KIMI_COOKIE || '',
    origin: process.env.KIMI_ORIGIN || 'https://www.kimi.com',
    noSign: false,
    localImagesOnly: false,
    embedFonts: false,
    transition: 'fade',
    wasmPath: null,
  };
  const a = [...argv];
  while (a.length) {
    const x = a.shift();
    if (x === '-o' || x === '--output') args.output = a.shift();
    else if (x === '--cookie') args.cookie = a.shift();
    else if (x === '--origin') args.origin = a.shift();
    else if (x === '--no-sign') args.noSign = true;
    else if (x === '--local-images-only') args.localImagesOnly = true;
    else if (x === '--embed-fonts') args.embedFonts = true;
    else if (x === '--transition') args.transition = a.shift();
    else if (x === '--wasm') args.wasmPath = a.shift();
    else if (x === '-h' || x === '--help') args.help = true;
    else if (!x.startsWith('-') && !args.input) args.input = x;
    else throw new Error(`Unknown arg: ${x}`);
  }
  if (!args.wasmPath) args.wasmPath = resolveDefaultWasmPath();
  return args;
}

// ---------- PPTD project load ----------
function findManifest(input) {
  const p = path.resolve(input);
  if (fs.statSync(p).isFile() && p.endsWith('.pptd')) return p;
  const files = fs.readdirSync(p).filter((f) => f.endsWith('.pptd'));
  if (files.length === 1) return path.join(p, files[0]);
  if (files.length === 0) throw new Error(`No .pptd in ${p}`);
  throw new Error(`Multiple .pptd in ${p}: ${files.join(', ')}`);
}

async function loadProject(manifestPath, parseYaml) {
  const root = path.dirname(manifestPath);
  const canonicalRoot = fs.realpathSync(root);
  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const manifest = parseYaml(manifestText);
  if (!manifest || manifest.version !== 'v2') {
    throw new Error('Only PPTD version: v2 is supported');
  }
  if (!Array.isArray(manifest.pages) || !manifest.pages.length) {
    throw new Error('manifest.pages must be a non-empty array');
  }

  const pages = [];
  for (const rel of manifest.pages) {
    const pagePath = resolveProjectFile(root, canonicalRoot, rel, 'page');
    if (!fs.existsSync(pagePath)) throw new Error(`Missing page: ${rel}`);
    const page = parseYaml(fs.readFileSync(pagePath, 'utf8'));
    if (!page || !Array.isArray(page.elements)) {
      throw new Error(`Invalid page elements: ${rel}`);
    }
    // Match official nt()/rt() shape: embed full page objects
    pages.push({
      ...page,
      pagePath: rel.replace(/\\/g, '/'),
      elements: page.elements.map(normalizeElement),
    });
  }

  return {
    ...manifest,
    version: 'v2',
    pages,
    pptdFileName: path.basename(manifestPath),
  };
}

function resolveProjectFile(projectRoot, canonicalRoot, requested, kind) {
  if (typeof requested !== 'string' || !requested || /^file:/i.test(requested)) {
    throw new Error(`Invalid local ${kind} path: ${String(requested)}`);
  }
  const target = path.resolve(projectRoot, requested.replace(/\\/g, '/'));
  const lexicalRelative = path.relative(projectRoot, target);
  if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
    throw new Error(`Local ${kind} escapes the PPTD project: ${requested}`);
  }
  if (!fs.existsSync(target)) return target;
  const canonicalTarget = fs.realpathSync(target);
  const canonicalRelative = path.relative(canonicalRoot, canonicalTarget);
  if (canonicalRelative === '..' || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
    throw new Error(`Local ${kind} resolves outside the PPTD project: ${requested}`);
  }
  return canonicalTarget;
}

function normalizeElement(el) {
  // Official it()/at(): ensure custom shapes get viewBox from bounds
  if (el.elementType === 'shape') {
    return ensureViewBox(el, [el.bounds?.[2], el.bounds?.[3]]);
  }
  if (el.elementType === 'image' && el.cropShape) {
    return {
      ...el,
      cropShape: ensureViewBox(el.cropShape, [el.bounds?.[2], el.bounds?.[3]]),
    };
  }
  return el;
}

function ensureViewBox(shape, size) {
  if (
    shape.shapeName !== 'custom' ||
    !shape.path ||
    shape.viewBox ||
    String(shape.path).includes(';')
  ) {
    return shape;
  }
  return { ...shape, viewBox: size };
}

// ---------- image resolve (official Bt + Ht) ----------

export { findManifest, loadProject, loadYaml, parseArgs, resolveProjectFile };
