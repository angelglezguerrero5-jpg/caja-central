/** Registra el service worker (solo en producción; en dev estorba al HMR). */
export function registerSW() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW no registrado', e));
  });
  // Pide almacenamiento persistente para que Android no purgue IndexedDB.
  navigator.storage?.persist?.().catch(() => undefined);
}
