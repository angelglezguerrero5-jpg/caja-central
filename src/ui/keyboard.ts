/**
 * Modo «teclado abierto»: mientras el teclado del teléfono ocupa la pantalla y se escribe en un campo de texto se ocultan las
 * pestañas inferiores y la barra de registro baja al borde (clase `kbd` en <html>), para dejar sitio en pantallas chicas.
 *
 * Dos comportamientos distintos del teclado, y esta pieza los cubre a los dos:
 *  - Chrome de Android (con `interactive-widget=resizes-content`): el teclado ENCOGE la ventana. `innerHeight` y la zona visible
 *    (`visualViewport.height`) bajan juntas.
 *  - Safari de iPhone: el teclado se pone ENCIMA de la página SIN encoger la ventana (`innerHeight` no cambia; solo baja la zona
 *    visible). Todo lo anclado abajo (`position: fixed` / `sticky`) quedaría detrás del teclado. Por eso se publica `--kb` en
 *    <html>: los píxeles que el teclado tapa. Las barras y hojas ancladas abajo suben esa cantidad. En Android vale 0.
 *    (Comportamiento descrito por WebKit; NO está probado en un iPhone físico: ver docs/PRUEBAS.md.)
 *
 * Reglas, y por qué:
 *  - Se decide por el TAMAÑO de la zona visible (el teclado la encoge), no solo por el foco: en Android, ocultar el teclado con
 *    «atrás» deja el campo con foco y las pestañas se quedarían escondidas sin teclado. Sin teclado real (escritorio, pruebas)
 *    la clase nunca se pone y la navegación siempre está visible.
 *  - Con zoom de pellizco (escala > 1) la zona visible también se encoge: no cuenta como teclado.
 *  - La clase se quita con retraso y nunca con el dedo apoyado. Si el diseño cambiara en el instante en que el campo pierde el
 *    foco (el mousedown del botón tocado), el botón se movería antes del mouseup y el toque caería en otro elemento: el primer
 *    toque «no hace nada». Con el retraso el toque termina antes de que algo se mueva.
 *  - La caja rápida (`[data-keep-tabs]`) conserva siempre las pestañas: ahí se escribe los kilos entre venta y venta.
 *  - `--kb` nunca usa un desplazamiento viejo: tras cerrar el teclado iOS 26 puede dejar `visualViewport.offsetTop` > 0
 *    (fallo reportado a Apple); como solo se resta, un valor viejo da 0 y no mueve nada.
 */

const TEXT_TYPES = new Set(['text', 'search', 'tel', 'number', 'email', 'url', 'password']);

/** Lo que tiene que encogerse (o taparse) la ventana para considerar que hay teclado (la barra de direcciones mide mucho menos). */
export const KEYBOARD_MIN_PX = 150;
/** Retraso antes de volver a mostrar las pestañas (más que un toque normal; menos que lo que se nota). */
export const SETTLE_MS = 350;
/** Por encima de esta escala hay zoom de pellizco y la zona visible ya no indica teclado. */
export const ZOOM_MAX = 1.02;

/** ¿Es un campo donde se abre el teclado? (no casillas, listas ni selectores de fecha: esos no abren teclado) */
export function isTextEntry(el: unknown): el is HTMLInputElement | HTMLTextAreaElement {
  if (typeof HTMLElement === 'undefined' || !(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  return el instanceof HTMLInputElement && TEXT_TYPES.has(el.type) && !el.readOnly && !el.disabled;
}

/** Medidas de la ventana: la de diseño (`innerHeight`) y la que realmente se ve (`visualViewport`). */
export interface ViewportGeometry {
  layoutHeight: number;
  visibleHeight: number;
  offsetTop: number;
  scale: number;
}

export function readGeometry(win: Pick<Window, 'innerHeight' | 'visualViewport'> = window): ViewportGeometry {
  const vv = win.visualViewport;
  return {
    layoutHeight: win.innerHeight,
    visibleHeight: vv ? vv.height : win.innerHeight,
    offsetTop: vv ? vv.offsetTop : 0,
    scale: vv ? vv.scale : 1,
  };
}

/**
 * Píxeles que el teclado TAPA sin haber encogido la ventana (Safari de iPhone), medidos desde el borde de abajo de la ventana
 * de diseño hasta el borde de abajo de la zona visible. `shown` dice si hay teclado (la zona visible se encogió ≥ 150 px). 0 si
 * no hay teclado, si la ventana sí se encogió (Android: allí el borde de la ventana ya es el borde del teclado) o si hay zoom
 * de pellizco. Cuando Safari desplaza la zona visible para mostrar el campo (`offsetTop` > 0) el borde sube con ella.
 */
export function keyboardOverlayPx(g: ViewportGeometry, shown: boolean): number {
  if (!shown || g.scale > ZOOM_MAX) return 0;
  return Math.max(0, Math.round(g.layoutHeight - g.visibleHeight - Math.max(g.offsetTop, 0)));
}

/** Instala los oyentes; devuelve la función que los quita. */
export function installKeyboardMode(root: HTMLElement = document.documentElement): () => void {
  let timer = 0;
  let down = false;
  let width = window.innerWidth;
  let tallest = Math.max(window.innerHeight, readGeometry().visibleHeight);
  let kb = 0;
  const vv = window.visualViewport;

  const keyboardShown = () => {
    const g = readGeometry();
    // Al girar el teléfono cambia el ancho: se vuelve a medir desde cero.
    if (window.innerWidth !== width) {
      width = window.innerWidth;
      tallest = Math.max(g.layoutHeight, g.visibleHeight);
    }
    if (g.scale > ZOOM_MAX) return false;
    tallest = Math.max(tallest, g.layoutHeight, g.visibleHeight);
    return tallest - g.visibleHeight >= KEYBOARD_MIN_PX;
  };
  const wanted = () => {
    const el = document.activeElement;
    return isTextEntry(el) && !el.closest('[data-keep-tabs]') && keyboardShown();
  };
  /** Publica `--kb` solo cuando cambia (cada escritura de una propiedad CSS obliga a recalcular estilos). */
  const publishKb = () => {
    const next = keyboardOverlayPx(readGeometry(), keyboardShown());
    if (next === kb) return;
    kb = next;
    root.style.setProperty('--kb', `${next}px`);
  };

  const settle = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (down) return settle(); // con el dedo apoyado no se mueve nada
      if (!wanted()) root.classList.remove('kbd');
    }, SETTLE_MS);
  };
  const apply = () => {
    publishKb();
    if (wanted()) {
      window.clearTimeout(timer);
      root.classList.add('kbd');
    } else if (root.classList.contains('kbd')) {
      settle();
    }
  };
  const onDown = () => {
    down = true;
  };
  // Un campo que se quita de la pantalla con el foco puesto no avisa con focusout: cada toque vuelve a revisar el estado.
  const onUp = () => {
    down = false;
    apply();
  };

  document.addEventListener('focusin', apply);
  document.addEventListener('focusout', apply);
  window.addEventListener('resize', apply);
  // Safari de iPhone no dispara `resize` de la ventana con el teclado: avisa por visualViewport (tamaño y desplazamiento).
  vv?.addEventListener('resize', apply);
  vv?.addEventListener('scroll', publishKb);
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onUp, true);
  publishKb();
  return () => {
    window.clearTimeout(timer);
    root.classList.remove('kbd');
    root.style.removeProperty('--kb');
    document.removeEventListener('focusin', apply);
    document.removeEventListener('focusout', apply);
    window.removeEventListener('resize', apply);
    vv?.removeEventListener('resize', apply);
    vv?.removeEventListener('scroll', publishKb);
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onUp, true);
  };
}
