// Verifica el build en dist/: manifest válido, íconos existentes y que TODO lo que
// el service worker precachea exista de verdad. Falla (exit 1) si algo no cuadra.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
const problems = [];
const need = (cond, msg) => cond || problems.push(msg);

need(existsSync(join(dist, 'index.html')), 'falta dist/index.html (corre npm run build)');
need(existsSync(join(dist, 'sw.js')), 'falta dist/sw.js');
need(existsSync(join(dist, 'manifest.webmanifest')), 'falta el manifest');

if (problems.length === 0) {
  const m = JSON.parse(readFileSync(join(dist, 'manifest.webmanifest'), 'utf8'));
  need(m.display === 'standalone', 'manifest.display debe ser standalone');
  need(m.start_url === '/', 'manifest.start_url debe ser "/"');
  const has = (size, purpose) => m.icons?.some((i) => i.sizes === size && (i.purpose ?? 'any') === purpose);
  need(has('192x192', 'any'), 'falta ícono 192 any');
  need(has('512x512', 'any'), 'falta ícono 512 any');
  need(has('512x512', 'maskable'), 'falta ícono 512 maskable');
  for (const i of m.icons ?? []) need(existsSync(join(dist, i.src)), `ícono inexistente: ${i.src}`);

  const sw = readFileSync(join(dist, 'sw.js'), 'utf8');
  const list = JSON.parse(sw.match(/const PRECACHE = (\[[\s\S]*?\]);/)[1]);
  for (const u of list) {
    const f = u === '/' ? 'index.html' : u.slice(1);
    need(existsSync(join(dist, f)), `precache apunta a un archivo inexistente: ${u}`);
  }
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  for (const [, ref] of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
    need(list.includes(ref), `index.html usa ${ref} pero no está en el precache`);
  }
  console.log(`precache: ${list.length} archivos · versión ${sw.match(/limones-[0-9a-f]+/)[0]}`);
}

if (problems.length) {
  console.error('✖ verificación PWA falló:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('✔ build PWA consistente (manifest, íconos y precache)');
