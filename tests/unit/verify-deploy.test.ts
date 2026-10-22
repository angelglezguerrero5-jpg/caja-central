import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

/**
 * scripts/verify-deploy.mjs revisa una dirección ya servida. Aquí se levanta un sitio de prueba (armado con el manifest, los
 * íconos y el index.html reales del proyecto) en un servidor local y se comprueba que el script da el visto bueno al sitio
 * correcto y marca FAIL en cada defecto que se le introduce. NO se ejercita contra un servidor HTTPS real: las comprobaciones
 * propias de HTTPS (HSTS, redirección de http a https) quedan sin probar.
 */

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', 'verify-deploy.mjs');

interface Reply {
  status?: number;
  type?: string;
  headers?: Record<string, string>;
  body: Buffer | string;
}
type Override = (path: string) => Reply | undefined;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
/** Un PNG sólido de `size`×`size`; colorType 2 = RGB, 6 = RGBA (con transparencia). */
function png(size: number, colorType: 2 | 6): Buffer {
  const channels = colorType === 6 ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const row = Buffer.alloc(1 + size * channels, 0x7f);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function buildSite(dir: string) {
  cpSync(join(ROOT, 'public'), dir, { recursive: true });
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8').replace('/src/main.tsx', '/assets/app.js');
  writeFileSync(join(dir, 'index.html'), html);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("app")');
  const urls = ['/', '/index.html', '/manifest.webmanifest', '/icons/apple-touch-icon.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/assets/app.js'];
  writeFileSync(join(dir, 'sw.js'), `const CACHE = 'caja-central-0123456789ab';\nconst PRECACHE = ${JSON.stringify(urls)};\nself.addEventListener('fetch', () => {});\n`);
}

const servers: Server[] = [];
const dirs: string[] = [];

async function serve(prepare: (dir: string) => void = () => {}, override: Override = () => undefined, prefix = ''): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'verify-deploy-'));
  dirs.push(dir);
  buildSite(dir);
  prepare(dir);
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const rel = prefix && path.startsWith(prefix) ? path.slice(prefix.length - 1) : path;
    const forced = override(rel);
    const reply: Reply | undefined =
      forced ??
      (() => {
        const file = rel === '/' ? 'index.html' : rel.slice(1);
        try {
          return { body: readFileSync(join(dir, file)), type: TYPES[extname(file)] ?? 'application/octet-stream' };
        } catch {
          return { status: 404, type: 'text/plain', body: 'no encontrado' };
        }
      })();
    res.writeHead(reply.status ?? 200, { 'content-type': reply.type ?? TYPES[extname(rel)] ?? 'text/html', ...(reply.headers ?? {}) });
    res.end(reply.body);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${prefix}`;
}

function verify(...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, ...args], { timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      done({ code, out: stdout + stderr });
    });
  });
}

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((ok) => s.close(ok))));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const SECURE = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "frame-ancestors 'none'" };

describe('verify-deploy: el sitio correcto', () => {
  let url = '';
  beforeAll(async () => {
    url = await serve(undefined, (p) => (p === '/' ? { body: readFileSync(join(ROOT, 'index.html'), 'utf8').replace('/src/main.tsx', '/assets/app.js'), type: TYPES['.html'], headers: SECURE } : undefined));
  });

  it('lo da por bueno (sin FAIL) y avisa que http local no sirve para instalar en iPhone', async () => {
    const { code, out } = await verify(url);
    expect(out).not.toMatch(/^FAIL/m);
    expect(code).toBe(0);
    expect(out).toMatch(/^WARN\s+http local/m);
    expect(out).toContain('PASS  apple-touch-icon (/icons/apple-touch-icon.png) mide 180x180');
    expect(out).toContain('PASS  todo lo que precachea el service worker existe en el servidor');
    expect(out).toMatch(/\d+ PASS · 1 WARN · 0 FAIL/);
  });

  it('con una dirección sin argumentos sale con código 2 y explica el uso', async () => {
    const { code, out } = await verify();
    expect(code).toBe(2);
    expect(out).toContain('Uso:');
  });
});

describe('verify-deploy: cada defecto se marca FAIL y el código de salida es 1', () => {
  const cases: Array<{ name: string; prepare?: (dir: string) => void; override?: Override; prefix?: string; expected: RegExp }> = [
    { name: 'falta un ícono del manifest', prepare: (d) => rmSync(join(d, 'icons', 'icon-512.png')), expected: /^FAIL\s+ícono \/icons\/icon-512\.png: no se pudo leer \(404\)/m },
    {
      name: 'apple-touch-icon que no mide 180×180',
      prepare: (d) => writeFileSync(join(d, 'icons', 'apple-touch-icon.png'), png(120, 2)),
      expected: /^FAIL\s+apple-touch-icon .* no se pudo leer o no mide 180x180/m,
    },
    {
      name: 'apple-touch-icon con transparencia (se vería con fondo negro)',
      prepare: (d) => writeFileSync(join(d, 'icons', 'apple-touch-icon.png'), png(180, 6)),
      expected: /^FAIL\s+apple-touch-icon con transparencia \(colorType 6\)/m,
    },
    {
      name: 'el manifest bloquea la orientación',
      prepare: (d) => {
        const m = JSON.parse(readFileSync(join(d, 'manifest.webmanifest'), 'utf8'));
        writeFileSync(join(d, 'manifest.webmanifest'), JSON.stringify({ ...m, orientation: 'portrait' }));
      },
      expected: /^FAIL\s+manifest\.orientation = «portrait»: bloquea girar el teléfono/m,
    },
    {
      name: 'start_url distinto de "/"',
      prepare: (d) => {
        const m = JSON.parse(readFileSync(join(d, 'manifest.webmanifest'), 'utf8'));
        writeFileSync(join(d, 'manifest.webmanifest'), JSON.stringify({ ...m, start_url: '/limones/' }));
      },
      expected: /^FAIL\s+start_url «\/limones\/»/m,
    },
    {
      name: 'un ícono dice una medida y el PNG mide otra',
      prepare: (d) => writeFileSync(join(d, 'icons', 'icon-192.png'), png(100, 2)),
      expected: /^FAIL\s+\/icons\/icon-192\.png: el manifest dice 192x192 pero el PNG mide 100x100/m,
    },
    {
      name: 'sw.js con caché de un año',
      override: (p) =>
        p === '/sw.js'
          ? { body: "const CACHE = 'caja-central-0123456789ab';\nconst PRECACHE = [\"/\"];\n", type: 'text/javascript', headers: { 'cache-control': 'public, max-age=31536000, immutable' } }
          : undefined,
      expected: /^FAIL\s+sw\.js con caché larga/m,
    },
    {
      name: 'el hosting reescribe /sw.js a index.html',
      override: (p) => (p === '/sw.js' ? { body: '<!doctype html><html></html>', type: 'text/html' } : undefined),
      expected: /^FAIL\s+\/sw\.js tiene content-type «text\/html/m,
    },
    {
      name: 'el precache apunta a un archivo que no existe',
      prepare: (d) => {
        const sw = readFileSync(join(d, 'sw.js'), 'utf8').replace('"/assets/app.js"', '"/assets/app.js","/assets/no-existe.js"');
        writeFileSync(join(d, 'sw.js'), sw);
      },
      expected: /^FAIL\s+el precache apunta a archivos que no responden 200: \/assets\/no-existe\.js \(404\)/m,
    },
    {
      name: 'el service worker guarda respuestas al vuelo (put con cualquier nombre de variable)',
      prepare: (d) => writeFileSync(join(d, 'sw.js'), readFileSync(join(d, 'sw.js'), 'utf8') + '\ncaches.open("x").then((c) => c.put(new Request("/"), new Response("")));\n'),
      expected: /^FAIL\s+el service worker usa \.put\(/m,
    },
    { name: 'la app está en una subcarpeta', prefix: '/limones/', expected: /^FAIL\s+la dirección tiene ruta «\/limones\/»/m },
    {
      name: 'el viewport no cubre la pantalla completa (sin viewport-fit=cover)',
      prepare: (d) => writeFileSync(join(d, 'index.html'), readFileSync(join(d, 'index.html'), 'utf8').replace(', viewport-fit=cover', '')),
      expected: /^FAIL\s+el viewport no incluye viewport-fit=cover/m,
    },
    {
      name: 'falta el apple-touch-icon en el HTML',
      prepare: (d) => writeFileSync(join(d, 'index.html'), readFileSync(join(d, 'index.html'), 'utf8').replace(/<link rel="apple-touch-icon"[^>]*>/, '')),
      expected: /^FAIL\s+falta <link rel="apple-touch-icon" sizes="180x180">/m,
    },
    { name: 'la página principal responde 404', override: (p) => (p === '/' ? { status: 404, body: 'no', type: 'text/plain' } : undefined), expected: /^FAIL\s+GET \/ respondió 404/m },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const url = await serve(c.prepare, c.override, c.prefix);
      const { code, out } = await verify(url);
      expect(out).toMatch(c.expected);
      expect(code).toBe(1);
    });
  }

  it('una dirección http que no es local es FAIL aunque el servidor no responda', async () => {
    const { code, out } = await verify('http://sitio-de-prueba.invalid/');
    expect(out).toMatch(/^FAIL\s+la dirección no usa HTTPS/m);
    expect(code).toBe(1);
  });

  it('un texto que no es una dirección es FAIL', async () => {
    const { code, out } = await verify('esto no es una url');
    expect(out).toMatch(/^FAIL\s+«esto no es una url» no es una dirección válida/m);
    expect(code).toBe(1);
  });
});

describe('verify-deploy: sin cabeceras de seguridad avisa (WARN) pero no falla', () => {
  it('sitio correcto sin nosniff, referrer-policy ni frame-ancestors', async () => {
    const url = await serve();
    const { code, out } = await verify(url);
    expect(code).toBe(0);
    expect(out).toMatch(/^WARN\s+falta X-Content-Type-Options: nosniff/m);
    expect(out).toMatch(/^WARN\s+falta Referrer-Policy/m);
    expect(out).toMatch(/^WARN\s+falta frame-ancestors/m);
  });
});
