#!/usr/bin/env node
/**
 * Baut die Steuerung als einzelne HTML-Datei: läuft ohne Server per Doppelklick im Browser,
 * Steuerung und Simulation laufen im Browser.
 *
 *   npm run build:standalone                                → dist/rocking-boat-steuerung.html
 *   node tools/build-standalone.js [layout.json] [ziel.html]
 *
 * Die Module werden in Abhängigkeitsreihenfolge gebündelt, jedes in einem eigenen Gültigkeitsbereich.
 * Unterstützt werden nur die im Projekt verwendeten Formen `import { a, b } from './x.js'` und
 * `export function|class|const|let` – alles andere bricht den Build ab.
 */
import { Buffer } from 'node:buffer';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND_ENTRY = 'src/standalone.js';
const UI_ENTRY = 'public/js/app.js';
const DEFAULT_OUT = path.join(ROOT, 'dist', 'rocking-boat-steuerung.html');

const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?[ \t]*$/gm;
const EXPORT_RE = /^export\s+((?:async\s+)?function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm;

async function collect(file, modules, order) {
  if (modules.has(file)) return;
  modules.set(file, null);
  let code = await readFile(path.join(ROOT, file), 'utf8');
  const deps = [];
  code = code.replace(IMPORT_RE, (_, names, spec) => {
    // Node-Module werden nur von serverseitigen Funktionen genutzt (z. B. loadConfig).
    if (spec.startsWith('node:')) return '';
    if (!spec.startsWith('.')) throw new Error(`${file}: Import „${spec}“ wird nicht unterstützt`);
    const dep = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    deps.push(dep);
    const bindings = names
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => n.replace(/\s+as\s+/, ': '));
    return `const { ${bindings.join(', ')} } = __modules[${JSON.stringify(dep)}];`;
  });
  if (/^import\s/m.test(code)) throw new Error(`${file}: nicht unterstützte import-Anweisung`);
  const exported = [];
  code = code.replace(EXPORT_RE, (_, kind, name) => {
    exported.push(name);
    return `${kind} ${name}`;
  });
  if (/^export\s/m.test(code)) throw new Error(`${file}: nicht unterstützte export-Anweisung`);
  for (const dep of deps) await collect(dep, modules, order);
  modules.set(file, { code, exported });
  order.push(file);
}

async function bundle(entry, modules) {
  const order = [];
  await collect(entry, modules, order);
  return order.map((file) => {
    const { code, exported } = modules.get(file);
    return `// ---- ${file}\n__modules[${JSON.stringify(file)}] = (() => {\n${code}\nreturn { ${exported.join(', ')} };\n})();`;
  });
}

function replaceOnce(text, search, replacement) {
  const parts = text.split(search);
  if (parts.length !== 2) throw new Error(`public/index.html: „${search}“ nicht genau einmal gefunden`);
  return parts.join(replacement);
}

export async function buildStandalone({ configPath = path.join(ROOT, 'config', 'rocking-boat.json') } = {}) {
  const rawConfig = JSON.parse(await readFile(configPath, 'utf8'));
  normalizeConfig(rawConfig); // Layoutfehler schon beim Bauen melden

  const modules = new Map();
  const backend = await bundle(BACKEND_ENTRY, modules);
  const ui = await bundle(UI_ENTRY, modules);
  const script = [
    'const __modules = Object.create(null);',
    ...backend,
    `window.MMC_LOCAL_BACKEND = __modules[${JSON.stringify(BACKEND_ENTRY)}].startLocalBackend(${JSON.stringify(rawConfig)});`,
    ...ui,
  ]
    .join('\n\n')
    .replaceAll('</script', '<\\/script');

  const [html, css, favicon] = await Promise.all([
    readFile(path.join(ROOT, 'public', 'index.html'), 'utf8'),
    readFile(path.join(ROOT, 'public', 'css', 'hmi.css'), 'utf8'),
    readFile(path.join(ROOT, 'public', 'favicon.svg')),
  ]);
  let out = replaceOnce(html, '<!doctype html>', '<!doctype html>\n<!-- Erzeugt mit tools/build-standalone.js – Änderungen in public/ und src/ vornehmen, dann neu bauen. -->');
  out = replaceOnce(out, '<link rel="icon" href="favicon.svg" type="image/svg+xml">', `<link rel="icon" href="data:image/svg+xml;base64,${favicon.toString('base64')}">`);
  out = replaceOnce(out, '<link rel="stylesheet" href="css/hmi.css">', `<style>\n${css}</style>`);
  out = replaceOnce(out, '<script type="module" src="js/app.js"></script>', `<script type="module">\n${script}\n</script>`);
  return out;
}

async function main() {
  const configPath = path.resolve(process.argv[2] ?? process.env.RIDE_CONFIG ?? path.join(ROOT, 'config', 'rocking-boat.json'));
  const outPath = path.resolve(process.argv[3] ?? DEFAULT_OUT);
  const html = await buildStandalone({ configPath });
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, html);
  console.log(`Einzeldatei erstellt: ${outPath} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
