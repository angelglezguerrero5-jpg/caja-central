import { devices, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { openApp, tab } from './helpers';

/**
 * Ayudas de las pruebas de catálogo clasificado + inventario/ventas por clasificación (clasificacion.spec.ts).
 * Solo LEE ./helpers (no lo modifica). Todo se hace por la interfaz, como lo haría la persona usuaria.
 */

export type Unit = 'kg' | 'pieza' | 'caja' | 'arpilla';

export interface ClassSpec {
  /** Variedad (obligatoria). */
  name: string;
  origin?: string;
  quality?: string;
  caliber?: string;
  /** Precio como se teclea ("30", "27.5"). `null` o ausente = «Sin precio todavía». */
  price?: string | null;
  unit?: Unit;
}

// ---------------------------------------------------------------------------------------------------------------
// Texto exacto y cantidades
// ---------------------------------------------------------------------------------------------------------------

export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Texto completo igual a `label` (ignora espacios de los bordes). */
export const exact = (label: string) => new RegExp(`^\\s*${esc(label)}\\s*$`);
/** Texto de un chip de clasificación: la etiqueta y, si falta el precio, « · sin precio». */
export const chipText = (label: string) => new RegExp(`^\\s*${esc(label)}(\\s*·\\s*sin precio)?\\s*$`);
export const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** "12.5 kg" → 12500 · "500 g" → 500 · "-3 kg" → -3000 · "2 caja" → 2000. Falla si el texto no es una cantidad. */
export function parseQtyText(s: string): number {
  const m = norm(s).match(/^(-?[\d,]*\.?\d+)\s*(g|kg|pza|caja|arpilla)$/);
  if (!m) throw new Error(`Cantidad ilegible: «${s}»`);
  const n = Number(m[1].replace(/,/g, ''));
  return m[2] === 'g' ? Math.round(n) : Math.round(n * 1000);
}

// ---------------------------------------------------------------------------------------------------------------
// Avisos (toast): un REGISTRO de todos los avisos permite distinguir uno NUEVO de uno igual que sigue (o ya se fue) en pantalla
// ---------------------------------------------------------------------------------------------------------------

interface ToastEntry {
  kind: 'ok' | 'error';
  text: string;
}

/**
 * La app hace `navigator.vibrate(...)` cada vez que muestra un aviso (un patrón corto = normal, uno doble = error). Se
 * aprovecha para llevar un registro de TODOS los avisos con su texto, leído justo después de que la interfaz lo pinta. Así
 * una prueba no se confunde con un aviso anterior igual ni pierde uno que se quitó pronto. Se instala ANTES de abrir la app
 * (script de inicio de la página).
 */
export async function spyToasts(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __toastLog: Array<{ kind: 'ok' | 'error'; text: string }> };
    w.__toastLog = [];
    const original = typeof navigator.vibrate === 'function' ? navigator.vibrate.bind(navigator) : undefined;
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: (pattern: VibratePattern) => {
        const entry = { kind: (Array.isArray(pattern) ? 'error' : 'ok') as 'ok' | 'error', text: '' };
        w.__toastLog.push(entry);
        // El texto se lee DESPUÉS de que la interfaz pinte el aviso (la pintura de Preact ocurre antes del siguiente cuadro).
        requestAnimationFrame(() => {
          entry.text = (document.querySelector('[data-testid="toast"]')?.textContent ?? '').replace(/\s+/g, ' ').trim();
        });
        try {
          return original ? original(pattern) : true;
        } catch {
          return true;
        }
      },
    });
  });
}

/**
 * «Otro dispositivo» / «cerrar y reabrir»: un contexto aislado con el mismo perfil que usa la configuración (Pixel 7,
 * America/Mexico_City, es-MX). `browser.newContext()` a secas NO hereda esas opciones.
 */
export function newDevice(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return browser.newContext({ ...devices['Pixel 7'], timezoneId: 'America/Mexico_City', locale: 'es-MX', serviceWorkers: 'allow', baseURL });
}

/** Abre la app SIN variedades (no inventa nada) con el espía de avisos puesto. */
export async function open(page: Page) {
  await spyToasts(page);
  await openApp(page, { seed: false });
}

/** Cuántos avisos ha mostrado la app hasta ahora (en esta carga de página). */
export const toastCount = (page: Page) => page.evaluate(() => (window as unknown as { __toastLog?: unknown[] }).__toastLog?.length ?? 0);

const toastsSince = (page: Page, before: number): Promise<ToastEntry[]> =>
  page.evaluate((b) => ((window as unknown as { __toastLog?: ToastEntry[] }).__toastLog ?? []).slice(b).map((e) => ({ ...e })), before);

/** Textos de los avisos de ERROR que han salido después de `before` (para comprobar que una acción repetida no asusta con un error). */
export async function errorToastsSince(page: Page, before: number): Promise<string[]> {
  return (await toastsSince(page, before)).filter((e) => e.kind === 'error').map((e) => e.text);
}

/** Espera un aviso NUEVO (posterior a `before`) con ese texto y ese tipo. Devuelve el texto completo. */
export async function expectNewToast(page: Page, before: number, text: RegExp | string, kind: 'ok' | 'error' = 'ok'): Promise<string> {
  const re = typeof text === 'string' ? new RegExp(esc(text)) : text;
  let seen: ToastEntry[] = [];
  let hit: ToastEntry | undefined;
  try {
    await expect
      .poll(
        async () => {
          seen = await toastsSince(page, before);
          hit = seen.find((e) => e.kind === kind && re.test(e.text));
          return !!hit;
        },
        { timeout: 8000 },
      )
      .toBe(true);
  } catch (e) {
    // El mensaje se arma AQUÍ (después de esperar) para mostrar lo que realmente salió en pantalla.
    throw new Error(
      `se esperaba un aviso ${kind === 'error' ? 'de ERROR' : 'normal'} nuevo que coincida con ${re}; ` +
        `avisos nuevos vistos: ${seen.length ? seen.map((s) => `[${s.kind}] «${s.text}»`).join(' · ') : 'ninguno'}\n${(e as Error).message}`,
    );
  }
  return hit!.text;
}

// ---------------------------------------------------------------------------------------------------------------
// Alta / edición de clasificaciones (formulario NuevaVariedad)
// ---------------------------------------------------------------------------------------------------------------

export const addForm = (page: Page) => page.locator('[data-testid="new-variety"]:visible');

export async function fillForm(form: Locator, c: ClassSpec, p = 'new') {
  await form.getByTestId(`${p}-name`).fill(c.name);
  await form.getByTestId(`${p}-origin`).fill(c.origin ?? '');
  await form.getByTestId(`${p}-quality`).fill(c.quality ?? '');
  await form.getByTestId(`${p}-caliber`).fill(c.caliber ?? '');
  // La unidad se fija SIEMPRE (por defecto kg): el selector conserva la última elegida entre un alta y la siguiente.
  await form.getByTestId(`${p}-unit`).selectOption(c.unit ?? 'kg');
  const noPrice = form.getByTestId(`${p}-no-price`);
  if (c.price == null) await noPrice.check();
  else {
    await noPrice.uncheck();
    await form.getByTestId(`${p}-price`).fill(c.price);
  }
}

/** Da de alta una clasificación desde Inventario → «Nueva variedad» y espera el aviso y la limpieza del formulario. */
export async function addClass(page: Page, c: ClassSpec) {
  await tab(page, 'inventario');
  const form = addForm(page);
  await fillForm(form, c);
  const n = await toastCount(page);
  await form.getByTestId('add-product').click();
  await expectNewToast(page, n, 'Producto agregado');
  await expect(form.getByTestId('new-name'), 'el formulario debe limpiarse solo si se guardó').toHaveValue('');
}

/** Intenta dar de alta y devuelve el texto del aviso de ERROR (la prueba comprueba aparte que no se creó nada). */
export async function tryAddClass(page: Page, c: ClassSpec, error: RegExp | string): Promise<string> {
  await tab(page, 'inventario');
  const form = addForm(page);
  await fillForm(form, c);
  const n = await toastCount(page);
  await form.getByTestId('add-product').click();
  return expectNewToast(page, n, error, 'error');
}

/** Rellena SOLO los campos indicados (para editar). `price: null` marca «Sin precio todavía». */
export async function patchForm(form: Locator, patch: Partial<ClassSpec>, p = 'edit') {
  if (patch.name !== undefined) await form.getByTestId(`${p}-name`).fill(patch.name);
  if (patch.origin !== undefined) await form.getByTestId(`${p}-origin`).fill(patch.origin);
  if (patch.quality !== undefined) await form.getByTestId(`${p}-quality`).fill(patch.quality);
  if (patch.caliber !== undefined) await form.getByTestId(`${p}-caliber`).fill(patch.caliber);
  if (patch.unit) await form.getByTestId(`${p}-unit`).selectOption(patch.unit);
  if ('price' in patch) {
    if (patch.price == null) await form.getByTestId(`${p}-no-price`).check();
    else {
      await form.getByTestId(`${p}-no-price`).uncheck();
      await form.getByTestId(`${p}-price`).fill(patch.price);
    }
  }
}

/** Abre «Editar» de una fila de Inventario. Devuelve la fila y el formulario de edición. */
export async function openEdit(page: Page, label: string) {
  await tab(page, 'inventario');
  const row = invRow(page, label);
  await row.getByTestId('edit-product').click();
  const form = row.getByTestId('edit-variety');
  await expect(form).toBeVisible();
  return { row, form };
}

/** Oculta o activa una clasificación desde Inventario y espera el cambio. */
export async function setHidden(page: Page, label: string, hide: boolean) {
  await tab(page, 'inventario');
  const row = invRow(page, label);
  await row.getByRole('button', { name: hide ? 'Ocultar' : 'Activar', exact: true }).click();
  if (hide) await expect(row).toHaveClass(/inactive/);
  else await expect(row).not.toHaveClass(/inactive/);
}

/** Etiqueta mostrada de una clasificación: variedad · procedencia · calidad · calibre (lo que exista). */
export const labelOf = (c: Pick<ClassSpec, 'name' | 'origin' | 'quality' | 'caliber'>) =>
  [c.name, c.origin, c.quality, c.caliber].filter(Boolean).join(' · ');

// ---------------------------------------------------------------------------------------------------------------
// Inventario
// ---------------------------------------------------------------------------------------------------------------

export const invRows = (page: Page) => page.getByTestId('inv-row');

/** Fila de Inventario cuya etiqueta es EXACTAMENTE `label`. */
export const invRow = (page: Page, label: string) =>
  invRows(page).filter({ has: page.locator('header > strong').filter({ hasText: exact(label) }) });

/** Lectura repetida hasta que dos lecturas seguidas coinciden (la interfaz recarga sus listas de forma asíncrona tras cada cambio). */
export async function stable<T>(read: () => Promise<T>): Promise<T> {
  let previous: string | undefined;
  let value!: T;
  await expect
    .poll(
      async () => {
        value = await read();
        const now = JSON.stringify(value);
        const same = now === previous;
        previous = now;
        return same;
      },
      { intervals: [60, 60, 120, 250], timeout: 5000 },
    )
    .toBe(true);
  return value;
}

interface DbProduct {
  label: string;
  physicalMilli: number;
  reservedMilli: number;
}
/**
 * Variedades guardadas en la base, en el MISMO orden que la app (sort y luego nombre). Es solo LECTURA y sirve para saber
 * cuándo la pantalla ya terminó de refrescarse (las aserciones siguen comparando contra lo que la prueba espera).
 */
const dbProducts = (page: Page): Promise<DbProduct[]> =>
  page.evaluate(
    () =>
      new Promise<DbProduct[]>((resolve, reject) => {
        const open = indexedDB.open('caja-central');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const all = db.transaction('products').objectStore('products').getAll();
          all.onerror = () => reject(all.error);
          all.onsuccess = () => {
            db.close();
            const list = (all.result as Array<{ name: string; origin?: string; quality?: string; caliber?: string; sort: number; physicalMilli: number; reservedMilli: number }>).sort(
              (a, b) => a.sort - b.sort || a.name.localeCompare(b.name),
            );
            resolve(list.map((p) => ({ label: [p.name, p.origin, p.quality, p.caliber].filter(Boolean).join(' · '), physicalMilli: p.physicalMilli, reservedMilli: p.reservedMilli })));
          };
        };
      }),
  );

/** Espera a que Inventario muestre exactamente lo que hay en la base (mismas filas, etiquetas, físico y apartado). */
export async function settleInventory(page: Page) {
  await tab(page, 'inventario');
  await expect
    .poll(
      async () => {
        try {
          const want = await dbProducts(page);
          const rows = invRows(page);
          if ((await rows.count()) !== want.length) return false;
          for (let i = 0; i < want.length; i++) {
            const row = rows.nth(i);
            if (norm(await row.locator('header > strong').innerText()) !== want[i].label) return false;
            if (parseQtyText(await row.getByTestId('stock-physical').innerText()) !== want[i].physicalMilli) return false;
            if (parseQtyText(await row.getByTestId('stock-reserved').innerText()) !== want[i].reservedMilli) return false;
          }
          return true;
        } catch {
          return false; // una fila se repintó a mitad de la lectura: se vuelve a intentar
        }
      },
      { message: 'Inventario no terminó de reflejar lo guardado en la base', timeout: 10_000 },
    )
    .toBe(true);
}

export async function invLabels(page: Page): Promise<string[]> {
  await settleInventory(page);
  return (await invRows(page).locator('header > strong').allInnerTexts()).map(norm);
}

export interface StockTexts {
  physical: string;
  reserved: string;
  available: string;
}
export async function expectStock(row: Locator, want: Partial<StockTexts> & { recibido?: string; manual?: string; vendido?: string; merma?: string; ajuste?: string }) {
  const ids: Record<string, string> = {
    physical: 'stock-physical', reserved: 'stock-reserved', available: 'stock-available',
    recibido: 'stock-recibido', manual: 'stock-manual', vendido: 'stock-vendido', merma: 'stock-merma', ajuste: 'stock-ajuste',
  };
  for (const [k, v] of Object.entries(want)) {
    if (v !== undefined) await expect(row.getByTestId(ids[k]), `${k} (esperado «${v}»)`).toHaveText(v);
  }
}

export interface RowSnapshot {
  label: string;
  price: string;
  physical: string;
  reserved: string;
  available: string;
  hidden: boolean;
}
/** Foto de TODAS las filas de Inventario (etiqueta, precio mostrado y existencias) para comparar antes/después. */
export async function snapshotInventory(page: Page): Promise<RowSnapshot[]> {
  await settleInventory(page);
  const rows = invRows(page);
  const n = await rows.count();
  const out: RowSnapshot[] = [];
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    out.push({
      label: norm(await row.locator('header > strong').innerText()),
      price: norm(await row.locator('header > span').innerText()),
      physical: norm(await row.getByTestId('stock-physical').innerText()),
      reserved: norm(await row.getByTestId('stock-reserved').innerText()),
      available: norm(await row.getByTestId('stock-available').innerText()),
      hidden: ((await row.getAttribute('class')) ?? '').includes('inactive'),
    });
  }
  return out;
}

/** Lee los números de una fila (en milésimas). Los acumulados solo existen si el producto ya tuvo movimientos. */
export async function readRow(row: Locator) {
  const q = async (id: string) => {
    const el = row.getByTestId(id);
    return (await el.count()) ? parseQtyText(await el.innerText()) : null;
  };
  return {
    physical: (await q('stock-physical'))!,
    reserved: (await q('stock-reserved'))!,
    available: (await q('stock-available'))!,
    recibido: await q('stock-recibido'),
    manual: await q('stock-manual'),
    vendido: await q('stock-vendido'),
    merma: await q('stock-merma'),
    ajuste: await q('stock-ajuste'),
  };
}

/**
 * Identidades que SIEMPRE deben cumplirse en cada fila:
 *   disponible = físico − apartado
 *   físico = recepciones + entradas manuales − vendido − mermas ± conteos  (si ya hubo movimientos)
 */
export async function expectIdentity(page: Page) {
  await settleInventory(page);
  const rows = invRows(page);
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const label = norm(await row.locator('header > strong').innerText());
    const r = await readRow(row);
    expect(r.available, `«${label}»: disponible = físico − apartado`).toBe(r.physical - r.reserved);
    if (r.recibido !== null) {
      const rebuilt = r.recibido + (r.manual ?? 0) - (r.vendido ?? 0) - (r.merma ?? 0) + (r.ajuste ?? 0);
      expect(r.physical, `«${label}»: físico = entradas − vendido − mermas ± conteos`).toBe(rebuilt);
    }
  }
}

/** Movimiento manual (entrada, merma o conteo) desde la fila. Con `authorize` espera y acepta la hoja de autorización. */
export async function moveStock(
  page: Page,
  label: string,
  kind: 'entrada' | 'merma' | 'ajuste',
  qty: string,
  note = '',
  opts: { authorize?: boolean } = {},
) {
  await tab(page, 'inventario');
  const row = invRow(page, label);
  await row.getByTestId(`move-${kind}`).click();
  await row.getByTestId('move-qty').fill(qty);
  if (note) await row.getByTestId('move-note').fill(note);
  const n = await toastCount(page);
  await row.getByTestId('move-save').click();
  if (opts.authorize) {
    await expect(page.getByTestId('authorize-sheet')).toBeVisible();
    await page.getByTestId('authorize-yes').click();
  }
  await expectNewToast(page, n, kind === 'entrada' ? 'Entrada manual registrada' : kind === 'merma' ? 'Merma registrada' : 'Conteo físico registrado');
}

/** Existencia inicial por entrada manual. */
export const addStock = (page: Page, label: string, kg: string) => moveStock(page, label, 'entrada', kg);

// ---------------------------------------------------------------------------------------------------------------
// Caja
// ---------------------------------------------------------------------------------------------------------------

/** Textos de los chips de una fila (sin el « · sin precio»). */
export async function chipTexts(page: Page, testid: string): Promise<string[]> {
  return stable(async () => (await page.getByTestId(testid).allInnerTexts()).map((t) => norm(t).replace(/ · sin precio$/, '')));
}

/** Elige la variedad (primer nivel de ProductChips). */
export async function pickVariety(page: Page, name: string) {
  await tab(page, 'caja');
  await page.getByTestId('variety').filter({ hasText: exact(name) }).click();
}

/**
 * Elige la clasificación (segundo nivel). Si la variedad tiene más de 6, la elegida se muestra sola y hay que abrir la hoja
 * «Ver las N clasificaciones».
 */
export async function pickClass(page: Page, classLabel: string) {
  const all = page.getByTestId('quality-all');
  if (await all.count()) {
    const shown = page.getByTestId('quality');
    if ((await shown.count()) && chipText(classLabel).test(norm(await shown.first().innerText()))) return;
    await all.click();
    await page.getByTestId('quality-sheet-item').filter({ has: page.locator('strong').filter({ hasText: exact(classLabel) }) }).click();
    await expect(page.getByTestId('quality-sheet')).toHaveCount(0);
  } else {
    await page.getByTestId('quality').filter({ hasText: chipText(classLabel) }).click();
  }
}

/** Caja → variedad → clasificación (si se indica). Comprueba el «Vendiendo: …» resultante. */
export async function selectInCaja(page: Page, c: Pick<ClassSpec, 'name' | 'origin' | 'quality' | 'caliber'>, unitSuffix = '') {
  await pickVariety(page, c.name);
  const rest = [c.origin, c.quality, c.caliber].filter(Boolean).join(' · ');
  // Si la variedad tiene UNA sola clasificación no hay segundo nivel de chips: ya quedó elegida.
  const secondLevel = (await page.getByTestId('quality').count()) + (await page.getByTestId('quality-all').count());
  if (rest && secondLevel > 0) await pickClass(page, rest + unitSuffix);
  await expect(page.getByTestId('selling')).toHaveText(exact(`Vendiendo: ${labelOf(c)}`));
}

export interface SellOpts {
  vale?: boolean;
  customer?: string;
  /** true = se espera la hoja de AUTORIZACIÓN (sin existencia suficiente); false = confirmación normal. */
  authorize: boolean;
}
/** Venta con efectivo exacto. Devuelve el folio. */
export async function sellKg(page: Page, kg: string, opts: SellOpts): Promise<number> {
  await tab(page, 'caja');
  await page.getByTestId('kg').fill(kg);
  await page.getByTestId('exact').click();
  if (opts.vale) {
    await page.getByTestId('is-vale').check();
    if (opts.customer) await page.getByTestId('customer').fill(opts.customer);
  }
  await page.getByTestId('confirm').click();
  await expect(page.getByTestId('confirm-sheet')).toBeVisible();
  if (opts.authorize) {
    await expect(page.getByTestId('stock-warning'), 'debe avisar que no hay existencia suficiente').toBeVisible();
    await expect(page.getByTestId('confirm-yes'), 'con existencia insuficiente NO debe haber confirmación normal').toHaveCount(0);
  } else {
    await expect(page.getByTestId('stock-warning'), 'con existencia suficiente no debe pedir autorización').toHaveCount(0);
    await expect(page.getByTestId('authorize')).toHaveCount(0);
  }
  const n = await toastCount(page);
  await page.getByTestId(opts.authorize ? 'authorize' : 'confirm-yes').click();
  const text = await expectNewToast(page, n, /Venta #\d+ guardada/);
  return Number(text.match(/#(\d+)/)![1]);
}

// ---------------------------------------------------------------------------------------------------------------
// Vales, Corte, Más
// ---------------------------------------------------------------------------------------------------------------

export async function deliverVale(page: Page, valeFolio: number) {
  await tab(page, 'vales');
  await page.getByTestId('vales-pendiente').click();
  const card = page.getByTestId('vale').filter({ hasText: `Vale V-${valeFolio}` });
  const n = await toastCount(page);
  await card.getByTestId('deliver').click();
  await expectNewToast(page, n, `Vale V-${valeFolio} entregado`);
}

export async function cancelVale(page: Page, valeFolio: number, reason: string, refund: 'efectivo' | 'transferencia' | 'ninguna') {
  await tab(page, 'vales');
  await page.getByTestId('vales-pendiente').click();
  const card = page.getByTestId('vale').filter({ hasText: `Vale V-${valeFolio}` });
  await card.getByTestId('cancel-vale').click();
  await page.getByTestId('cancel-reason').fill(reason);
  await page.getByTestId(`refund-${refund}`).check();
  const n = await toastCount(page);
  await page.getByTestId('cancel-confirm').click();
  await expectNewToast(page, n, `Vale V-${valeFolio} cancelado`);
}

export interface AuditView {
  text: string;
  ok: boolean;
  warnings: string;
}
/** Más → «Auditar integridad». */
export async function runAudit(page: Page): Promise<AuditView> {
  await tab(page, 'mas');
  await page.getByTestId('audit').click();
  const box = page.getByTestId('audit-result');
  await expect(box).toBeVisible();
  const text = norm(await box.innerText());
  const warn = page.getByTestId('audit-warnings');
  return { text, ok: text.includes('Sin inconsistencias'), warnings: (await warn.count()) ? norm(await warn.innerText()) : '' };
}

// ---------------------------------------------------------------------------------------------------------------
// Pantalla (copiado de teclado.spec.ts: no se importa porque ese archivo es de otro autor)
// ---------------------------------------------------------------------------------------------------------------

/** Elementos que se salen de la pantalla a lo ancho (vacío = sin desbordamiento horizontal). */
export async function overflowing(page: Page): Promise<string[]> {
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

// ---------------------------------------------------------------------------------------------------------------
// Toques y teclado emulado (copiado de teclado.spec.ts: ese archivo es de otro autor y no se importa)
// ---------------------------------------------------------------------------------------------------------------

export interface Phone {
  name: string;
  width: number;
  height: number;
  /** Alto que se «come» el teclado (aprox. de un teclado de Android). */
  keyboardPx: number;
}
export const PHONES: Phone[] = [
  { name: '360×640', width: 360, height: 640, keyboardPx: 300 },
  { name: '412×915', width: 412, height: 915, keyboardPx: 340 },
];

/**
 * El teclado del teléfono se EMULA encogiendo la ventana (como Android con `interactive-widget=resizes-content`). No es lo
 * mismo que un teléfono real: la prueba física en Android sigue pendiente (docs/PRUEBAS.md).
 */
export const showKeyboard = (page: Page, phone: Phone) => page.setViewportSize({ width: phone.width, height: phone.height - phone.keyboardPx });
export const hideKeyboard = (page: Page, phone: Phone) => page.setViewportSize({ width: phone.width, height: phone.height });

interface TapRecord {
  testid: string | null;
  down: number[];
  up: number[];
  onButton: boolean;
}

/** Registra, para cada toque, dónde estaba el botón al empezar y al terminar, y si el click le llegó a él. */
export async function watchTaps(page: Page) {
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

/**
 * El botón recibió el click y NO se movió entre el inicio y el final del toque. Se revisa ANTES que el efecto del toque
 * (aviso, hoja...) para que, si el toque se pierde, el mensaje diga la causa real. `testid` null = botón sin data-testid (chips).
 */
export async function expectSolidTap(page: Page, testid: string | null) {
  await expect.poll(async () => (await taps(page)).length, { message: 'el toque no produjo ningún click' }).toBeGreaterThan(0);
  const all = await taps(page);
  const tap = all[all.length - 1];
  expect(tap.testid).toBe(testid);
  expect(tap.onButton, 'el click cayó en otro elemento (el botón se movió bajo el dedo)').toBe(true);
  expect(tap.up, 'el botón cambió de lugar entre que se puso el dedo y se levantó').toEqual(tap.down);
}
