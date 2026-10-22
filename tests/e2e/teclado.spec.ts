import { expect, test, type Locator, type Page } from '@playwright/test';
import { openApp, tab } from './helpers';

/**
 * Regresión del «toque perdido» al soltar el foco del teclado.
 *
 * Fallo original: al tocar un botón con un campo de texto enfocado, el campo pierde el foco en el mousedown. El CSS
 * `body:has(input:focus)` cambiaba el diseño en ese instante (pestañas que reaparecen, barra de registro que sube) y el
 * botón se movía antes del mouseup: el `click` caía en el DIV padre y «el primer toque no hacía nada». Las 26 E2E
 * originales lo detectaron como «no aparece el aviso de Variedad agregada».
 *
 * El teclado del teléfono se emula como lo hace Android con `interactive-widget=resizes-content`: la ventana se encoge.
 * NO es lo mismo que un teléfono real: la prueba física en Android sigue pendiente (ver docs/PRUEBAS.md).
 */

interface Phone {
  name: string;
  width: number;
  height: number;
  /** Alto que se «come» el teclado (aprox. de un teclado de Android). */
  keyboardPx: number;
}
const PHONES: Phone[] = [
  { name: '360×640', width: 360, height: 640, keyboardPx: 300 },
  { name: '412×915', width: 412, height: 915, keyboardPx: 340 },
];

interface TapRecord {
  testid: string | null;
  down: number[];
  up: number[];
  onButton: boolean;
}

/** Registra, para cada toque, dónde estaba el botón al empezar y al terminar, y si el click le llegó a él. */
async function watchTaps(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __taps: unknown[]; __tapWatch?: boolean };
    w.__taps = [];
    if (w.__tapWatch) return;
    w.__tapWatch = true;
    let pressed: Element | null = null;
    let down: number[] = [];
    let up: number[] = [];
    const rect = (el: Element) => {
      const b = el.getBoundingClientRect();
      return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)];
    };
    addEventListener(
      'pointerdown',
      (e) => {
        pressed = (e.target as Element).closest('button');
        down = pressed ? rect(pressed) : [];
        up = [];
      },
      true,
    );
    addEventListener('mouseup', () => (up = pressed ? rect(pressed) : []), true);
    addEventListener(
      'click',
      (e) => {
        const t = e.target as Element;
        w.__taps.push({
          testid: pressed?.getAttribute('data-testid') ?? null,
          down,
          up,
          onButton: !!pressed && (pressed === t || pressed.contains(t)),
        });
        pressed = null;
      },
      true,
    );
  });
}
const taps = (page: Page) => page.evaluate(() => (window as unknown as { __taps: TapRecord[] }).__taps);
async function lastTap(page: Page): Promise<TapRecord> {
  const all = await taps(page);
  expect(all.length, 'no hubo ningún click').toBeGreaterThan(0);
  return all[all.length - 1];
}
/**
 * El botón recibió el click y NO se movió entre el inicio y el final del toque. Se revisa ANTES que el efecto del toque
 * (toast, hoja...) para que, si el toque se pierde, el mensaje diga la causa real y no solo «no apareció el aviso».
 */
async function expectSolidTap(page: Page, testid: string) {
  await expect.poll(async () => (await taps(page)).length, { message: 'el toque no produjo ningún click' }).toBeGreaterThan(0);
  const tap = await lastTap(page);
  expect(tap.testid).toBe(testid);
  expect(tap.onButton, 'el click cayó en otro elemento (el botón se movió bajo el dedo)').toBe(true);
  expect(tap.up, 'el botón cambió de lugar entre que se puso el dedo y se levantó').toEqual(tap.down);
}

const html = (page: Page) => page.locator('html');
async function showKeyboard(page: Page, phone: Phone) {
  await page.setViewportSize({ width: phone.width, height: phone.height - phone.keyboardPx });
}
async function hideKeyboard(page: Page, phone: Phone) {
  await page.setViewportSize({ width: phone.width, height: phone.height });
}
const rectOf = (l: Locator) =>
  l.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width };
  });
const innerHeight = (page: Page) => page.evaluate(() => window.innerHeight);

/** Elementos que se salen de la pantalla a lo ancho (vacío = sin desbordamiento horizontal). */
async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const bad: string[] = [];
    if (document.documentElement.scrollWidth > vw) bad.push(`documento: ancho ${document.documentElement.scrollWidth} > ${vw}`);
    const sel = 'button, input, select, textarea, h2, h3, p, label, summary, dt, dd, li, .chip';
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // ocultos (display:none / hidden)
      if (r.right > vw + 1 || r.left < -1) {
        const name = el.getAttribute('data-testid') ?? (el.textContent ?? '').trim().slice(0, 24);
        bad.push(`${el.tagName.toLowerCase()}[${name}] ${Math.round(r.left)}..${Math.round(r.right)} fuera de 0..${vw}`);
      }
    }
    return bad;
  });
}

/** Pestañas de abajo: todas visibles y con la etiqueta completa (sin recortar). */
async function expectTabsIntact(page: Page) {
  const ids = ['caja', 'vales', 'recepcion', 'inventario', 'corte', 'mas'] as const;
  for (const id of ids) {
    const t = page.getByTestId(`tab-${id}`);
    await expect(t).toBeVisible();
    const fits = await t.locator('.lbl').evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(fits, `la etiqueta de la pestaña «${id}» está recortada`).toBe(true);
    const r = await rectOf(t);
    expect(r.right, `la pestaña «${id}» se sale por la derecha`).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
    expect(r.height, `la pestaña «${id}» es muy baja para tocarla`).toBeGreaterThanOrEqual(44);
  }
}

/**
 * Entra a Recepción y elige «Con semilla» (una sola clasificación, queda elegida de una vez). La app guarda «Limón con
 * semilla» como la variedad «Con semilla»: es el nombre canónico (ver docs/DISENO-CLASIFICACION-RECEPCION.md).
 */
async function goReceive(page: Page) {
  await tab(page, 'recepcion');
  await page.getByTestId('rec-variety').filter({ hasText: 'Con semilla' }).click();
  await expect(page.getByTestId('rec-selected')).toContainText('Con semilla');
}

for (const phone of PHONES) {
  test.describe(`Teclado y toques · ${phone.name}`, () => {
    test.use({ viewport: { width: phone.width, height: phone.height } });

    test('alta de variedad: el primer toque en «Agregar variedad» funciona con el precio todavía enfocado', async ({ page }) => {
      await openApp(page, { seed: false });
      const form = page.locator('[data-testid="new-variety"]:visible');
      await form.getByTestId('new-name').fill('Limón persa');
      await form.getByTestId('new-quality').fill('Primera');
      await form.getByTestId('new-price').fill('30');
      await expect(form.getByTestId('new-price')).toBeFocused();
      await watchTaps(page);
      await form.getByTestId('add-product').tap();
      await expectSolidTap(page, 'add-product');
      await expect(page.getByTestId('toast')).toContainText('Producto agregado');
    });

    test('alta de variedad con TECLADO ABIERTO: se esconden las pestañas y el primer toque sigue funcionando', async ({ page }) => {
      await openApp(page, { seed: false });
      const form = page.locator('[data-testid="new-variety"]:visible');
      await form.getByTestId('new-name').fill('Limón persa');
      await form.getByTestId('new-price').fill('30');
      await showKeyboard(page, phone);
      await expect(html(page)).toHaveClass(/kbd/);
      await expect(page.getByTestId('tab-inventario')).toBeHidden();
      await watchTaps(page);
      await form.getByTestId('add-product').tap();
      await expectSolidTap(page, 'add-product');
      await expect(page.getByTestId('toast')).toContainText('Producto agregado');
    });

    test('recepción con teclado abierto: barra de registro en el borde, campo no tapado y registro al primer toque', async ({ page }) => {
      await openApp(page);
      await goReceive(page);
      await page.getByTestId('rec-net-direct').fill('120');
      await showKeyboard(page, phone);
      await expect(html(page)).toHaveClass(/kbd/);
      await expect(page.locator('.topbar'), 'con el teclado abierto la barra de arriba deja de estar fija y no tapa lo que se escribe').toHaveCSS('position', 'static');

      // La barra de registro baja al borde de la ventana y el botón queda completo a la vista.
      const dock = await rectOf(page.getByTestId('rec-dock'));
      const vh = await innerHeight(page);
      expect(Math.abs(dock.bottom - vh), 'la barra de registro debe pegarse al borde inferior').toBeLessThanOrEqual(1.5);
      const confirm = await rectOf(page.getByTestId('rec-confirm'));
      expect(confirm.top).toBeGreaterThanOrEqual(0);
      expect(confirm.bottom).toBeLessThanOrEqual(vh + 0.5);
      expect(await overflowing(page)).toEqual([]);

      await watchTaps(page);
      await page.getByTestId('rec-confirm').tap();
      await expectSolidTap(page, 'rec-confirm');
      await expect(page.getByTestId('rec-sheet')).toBeVisible();
      await expect(page.getByTestId('rec-sheet-net')).toHaveAttribute('data-milli', '120000');

      await watchTaps(page);
      await page.getByTestId('rec-confirm-yes').tap();
      await expectSolidTap(page, 'rec-confirm-yes');
      await expect(page.getByTestId('toast')).toContainText('registrada: +120 kg');

      // Al cerrarse el teclado las pestañas vuelven solas.
      await hideKeyboard(page, phone);
      await expect(html(page)).not.toHaveClass(/kbd/);
      await expectTabsIntact(page);
    });

    test('«atrás» cierra el teclado pero el campo conserva el foco: las pestañas NO se quedan escondidas', async ({ page }) => {
      await openApp(page);
      await goReceive(page);
      await page.getByTestId('rec-net-direct').fill('50');
      await showKeyboard(page, phone);
      await expect(html(page)).toHaveClass(/kbd/);
      await hideKeyboard(page, phone);
      await expect(page.getByTestId('rec-net-direct')).toBeFocused();
      await expect(html(page)).not.toHaveClass(/kbd/);
      await expectTabsIntact(page);
    });

    test('sin teclado (escritorio o pruebas) la clase kbd nunca se pone, aunque haya un campo enfocado', async ({ page }) => {
      await openApp(page);
      await goReceive(page);
      await page.getByTestId('rec-net-direct').fill('50');
      await expect(page.getByTestId('rec-net-direct')).toBeFocused();
      await expect(html(page)).not.toHaveClass(/kbd/);
      await expectTabsIntact(page);
    });

    test('caja rápida con teclado abierto: las pestañas siguen a la vista y la venta se cobra con toques', async ({ page }) => {
      await openApp(page);
      await page.getByTestId('kg').fill('2');
      await showKeyboard(page, phone);
      await expect(page.getByTestId('kg')).toBeFocused();
      await expect(html(page)).not.toHaveClass(/kbd/);
      await expect(page.getByTestId('tab-corte')).toBeVisible();
      await watchTaps(page);
      await page.getByTestId('bill-100').tap();
      await expectSolidTap(page, 'bill-100');
      await page.getByTestId('confirm').tap();
      await expect(page.getByTestId('confirm-sheet')).toBeVisible();
      await page.getByTestId('authorize').or(page.getByTestId('confirm-yes')).first().tap();
      await expect(page.getByTestId('toast')).toContainText('guardada');
    });

    test('inventario con teclado abierto: «Guardar» entrada responde al primer toque', async ({ page }) => {
      await openApp(page);
      await tab(page, 'inventario');
      const row = page.getByTestId('inv-row').filter({ hasText: 'Con semilla' });
      await row.getByTestId('move-entrada').tap();
      await row.getByTestId('move-qty').fill('100');
      await showKeyboard(page, phone);
      await expect(html(page)).toHaveClass(/kbd/);
      await watchTaps(page);
      await row.getByTestId('move-save').tap();
      await expectSolidTap(page, 'move-save');
      await expect(page.getByTestId('toast')).toContainText('Entrada manual registrada');
      await expect(row.getByTestId('stock-physical')).toHaveText('100 kg');
    });

    test('un campo enfocado cerca del borde no queda tapado por la barra de registro ni por las pestañas', async ({ page }) => {
      await openApp(page);
      await goReceive(page);
      for (const kb of [false, true]) {
        if (kb) await showKeyboard(page, phone);
        // Se deja el campo pegado al borde inferior y luego se enfoca: el navegador debe subirlo. (Enfocar un campo que ya
        // tiene el foco no desplaza nada, por eso se suelta primero.)
        await page.getByTestId('rec-supplier').blur();
        await page.evaluate(() => {
          const el = document.querySelector('[data-testid=rec-supplier]')!;
          window.scrollBy(0, el.getBoundingClientRect().bottom - (window.innerHeight - 6));
        });
        await page.getByTestId('rec-supplier').focus();
        await page.waitForTimeout(150);
        const field = await rectOf(page.getByTestId('rec-supplier'));
        const dock = await rectOf(page.getByTestId('rec-dock'));
        const covered = field.bottom > dock.top + 0.5 && field.top < dock.bottom - 0.5;
        expect(covered, `el campo quedó debajo de la barra de registro (teclado ${kb ? 'abierto' : 'cerrado'})`).toBe(false);
        if (!kb) {
          const tabs = await rectOf(page.locator('nav.tabs'));
          expect(field.bottom, 'el campo quedó debajo de las pestañas').toBeLessThanOrEqual(tabs.top + 0.5);
        }
      }
    });

    test('sin desbordamiento horizontal ni pestañas recortadas, con el teclado cerrado, en todas las secciones', async ({ page }) => {
      await openApp(page);
      await expectTabsIntact(page);
      for (const name of ['caja', 'vales', 'recepcion', 'inventario', 'corte', 'mas'] as const) {
        await tab(page, name);
        await expect(page.getByTestId(name === 'recepcion' ? 'recepcion' : name)).toBeVisible();
        expect(await overflowing(page), `desbordamiento en «${name}»`).toEqual([]);
      }
      // Recepción: las cuatro subsecciones.
      await tab(page, 'recepcion');
      for (const sub of ['nueva', 'borradores', 'historial', 'resumen']) {
        await page.getByTestId(`rec-sub-${sub}`).click();
        expect(await overflowing(page), `desbordamiento en Recepción › ${sub}`).toEqual([]);
      }
    });

    test('sin desbordamiento horizontal con el teclado ABIERTO (formularios de captura)', async ({ page }) => {
      await openApp(page);
      await goReceive(page);
      await page.getByTestId('rec-supplier').fill('Proveedor con un nombre bastante largo para probar el ancho de la pantalla');
      await page.getByTestId('rec-net-direct').fill('123456.789');
      await showKeyboard(page, phone);
      expect(await overflowing(page)).toEqual([]);
      await hideKeyboard(page, phone);
      await tab(page, 'inventario');
      await page.getByTestId('inv-row').first().getByTestId('move-entrada').click();
      await page.getByTestId('move-qty').fill('5');
      await showKeyboard(page, phone);
      expect(await overflowing(page)).toEqual([]);
    });

    test('las hojas modales responden y dejan el fondo inerte (regresión: la hoja quedaba inerte junto con <main>)', async ({ page }) => {
      await openApp(page);
      await tab(page, 'recepcion');
      await page.getByTestId('rec-new-class-toggle').click();
      const sheet = page.getByTestId('rec-newclass-sheet');
      await expect(sheet).toBeVisible();
      // El fondo (pestañas, encabezado y el resto de <main>) está inerte; la hoja y sus botones NO.
      const inertOf = (id: string) => page.getByTestId(id).evaluate((el) => !!el.closest('[inert]'));
      expect(await inertOf('tab-caja')).toBe(true);
      expect(await inertOf('rec-new-class-toggle')).toBe(true);
      expect(await inertOf('rec-newclass-close')).toBe(false);
      expect(await inertOf('recnew-name')).toBe(false);
      // Se puede escribir y guardar dentro de la hoja (los botones responden).
      await sheet.getByTestId('recnew-name').fill('Limón criollo');
      await sheet.getByTestId('recnew-add').tap();
      await expect(page.getByTestId('toast')).toContainText('Producto agregado');
      await expect(sheet).toBeHidden();
      // Al cerrar no queda NADA inerte.
      expect(await page.evaluate(() => document.querySelectorAll('[inert], [data-sheet-inert]').length)).toBe(0);
      await expect(page.getByTestId('rec-selected')).toContainText('Limón criollo');
    });
  });
}
