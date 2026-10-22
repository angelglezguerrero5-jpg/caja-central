// Verifica el build en dist/: manifest válido, íconos reales (tamaño declarado = tamaño del PNG), metas de iPhone y que TODO lo
// que el service worker precachea exista de verdad. Falla (exit 1) si algo no cuadra.
// Esto NO sustituye abrir la app en un iPhone o un Android reales: solo comprueba que el paquete que se publicaría es coherente.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2] ?? 'dist';
const problems = [];
const need = (cond, msg) => cond || problems.push(msg);

/** Lee la cabecera de un PNG: { width, height, colorType } o null si no es un PNG. */
function pngInfo(file) {
  const b = readFileSync(file);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (b.length < 29 || !b.subarray(0, 8).equals(sig) || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
}

need(existsSync(join(dist, 'index.html')), 'falta dist/index.html (corre npm run build)');
need(existsSync(join(dist, 'sw.js')), 'falta dist/sw.js');
need(existsSync(join(dist, 'manifest.webmanifest')), 'falta el manifest');

if (problems.length === 0) {
  const m = JSON.parse(readFileSync(join(dist, 'manifest.webmanifest'), 'utf8'));
  const html = readFileSync(join(dist, 'index.html'), 'utf8');

  // ── Manifest ──────────────────────────────────────────────────────────────────────────────────────────────────────
  for (const k of ['name', 'short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color', 'id', 'lang']) {
    need(typeof m[k] === 'string' && m[k].length > 0, `manifest.${k} falta o está vacío`);
  }
  need(m.display === 'standalone', 'manifest.display debe ser standalone');
  need(m.start_url === '/', 'manifest.start_url debe ser "/"');
  need(m.scope === '/', 'manifest.scope debe ser "/"');
  need((m.short_name ?? '').length <= 12, 'manifest.short_name debe ser corto (≤ 12): es el nombre bajo el ícono');
  need(/^#[0-9a-f]{6}$/i.test(m.theme_color ?? ''), 'manifest.theme_color debe ser #rrggbb');
  need(/^#[0-9a-f]{6}$/i.test(m.background_color ?? ''), 'manifest.background_color debe ser #rrggbb');
  need(m.orientation === undefined || m.orientation === 'any', 'manifest.orientation no debe bloquear la orientación (soporte vertical y horizontal)');
  const has = (size, purpose) => m.icons?.some((i) => i.sizes === size && (i.purpose ?? 'any') === purpose);
  need(has('180x180', 'any'), 'falta ícono 180 any (iPhone)');
  need(has('192x192', 'any'), 'falta ícono 192 any');
  need(has('512x512', 'any'), 'falta ícono 512 any');
  need(has('512x512', 'maskable'), 'falta ícono 512 maskable');
  for (const i of m.icons ?? []) {
    const f = join(dist, i.src);
    need(existsSync(f), `ícono inexistente: ${i.src}`);
    if (!existsSync(f)) continue;
    const info = pngInfo(f);
    need(info !== null, `${i.src} no es un PNG válido`);
    if (info) need(`${info.width}x${info.height}` === i.sizes, `${i.src}: el manifest dice ${i.sizes} pero el PNG mide ${info.width}x${info.height}`);
    need(i.type === 'image/png', `${i.src}: type debe ser image/png`);
  }

  // ── index.html: iPhone y navegador ────────────────────────────────────────────────────────────────────────────────
  const meta = (name) => html.match(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'i'))?.[1];
  need(/viewport-fit=cover/.test(meta('viewport') ?? ''), 'el viewport debe incluir viewport-fit=cover (zonas seguras del iPhone)');
  need(!/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/.test(meta('viewport') ?? ''), 'el viewport no debe impedir el zoom (accesibilidad)');
  need(meta('apple-mobile-web-app-capable') === 'yes', 'falta <meta name="apple-mobile-web-app-capable" content="yes">');
  need((meta('apple-mobile-web-app-title') ?? '').length > 0, 'falta <meta name="apple-mobile-web-app-title">');
  need(['default', 'black', 'black-translucent'].includes(meta('apple-mobile-web-app-status-bar-style') ?? ''), 'falta o es inválido apple-mobile-web-app-status-bar-style');
  need(/telephone=no/.test(meta('format-detection') ?? ''), 'falta format-detection telephone=no (iOS convertiría cifras en teléfonos)');
  need(/^#[0-9a-f]{6}$/i.test(meta('theme-color') ?? ''), 'falta <meta name="theme-color">');
  need(/rel="manifest"\s+href="\/manifest\.webmanifest"/.test(html), 'index.html no enlaza el manifest');
  need(/Content-Security-Policy/.test(html) && /default-src 'self'/.test(html), 'index.html debe traer la Content-Security-Policy');
  const apple = html.match(/<link\s+rel="apple-touch-icon"\s+sizes="180x180"\s+href="(\/[^"]+)"/)?.[1];
  need(!!apple, 'falta <link rel="apple-touch-icon" sizes="180x180">');
  if (apple) {
    const f = join(dist, apple);
    need(existsSync(f), `apple-touch-icon inexistente: ${apple}`);
    const info = existsSync(f) ? pngInfo(f) : null;
    need(info?.width === 180 && info?.height === 180, `${apple} debe medir 180x180`);
    need(info?.colorType === 2, `${apple} no debe tener canal alfa (iOS rellena la transparencia de negro): colorType=${info?.colorType}`);
  }

  // ── Service worker ────────────────────────────────────────────────────────────────────────────────────────────────
  const sw = readFileSync(join(dist, 'sw.js'), 'utf8');
  const list = JSON.parse(sw.match(/const PRECACHE = (\[[\s\S]*?\]);/)[1]);
  for (const u of list) {
    const f = u === '/' ? 'index.html' : u.slice(1);
    need(existsSync(join(dist, f)), `precache apunta a un archivo inexistente: ${u}`);
  }
  for (const [, ref] of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
    need(list.includes(ref), `index.html usa ${ref} pero no está en el precache`);
  }
  for (const i of m.icons ?? []) need(list.includes(i.src), `el ícono ${i.src} del manifest no está en el precache`);
  need(/const CACHE = 'caja-central-[0-9a-f]{12}'/.test(sw), 'la caché del service worker debe llevar versión (caja-central-<hash>)');
  // Seguridad de la caché: solo se precachea lo estático del build. Nada de guardar respuestas de la red al vuelo
  // (en esta app los datos viven en IndexedDB, no en cachés), nada de peticiones que no sean GET ni de otros orígenes.
  need(!/\.put\(/.test(sw) && !/\.add\(/.test(sw), 'el service worker no debe guardar respuestas al vuelo (put/add con cualquier nombre de caché): solo el precache del build');
  need(/req\.method !== 'GET'/.test(sw), 'el service worker debe ignorar peticiones que no sean GET');
  need(/url\.origin !== self\.location\.origin/.test(sw), 'el service worker debe ignorar otros orígenes');
  need(/k\.startsWith\('caja-central-'\)/.test(sw), 'el service worker solo debe borrar sus propias cachés (prefijo caja-central-)');
  console.log(`precache: ${list.length} archivos · versión ${sw.match(/caja-central-[0-9a-f]+/)[0]}`);
}

if (problems.length) {
  console.error('✖ verificación PWA falló:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('✔ build PWA consistente (manifest, íconos reales, metas de iPhone y precache)');
