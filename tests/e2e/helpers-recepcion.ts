import { expect, type Locator, type Page } from '@playwright/test';
import { charge, tab } from './helpers';

/**
 * Ayudas de las pruebas E2E de RECEPCIÓN DE MERCANCÍA (tests/e2e/recepcion.spec.ts).
 * Solo se IMPORTA (lectura) ./helpers; nada de src/ se toca.
 */

// ─────────────────────────────── tipos mínimos de lo que se lee de IndexedDB ───────────────────────────────

export interface DbProduct {
  id: string;
  name: string;
  origin?: string;
  quality?: string;
  caliber?: string;
  unit: string;
  priceCents: number;
  physicalMilli: number;
  reservedMilli: number;
  active: boolean;
}
export interface DbCorrection {
  id: string;
  reason: string;
  previousNetMilli: number;
  newNetMilli: number;
  deltaMilli: number;
  stockMoveId: string;
}
export interface DbReception {
  id: string;
  folio?: number;
  status: 'borrador' | 'confirmada' | 'cancelada' | 'anulada';
  receivedAt: string;
  day: string;
  supplier?: string;
  reference?: string;
  notes?: string;
  productId?: string;
  productLabel?: string;
  packaging: 'granel' | 'caja' | 'arpilla';
  containers?: number;
  weightMode: 'directo' | 'por_envase' | 'bruto_tara';
  netDirectMilli?: number;
  weighingsMilli?: number[];
  unitNetMilli?: number;
  grossMilli?: number;
  tareMilli?: number;
  netMilli?: number;
  confirmedAt?: string;
  confirmedNetMilli?: number;
  stockMoveId?: string;
  corrections: DbCorrection[];
  dataEdits?: Array<{ reason: string; changes: Array<{ field: string; before?: string | number; after?: string | number }> }>;
  acknowledged?: Array<{ op: string; warnings: string[] }>;
  cancelledAt?: string;
  cancelReason?: string;
  voidedAt?: string;
  voidReason?: string;
  voidStockMoveId?: string;
}
export interface DbMove {
  id: string;
  productId: string;
  type: string;
  deltaMilli: number;
  reservedDeltaMilli: number;
  note: string;
  createdAt: string;
  receptionId?: string;
  saleId?: string;
  authorizedNegativeAfterMilli?: number;
}
export interface DbSale {
  id: string;
  folio: number;
  totalCents: number;
  status: string;
  delivery: string;
  valeFolio?: number;
  items: Array<{ productId: string; qtyMilli: number }>;
}
export interface Dump {
  products: DbProduct[];
  receptions: DbReception[];
  stockMoves: DbMove[];
  sales: DbSale[];
  shifts: unknown[];
  cashMovements: unknown[];
  meta: Array<{ key: string; value: unknown }>;
}

/**
 * Lee TODAS las tablas de la base real de la página (solo lectura). Sirve para comprobar el efecto exacto en milésimas de kilo
 * y los vínculos entre documentos, sin fiarse de lo que la pantalla redondee o resuma.
 * Nunca abre la base si la app todavía no la creó (abrirla vacía crearía una versión 1 sin tablas).
 */
export async function readDb(page: Page): Promise<Dump> {
  return page.evaluate(async () => {
    const empty = { products: [], receptions: [], stockMoves: [], sales: [], shifts: [], cashMovements: [], meta: [] };
    const known = await indexedDB.databases();
    if (!known.some((d) => d.name === 'venta-limones')) return empty as never;
    return new Promise<never>((resolve, reject) => {
      const open = indexedDB.open('venta-limones');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const names = Array.from(db.objectStoreNames);
        const out: Record<string, unknown[]> = { ...empty };
        const tx = db.transaction(names, 'readonly');
        for (const n of names) {
          const r = tx.objectStore(n).getAll();
          r.onsuccess = () => {
            out[n] = r.result;
          };
        }
        tx.oncomplete = () => {
          db.close();
          resolve(out as never);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  });
}

export const labelOf = (p: Pick<DbProduct, 'name' | 'origin' | 'quality' | 'caliber'>) =>
  [p.name, p.origin, p.quality, p.caliber].filter(Boolean).join(' · ');

/** Las tres clasificaciones de prueba (las que da de alta openApp). */
export type Which = 'semilla' | 'primera' | 'segunda';
export const LABEL: Record<Which, string> = {
  semilla: 'Con semilla',
  primera: 'Limón persa · Primera',
  segunda: 'Limón persa · Segunda',
};
export const productOf = (d: Dump, w: Which): DbProduct => {
  const p = d.products.find((x) => labelOf(x) === LABEL[w]);
  if (!p) throw new Error(`No existe la clasificación «${LABEL[w]}» en la base`);
  return p;
};
export const physicalOf = (d: Dump, w: Which) => productOf(d, w).physicalMilli;
export const reservedOf = (d: Dump, w: Which) => productOf(d, w).reservedMilli;
export const movesOf = (d: Dump, w: Which, type?: string) =>
  d.stockMoves.filter((m) => m.productId === productOf(d, w).id && (!type || m.type === type));
/** Movimientos en orden cronológico (getAll() los devuelve por id, no por hora). Empata por el orden lógico de la operación. */
const MOVE_RANK: Record<string, number> = { recepcion: 0, correccion_recepcion: 1, reversa_recepcion: 2, venta: 3, reserva: 3, entrega_vale: 4 };
export const orderedMoves = (d: Dump, w?: Which): DbMove[] =>
  d.stockMoves
    .filter((m) => !w || m.productId === productOf(d, w).id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (MOVE_RANK[a.type] ?? 9) - (MOVE_RANK[b.type] ?? 9));
export const byStatus = (d: Dump, status: DbReception['status']) => d.receptions.filter((r) => r.status === status);
export const nextReceptionFolio = (d: Dump): number => {
  const v = d.meta.find((m) => m.key === 'nextReceptionFolio')?.value;
  return typeof v === 'number' ? v : 1;
};

const RECEPTION_MOVES = ['recepcion', 'correccion_recepcion', 'reversa_recepcion'];

/**
 * Auditoría INDEPENDIENTE de la que trae la app (no la reutiliza): reconstruye desde los registros crudos que el saldo de cada
 * clasificación es la suma de sus movimientos y que cada recepción tiene exactamente los movimientos que le tocan.
 * Devuelve la lista de problemas (vacía = todo cuadra).
 */
export function auditRaw(d: Dump): string[] {
  const bad: string[] = [];
  for (const p of d.products) {
    const mv = d.stockMoves.filter((m) => m.productId === p.id);
    const phys = mv.reduce((s, m) => s + m.deltaMilli, 0);
    const res = mv.reduce((s, m) => s + m.reservedDeltaMilli, 0);
    if (phys !== p.physicalMilli) bad.push(`${labelOf(p)}: físico ${p.physicalMilli} ≠ Σ movimientos ${phys}`);
    if (res !== p.reservedMilli) bad.push(`${labelOf(p)}: reservado ${p.reservedMilli} ≠ Σ movimientos ${res}`);
  }
  const folios = new Set<number>();
  const next = nextReceptionFolio(d);
  for (const r of d.receptions) {
    const tag = `Recepción ${r.folio !== undefined ? `R-${r.folio}` : r.id.slice(0, 8)} (${r.status})`;
    const mv = d.stockMoves.filter((m) => m.receptionId === r.id);
    const of = (t: string) => mv.filter((m) => m.type === t);
    if (r.status === 'borrador' || r.status === 'cancelada') {
      if (r.folio !== undefined) bad.push(`${tag}: no debería tener folio`);
      if (mv.length) bad.push(`${tag}: no debería tener movimientos (${mv.length})`);
      continue;
    }
    if (r.folio === undefined) bad.push(`${tag}: sin folio`);
    else {
      if (folios.has(r.folio)) bad.push(`${tag}: folio repetido`);
      folios.add(r.folio);
      if (r.folio >= next) bad.push(`${tag}: folio ≥ siguiente folio (${next})`);
    }
    const entry = of('recepcion');
    if (entry.length !== 1) bad.push(`${tag}: ${entry.length} movimientos de recepción (debe ser 1)`);
    else if (entry[0].deltaMilli !== r.confirmedNetMilli) bad.push(`${tag}: movimiento ${entry[0].deltaMilli} ≠ confirmados ${r.confirmedNetMilli}`);
    if (of('correccion_recepcion').length !== r.corrections.length) bad.push(`${tag}: correcciones y movimientos no coinciden`);
    const current = (r.confirmedNetMilli ?? 0) + r.corrections.reduce((s, c) => s + c.deltaMilli, 0);
    if (r.status === 'confirmada') {
      if (r.netMilli !== current) bad.push(`${tag}: vigentes ${r.netMilli} ≠ original + correcciones ${current}`);
      if (of('reversa_recepcion').length) bad.push(`${tag}: confirmada con reversa`);
    } else {
      const rev = of('reversa_recepcion');
      if (rev.length !== 1 || rev[0].deltaMilli !== -current) bad.push(`${tag}: la reversa no revierte exactamente ${current}`);
      if (r.netMilli !== 0) bad.push(`${tag}: anulada con kilos vigentes ${r.netMilli}`);
    }
  }
  for (const m of d.stockMoves) {
    if (RECEPTION_MOVES.includes(m.type) && !d.receptions.some((r) => r.id === m.receptionId)) {
      bad.push(`Movimiento ${m.type} (${m.note}) apunta a una recepción que no existe`);
    }
  }
  return bad;
}

/** Nada cambió: ni documentos ni movimientos ni existencias (para los caminos negativos). */
export async function expectNothingChanged(page: Page, why: string) {
  const d = await readDb(page);
  expect(d.receptions, `${why}: no debe existir ninguna recepción`).toHaveLength(0);
  expect(d.stockMoves, `${why}: no debe existir ningún movimiento`).toHaveLength(0);
  expect(
    d.products.map((p) => p.physicalMilli),
    `${why}: las existencias no cambian`,
  ).toEqual(d.products.map(() => 0));
}

// ─────────────────────────────── navegación y captura ───────────────────────────────

export const toast = (page: Page) => page.getByTestId('toast');

/** Entra a Recepción › Nueva. */
export async function goReceive(page: Page) {
  await tab(page, 'recepcion');
  await page.getByTestId('rec-sub-nueva').click();
  await expect(page.getByTestId('rec-nueva')).toBeVisible();
}

export async function subTab(page: Page, sub: 'nueva' | 'borradores' | 'historial' | 'resumen') {
  await tab(page, 'recepcion');
  await page.getByTestId(`rec-sub-${sub}`).click();
  const area = { nueva: 'rec-nueva', borradores: 'rec-borradores', historial: 'rec-historial', resumen: 'rec-resumen' }[sub];
  await expect(page.getByTestId(area)).toBeVisible();
}

/** Elige la clasificación a recibir tocando los chips (la variedad con varias clasificaciones pide además la clasificación). */
export async function pick(page: Page, which: Which) {
  if (which === 'semilla') {
    await page.getByTestId('rec-variety').filter({ hasText: 'Con semilla' }).click();
  } else {
    await page.getByTestId('rec-variety').filter({ hasText: 'Limón persa' }).click();
    await page.getByTestId('rec-class').filter({ hasText: which === 'primera' ? 'Primera' : 'Segunda' }).click();
  }
  await expect(page.getByTestId('rec-selected')).toContainText(LABEL[which]);
}

export async function setPackaging(page: Page, pk: 'granel' | 'caja' | 'arpilla') {
  await page.getByTestId(`rec-pack-${pk}`).click();
  await expect(page.getByTestId(`rec-pack-${pk}`)).toHaveAttribute('aria-checked', 'true');
}

export async function setMode(page: Page, mode: 'directo' | 'por_envase' | 'bruto_tara') {
  await page.getByTestId(`rec-mode-${mode}`).click();
  await expect(page.getByTestId(`rec-mode-${mode}`)).toHaveAttribute('aria-checked', 'true');
}

/** Granel (o cualquier presentación en modo directo): escribe los kilos netos. */
export async function typeNet(page: Page, kg: string) {
  await page.getByTestId('rec-net-direct').fill(kg);
}

/** Cajas o arpillas × kilos netos por envase (la presentación elige este modo sola). */
export async function typeContainers(page: Page, containers: string, unitKg: string) {
  await page.getByTestId('rec-containers').fill(containers);
  await page.getByTestId('rec-unit-net').fill(unitKg);
}

export async function typeLot(page: Page, lot: { supplier?: string; reference?: string; notes?: string }) {
  if (lot.supplier !== undefined) await page.getByTestId('rec-supplier').fill(lot.supplier);
  if (lot.reference !== undefined) await page.getByTestId('rec-reference').fill(lot.reference);
  if (lot.notes !== undefined) await page.getByTestId('rec-notes').fill(lot.notes);
}

/** Lo que muestra la barra de registro: kilos netos y su texto de ayuda. */
export async function expectNet(page: Page, milli: number, text: string) {
  await expect(page.getByTestId('rec-net')).toHaveAttribute('data-milli', String(milli));
  await expect(page.getByTestId('rec-net')).toHaveText(text);
}

export const confirmDisabled = (page: Page, disabled: boolean) =>
  expect(page.getByTestId('rec-confirm')).toHaveAttribute('aria-disabled', String(disabled));

/**
 * Toca «Registrar recepción» CUANDO está aria-disabled (faltan datos). La app lo diseñó así a propósito: el botón nunca queda
 * «muerto», explica qué falta. Playwright trata aria-disabled como «no habilitado» y no hace clic sin `force`, que aquí solo
 * se salta ESA comprobación (el toque sí cae en el botón, en su centro).
 */
export const tapDisabledConfirm = (page: Page) => page.getByTestId('rec-confirm').click({ force: true });

/**
 * Toca «Registrar recepción», comprueba que se abre la hoja de confirmación (todavía nada registrado) y confirma.
 * `ack` = hay avisos que reconocer: el botón es «Registrar de todos modos».
 */
export async function register(page: Page, expectedToast: string | RegExp, opts: { ack?: boolean } = {}) {
  await page.getByTestId('rec-confirm').click();
  await expect(page.getByTestId('rec-sheet')).toBeVisible();
  await page.getByTestId(opts.ack ? 'rec-dup-ack' : 'rec-confirm-yes').click();
  await expect(toast(page)).toContainText(expectedToast);
  await expect(page.getByTestId('rec-sheet')).toBeHidden();
}

/** Captura y registra de un tirón (sin avisos esperados). */
export async function receive(
  page: Page,
  which: Which,
  kg: string,
  expectedToast: string | RegExp,
  lot: { supplier?: string; reference?: string; notes?: string } = {},
) {
  await goReceive(page);
  await pick(page, which);
  await setPackaging(page, 'granel'); // la presentación elegida antes se recuerda: aquí siempre es granel
  await typeNet(page, kg);
  await typeLot(page, lot);
  await register(page, expectedToast);
}

/** El formulario de «Nueva» quedó limpio, listo para otra recepción. */
export async function expectFormClean(page: Page) {
  await expect(page.getByTestId('rec-selected')).toHaveCount(0);
  await expect(page.getByTestId('rec-supplier')).toHaveValue('');
  await expect(page.getByTestId('rec-reference')).toHaveValue('');
  await expect(page.getByTestId('rec-notes')).toHaveValue('');
  await expect(page.getByTestId('rec-net')).toHaveAttribute('data-milli', '');
  await expect(page.getByTestId('rec-net')).toHaveText('—');
  await confirmDisabled(page, true);
}

// ─────────────────────────────── existencias en pantalla ───────────────────────────────

export const invRow = (page: Page, which: Which) => page.getByTestId('inv-row').filter({ hasText: LABEL[which] });

/** Abre Inventario y compara lo que SE VE (físico / reservado / disponible y acumulados). */
export async function expectStock(
  page: Page,
  which: Which,
  s: { physical?: string; reserved?: string; available?: string; received?: string; sold?: string },
) {
  await tab(page, 'inventario');
  const row = invRow(page, which);
  await expect(row).toHaveCount(1);
  if (s.physical !== undefined) await expect(row.getByTestId('stock-physical')).toHaveText(s.physical);
  if (s.reserved !== undefined) await expect(row.getByTestId('stock-reserved')).toHaveText(s.reserved);
  if (s.available !== undefined) await expect(row.getByTestId('stock-available')).toHaveText(s.available);
  if (s.received !== undefined) await expect(row.getByTestId('stock-recibido')).toHaveText(s.received);
  if (s.sold !== undefined) await expect(row.getByTestId('stock-vendido')).toHaveText(s.sold);
}

// ─────────────────────────────── ventas (integración) ───────────────────────────────

/** Venta de contado de la clasificación que la caja trae elegida (Limón persa · Primera, $30/kg) pagada exacta. */
export async function sellExact(page: Page, kg: string) {
  await tab(page, 'caja');
  await page.getByTestId('kg').fill(kg);
  await page.getByTestId('exact').click();
  await charge(page);
}

export async function sellVale(page: Page, kg: string, customer: string) {
  await tab(page, 'caja');
  await page.getByTestId('kg').fill(kg);
  await page.getByTestId('exact').click();
  await page.getByTestId('is-vale').check();
  await page.getByTestId('customer').fill(customer);
  await charge(page);
}

// ─────────────────────────────── fechas en la hora del navegador (CDMX) ───────────────────────────────

/** Valor de un <input type="datetime-local"> para «ahora + offsetMs», en la zona horaria del navegador. */
export const localInput = (page: Page, offsetMs = 0): Promise<string> =>
  page.evaluate((off) => {
    const d = new Date(Date.now() + off);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }, offsetMs);

/** Día local YYYY-MM-DD de «ahora + offsetMs» en el navegador. */
export const localDayOf = (page: Page, offsetMs = 0): Promise<string> => localInput(page, offsetMs).then((s) => s.slice(0, 10));

// ─────────────────────────────── captura en curso guardada sola ───────────────────────────────

export const FORM_KEY = 'limones.rec.form.v1';

/** Espera a que la captura en curso se haya guardado sola (el guardado se retrasa ~300 ms) y la devuelve. */
export async function autosaved(page: Page): Promise<Record<string, unknown>> {
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), FORM_KEY), { message: 'la captura en curso debería guardarse sola' })
    .not.toBeNull();
  return JSON.parse((await page.evaluate((k) => localStorage.getItem(k), FORM_KEY))!);
}

// ─────────────────────────────── toques, teclado emulado y desbordamiento (copiados de teclado.spec.ts) ───────────────────────────────

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

export interface TapRecord {
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
/** El último click registrado por watchTaps (para probar que un toque SE PIERDE cuando debe perderse). */
export async function lastTap(page: Page): Promise<TapRecord> {
  await expect.poll(async () => (await taps(page)).length, { message: 'el toque no produjo ningún click' }).toBeGreaterThan(0);
  const all = await taps(page);
  return all[all.length - 1];
}

/**
 * El botón recibió el click y NO se movió entre el inicio y el final del toque. Se revisa ANTES que el efecto del toque
 * (aviso, hoja...) para que, si el toque se pierde, el mensaje diga la causa real.
 */
export async function expectSolidTap(page: Page, testid: string) {
  await expect.poll(async () => (await taps(page)).length, { message: 'el toque no produjo ningún click' }).toBeGreaterThan(0);
  const all = await taps(page);
  const tap = all[all.length - 1];
  expect(tap.testid).toBe(testid);
  expect(tap.onButton, 'el click cayó en otro elemento (el botón se movió bajo el dedo)').toBe(true);
  expect(tap.up, 'el botón cambió de lugar entre que se puso el dedo y se levantó').toEqual(tap.down);
}

export const html = (page: Page) => page.locator('html');
export async function showKeyboard(page: Page, phone: Phone) {
  await page.setViewportSize({ width: phone.width, height: phone.height - phone.keyboardPx });
}
export async function hideKeyboard(page: Page, phone: Phone) {
  await page.setViewportSize({ width: phone.width, height: phone.height });
}
export const rectOf = (l: Locator) =>
  l.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width };
  });
export const innerHeight = (page: Page) => page.evaluate(() => window.innerHeight);

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

/** Pestañas de abajo: todas visibles, con la etiqueta completa y de tamaño tocable. */
export async function expectTabsIntact(page: Page) {
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
 * Doble toque HUMANO en unas coordenadas fijas de la pantalla: dos toques separados por ~150 ms (lo normal al doble-tocar),
 * sin mirar qué hay debajo (una persona no sabe que apareció una hoja). `locator.tap()` no sirve: espera a que el elemento
 * reciba el toque y se negaría a tocar donde ya hay una hoja encima. Después deja un margen para que se note cualquier efecto.
 */
export async function doubleTapAt(page: Page, x: number, y: number, gapMs = 150) {
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(gapMs); // justificado: es EL intervalo del doble toque que se está simulando
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(500); // justificado: margen para detectar un efecto tardío del segundo toque (no hay evento que esperar)
}

/** Centro del elemento en coordenadas de pantalla. */
export async function centerOf(l: Locator): Promise<{ x: number; y: number }> {
  const b = await l.boundingBox();
  if (!b) throw new Error('El elemento no está visible');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
