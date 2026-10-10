import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { createHash } from 'node:crypto';

/**
 * Genera `sw.js` con la lista exacta de archivos del build (precache) y un
 * hash como versión de caché, de modo que cada build invalida el anterior.
 */
function offlineServiceWorker(): Plugin {
  const staticFiles = [
    '/',
    '/index.html',
    '/manifest.webmanifest',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/maskable-512.png',
  ];
  return {
    name: 'offline-sw',
    apply: 'build',
    generateBundle(_, bundle) {
      const built = Object.keys(bundle).map((f) => '/' + f);
      const urls = [...new Set([...staticFiles, ...built])].sort();
      const hash = createHash('sha256')
        .update(urls.join('|') + Object.values(bundle).map((b) => ('code' in b ? b.code : String(b.source))).join(''))
        .digest('hex')
        .slice(0, 12);
      const source = `// Generado en build. No editar.
const CACHE = 'limones-${hash}';
const PRECACHE = ${JSON.stringify(urls, null, 2)};

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        return await fetch(req);
      } catch (err) {
        // Navegación sin red: se sirve la app desde caché.
        if (req.mode === 'navigate') {
          const shell = (await cache.match('/index.html')) || (await cache.match('/'));
          if (shell) return shell;
        }
        throw err;
      }
    })(),
  );
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [preact(), offlineServiceWorker()],
  server: { host: true },
  build: { target: 'es2020' },
});
