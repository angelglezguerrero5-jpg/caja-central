/**
 * Dónde se está usando la app. Sirve para avisar lo que SOLO importa en iPhone/iPad:
 *  - Los datos de Safari y los de la app instalada en la pantalla de inicio son almacenes distintos: lo capturado en uno no
 *    aparece en el otro. Hay que instalar la app ANTES de capturar datos reales.
 *  - Safari puede borrar los datos de un sitio que no se usa en 7 días; Apple dice que las apps de pantalla de inicio no entran
 *    en esa regla (no hay forma de comprobarlo desde aquí: por eso el aviso insiste en los respaldos).
 */

type Nav = Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>;

/** iPhone, iPod o iPad (iPadOS se presenta como «Macintosh», pero con pantalla táctil). */
export function isIOS(nav: Nav = navigator): boolean {
  return /iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1);
}

/** ¿Abierta desde el ícono de la pantalla de inicio / instalada (y no en una pestaña del navegador)? */
export function isStandalone(win: Window = window): boolean {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || win.matchMedia?.('(display-mode: standalone)').matches === true;
}
