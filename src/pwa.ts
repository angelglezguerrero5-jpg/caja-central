/** Cada cuánto, como mínimo, se pregunta si hay una versión nueva de la app mientras está abierta. */
export const UPDATE_CHECK_MS = 30 * 60 * 1000;

/** Registra el service worker (solo en producción; en dev estorba al HMR). */
export function registerSW() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  // Si ya había un service worker controlando esta página y llega uno nuevo, se avisa: NO se recarga sola para no perder
  // lo que se esté capturando (la persona decide con «Actualizar ahora»; los datos viven en IndexedDB y no se tocan).
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) window.dispatchEvent(new Event('limones:update'));
  });
  let registration: ServiceWorkerRegistration | undefined;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((r) => {
        registration = r;
      })
      .catch((e) => console.warn('SW no registrado', e));
  });
  // Una app de la pantalla de inicio del iPhone puede quedarse días en segundo plano sin cerrarse y el sistema solo busca
  // versiones nuevas al abrirla de cero: se pregunta también al volver a ella y al recuperar internet. Sin red el intento
  // simplemente falla (no pasa nada).
  let last = 0;
  const check = () => {
    const t = Date.now();
    if (!registration || t - last < UPDATE_CHECK_MS) return;
    last = t;
    registration.update().catch(() => undefined);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  window.addEventListener('online', check);
  // Pide almacenamiento persistente para que el sistema no purgue IndexedDB (se pide en cada apertura: en Safari la respuesta
  // puede cambiar de una vez a otra; Más → «Estado de los datos» muestra lo que contestó).
  navigator.storage?.persist?.().catch(() => undefined);
}
