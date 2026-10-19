import type { Page } from '@playwright/test';
import type { Freight, FreightSettings } from '../../src/domain/types';
import { openApp } from './helpers';
import { FIXED_NOW, buildMarket, restoreBackup, type Market, type MarketOptions } from './helpers-android';
import { asV3 } from './helpers-fletes';

/**
 * Ayudas de iphone.spec.ts: un iPhone 16 EMULADO en Chromium.
 *
 * Qué es y qué NO es (importante):
 *  - Se emula el tamaño de pantalla, la proporción de píxeles, el «user agent» de iPhone y la pantalla táctil. El motor sigue
 *    siendo Chromium, NO Safari/WebKit: lo que dependa del motor de Safari (cómo pinta, qué soporta, sus fallos) no se prueba.
 *  - Las zonas seguras (muesca, isla dinámica, barra de inicio) se simulan escribiendo las variables --sat/--sar/--sab/--sal
 *    que lee el CSS, porque `env(safe-area-inset-*)` no se puede forzar desde fuera.
 *  - El teclado de Safari (que NO encoge la ventana) se simula con un `window.visualViewport` falso que sí lo encoge, igual
 *    que lo describe WebKit. Prueba que la app reacciona bien a esas medidas, no que Safari las entregue así.
 * Todo esto sigue SIN sustituir una prueba en un iPhone físico (ver docs/PRUEBAS.md).
 */

export const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

export interface Inset {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
export interface Iphone {
  name: string;
  width: number;
  height: number;
  /** Alto aproximado que tapa el teclado de iPhone en esa pantalla. */
  keyboardPx: number;
  /** Zonas seguras de esa pantalla (puntos CSS). */
  inset: Inset;
}

/** Medidas de Safari/web app en vertical: iPhone 16 (393×852), 16 Pro Max (430×932) y SE (375×667, sin muesca). */
export const IPHONES: Iphone[] = [
  { name: 'iPhone 16 · 393×852', width: 393, height: 852, keyboardPx: 336, inset: { top: 59, right: 0, bottom: 34, left: 0 } },
  { name: 'iPhone 16 Pro Max · 430×932', width: 430, height: 932, keyboardPx: 346, inset: { top: 59, right: 0, bottom: 34, left: 0 } },
  { name: 'iPhone SE · 375×667', width: 375, height: 667, keyboardPx: 291, inset: { top: 20, right: 0, bottom: 0, left: 0 } },
];
/** iPhone 16 de lado: la isla dinámica y la barra de inicio ocupan los lados y abajo. */
export const IPHONE_LANDSCAPE: Iphone = {
  name: 'iPhone 16 horizontal · 852×393',
  width: 852,
  height: 393,
  keyboardPx: 200,
  inset: { top: 0, right: 59, bottom: 21, left: 59 },
};

declare global {
  interface Window {
    __ios: { keyboard: (px: number, pan?: number) => void; close: (staleOffset?: number) => void; zoom: (scale: number) => void };
    __idbConns?: IDBDatabase[];
  }
}

/**
 * Se instala ANTES de abrir la app:
 *  - `navigator.standalone` como lo expone Safari (false en una pestaña, true desde la pantalla de inicio);
 *  - un `visualViewport` falso: su alto baja con el teclado SIN que cambie `innerHeight` (como en Safari de iPhone);
 *  - un registro de las conexiones que la app abre a IndexedDB (para poder cerrarlas desde la prueba).
 */
export async function iosInit(page: Page, opts: { standalone: boolean }): Promise<void> {
  await page.addInitScript((standalone) => {
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: standalone });

    let kb = 0;
    let pan = 0;
    let stale = 0;
    let scale = 1;
    const listeners: Record<string, Set<(e: Event) => void>> = { resize: new Set(), scroll: new Set() };
    const fire = (type: 'resize' | 'scroll') => listeners[type].forEach((fn) => fn(new Event(type)));
    const fake = {
      get width() {
        return window.innerWidth;
      },
      get height() {
        return window.innerHeight / scale - kb;
      },
      get offsetTop() {
        return kb ? pan : stale;
      },
      offsetLeft: 0,
      pageLeft: 0,
      pageTop: 0,
      get scale() {
        return scale;
      },
      addEventListener: (type: string, fn: (e: Event) => void) => void listeners[type]?.add(fn),
      removeEventListener: (type: string, fn: (e: Event) => void) => void listeners[type]?.delete(fn),
      dispatchEvent: () => true,
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
    window.__ios = {
      keyboard(px, p = 0) {
        kb = px;
        pan = p;
        stale = 0;
        fire('resize');
        fire('scroll');
      },
      // iOS 26 puede dejar offsetTop > 0 después de cerrar el teclado (fallo reportado a Apple): `staleOffset` lo emula.
      close(staleOffset = 0) {
        kb = 0;
        pan = 0;
        stale = staleOffset;
        fire('resize');
        fire('scroll');
      },
      zoom(s) {
        scale = s;
        fire('resize');
      },
    };

    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args: Parameters<IDBFactory['open']>) {
      const req = open.apply(this, args);
      req.addEventListener('success', () => (window.__idbConns ??= []).push(req.result));
      return req;
    };
  }, opts.standalone);
}

export const iosKeyboard = (page: Page, px: number, pan = 0) => page.evaluate(([k, p]) => window.__ios.keyboard(k, p), [px, pan] as const);
export const iosKeyboardClose = (page: Page, staleOffset = 0) => page.evaluate((s) => window.__ios.close(s), staleOffset);

/** Zonas seguras simuladas (el CSS las lee de --sat/--sar/--sab/--sal). */
export const setInsets = (page: Page, i: Inset) =>
  page.evaluate((v) => {
    const s = document.documentElement.style;
    s.setProperty('--sat', `${v.top}px`);
    s.setProperty('--sar', `${v.right}px`);
    s.setProperty('--sab', `${v.bottom}px`);
    s.setProperty('--sal', `${v.left}px`);
  }, i);

export const kbVar = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--kb').trim());

/**
 * Abre la app y la puebla con el mercado de pruebas (como boot() de android.spec.ts). Reloj fijo: sábado 10 oct 2026, 14:00.
 * Con `extra.freights` el respaldo que se restaura es del formato 3 y trae esos fletes (sin ellos, la app arranca sin fletes).
 */
export async function bootIphone(
  page: Page,
  opts: MarketOptions = {},
  extra: { freights?: Freight[]; freightSettings?: FreightSettings } = {},
): Promise<Market> {
  const market = buildMarket(opts);
  await page.clock.setFixedTime(FIXED_NOW);
  await openApp(page, { seed: false });
  await restoreBackup(page, extra.freights ? asV3(market.backup, extra.freights, extra.freightSettings) : market.backup);
  return market;
}

/** Espera a que la pantalla termine de pintar (dos cuadros). */
export const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

/** Mide lo que importa de las barras fijas, de una vez. */
export const chrome = (page: Page) =>
  page.evaluate(() => {
    const rect = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width };
    };
    return { header: rect('header.top'), title: rect('header.top strong'), tabs: rect('nav.tabs'), firstTab: rect('nav.tabs .tab'), lastTab: rect('nav.tabs .tab:last-child'), vh: window.innerHeight, vw: window.innerWidth };
  });
