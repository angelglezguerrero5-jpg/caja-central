import { expect, test, type Page } from '@playwright/test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { charge, openApp, sellCash, tab } from './helpers';
import {
  CATALOG,
  bottomReachReport,
  clippedTextReport,
  contrastReport,
  controlNameReport,
  dialogReport,
  expectSolidTap,
  html,
  invariants,
  overflowReport,
  overlapArea,
  reachReport,
  readDb,
  rectOf,
  settled,
  touchTargetReport,
  watchTaps,
} from './helpers-android';
import {
  IPHONES,
  IPHONE_LANDSCAPE,
  UA_IPHONE,
  bootIphone,
  chrome,
  frames,
  iosInit,
  iosKeyboard,
  iosKeyboardClose,
  kbVar,
  setInsets,
} from './helpers-iphone';
import { raizDelProyecto, servirCarpeta } from './helpers-migracion';
import { row as fleteRow, sampleFreights } from './helpers-fletes';

/**
 * iPHONE 16 (y otros tamaños de iPhone), EMULADO en Chromium.
 *
 * LÉELO ASÍ: esto prueba que la app se comporta bien con la pantalla, las zonas seguras y las medidas del teclado de un iPhone,
 * y que el paquete instalable está completo. NO es Safari ni un iPhone: el motor es Chromium. Instalar en la pantalla de inicio,
 * el teclado real, el modo avión real y los fallos propios de iOS siguen SIN probarse (docs/PRUEBAS.md y docs/IPHONE.md).
 */

const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

// ═════════════════════════════════════════════ 1. Paquete instalable ═════════════════════════════════════════════

test.describe('iPhone · paquete instalable (archivos y metas)', () => {
  test('index.html trae las metas de Apple, el viewport con zonas seguras y un ícono de 180×180 real, sin transparencia', async ({ page, request }) => {
    await page.goto('/');
    const head = await page.evaluate(() => {
      const meta = (n: string) => document.querySelector(`meta[name="${n}"]`)?.getAttribute('content') ?? null;
      const link = document.querySelector('link[rel="apple-touch-icon"]');
      return {
        capable: meta('apple-mobile-web-app-capable'),
        webCapable: meta('mobile-web-app-capable'),
        title: meta('apple-mobile-web-app-title'),
        status: meta('apple-mobile-web-app-status-bar-style'),
        detect: meta('format-detection'),
        viewport: meta('viewport'),
        theme: meta('theme-color'),
        href: link?.getAttribute('href') ?? null,
        sizes: link?.getAttribute('sizes') ?? null,
        links: document.querySelectorAll('link[rel="apple-touch-icon"]').length,
      };
    });
    expect(head).toMatchObject({ capable: 'yes', webCapable: 'yes', title: 'Caja', status: 'black-translucent', sizes: '180x180', href: '/icons/apple-touch-icon.png', links: 1 });
    expect(head.viewport).toContain('viewport-fit=cover');
    expect(head.viewport, 'no se debe impedir el zoom (accesibilidad)').not.toMatch(/user-scalable\s*=\s*no|maximum-scale/);
    expect(head.detect).toContain('telephone=no');
    expect(head.theme).toMatch(/^#[0-9a-f]{6}$/i);

    const res = await request.get(head.href!);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');
    const png = await res.body();
    expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'firma PNG').toBe(true);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)], 'alto y ancho reales del PNG').toEqual([180, 180]);
    expect(png[25], 'tipo de color 2 = RGB sin canal alfa (iOS rellena de negro la transparencia)').toBe(2);
  });

  test('el manifest está completo, no bloquea la orientación y cada ícono mide exactamente lo que declara', async ({ request }) => {
    const m = await (await request.get('/manifest.webmanifest')).json();
    expect(m).toMatchObject({ id: '/', name: 'Caja Central', short_name: 'Caja', start_url: '/', scope: '/', display: 'standalone', lang: 'es-MX' });
    expect(m.short_name.length, 'el nombre bajo el ícono debe ser corto').toBeLessThanOrEqual(12);
    expect(m.orientation ?? 'any', 'el teléfono debe poder girar').toBe('any');
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes} ${i.purpose}`)).toEqual(
      expect.arrayContaining(['180x180 any', '192x192 any', '512x512 any', '512x512 maskable']),
    );
    for (const icon of m.icons as Array<{ src: string; sizes: string; type: string }>) {
      const r = await request.get(icon.src);
      expect(r.ok(), `${icon.src} existe`).toBe(true);
      expect(icon.type).toBe('image/png');
      const b = await r.body();
      expect(`${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`, `${icon.src} mide lo que declara`).toBe(icon.sizes);
    }
  });

  test('el service worker solo guarda archivos estáticos: vender, hacer un vale y recibir mercancía no agrega NADA a su caché ni deja datos del negocio en ella', async ({ page, request }) => {
    test.setTimeout(60_000);
    await openApp(page);
    const sw = await (await request.get('/sw.js')).text();
    const precache: string[] = JSON.parse(sw.match(/const PRECACHE = (\[[\s\S]*?\]);/)![1]);
    const snapshot = () =>
      page.evaluate(async () => {
        const out: Record<string, string[]> = {};
        for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname).sort();
        return out;
      });
    const before = await snapshot();
    const names = Object.keys(before);
    expect(names, 'una sola caché, con versión').toHaveLength(1);
    expect(names[0]).toMatch(/^caja-central-[0-9a-f]{12}$/);
    expect(before[names[0]], 'la caché contiene exactamente el precache del build').toEqual([...precache].sort());

    await sellCash(page, '1', [50]);
    await page.getByTestId('kg').fill('2');
    await page.getByTestId('exact').click();
    await page.getByTestId('is-vale').check();
    await page.getByTestId('customer').fill('Cliente-SENTINELA-8841');
    await charge(page);
    expect(await snapshot(), 'después de operar, la caché es idéntica').toEqual(before);

    const text = await page.evaluate(async () => {
      const cache = await caches.open((await caches.keys())[0]);
      let all = '';
      for (const req of await cache.keys()) {
        const res = await cache.match(req);
        if (res && /json|text|javascript|html|css/.test(res.headers.get('content-type') ?? '')) all += await res.text();
      }
      return all;
    });
    expect(text.length, 'se leyó el contenido de las cachés').toBeGreaterThan(10_000);
    expect(text, 'ningún dato del negocio llegó a la caché').not.toContain('SENTINELA-8841');
  });
});

// ═════════════════════════════════════════════ 2. Pantallas verticales ═════════════════════════════════════════════

type Visit = (where: string) => Promise<void>;

/** Recorre todas las secciones y subsecciones con la app poblada; `visit` mide cada estado. */
async function walkScreens(page: Page, visit: Visit) {
  await tab(page, 'caja');
  await expect(page.getByTestId('kg')).toBeVisible();
  await visit('Caja');
  await tab(page, 'vales');
  await expect(page.getByTestId('vale')).toHaveCount(4);
  await visit('Vales');
  await tab(page, 'recepcion');
  await page.getByTestId('rec-sub-nueva').click();
  await expect(page.getByTestId('rec-pick-hint')).toBeVisible();
  await visit('Recepción › Nueva');
  await page.getByTestId('rec-sub-borradores').click();
  await expect(page.getByTestId('rec-draft-row')).toHaveCount(3);
  await visit('Recepción › Borradores');
  await page.getByTestId('rec-sub-historial').click();
  await expect(page.getByTestId('rec-row').first()).toBeVisible();
  await visit('Recepción › Historial');
  await page.getByTestId('rec-sub-resumen').click();
  await expect(page.getByTestId('rep-received')).toBeVisible();
  await visit('Recepción › Resumen');
  await tab(page, 'inventario');
  await expect(page.getByTestId('inv-row')).toHaveCount(CATALOG.length);
  await visit('Inventario');
  // Control de pesaje (se recorre con los 10 fletes de ejemplo: completos, incompletos, anulado, corregido y textos larguísimos)
  await page.getByTestId('inv-sub-fletes').click();
  await expect(page.getByTestId('fl-row')).toHaveCount(sampleFreights().length);
  await visit('Inventario › Fletes');
  await page.getByTestId('fl-new').click();
  await expect(page.getByTestId('fl-form')).toBeVisible();
  await visit('Inventario › Fletes › Nuevo flete');
  await page.getByTestId('fl-cancel').click();
  await expect(page.getByTestId('fl-form')).toHaveCount(0);
  await fleteRow(page, 'F-DENTRO').getByTestId('fl-edit').click(); // (el primero de la lista es el anulado, que ya no se edita)
  await expect(page.getByTestId('fl-form')).toBeVisible();
  await visit('Inventario › Fletes › Corregir');
  await page.getByTestId('fl-cancel').click();
  await expect(page.getByTestId('fl-form')).toHaveCount(0);
  await page.getByTestId('inv-sub-existencias').click();
  await tab(page, 'corte');
  await expect(page.getByTestId('r-total')).toBeVisible();
  await visit('Corte');
  await tab(page, 'mas');
  await expect(page.getByTestId('hist-summary')).toBeVisible();
  await visit('Más');
}

for (const p of IPHONES) {
  test.describe(`iPhone · ${p.name}`, () => {
    test.use({ viewport: { width: p.width, height: p.height }, userAgent: UA_IPHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    test.beforeEach(async ({ page }) => {
      await iosInit(page, { standalone: true });
    });

    test('todas las pantallas, pobladas: nada se sale a lo ancho ni se recorta, el final se alcanza y los controles miden ≥ 44 px', async ({ page }) => {
      test.setTimeout(150_000);
      await bootIphone(page, {}, { freights: sampleFreights() });
      await setInsets(page, p.inset);
      const bad: Record<string, string[]> = {};
      await walkScreens(page, async (where) => {
        await settled(page);
        await frames(page);
        const found = [
          ...(await overflowReport(page)).map((x) => `desborda: ${x}`),
          ...(await clippedTextReport(page)).map((x) => `recortado: ${x}`),
          ...(await touchTargetReport(page)).map((x) => `muy chico: ${x}`),
          ...(await bottomReachReport(page)).map((x) => `final: ${x}`),
        ];
        await page.evaluate(() => window.scrollTo(0, 0));
        if (found.length) bad[where] = found;
      });
      expect(bad, 'estados con defectos de diseño').toEqual({});
    });

    test('zonas seguras: el encabezado queda debajo de la muesca, las pestañas encima de la barra de inicio y el aviso no tapa el encabezado', async ({ page }) => {
      await bootIphone(page);
      const base = await chrome(page);
      await setInsets(page, p.inset);
      await frames(page);
      const c = await chrome(page);
      expect(Math.abs(c.header!.height - base.header!.height - p.inset.top), 'el encabezado crece lo que mide la muesca').toBeLessThanOrEqual(1);
      expect(c.title!.top, 'el título no queda bajo la muesca / isla dinámica').toBeGreaterThanOrEqual(p.inset.top);
      expect(Math.abs(c.tabs!.height - base.tabs!.height - p.inset.bottom), 'las pestañas crecen lo que mide la barra de inicio').toBeLessThanOrEqual(1);
      expect(c.tabs!.bottom).toBeCloseTo(c.vh, 0);
      expect(c.firstTab!.bottom, 'los botones de las pestañas no invaden la barra de inicio').toBeLessThanOrEqual(c.vh - p.inset.bottom + 0.5);
      const pad = await page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingBottom));
      expect(pad, 'relleno inferior = 68 px + barra de inicio').toBeCloseTo(68 + p.inset.bottom, 0);
      expect(await bottomReachReport(page), 'el final del contenido se alcanza').toEqual([]);

      // El aviso (toast) se pinta debajo del encabezado, no encima de él.
      await tab(page, 'recepcion');
      await page.getByTestId('rec-sub-nueva').click();
      await page.getByTestId('rec-confirm').click({ force: true }); // aria-disabled: Playwright lo trata como deshabilitado
      const toast = page.getByTestId('toast');
      await expect(toast).toContainText('Escribe los kilos netos');
      const [t, h] = [await rectOf(toast), (await chrome(page)).header!];
      expect(t.top, 'el aviso no tapa el encabezado').toBeGreaterThanOrEqual(h.bottom - 1);
    });

    test('ningún campo de captura baja de 16 px de letra (Safari de iPhone haría zoom al enfocarlo) en ninguna pantalla', async ({ page }) => {
      test.setTimeout(150_000);
      await bootIphone(page, {}, { freights: sampleFreights() });
      const small = new Set<string>();
      let seen = 0;
      await walkScreens(page, async (where) => {
        const found = await page.evaluate(() => {
          const out: Array<{ name: string; size: number }> = [];
          for (const el of Array.from(document.querySelectorAll<HTMLElement>('input, select, textarea'))) {
            if (el instanceof HTMLInputElement && ['checkbox', 'radio', 'hidden', 'file', 'button', 'submit'].includes(el.type)) continue;
            if (el.getBoundingClientRect().width === 0) continue;
            out.push({ name: `${el.tagName.toLowerCase()}[${el.getAttribute('data-testid') ?? el.getAttribute('type') ?? ''}]`, size: parseFloat(getComputedStyle(el).fontSize) });
          }
          return out;
        });
        seen += found.length;
        for (const f of found) if (f.size < 16) small.add(`${where}: ${f.name} ${f.size}px`);
      });
      expect(seen, 'se revisaron campos de verdad').toBeGreaterThan(8);
      expect([...small]).toEqual([]);
    });

    test('toda la página usa touch-action: manipulation (un doble toque rápido en los billetes no hace zoom) y el texto no se agranda al girar', async ({ page }) => {
      await bootIphone(page);
      const css = await page.evaluate(() => {
        const s = getComputedStyle(document.documentElement);
        return { touch: s.touchAction, adjust: s.getPropertyValue('-webkit-text-size-adjust') || s.getPropertyValue('text-size-adjust') };
      });
      expect(css.touch).toBe('manipulation');
      expect(css.adjust).toBe('100%');
    });

    test('teclado de iPhone (la ventana NO se encoge, solo baja la zona visible): las pestañas se esconden, la barra de registro queda justo SOBRE el teclado y el primer toque funciona', async ({ page }) => {
      test.setTimeout(90_000);
      await bootIphone(page);
      await tab(page, 'recepcion');
      await page.getByTestId('rec-sub-nueva').click();
      await page.getByTestId('rec-variety').filter({ hasText: 'Sin semilla' }).click();
      await page.getByTestId('rec-class').filter({ hasText: 'Primera · 2X' }).click();
      await expect(page.getByTestId('rec-selected')).toContainText('Sin semilla · Primera · 2X');
      await watchTaps(page);

      const supplier = page.getByTestId('rec-supplier');
      await supplier.focus();
      await iosKeyboard(page, p.keyboardPx);
      await expect(html(page)).toHaveClass(/kbd/);
      await expect(page.getByTestId('tab-caja')).toBeHidden();
      expect(await kbVar(page)).toBe(`${p.keyboardPx}px`);
      expect(await page.evaluate(() => window.innerHeight), 'la ventana de diseño NO cambió (es lo que hace Safari)').toBe(p.height);

      await page.evaluate(() => window.scrollTo(0, 0));
      await frames(page);
      const dock = await rectOf(page.getByTestId('rec-dock'));
      expect(Math.abs(dock.bottom - (p.height - p.keyboardPx)), 'la barra de registro queda pegada al borde de arriba del teclado').toBeLessThanOrEqual(1.5);
      expect(await overlapArea(supplier, page.getByTestId('rec-dock')), 'la barra de registro no tapa el campo').toBe(0);

      // El primer toque en «Registrar» llega al botón (sin que se mueva nada entre poner y levantar el dedo)
      await page.getByTestId('rec-confirm').click({ force: true });
      await expectSolidTap(page, 'rec-confirm');
      await expect(page.getByTestId('toast')).toContainText('Escribe los kilos netos');

      // Safari desplaza la zona visible para mostrar el campo: la barra sube con ella
      await supplier.focus();
      await iosKeyboard(page, p.keyboardPx, 80);
      expect(await kbVar(page)).toBe(`${p.keyboardPx - 80}px`);

      // Cierra el teclado: todo vuelve a su lugar (tras el retraso de seguridad, nunca con el dedo apoyado)
      await supplier.evaluate((el) => (el as HTMLElement).blur());
      await iosKeyboardClose(page);
      await expect(html(page)).not.toHaveClass(/kbd/);
      await expect(page.getByTestId('tab-caja')).toBeVisible();
      expect(await kbVar(page)).toBe('0px');
    });

    test('iOS 26 deja un desplazamiento viejo al cerrar el teclado: la app no mueve nada por eso (--kb vuelve a 0 y las pestañas reaparecen)', async ({ page }) => {
      await bootIphone(page);
      await tab(page, 'recepcion');
      await page.getByTestId('rec-supplier').focus();
      await iosKeyboard(page, p.keyboardPx);
      await expect(html(page)).toHaveClass(/kbd/);
      await page.getByTestId('rec-supplier').evaluate((el) => (el as HTMLElement).blur());
      await iosKeyboardClose(page, 120);
      await expect(html(page)).not.toHaveClass(/kbd/);
      expect(await kbVar(page)).toBe('0px');
      await expect(page.getByTestId('tab-caja')).toBeVisible();
      const c = await chrome(page);
      expect(c.tabs!.bottom).toBeCloseTo(c.vh, 0);
    });

    test('Caja con teclado de iPhone: las pestañas NO se esconden (ahí se teclean kilos entre venta y venta) pero --kb sí se publica', async ({ page }) => {
      await bootIphone(page);
      await tab(page, 'caja');
      await page.getByTestId('kg').focus();
      await iosKeyboard(page, p.keyboardPx);
      expect(await kbVar(page)).toBe(`${p.keyboardPx}px`);
      await expect(html(page)).not.toHaveClass(/kbd/);
      await expect(page.getByTestId('tab-caja')).toBeVisible();
    });

    test('con zoom de pellizco la zona visible se encoge sin que haya teclado: no se esconden las pestañas ni se mueve nada', async ({ page }) => {
      await bootIphone(page);
      await tab(page, 'recepcion');
      await page.getByTestId('rec-supplier').focus();
      await page.evaluate(() => window.__ios.zoom(2));
      await expect(html(page)).not.toHaveClass(/kbd/);
      expect(await kbVar(page)).toBe('0px');
      await expect(page.getByTestId('tab-caja')).toBeVisible();
    });
  });
}

// ═════════════════════════════════════════════ 3. iPhone de lado ═════════════════════════════════════════════

test.describe(`iPhone · ${IPHONE_LANDSCAPE.name}`, () => {
  const p = IPHONE_LANDSCAPE;
  test.use({ viewport: { width: p.width, height: p.height }, userAgent: UA_IPHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  test.beforeEach(async ({ page }) => {
    await iosInit(page, { standalone: true });
  });

  test('girado: nada se sale, el diseño se compacta, las pestañas respetan la isla dinámica y los botones principales se alcanzan', async ({ page }) => {
    test.setTimeout(150_000);
    await bootIphone(page, {}, { freights: sampleFreights() });
    await setInsets(page, p.inset);
    await frames(page);
    const c = await chrome(page);
    expect(c.header!.height, 'encabezado compacto').toBeLessThan(52);
    expect(c.title!.left, 'el título queda dentro de la zona segura de la izquierda').toBeGreaterThanOrEqual(p.inset.left);
    expect(c.firstTab!.left, 'la primera pestaña no queda bajo la isla dinámica').toBeGreaterThanOrEqual(p.inset.left - 0.5);
    expect(c.lastTab!.right, 'la última pestaña no queda bajo el borde derecho').toBeLessThanOrEqual(c.vw - p.inset.right + 0.5);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.tab')!).flexDirection), 'icono y texto en una fila').toBe('row');
    expect(c.firstTab!.height, 'la pestaña sigue siendo táctil').toBeGreaterThanOrEqual(44);

    const bad: Record<string, string[]> = {};
    await walkScreens(page, async (where) => {
      await settled(page);
      await frames(page);
      const found = [
        ...(await overflowReport(page)).map((x) => `desborda: ${x}`),
        ...(await clippedTextReport(page)).map((x) => `recortado: ${x}`),
        ...(await touchTargetReport(page)).map((x) => `muy chico: ${x}`),
        ...(await bottomReachReport(page)).map((x) => `final: ${x}`),
      ];
      await page.evaluate(() => window.scrollTo(0, 0));
      if (found.length) bad[where] = found;
    });
    expect(bad, 'estados con defectos de diseño en horizontal').toEqual({});

    await tab(page, 'caja');
    await page.getByTestId('kg').fill('12.5');
    await page.getByTestId('bill-500').click();
    expect(await reachReport(page.getByTestId('confirm')), '«Cobrar» se alcanza y se puede tocar en horizontal').toEqual([]);
  });

  test('el tamaño de pantalla de 360×340 (vertical con teclado de Android) NO activa el diseño de horizontal', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 340 });
    await bootIphone(page);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.tab')!).flexDirection), 'se queda en columna').toBe('column');
  });
});

// ═════════════════════════════════════════════ 3b. Contraste de color ═════════════════════════════════════════════

test.describe('iPhone · contraste de color (WCAG 1.4.3)', () => {
  const p = IPHONES[0];
  test.use({ viewport: { width: p.width, height: p.height }, userAgent: UA_IPHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test('el texto de todas las pantallas (con el aviso de Safari, la ayuda de instalación, un error y la hoja de confirmación) cumple 4.5:1, o 3:1 si es grande', async ({ page }) => {
    test.setTimeout(150_000);
    await iosInit(page, { standalone: false }); // sin instalar: también se mide el aviso de instalación
    await bootIphone(page, {}, { freights: sampleFreights() });
    let measured = 0;
    const bad: Record<string, string[]> = {};
    const measure = async (where: string) => {
      await settled(page);
      const r = await contrastReport(page);
      measured += r.measured;
      if (r.failures.length) bad[where] = r.failures;
    };
    await walkScreens(page, measure);

    await page.getByTestId('install-help').click();
    await expect(page.getByTestId('install-sheet')).toBeVisible();
    await measure('Ayuda de instalación');
    await page.keyboard.press('Escape');

    await tab(page, 'recepcion');
    await page.getByTestId('rec-sub-nueva').click();
    await page.getByTestId('rec-confirm').click({ force: true }); // aviso de error
    await expect(page.getByTestId('toast')).toContainText('Escribe los kilos netos');
    await measure('Aviso de error');

    await tab(page, 'caja');
    await page.getByTestId('kg').fill('3');
    await page.getByTestId('bill-100').click();
    await page.getByTestId('confirm').click();
    await expect(page.getByTestId('confirm-sheet')).toBeVisible();
    await measure('Hoja de confirmación de cobro');

    expect(measured, 'se midieron textos de verdad en todas las pantallas').toBeGreaterThan(400);
    expect(bad, 'textos con poco contraste').toEqual({});
  });
});

// ═════════════════════════════════════════════ 4. Instalación y aviso de Safari ═════════════════════════════════════════════

test.describe('iPhone · aviso de instalación (Safari ≠ app instalada)', () => {
  const p = IPHONES[0];
  test.use({ viewport: { width: p.width, height: p.height }, userAgent: UA_IPHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test('en Safari (pestaña) se avisa que los datos NO son los de la app instalada y se explica cómo instalarla; con Entendido se cierra', async ({ page }) => {
    test.setTimeout(60_000);
    await iosInit(page, { standalone: false });
    await bootIphone(page);
    const notice = page.getByTestId('install-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('no aparece');
    await expect(notice).toContainText('antes');
    expect(await controlNameReport(page), 'todos los controles tienen nombre').toEqual({ unnamed: [], placeholderOnly: [] });

    await page.getByTestId('install-help').click();
    const sheet = page.getByTestId('install-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Añadir a pantalla de inicio');
    await expect(sheet).toContainText('Abrir como app web');
    await expect(page.getByTestId('install-steps').locator('li')).toHaveCount(5);
    expect(await dialogReport(page), 'es un diálogo con nombre').toEqual([]);
    expect((await overflowReport(page)).filter((x) => !x.startsWith('contenedor')), 'la hoja no desborda').toEqual([]);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(notice).toBeVisible(); // cerrar la ayuda no cierra el aviso

    await page.getByTestId('install-dismiss').click();
    await expect(notice).toHaveCount(0);
    // No se guarda para siempre: la persona sigue en Safari y al volver a abrir se le recuerda
    await page.reload();
    await expect(page.getByTestId('install-notice')).toBeVisible();
  });

  test('Más → «Estado de los datos» dice en qué modo se usa la app y trae la ayuda de instalación solo en Safari', async ({ page }) => {
    await iosInit(page, { standalone: false });
    await bootIphone(page);
    await tab(page, 'mas');
    await expect(page.getByTestId('install-state')).toContainText('navegador');
    await expect(page.getByTestId('install-state')).toContainText('son distintos');
    await expect(page.getByTestId('storage-state')).toContainText('instala la app en la pantalla de inicio'); // no persistente en Chromium de pruebas
    await page.getByTestId('install-help-mas').click();
    await expect(page.getByTestId('install-sheet')).toBeVisible();
    await page.getByTestId('install-sheet-close').click();
    await expect(page.getByTestId('install-sheet')).toHaveCount(0);
  });

  test('instalada en la pantalla de inicio NO hay aviso y Más dice «app instalada»', async ({ page }) => {
    await iosInit(page, { standalone: true });
    await bootIphone(page);
    await expect(page.getByTestId('install-notice')).toHaveCount(0);
    await tab(page, 'mas');
    await expect(page.getByTestId('install-state')).toContainText('app instalada');
    await expect(page.getByTestId('install-help-mas')).toHaveCount(0);
  });

  test('la hoja de ayuda queda SOBRE el teclado: su borde de abajo sube lo que tapa el teclado y su botón se alcanza', async ({ page }) => {
    await iosInit(page, { standalone: false });
    await bootIphone(page);
    await page.getByTestId('install-help').click();
    const overlay = page.getByTestId('install-sheet');
    await expect(overlay).toBeVisible();
    await settled(page);
    await iosKeyboard(page, p.keyboardPx);
    const o = await rectOf(overlay);
    expect(Math.abs(o.bottom - (p.height - p.keyboardPx)), 'el borde de abajo de la hoja es el del teclado').toBeLessThanOrEqual(1.5);
    const close = await rectOf(page.getByTestId('install-sheet-close'));
    expect(close.bottom, 'el botón queda por encima del teclado').toBeLessThanOrEqual(p.height - p.keyboardPx + 0.5);
    expect(close.top).toBeGreaterThanOrEqual(0);
    await iosKeyboardClose(page);
    expect((await rectOf(overlay)).bottom).toBeCloseTo(p.height, 0);
  });

  test('un teléfono Android y una computadora no ven el aviso de iPhone', async ({ browser }) => {
    // (browser.newContext hereda las opciones de iPhone de este bloque: se pisan a propósito con otro «user agent»)
    const agents = {
      'Android (Chrome)': 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Windows (Chrome)': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };
    for (const [name, userAgent] of Object.entries(agents)) {
      const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, serviceWorkers: 'allow', userAgent, isMobile: name.startsWith('Android') });
      const page = await ctx.newPage();
      await page.goto('/');
      await expect(page.getByTestId('caja'), name).toBeVisible();
      await expect(page.getByTestId('install-notice'), name).toHaveCount(0);
      await ctx.close();
    }
  });
});

// ═════════════════════════════════════════════ 5. Respaldo en iPhone ═════════════════════════════════════════════

test.describe('iPhone · respaldo con la hoja de compartir', () => {
  const p = IPHONES[0];
  test.use({ viewport: { width: p.width, height: p.height }, userAgent: UA_IPHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test('«Compartir respaldo» pide la hoja de compartir EN EL MISMO TOQUE (Safari la rechaza si hubo esperas) y marca el respaldo como hecho', async ({ page }) => {
    test.setTimeout(60_000);
    // Emula la regla de WebKit: share() solo se acepta mientras dura el gesto del toque; tras cualquier espera (leer la base,
    // un setTimeout) lo rechaza con NotAllowedError.
    await page.addInitScript(() => {
      let inGesture = false;
      const calls: Array<{ inGesture: boolean; files: number; name: string }> = [];
      (window as unknown as { __shares: typeof calls }).__shares = calls;
      addEventListener(
        'click',
        () => {
          inGesture = true;
          setTimeout(() => (inGesture = false), 0);
        },
        true,
      );
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (d: { files?: File[] }) => {
          calls.push({ inGesture, files: d.files?.length ?? 0, name: d.files?.[0]?.name ?? '' });
          if (!inGesture) throw new DOMException('Se necesita un gesto del usuario', 'NotAllowedError');
        },
      });
    });
    await iosInit(page, { standalone: true });
    await bootIphone(page);
    await tab(page, 'mas');
    await expect(page.getByTestId('share-backup')).toHaveAttribute('data-ready', 'yes');
    let descargas = 0;
    page.on('download', () => descargas++);
    await page.getByTestId('share-backup').click();
    await expect(page.getByTestId('toast')).toContainText('Respaldo compartido');
    const calls = await page.evaluate(() => (window as unknown as { __shares: Array<{ inGesture: boolean; files: number; name: string }> }).__shares);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ inGesture: true, files: 1 });
    expect(calls[0].name).toMatch(/^respaldo-caja-central-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    expect(descargas, 'no hizo falta descargar nada').toBe(0);
    await expect(page.getByTestId('last-backup')).toContainText('Último respaldo: hoy');
  });
});

// ═════════════════════════════════════════════ 6. Actualizar la PWA ═════════════════════════════════════════════

test.describe('iPhone · actualizar la PWA no borra los registros', () => {
  test('llega una versión nueva: aparece el aviso, las cachés viejas se limpian, «Actualizar ahora» recarga y los datos quedan EXACTAMENTE igual', async ({ browser }, testInfo) => {
    test.setTimeout(150_000);
    // Se sirve una COPIA de la app compilada para poder cambiar su service worker sin afectar a las demás pruebas.
    const copy = testInfo.outputPath('app-copia');
    cpSync(join(raizDelProyecto(), process.env.E2E_OUT_DIR ?? 'dist-e2e'), copy, { recursive: true });
    const srv = await servirCarpeta(copy);
    const ctx = await browser.newContext({
      serviceWorkers: 'allow',
      baseURL: `http://127.0.0.1:${srv.port}`,
      viewport: { width: 393, height: 852 },
      userAgent: UA_IPHONE,
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      timezoneId: 'America/Mexico_City',
      locale: 'es-MX',
    });
    try {
      const page = await ctx.newPage();
      await iosInit(page, { standalone: true });
      await openApp(page);
      await sellCash(page, '1', [50]);
      await page.reload(); // ahora la página nace CONTROLADA por el service worker: así sí recibe el aviso de versión nueva
      await expect(page.getByTestId('caja')).toBeVisible();
      const before = await readDb(page);
      expect(before.sales).toHaveLength(1);
      const cachesBefore = await page.evaluate(async () => (await caches.keys()).sort());
      expect(cachesBefore).toHaveLength(1);

      // «Se publica una versión nueva»: cambia el service worker (otra versión de caché)
      const swPath = join(copy, 'sw.js');
      writeFileSync(swPath, readFileSync(swPath, 'utf8').replace(/caja-central-[0-9a-f]{12}/, 'caja-central-nueva0000001'));
      await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        await reg!.update();
      });
      await expect(page.getByTestId('new-version')).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => page.evaluate(async () => (await caches.keys()).sort()), { message: 'la caché vieja se borró y quedó la nueva' }).toEqual(['caja-central-nueva0000001']);
      // No se recarga sola: lo que se esté capturando no se pierde
      await expect(page.getByTestId('caja')).toBeVisible();
      await expect(page.getByTestId('new-version')).toContainText('Tus datos no se tocan');

      await page.getByTestId('new-version-reload').click();
      await expect(page.getByTestId('caja')).toBeVisible();
      await expect(page.getByTestId('new-version')).toHaveCount(0);
      const after = await readDb(page);
      expect(after, 'la base quedó EXACTAMENTE igual').toEqual(before);
      expect(invariants(after)).toEqual([]);
      await tab(page, 'corte');
      await expect(page.getByTestId('r-total')).toHaveText(money(3000));

      // Y con la versión nueva se sigue vendiendo, con el folio que toca
      await tab(page, 'caja');
      await sellCash(page, '2', [100]);
      const later = await readDb(page);
      expect(later.sales.map((s) => s.folio).sort()).toEqual([1, 2]);
      expect(invariants(later)).toEqual([]);
    } finally {
      await ctx.close();
      await srv.close();
    }
  });
});

// ═════════════════════════════════════════════ 7. Conexión a la base ═════════════════════════════════════════════

test.describe('iPhone · la conexión a la base se recupera sola', () => {
  const p = IPHONES[0];
  test.use({ viewport: { width: p.width, height: p.height }, userAgent: UA_IPHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test('si el sistema cierra la conexión con la app suspendida, al volver la app la reabre sola: nada se pierde y se sigue vendiendo', async ({ page }) => {
    test.setTimeout(90_000);
    await iosInit(page, { standalone: true });
    await openApp(page);
    await sellCash(page, '1', [50]);
    const before = await readDb(page);
    expect(before.sales).toHaveLength(1);

    const count = () => page.evaluate(() => (window.__idbConns ?? []).filter((c) => c.name === 'caja-central').length);
    const opened = await count();
    // El sistema cierra la conexión de la app (aquí la prueba la cierra desde fuera)
    await page.evaluate(() => (window.__idbConns ?? []).filter((c) => c.name === 'caja-central').forEach((c) => c.close()));
    // La persona vuelve a la app: el sistema avisa que ya es visible otra vez
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(count, { message: 'la app debió abrir una conexión nueva' }).toBeGreaterThan(opened);

    await sellCash(page, '2', [100]);
    const after = await readDb(page);
    expect(after.sales.map((s) => s.folio).sort()).toEqual([1, 2]);
    expect(after.sales.find((s) => s.folio === 1)).toEqual(before.sales[0]);
    expect(invariants(after)).toEqual([]);
  });
});
