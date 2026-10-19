import { describe, expect, it } from 'vitest';
import { KEYBOARD_MIN_PX, ZOOM_MAX, keyboardOverlayPx, readGeometry, type ViewportGeometry } from '../../src/ui/keyboard';
import { isIOS, isStandalone } from '../../src/ui/platform';

/**
 * Lógica pura de iPhone: cuánto tapa el teclado cuando NO encoge la ventana (Safari) y dónde se está usando la app.
 * Son pruebas de la FÓRMULA con medidas inventadas a partir de lo que describe WebKit; no prueban Safari ni un iPhone real.
 */

const g = (over: Partial<ViewportGeometry> = {}): ViewportGeometry => ({ layoutHeight: 852, visibleHeight: 852, offsetTop: 0, scale: 1, ...over });

describe('keyboardOverlayPx · cuánto tapa el teclado de Safari', () => {
  it('sin teclado vale 0', () => {
    expect(keyboardOverlayPx(g(), false)).toBe(0);
  });

  it('Safari de iPhone: la ventana mide lo mismo y la zona visible baja → la diferencia es lo que tapa el teclado', () => {
    expect(keyboardOverlayPx(g({ visibleHeight: 516 }), true)).toBe(336);
  });

  it('si Safari desplaza la zona visible para mostrar el campo, el borde de abajo sube con ella', () => {
    expect(keyboardOverlayPx(g({ visibleHeight: 516, offsetTop: 80 }), true)).toBe(256);
    // incluso si se desplazó tanto que lo tapado es menos que el umbral de «hay teclado»: ya se sabe que hay teclado
    expect(keyboardOverlayPx(g({ visibleHeight: 516, offsetTop: 300 }), true)).toBe(36);
    expect(36).toBeLessThan(KEYBOARD_MIN_PX);
  });

  it('Android (la ventana SÍ se encoge): el borde de la ventana ya es el del teclado → 0', () => {
    expect(keyboardOverlayPx(g({ layoutHeight: 516, visibleHeight: 516 }), true)).toBe(0);
  });

  it('iOS 26 deja `offsetTop` viejo tras cerrar el teclado: como ya no hay teclado, no mueve nada', () => {
    expect(keyboardOverlayPx(g({ visibleHeight: 852, offsetTop: 120 }), false)).toBe(0);
    // y aunque la zona visible fuera más grande que la ventana, nunca da negativo
    expect(keyboardOverlayPx(g({ visibleHeight: 900, offsetTop: 40 }), true)).toBe(0);
  });

  it('un desplazamiento negativo (rebote de Safari al tirar hacia abajo) cuenta como 0', () => {
    expect(keyboardOverlayPx(g({ visibleHeight: 516, offsetTop: -30 }), true)).toBe(336);
  });

  it('con zoom de pellizco la zona visible se encoge sin que haya teclado → 0', () => {
    expect(keyboardOverlayPx(g({ visibleHeight: 426, scale: 2 }), true)).toBe(0);
    expect(keyboardOverlayPx(g({ visibleHeight: 516, scale: ZOOM_MAX }), true)).toBe(336); // hasta ZOOM_MAX todavía cuenta como sin zoom
  });
});

describe('readGeometry', () => {
  it('lee la zona visible de visualViewport', () => {
    expect(readGeometry({ innerHeight: 852, visualViewport: { height: 516, offsetTop: 12, scale: 1 } as VisualViewport })).toEqual({
      layoutHeight: 852,
      visibleHeight: 516,
      offsetTop: 12,
      scale: 1,
    });
  });

  it('sin visualViewport (navegador viejo) la zona visible es la ventana', () => {
    expect(readGeometry({ innerHeight: 640, visualViewport: null })).toEqual({ layoutHeight: 640, visibleHeight: 640, offsetTop: 0, scale: 1 });
  });
});

describe('isIOS', () => {
  const nav = (userAgent: string, platform = 'Linux armv81', maxTouchPoints = 5) => ({ userAgent, platform, maxTouchPoints });
  const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const UA_IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

  it('reconoce iPhone, iPod y iPad', () => {
    expect(isIOS(nav(UA_IPHONE))).toBe(true);
    expect(isIOS(nav(UA_IPAD))).toBe(true);
    expect(isIOS(nav('Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)'))).toBe(true);
  });

  it('iPadOS en modo escritorio se presenta como Mac, pero con pantalla táctil', () => {
    expect(isIOS(nav(UA_MAC, 'MacIntel', 5))).toBe(true);
  });

  it('una Mac de verdad (sin pantalla táctil), Android y Windows no son iOS', () => {
    expect(isIOS(nav(UA_MAC, 'MacIntel', 0))).toBe(false);
    expect(isIOS(nav('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'))).toBe(false);
    expect(isIOS(nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'Win32', 0))).toBe(false);
  });
});

describe('isStandalone', () => {
  const win = (standalone: boolean | undefined, displayStandalone: boolean | 'sin matchMedia') =>
    ({
      navigator: { standalone },
      matchMedia: displayStandalone === 'sin matchMedia' ? undefined : () => ({ matches: displayStandalone }),
    }) as unknown as Window;

  it('Safari: navigator.standalone verdadero = abierta desde la pantalla de inicio', () => {
    expect(isStandalone(win(true, false))).toBe(true);
  });

  it('Chrome / Android: display-mode standalone', () => {
    expect(isStandalone(win(undefined, true))).toBe(true);
  });

  it('una pestaña normal del navegador no es standalone', () => {
    expect(isStandalone(win(false, false))).toBe(false);
    expect(isStandalone(win(undefined, false))).toBe(false);
  });

  it('sin matchMedia ni navigator.standalone no se afirma nada', () => {
    expect(isStandalone(win(undefined, 'sin matchMedia'))).toBe(false);
  });
});
