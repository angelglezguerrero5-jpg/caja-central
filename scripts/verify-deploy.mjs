// Verifica una dirección YA servida (una prueba publicada o un servidor local): HTTPS, raíz del dominio, manifest, íconos reales,
// apple-touch-icon, service worker con todo su precache, y cabeceras de caché y seguridad. Solo hace GET/HEAD: no escribe nada.
//
//   node scripts/verify-deploy.mjs https://mi-prueba.ejemplo.com
//   npm run verify:deploy -- https://mi-prueba.ejemplo.com
//
// Sale con código 1 si hay algún FAIL. Los WARN no fallan pero hay que leerlos.
// Esto NO sustituye abrir la dirección en un iPhone y un Android reales (instalar, modo avión, actualizar): ver docs/IPHONE.md.

const input = process.argv[2];
if (!input) {
  console.error('Uso: node scripts/verify-deploy.mjs https://direccion-publicada');
  process.exit(2);
}

const results = [];
const note = (level, msg) => results.push({ level, msg });
const pass = (msg) => note('PASS', msg);
const warn = (msg) => note('WARN', msg);
const fail = (msg) => note('FAIL', msg);
const check = (cond, okMsg, failMsg, level = 'FAIL') => (cond ? pass(okMsg) : note(level, failMsg));

/** Lee la cabecera de un PNG: { width, height, colorType } o null si no es un PNG. */
function pngInfo(buf) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.length < 29 || !buf.subarray(0, 8).equals(sig) || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

async function main() {
  let base;
  try {
    base = new URL(input);
  } catch {
    fail(`«${input}» no es una dirección válida`);
    return;
  }
  const local = LOCAL.has(base.hostname);
  if (base.protocol === 'https:') pass('la dirección usa HTTPS');
  else if (base.protocol === 'http:' && local) warn('http local: sirve para ver la app en esta computadora o por cable (Android), NO para instalarla en un iPhone');
  else fail('la dirección no usa HTTPS: iPhone y Android no instalarán la app ni activarán el service worker');
  check(base.pathname === '/' || base.pathname === '', 'la app está en la raíz del dominio', `la dirección tiene ruta «${base.pathname}»: el manifest usa start_url "/" y scope "/", así que debe estar en la raíz de su propio dominio`);
  const origin = base.origin;

  const get = async (path, init = {}) => {
    try {
      const res = await fetch(new URL(path, origin), { redirect: 'manual', ...init });
      return { res, body: Buffer.from(await res.arrayBuffer()) };
    } catch (e) {
      return { error: e?.cause?.code ?? e?.message ?? String(e) };
    }
  };
  const head = (r, name) => r.res.headers.get(name) ?? '';
  const longCache = (cc) => /immutable/i.test(cc) || Number(cc.match(/max-age=(\d+)/i)?.[1] ?? 0) >= 3600;
  const revalidates = (cc) => /no-cache|no-store|must-revalidate|max-age=0/i.test(cc);

  // ── Página principal ───────────────────────────────────────────────────────────────────────────────────────────────
  const page = await get('/');
  if (page.error) {
    fail(`no se pudo abrir ${origin}/ (${page.error})`);
    return;
  }
  check(page.res.status === 200, 'GET / responde 200', `GET / respondió ${page.res.status} (debe ser 200, sin redirigir)`);
  check(/text\/html/i.test(head(page, 'content-type')), 'GET / es HTML', `GET / tiene content-type «${head(page, 'content-type')}»`);
  const html = page.body.toString('utf8');
  const cacheIndex = head(page, 'cache-control');
  if (longCache(cacheIndex) && !revalidates(cacheIndex)) warn(`index.html con caché larga («${cacheIndex}»): las versiones nuevas tardarían en llegar a los teléfonos`);
  else pass('index.html no se queda guardado por mucho tiempo');

  const meta = (name) => html.match(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'i'))?.[1];
  check(/viewport-fit=cover/.test(meta('viewport') ?? ''), 'viewport con viewport-fit=cover (zonas seguras del iPhone)', 'el viewport no incluye viewport-fit=cover');
  check(meta('apple-mobile-web-app-capable') === 'yes', 'meta apple-mobile-web-app-capable', 'falta <meta name="apple-mobile-web-app-capable" content="yes">');
  check((meta('apple-mobile-web-app-title') ?? '').length > 0, 'meta apple-mobile-web-app-title', 'falta apple-mobile-web-app-title');
  check(/^#[0-9a-f]{6}$/i.test(meta('theme-color') ?? ''), 'meta theme-color', 'falta theme-color');
  check(/Content-Security-Policy/.test(html), 'trae Content-Security-Policy', 'index.html no trae Content-Security-Policy', 'WARN');

  // ── Manifest ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const manifestHref = html.match(/<link\s+rel="manifest"\s+href="([^"]+)"/i)?.[1];
  check(!!manifestHref, 'index.html enlaza el manifest', 'index.html no enlaza el manifest');
  let manifest = null;
  if (manifestHref) {
    const m = await get(manifestHref);
    if (m.error || m.res.status !== 200) fail(`el manifest (${manifestHref}) no se pudo leer (${m.error ?? m.res.status})`);
    else {
      check(/json/i.test(head(m, 'content-type')), 'el manifest se sirve como JSON', `el manifest tiene content-type «${head(m, 'content-type')}» (debe ser application/manifest+json)`, 'WARN');
      try {
        manifest = JSON.parse(m.body.toString('utf8'));
      } catch {
        fail('el manifest no es JSON válido');
      }
    }
  }
  if (manifest) {
    for (const k of ['name', 'short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color']) check(typeof manifest[k] === 'string' && manifest[k], `manifest.${k}`, `manifest.${k} falta o está vacío`);
    check(manifest.display === 'standalone', 'manifest.display = standalone', `manifest.display = «${manifest.display}» (debe ser standalone)`);
    check(manifest.start_url === '/' && manifest.scope === '/', 'start_url y scope = "/"', `start_url «${manifest.start_url}» / scope «${manifest.scope}» (deben ser "/")`);
    check(manifest.orientation === undefined || manifest.orientation === 'any', 'el manifest no bloquea la orientación', `manifest.orientation = «${manifest.orientation}»: bloquea girar el teléfono`);
    check((manifest.short_name ?? '').length <= 12, 'short_name corto (cabe bajo el ícono)', 'short_name de más de 12 caracteres');
    const sizes = new Set();
    for (const icon of manifest.icons ?? []) {
      const r = await get(icon.src);
      if (r.error || r.res.status !== 200) {
        fail(`ícono ${icon.src}: no se pudo leer (${r.error ?? r.res.status})`);
        continue;
      }
      const info = pngInfo(r.body);
      check(/image\/png/i.test(head(r, 'content-type')), `${icon.src} se sirve como PNG`, `${icon.src} tiene content-type «${head(r, 'content-type')}»`);
      check(info !== null && `${info.width}x${info.height}` === icon.sizes, `${icon.src} mide ${icon.sizes}`, `${icon.src}: el manifest dice ${icon.sizes} pero ${info ? `el PNG mide ${info.width}x${info.height}` : 'no es un PNG válido'}`);
      sizes.add(`${icon.sizes} ${icon.purpose ?? 'any'}`);
    }
    for (const need of ['192x192 any', '512x512 any', '512x512 maskable']) check(sizes.has(need), `ícono ${need}`, `falta el ícono ${need}`);
  }

  // ── apple-touch-icon (iPhone) ──────────────────────────────────────────────────────────────────────────────────────
  const apple = html.match(/<link\s+rel="apple-touch-icon"\s+sizes="180x180"\s+href="([^"]+)"/i)?.[1];
  check(!!apple, 'index.html trae apple-touch-icon de 180x180', 'falta <link rel="apple-touch-icon" sizes="180x180">');
  if (apple) {
    const r = await get(apple);
    const info = r.error ? null : pngInfo(r.body);
    check(!r.error && r.res.status === 200 && info?.width === 180 && info?.height === 180, `apple-touch-icon (${apple}) mide 180x180`, `apple-touch-icon (${apple}) no se pudo leer o no mide 180x180`);
    check(info?.colorType === 2, 'apple-touch-icon sin transparencia (iOS rellenaría de negro)', `apple-touch-icon con canal alfa (colorType ${info?.colorType}): en iPhone se vería con fondo negro`);
  }

  // ── Service worker ─────────────────────────────────────────────────────────────────────────────────────────────────
  const sw = await get('/sw.js');
  if (sw.error || sw.res.status !== 200) fail(`/sw.js no se pudo leer (${sw.error ?? sw.res.status})`);
  else {
    const swText = sw.body.toString('utf8');
    check(/javascript/i.test(head(sw, 'content-type')) && !/^\s*<!doctype html/i.test(swText), '/sw.js se sirve como JavaScript', `/sw.js tiene content-type «${head(sw, 'content-type')}» o devuelve HTML (¿el hosting reescribe todo a index.html?)`);
    const cc = head(sw, 'cache-control');
    check(!(longCache(cc) && !revalidates(cc)), 'sw.js no tiene caché larga', `sw.js con caché larga («${cc}»): los teléfonos tardarían en enterarse de una versión nueva`);
    const list = (() => {
      try {
        return JSON.parse(swText.match(/const PRECACHE = (\[[\s\S]*?\]);/)[1]);
      } catch {
        return null;
      }
    })();
    check(Array.isArray(list) && list.length > 0, `el service worker precachea ${list?.length ?? 0} archivos`, 'no se pudo leer la lista PRECACHE de sw.js');
    check(/const CACHE = 'limones-[0-9a-f]{12}'/.test(swText), 'la caché del service worker lleva versión', 'la caché del service worker no lleva versión limones-<hash>');
    check(!/\.put\(/.test(swText), 'el service worker no guarda respuestas al vuelo', 'el service worker usa .put(: guardaría datos de la red');
    if (Array.isArray(list)) {
      const missing = [];
      await Promise.all(
        list.map(async (u) => {
          const r = await get(u);
          if (r.error || r.res.status !== 200) missing.push(`${u} (${r.error ?? r.res.status})`);
        }),
      );
      check(missing.length === 0, 'todo lo que precachea el service worker existe en el servidor', `el precache apunta a archivos que no responden 200: ${missing.join(', ')}`);
      for (const [, ref] of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) check(list.includes(ref), `${ref} está en el precache`, `index.html usa ${ref} pero no está en el precache`);
    }
  }

  // ── Cabeceras ──────────────────────────────────────────────────────────────────────────────────────────────────────
  if (base.protocol === 'https:') {
    check(!!head(page, 'strict-transport-security'), 'Strict-Transport-Security', 'falta Strict-Transport-Security (HSTS)', 'WARN');
    if (!local && !base.port) {
      const plain = await fetch(`http://${base.host}/`, { redirect: 'manual' }).catch((e) => ({ error: e?.cause?.code ?? e?.message ?? String(e) }));
      if (plain.error) warn(`no se pudo comprobar la redirección de http a https (${plain.error}); puede ser que el hosting no atienda el puerto 80`);
      else check([301, 302, 307, 308].includes(plain.status) && /^https:/i.test(plain.headers.get('location') ?? ''), 'http:// redirige a https://', `http:// responde ${plain.status} sin redirigir a https`, 'WARN');
    }
  }
  check(/nosniff/i.test(head(page, 'x-content-type-options')), 'X-Content-Type-Options: nosniff', 'falta X-Content-Type-Options: nosniff', 'WARN');
  check(!!head(page, 'referrer-policy'), 'Referrer-Policy', 'falta Referrer-Policy', 'WARN');
  const csp = head(page, 'content-security-policy');
  check(/frame-ancestors/i.test(csp) || !!head(page, 'x-frame-options'), 'no se puede incrustar en otro sitio (frame-ancestors / X-Frame-Options)', 'falta frame-ancestors (en la cabecera Content-Security-Policy) o X-Frame-Options: otro sitio podría incrustar la app', 'WARN');
}

await main();

const order = { FAIL: 0, WARN: 1, PASS: 2 };
for (const r of [...results].sort((a, b) => order[a.level] - order[b.level])) console.log(`${r.level.padEnd(4)}  ${r.msg}`);
const count = (l) => results.filter((r) => r.level === l).length;
console.log(`\n${count('PASS')} PASS · ${count('WARN')} WARN · ${count('FAIL')} FAIL  —  ${input}`);
console.log('Esto solo revisa la dirección; instalar, modo avión y actualizar se prueban en el teléfono (docs/IPHONE.md, docs/ANDROID.md).');
process.exit(count('FAIL') > 0 ? 1 : 0);
