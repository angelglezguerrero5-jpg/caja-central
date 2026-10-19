import { expect, type BrowserContext, type Locator, type Page, type Request as PwRequest, type Route } from '@playwright/test';
import type { Backup, CashMovement, Classification, LegacyBackup, PaymentMethod, Product, Reception, RefundMethod, Sale, Shift, StockMove } from '../../src/domain/types';
import { tab } from './helpers';

/**
 * Ayudas de android.spec.ts (pantallas Android 360×640 y 412×915 + sin conexión simulada).
 *
 * Cuatro bloques:
 *  1. Teléfonos y teclado emulado (la ventana se encoge, como hace Android con `interactive-widget=resizes-content`).
 *  2. «Mercado»: una base realista y CONSISTENTE (el libro de movimientos cuadra con las existencias) que se carga por la
 *     propia interfaz (Más → Restaurar). Así las pantallas se prueban POBLADAS sin teclear cientos de datos.
 *  3. Lectura cruda de IndexedDB (solo lectura) y chequeo independiente de invariantes.
 *  4. Barridos de diseño y accesibilidad que se ejecutan dentro de la página.
 *
 * Nada de esto toca src/. Las únicas dependencias de la app son TIPOS (se borran al compilar) y los data-testid.
 */

// =====================================================================================================================
// 1. Teléfonos y teclado
// =====================================================================================================================

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

export const html = (page: Page) => page.locator('html');
export const showKeyboard = (page: Page, phone: Phone) => page.setViewportSize({ width: phone.width, height: phone.height - phone.keyboardPx });
export const hideKeyboard = (page: Page, phone: Phone) => page.setViewportSize({ width: phone.width, height: phone.height });

export const rectOf = (l: Locator) =>
  l.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width };
  });
export const innerHeight = (page: Page) => page.evaluate(() => window.innerHeight);

// ---- Toques: dónde estaba el botón al poner y al levantar el dedo (copiado de teclado.spec.ts, solo lectura) ----

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

/**
 * El botón recibió el click y NO se movió entre el inicio y el final del toque. Se revisa ANTES que el efecto del toque
 * (toast, hoja...) para que, si el toque se pierde, el mensaje diga la causa real y no solo «no apareció el aviso».
 */
export async function expectSolidTap(page: Page, testid: string) {
  await expect.poll(async () => (await taps(page)).length, { message: `el toque en «${testid}» no produjo ningún click` }).toBeGreaterThan(0);
  const all = await taps(page);
  const tap = all[all.length - 1];
  expect(tap.testid).toBe(testid);
  expect(tap.onButton, `el click cayó en otro elemento (el botón «${testid}» se movió bajo el dedo)`).toBe(true);
  expect(tap.up, `el botón «${testid}» cambió de lugar entre que se puso el dedo y se levantó`).toEqual(tap.down);
}

// =====================================================================================================================
// 2. Datos de mercado
// =====================================================================================================================

const MX = 'America/Mexico_City';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: MX, year: 'numeric', month: '2-digit', day: '2-digit' });
/** Día local de Ciudad de México (YYYY-MM-DD). México ya no usa horario de verano: el desfase es siempre UTC−6. */
export const mxDay = (d: Date): string => dayFmt.format(d);

/** Sábado 10 de octubre de 2026, 14:00 en la Central de Abasto. Se fija en la página para que los datos no dependan de la hora. */
export const FIXED_NOW = new Date('2026-10-10T20:00:00.000Z');

type Pack = 'granel' | 'caja' | 'arpilla';
type Mode = 'directo' | 'por_envase' | 'bruto_tara';

interface CatalogEntry {
  key: string;
  name: string;
  origin?: string;
  quality?: string;
  caliber?: string;
  unit?: Product['unit'];
  priceCents: number;
  active?: boolean;
}

/**
 * Catálogo del mercado. «Con semilla» tiene 7 clasificaciones (> 6: la caja y la recepción muestran «Ver las N
 * clasificaciones»); «Sin semilla» tiene 6 activas (+1 oculta) y mezcla unidades; hay una con nombre larguísimo (cada texto
 * dentro del tope de 40 caracteres), una sin precio, una por pieza.
 */
export const CATALOG: CatalogEntry[] = [
  { key: 'sin-1ra-2x', name: 'Sin semilla', quality: 'Primera', caliber: '2X', priceCents: 3200 },
  { key: 'sin-2da-3x', name: 'Sin semilla', quality: 'Segunda', caliber: '3X', priceCents: 2400 },
  { key: 'sin-3ra', name: 'Sin semilla', quality: 'Tercera', priceCents: 1550 },
  { key: 'sin', name: 'Sin semilla', priceCents: 2800 },
  { key: 'sin-caja', name: 'Sin semilla', unit: 'caja', priceCents: 45000 },
  { key: 'sin-1x-sin-precio', name: 'Sin semilla', quality: 'Primera', caliber: '1X', priceCents: 0 },
  { key: 'sin-4ta-oculta', name: 'Sin semilla', quality: 'Cuarta', priceCents: 1000, active: false },
  { key: 'oax-1ra-300', name: 'Con semilla', origin: 'Oaxaca', quality: 'Primera', caliber: '300', priceCents: 3000 },
  { key: 'oax-2da-400', name: 'Con semilla', origin: 'Oaxaca', quality: 'Segunda', caliber: '400', priceCents: 2200 },
  { key: 'oax-3ra-500', name: 'Con semilla', origin: 'Oaxaca', quality: 'Tercera', caliber: '500', priceCents: 1400 },
  { key: 'mich-1ra-200', name: 'Con semilla', origin: 'Michoacán', quality: 'Primera', caliber: '200', priceCents: 3400 },
  { key: 'mich-2da-300', name: 'Con semilla', origin: 'Michoacán', quality: 'Segunda', caliber: '300', priceCents: 2500 },
  { key: 'mich-3ra-400', name: 'Con semilla', origin: 'Michoacán', quality: 'Tercera', caliber: '400', priceCents: 1600 },
  { key: 'mich-1ra-500', name: 'Con semilla', origin: 'Michoacán', quality: 'Primera', caliber: '500', priceCents: 1800 },
  {
    key: 'largo',
    name: 'Limón criollo de exportación selecta',
    origin: 'Michoacán, región Tierra Caliente',
    quality: 'Primera especial de selección extra',
    caliber: 'Calibre grande 150 a 180 piezas',
    priceCents: 4125,
  },
  { key: 'pieza', name: 'Limón en bolsa', unit: 'pieza', priceCents: 500 },
];

const SUPPLIERS = ['Rancho Los Limones', 'Huerta San Miguel', 'Agrícola del Valle', 'Cooperativa Tierra Caliente', 'Don Pepe', 'Limones de Apatzingán'];
export const LONG_CUSTOMER = 'Distribuidora de frutas y verduras La Central de Abasto, Nave H bodega 245, a nombre del Sr. Ramírez Hernández';

export interface MarketOptions {
  /** «Ahora» del mercado. Por omisión FIXED_NOW (hay que fijar el mismo instante en la página). */
  now?: Date;
  /** Recepciones registradas de relleno (además de los escenarios fijos). */
  confirmedReceptions?: number;
  /** Ventas del turno abierto. */
  sales?: number;
}

export interface Market {
  backup: LegacyBackup;
  now: Date;
  /** Producto por su clave del catálogo. */
  product(key: string): Product;
  /** Etiqueta como la muestra la app: «Variedad · Origen · Calidad · Calibre». */
  label(key: string): string;
  facts: {
    receptionsConfirmed: number;
    receptionsVoided: number;
    receptionsCorrected: number;
    drafts: number;
    discarded: number;
    valesPending: number;
    valesDelivered: number;
    valesCancelled: number;
    /** Existencia final por producto (milésimas). */
    stock: (key: string) => { physical: number; reserved: number; available: number };
    /** Turno abierto (hoy): lo que debe mostrar el Corte. */
    openShift: {
      salesCount: number;
      totalCents: number;
      efectivoCents: number;
      openingCents: number;
      cashOutCents: number;
      refundsCents: number;
      expectedCents: number;
      lastFolio: number;
    };
    closedShift: { expectedCents: number; countedCents: number; differenceCents: number };
    /** Ventas del día de «ahora» (Más → Historial). */
    today: { sales: number; totalCents: number };
    nextFolio: number;
    nextValeFolio: number;
    nextReceptionFolio: number;
  };
}

const label = (p: { name: string; origin?: string; quality?: string; caliber?: string }) =>
  [p.name, p.origin, p.quality, p.caliber].filter(Boolean).join(' · ');

/**
 * Construye el mercado simulando las operaciones una por una (recepciones, correcciones, anulaciones, ventas, vales,
 * entregas, cancelaciones, mermas, conteos, turnos): cada existencia es la suma de sus movimientos y cada folio es único.
 * Los hechos de `facts` salen de este libro, NO de la app.
 */
export function buildMarket(opts: MarketOptions = {}): Market {
  const now = opts.now ?? FIXED_NOW;
  const nRec = opts.confirmedReceptions ?? 24;
  const nSales = opts.sales ?? 26;
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  const iso = (d: Date) => d.toISOString();
  const DAY = 1440;

  let seq = 0;
  const uid = (p: string) => `${p}-${String(++seq).padStart(5, '0')}`;

  const products: Product[] = CATALOG.map((c, i) => ({
    id: `prod-${String(i + 1).padStart(2, '0')}`,
    name: c.name,
    ...(c.quality ? { quality: c.quality } : {}),
    ...(c.origin ? { origin: c.origin } : {}),
    ...(c.caliber ? { caliber: c.caliber } : {}),
    unit: c.unit ?? 'kg',
    priceCents: c.priceCents,
    active: c.active ?? true,
    sort: i,
    physicalMilli: 0,
    reservedMilli: 0,
    updatedAt: iso(ago(8 * DAY)),
  }));
  const byKey = new Map(CATALOG.map((c, i) => [c.key, products[i]]));
  const P = (key: string): Product => {
    const p = byKey.get(key);
    if (!p) throw new Error(`producto de prueba desconocido: ${key}`);
    return p;
  };
  const prodById = (id: string): Product => products.find((p) => p.id === id)!;
  const clsOf = (p: Product): Classification => ({
    variety: p.name,
    ...(p.origin ? { origin: p.origin } : {}),
    ...(p.quality ? { quality: p.quality } : {}),
    ...(p.caliber ? { caliber: p.caliber } : {}),
  });
  const avail = (p: Product) => p.physicalMilli - p.reservedMilli;

  const moves: StockMove[] = [];
  const receptions: Reception[] = [];
  const sales: Sale[] = [];
  const shifts: Shift[] = [];
  const cash: CashMovement[] = [];
  let nextFolio = 1;
  let nextVale = 1;
  let nextRec = 1;

  function move(p: Product, type: StockMove['type'], delta: number, reserved: number, note: string, at: Date, extra: Partial<StockMove> = {}): StockMove {
    p.physicalMilli += delta;
    p.reservedMilli += reserved;
    p.updatedAt = iso(at);
    const m: StockMove = { id: uid('mv'), productId: p.id, createdAt: iso(at), type, deltaMilli: delta, reservedDeltaMilli: reserved, note, ...extra };
    moves.push(m);
    return m;
  }

  // ---- Recepciones
  interface RecIn {
    product?: Product;
    packaging: Pack;
    mode: Mode;
    minAgo: number;
    net?: number;
    weighings?: number[];
    containers?: number;
    unitNet?: number;
    gross?: number;
    tare?: number;
    supplier?: string;
    reference?: string;
    notes?: string;
  }
  const netOf = (r: RecIn): number | undefined => {
    if (r.mode === 'directo') return r.weighings ? r.weighings.reduce((a, b) => a + b, 0) : r.net;
    if (r.mode === 'por_envase') return r.containers !== undefined && r.unitNet !== undefined ? r.containers * r.unitNet : undefined;
    return r.gross !== undefined && r.tare !== undefined ? r.gross - r.tare : undefined;
  };
  /** Campos de captura según el modo (solo los del modo activo, como los guarda la app). */
  const captured = (r: RecIn, net: number | undefined) => ({
    ...(r.supplier ? { supplier: r.supplier } : {}),
    ...(r.reference ? { reference: r.reference } : {}),
    ...(r.notes ? { notes: r.notes } : {}),
    packaging: r.packaging,
    ...(r.containers !== undefined && r.packaging !== 'granel' ? { containers: r.containers } : {}),
    weightMode: r.mode,
    ...(r.mode === 'directo' && net !== undefined ? { netDirectMilli: net } : {}),
    ...(r.mode === 'directo' && r.weighings && r.weighings.length >= 2 ? { weighingsMilli: r.weighings } : {}),
    ...(r.mode === 'por_envase' && r.unitNet !== undefined ? { unitNetMilli: r.unitNet } : {}),
    ...(r.mode === 'bruto_tara' && r.gross !== undefined ? { grossMilli: r.gross } : {}),
    ...(r.mode === 'bruto_tara' && r.tare !== undefined ? { tareMilli: r.tare } : {}),
  });

  function receive(r: RecIn & { product: Product }): Reception {
    const net = netOf(r)!;
    const receivedAt = ago(r.minAgo);
    const confirmedAt = ago(Math.max(r.minAgo - 3, 1)); // se captura unos minutos después de que llega el camión
    const id = uid('rec');
    const folio = nextRec++;
    const mv = move(r.product, 'recepcion', net, 0, `Recepción R-${folio}`, confirmedAt, { id: `rcp:${id}:in`, receptionId: id });
    const rec: Reception = {
      id,
      folio,
      status: 'confirmada',
      createdAt: iso(confirmedAt),
      updatedAt: iso(confirmedAt),
      receivedAt: iso(receivedAt),
      day: mxDay(receivedAt),
      ...captured(r, net),
      productId: r.product.id,
      productLabel: label(r.product),
      cls: clsOf(r.product),
      netMilli: net,
      confirmedAt: iso(confirmedAt),
      confirmedNetMilli: net,
      stockMoveId: mv.id,
      corrections: [],
    };
    receptions.push(rec);
    return rec;
  }

  function correct(rec: Reception, newNet: number, reason: string, minAgo: number) {
    const at = ago(minAgo);
    const prev = rec.netMilli!;
    const mv = move(prodById(rec.productId!), 'correccion_recepcion', newNet - prev, 0, `Corrección R-${rec.folio}: ${reason}`, at, {
      id: `rcp:${rec.id}:c${rec.corrections.length + 1}`,
      receptionId: rec.id,
    });
    rec.corrections.push({ id: uid('cor'), at: iso(at), reason, previousNetMilli: prev, newNetMilli: newNet, deltaMilli: newNet - prev, stockMoveId: mv.id });
    rec.netMilli = newNet;
    rec.updatedAt = iso(at);
  }

  function voidRec(rec: Reception, reason: string, minAgo: number) {
    const at = ago(minAgo);
    const cur = rec.netMilli!;
    const mv = move(prodById(rec.productId!), 'reversa_recepcion', -cur, 0, `Anula R-${rec.folio}: ${reason}`, at, {
      id: `rcp:${rec.id}:void`,
      receptionId: rec.id,
    });
    rec.status = 'anulada';
    rec.netMilli = 0;
    rec.updatedAt = iso(at);
    rec.voidedAt = iso(at);
    rec.voidReason = reason;
    rec.voidStockMoveId = mv.id;
  }

  function draft(r: RecIn, status: 'borrador' | 'cancelada' = 'borrador', reason = ''): Reception {
    const net = netOf(r);
    const at = ago(r.minAgo);
    const rec: Reception = {
      id: uid('rec'),
      status,
      createdAt: iso(at),
      updatedAt: iso(at),
      receivedAt: iso(at),
      day: mxDay(at),
      ...captured(r, net),
      ...(r.product ? { productId: r.product.id } : {}),
      ...(net !== undefined ? { netMilli: net } : {}),
      corrections: [],
      ...(status === 'cancelada' ? { cancelledAt: iso(at), ...(reason ? { cancelReason: reason } : {}) } : {}),
    };
    receptions.push(rec);
    return rec;
  }

  // ---- Turnos, ventas y vales
  function openShift(openedMin: number, opening: number, closedMin?: number): Shift {
    const s: Shift = { id: uid('shift'), openedAt: iso(ago(openedMin)), openingCashCents: opening, ...(closedMin !== undefined ? { closedAt: iso(ago(closedMin)) } : {}) };
    shifts.push(s);
    return s;
  }
  function cashOut(sh: Shift, amount: number, concept: string, minAgo: number) {
    cash.push({ id: uid('cash'), shiftId: sh.id, createdAt: iso(ago(minAgo)), type: 'salida', amountCents: amount, concept });
  }

  interface SaleIn {
    method?: PaymentMethod;
    vale?: boolean;
    customer?: string;
    exact?: boolean;
    override?: boolean;
  }
  function sell(p: Product, qty: number, minAgo: number, sh: Shift, o: SaleIn = {}): Sale {
    const at = ago(minAgo);
    const total = Math.round((p.priceCents * qty) / 1000);
    const method = o.method ?? 'efectivo';
    const received = method === 'efectivo' ? (o.exact ? total : Math.ceil(total / 5000) * 5000) : total;
    const folio = nextFolio++;
    const valeFolio = o.vale ? nextVale++ : undefined;
    const id = uid('sale');
    const sale: Sale = {
      id,
      folio,
      createdAt: iso(at),
      day: mxDay(at),
      shiftId: sh.id,
      items: [{ productId: p.id, name: label(p), unit: p.unit, qtyMilli: qty, unitPriceCents: p.priceCents, totalCents: total, cls: clsOf(p) }],
      totalCents: total,
      paymentMethod: method,
      receivedCents: received,
      changeCents: method === 'efectivo' ? received - total : 0,
      status: 'completada',
      delivery: o.vale ? 'pendiente' : 'inmediata',
      ...(valeFolio !== undefined ? { valeFolio } : {}),
      ...(o.customer ? { customerName: o.customer } : {}),
      ...(o.override ? { stockOverride: true } : {}),
    };
    sales.push(sale);
    if (o.vale) move(p, 'reserva', 0, qty, `Vale V-${valeFolio}`, at, { saleId: id });
    else move(p, 'venta', -qty, 0, `Folio ${folio}`, at, { saleId: id, ...(o.override ? { authorizedNegativeAfterMilli: avail(p) - qty } : {}) });
    return sale;
  }
  function deliver(s: Sale, minAgo: number) {
    const at = ago(minAgo);
    s.delivery = 'entregado';
    s.deliveredAt = iso(at);
    for (const it of s.items) move(prodById(it.productId), 'entrega_vale', -it.qtyMilli, -it.qtyMilli, `Vale V-${s.valeFolio}`, at, { saleId: s.id });
  }
  function cancelVale(s: Sale, reason: string, refund: RefundMethod, minAgo: number, sh: Shift) {
    const at = ago(minAgo);
    s.delivery = 'cancelado';
    s.cancelReason = reason;
    s.cancelledAt = iso(at);
    s.refundMethod = refund;
    s.refundCents = refund === 'ninguna' ? 0 : s.totalCents;
    for (const it of s.items) move(prodById(it.productId), 'anulacion', 0, -it.qtyMilli, `Cancela V-${s.valeFolio}`, at, { saleId: s.id });
    if (refund === 'efectivo') {
      cash.push({ id: uid('cash'), shiftId: sh.id, createdAt: iso(at), type: 'devolucion', amountCents: s.totalCents, concept: `Devolución vale V-${s.valeFolio}`, saleId: s.id });
    }
  }
  function voidSale(s: Sale, reason: string, minAgo: number) {
    const at = ago(minAgo);
    s.status = 'anulada';
    s.voidReason = reason;
    s.voidedAt = iso(at);
    for (const it of s.items) move(prodById(it.productId), 'anulacion', it.qtyMilli, 0, `Anula ${s.folio}`, at, { saleId: s.id });
  }

  // ===================================================================================================================
  // La historia del mercado (de lo más viejo a lo más nuevo)
  // ===================================================================================================================

  // Inventario inicial de lo que NO llega por recepción (cajas y bolsas se manejan con entradas manuales en su unidad).
  move(P('sin-caja'), 'entrada', 120_000, 0, 'Inventario inicial', ago(8 * DAY));
  move(P('pieza'), 'entrada', 5_000_000, 0, 'Inventario inicial', ago(8 * DAY));
  move(P('sin-1x-sin-precio'), 'entrada', 30_000, 0, 'Existencia inicial', ago(8 * DAY));

  // Recepciones de relleno, repartidas en seis días: granel/cajas/arpillas y los tres modos de peso.
  const stocked = ['sin-1ra-2x', 'sin-2da-3x', 'sin-3ra', 'sin', 'oax-1ra-300', 'oax-2da-400', 'oax-3ra-500', 'mich-1ra-200', 'mich-2da-300', 'mich-3ra-400', 'mich-1ra-500', 'largo'];
  const step = Math.max(Math.floor((6 * DAY - 100) / Math.max(nRec, 1)), 20);
  const filler: Reception[] = [];
  for (let i = 0; i < nRec; i++) {
    const product = P(stocked[i % stocked.length]);
    const minAgo = 40 + (nRec - 1 - i) * step; // la i más grande es la más reciente
    const supplier = SUPPLIERS[i % SUPPLIERS.length];
    const reference = `CAM-${100 + i}`;
    const notes = i % 5 === 0 ? 'Llegó con humedad en las cajas de abajo' : undefined;
    const shape = i % 6;
    const base = { product, minAgo, supplier, reference, ...(notes ? { notes } : {}) };
    if (shape === 0) filler.push(receive({ ...base, packaging: 'granel', mode: 'directo', net: 80_000 + (i % 7) * 17_500 + (i % 3) * 250 }));
    else if (shape === 1) filler.push(receive({ ...base, packaging: 'caja', mode: 'por_envase', containers: 20 + (i % 9) * 3, unitNet: [15_000, 18_500, 12_250, 20_000][i % 4] }));
    else if (shape === 2) filler.push(receive({ ...base, packaging: 'arpilla', mode: 'por_envase', containers: 30 + (i % 8) * 4, unitNet: [15_000, 14_500, 16_000][i % 3] }));
    else if (shape === 3) filler.push(receive({ ...base, packaging: 'granel', mode: 'bruto_tara', gross: 520_000 + (i % 5) * 13_750, tare: 18_000 + (i % 4) * 750 }));
    else if (shape === 4) filler.push(receive({ ...base, packaging: 'caja', mode: 'bruto_tara', containers: 40 + (i % 5), gross: 610_000 + (i % 4) * 9_500, tare: 40_000 + (i % 3) * 500 }));
    else filler.push(receive({ ...base, packaging: 'arpilla', mode: 'directo', containers: 25 + (i % 6), net: 350_000 + (i % 5) * 12_500 }));
  }
  // Pesadas sumadas (modo directo con varias pesadas) en una de las recepciones.
  receive({ product: P('mich-1ra-200'), packaging: 'granel', mode: 'directo', weighings: [100_100, 99_900, 50_050, 74_950], minAgo: 700, supplier: 'Don Pepe', reference: 'CAM-PESADAS' });

  // Correcciones, anulaciones y una corrección de datos sobre recepciones de relleno (si hay suficientes).
  const corrected: Reception[] = [];
  if (filler.length >= 8) {
    const a = filler[filler.length - 3];
    correct(a, a.netMilli! - 7_500, 'La báscula estaba descalibrada', 400);
    correct(a, a.netMilli! + 2_250, 'Se pesó otra vez una arpilla que faltaba', 380);
    corrected.push(a);
    const b = filler[filler.length - 5];
    correct(b, b.netMilli! + 12_000, 'Faltó sumar la última tarima', 500);
    corrected.push(b);
    voidRec(filler[filler.length - 4], 'Se capturó con la clasificación equivocada: era otra', 360);
    voidRec(filler[filler.length - 6], 'Camión repetido: ya estaba registrado con otro folio', 340);
    const c = filler[filler.length - 2];
    c.dataEdits = [
      {
        id: uid('edit'),
        at: iso(ago(300)),
        reason: 'El proveedor se escribió mal en el andén y la referencia cambió de camión',
        changes: [
          { field: 'supplier', before: c.supplier ?? '', after: 'Cooperativa Agrícola de Tierra Caliente, S. de R.L.' },
          { field: 'reference', before: c.reference ?? '', after: 'CAM-CORREGIDO-77' },
        ],
      },
    ];
    c.supplier = 'Cooperativa Agrícola de Tierra Caliente, S. de R.L.';
    c.reference = 'CAM-CORREGIDO-77';
  }

  // Escenario de «posible duplicado»: el camión CAM-77 se registró cuatro veces (tres avisos al volver a registrarlo).
  for (const m of [300, 280, 260, 240]) {
    receive({ product: P('sin-1ra-2x'), packaging: 'granel', mode: 'directo', net: 120_000, minAgo: m, supplier: 'Rancho Los Limones', reference: 'CAM-77' });
  }
  move(P('sin-1ra-2x'), 'ajuste', -1_500, 0, 'Conteo de cierre del andén: faltaron 1.5 kg', ago(100));
  move(P('sin-1ra-2x'), 'entrada', 120_000, 0, 'Mercancía de bodega vieja', ago(90));

  // Una clasificación con más de una edición de nombre (bitácora visible en Inventario).
  const edited = P('sin-3ra');
  edited.classEdits = [
    { at: iso(ago(3 * DAY)), before: { variety: 'Sin semilla', quality: 'Tercera ' }, after: { variety: 'Sin semilla', quality: 'Tercera' } },
    { at: iso(ago(2 * DAY)), before: { variety: 'Limón sin semilla', quality: 'Tercera' }, after: { variety: 'Sin semilla', quality: 'Tercera' } },
  ];

  // Mermas y conteos
  move(P('oax-1ra-300'), 'merma', -3_250, 0, 'Golpeado en el traslado', ago(1500));
  move(P('mich-3ra-400'), 'merma', -12_000, 0, 'Se echó a perder por la humedad de la lluvia del camión de ayer', ago(900));
  const counted = P('oax-2da-400');
  move(counted, 'ajuste', -2_000, 0, 'Conteo físico: faltan dos kilos', ago(600));

  // ---- Turno cerrado de ayer
  const s1 = openShift(1800, 50_000, 1140);
  cashOut(s1, 20_000, 'Pago de flete', 1500);
  const closedSales: Sale[] = [];
  const sellable = ['sin-1ra-2x', 'sin-2da-3x', 'oax-1ra-300', 'mich-1ra-200', 'sin', 'mich-2da-300', 'oax-2da-400', 'sin-3ra'];
  const qtys = [2_500, 10_000, 750, 25_000, 5_000, 50_000, 12_250, 1_000, 100_000, 7_500];
  for (let i = 0; i < 9; i++) {
    const p = P(sellable[i % sellable.length]);
    const q = Math.min(qtys[i % qtys.length], Math.max(avail(p) - 1000, 500));
    closedSales.push(sell(p, q, 1700 - i * 55, s1, { method: i % 4 === 3 ? 'transferencia' : 'efectivo' }));
  }
  const cashIn = (list: Sale[]) => list.filter((s) => s.status === 'completada' && s.paymentMethod === 'efectivo').reduce((a, s) => a + s.totalCents, 0);
  const s1Expected = s1.openingCashCents + cashIn(closedSales) - 20_000;
  s1.expectedCashCents = s1Expected;
  s1.countedCashCents = s1Expected - 500;
  s1.differenceCents = -500;

  // ---- Turno abierto de hoy
  const s2 = openShift(480, 80_000);
  const todays: Sale[] = [];
  const vales: Sale[] = [];
  for (let i = 0; i < nSales; i++) {
    const p = P(sellable[(i + 2) % sellable.length]);
    const q = Math.min(qtys[(i + 3) % qtys.length], Math.max(avail(p) - 1000, 500));
    const method: PaymentMethod = i % 5 === 4 ? 'transferencia' : i % 7 === 6 ? 'tarjeta' : 'efectivo';
    const o: SaleIn = { method, ...(i % 3 === 0 && method === 'efectivo' ? { exact: true } : {}) };
    todays.push(sell(p, q, 450 - i * Math.max(Math.floor(430 / Math.max(nSales, 1)), 1), s2, o));
  }
  // Vales: cuatro pendientes (uno con cliente de nombre larguísimo), dos entregados, dos cancelados.
  const vp = (key: string, qty: number, minAgo: number, customer?: string) => {
    const s = sell(P(key), Math.min(qty, Math.max(avail(P(key)) - 1000, 500)), minAgo, s2, { vale: true, ...(customer ? { customer } : {}) });
    vales.push(s);
    return s;
  };
  vp('sin-1ra-2x', 40_000, 300, 'Doña Mary');
  vp('oax-1ra-300', 22_500, 280, LONG_CUSTOMER);
  const delivered1 = vp('mich-1ra-200', 18_000, 260, 'Taquería El Güero');
  vp('sin', 15_250, 240);
  const delivered2 = vp('sin-2da-3x', 30_000, 220, 'Fonda La Central');
  const cancelled1 = vp('mich-2da-300', 9_000, 200, 'Pedro (no regresó por el pedido)');
  const cancelled2 = vp('oax-2da-400', 6_500, 190, 'Chuy');
  vp('mich-3ra-400', 11_000, 170, 'Mercado de San Juan');
  deliver(delivered1, 150);
  deliver(delivered2, 140);
  cancelVale(cancelled1, 'El cliente no regresó por el pedido', 'efectivo', 120, s2);
  cancelVale(cancelled2, 'Se equivocó de clasificación y pidió otra', 'ninguna', 110, s2);
  // Una venta anulada y una venta que dejó la existencia en negativo CON autorización.
  const toVoid = sell(P('sin'), 3_000, 60, s2, { method: 'efectivo', exact: true });
  voidSale(toVoid, 'El cliente se arrepintió', 50);
  const neg = P('oax-3ra-500');
  const negQty = Math.max(avail(neg), 0) + 12_500;
  const overridden = sell(neg, negQty, 30, s2, { override: true });
  todays.push(overridden);
  cashOut(s2, 12_000, 'Bolsas y hielo', 400);
  cashOut(s2, 35_000, 'Comida del personal', 250);

  // ---- Borradores y descartados
  draft({ product: P('oax-1ra-300'), packaging: 'caja', mode: 'por_envase', containers: 40, minAgo: 150, supplier: 'Huerta San Miguel', reference: 'CAM-205' });
  draft({ product: P('mich-2da-300'), packaging: 'granel', mode: 'directo', net: 75_000, minAgo: 130, supplier: 'Don Pepe', notes: 'Falta confirmar con el chofer cuánto pesó realmente la carga' });
  draft({ packaging: 'arpilla', mode: 'por_envase', minAgo: 70, reference: 'CAM-501', notes: 'Todavía no descargan' });
  draft({ product: P('sin-2da-3x'), packaging: 'granel', mode: 'directo', net: 40_000, minAgo: 500, supplier: 'Rancho Los Limones' }, 'cancelada', 'borrador descartado');
  draft({ packaging: 'caja', mode: 'por_envase', containers: 12, minAgo: 520 }, 'cancelada', 'Era el mismo camión del folio anterior');

  // ===================================================================================================================
  // Hechos independientes (salen del libro, no de la app)
  // ===================================================================================================================
  const completed = (list: Sale[]) => list.filter((s) => s.status === 'completada');
  const openSales = sales.filter((s) => s.shiftId === s2.id);
  const openDone = completed(openSales);
  const cashOutOpen = cash.filter((m) => m.shiftId === s2.id && m.type === 'salida').reduce((a, m) => a + m.amountCents, 0);
  const refundsOpen = cash.filter((m) => m.shiftId === s2.id && m.type === 'devolucion').reduce((a, m) => a + m.amountCents, 0);
  const todayKey = mxDay(now);
  const todaySales = sales.filter((s) => s.day === todayKey && s.status === 'completada');
  const recs = (st: Reception['status']) => receptions.filter((r) => r.status === st);

  const backup: LegacyBackup = {
    app: 'sistema-venta-limones',
    version: 2,
    exportedAt: iso(ago(2 * DAY)),
    products,
    sales,
    shifts,
    cashMovements: cash,
    stockMoves: moves,
    receptions,
    nextFolio,
    nextValeFolio: nextVale,
    nextReceptionFolio: nextRec,
  };

  return {
    backup,
    now,
    product: P,
    label: (key) => label(P(key)),
    facts: {
      receptionsConfirmed: recs('confirmada').length,
      receptionsVoided: recs('anulada').length,
      receptionsCorrected: receptions.filter((r) => r.corrections.length > 0).length,
      drafts: recs('borrador').length,
      discarded: recs('cancelada').length,
      valesPending: sales.filter((s) => s.delivery === 'pendiente').length,
      valesDelivered: sales.filter((s) => s.delivery === 'entregado').length,
      valesCancelled: sales.filter((s) => s.delivery === 'cancelado').length,
      stock: (key) => {
        const p = P(key);
        return { physical: p.physicalMilli, reserved: p.reservedMilli, available: avail(p) };
      },
      openShift: {
        salesCount: openDone.length,
        totalCents: openDone.reduce((a, s) => a + s.totalCents, 0),
        efectivoCents: cashIn(openSales),
        openingCents: s2.openingCashCents,
        cashOutCents: cashOutOpen,
        refundsCents: refundsOpen,
        expectedCents: s2.openingCashCents + cashIn(openSales) - cashOutOpen - refundsOpen,
        lastFolio: Math.max(...openSales.map((s) => s.folio)),
      },
      closedShift: { expectedCents: s1Expected, countedCents: s1Expected - 500, differenceCents: -500 },
      today: { sales: todaySales.length, totalCents: todaySales.reduce((a, s) => a + s.totalCents, 0) },
      nextFolio,
      nextValeFolio: nextVale,
      nextReceptionFolio: nextRec,
    },
  };
}

/**
 * Carga un respaldo POR LA INTERFAZ (Más → Restaurar desde archivo → Restaurar y reemplazar), que es lo que haría una persona
 * al pasar sus datos a un teléfono nuevo. Si la hoja pide «Entiendo lo que se perderá», lo marca.
 */
export async function restoreBackup(page: Page, backup: unknown, opts: { name?: string } = {}) {
  await tab(page, 'mas');
  await page.getByTestId('import-file').setInputFiles({
    name: opts.name ?? 'mercado.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.getByTestId('restore-sheet')).toBeVisible();
  const understood = page.getByTestId('restore-understood');
  if (await understood.count()) await understood.check();
  await page.getByTestId('restore-confirm').click();
  await expect(page.getByTestId('toast')).toContainText('Respaldo restaurado');
  await expect(page.getByTestId('restore-sheet')).toHaveCount(0);
}

// =====================================================================================================================
// 3. Lectura cruda de IndexedDB e invariantes
// =====================================================================================================================

export type Dump = Pick<Backup, 'products' | 'sales' | 'shifts' | 'cashMovements' | 'stockMoves' | 'receptions' | 'nextFolio' | 'nextValeFolio' | 'nextReceptionFolio'> & {
  currentShiftId?: string;
};

/** Lee TODA la base de la app (solo lectura, sin pasar por la interfaz ni por el código de la app). */
export async function readDb(page: Page): Promise<Dump> {
  return page.evaluate(
    () =>
      new Promise<Dump>((resolve, reject) => {
        const open = indexedDB.open('venta-limones');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const names = ['products', 'sales', 'shifts', 'cashMovements', 'stockMoves', 'receptions', 'meta'];
          const tx = db.transaction(names, 'readonly');
          const out: Record<string, unknown[]> = {};
          let left = names.length;
          for (const n of names) {
            const req = tx.objectStore(n).getAll();
            req.onsuccess = () => {
              out[n] = req.result;
              if (--left === 0) {
                db.close();
                const meta = Object.fromEntries((out.meta as Array<{ key: string; value: unknown }>).map((m) => [m.key, m.value]));
                resolve({
                  products: out.products,
                  sales: out.sales,
                  shifts: out.shifts,
                  cashMovements: out.cashMovements,
                  stockMoves: out.stockMoves,
                  receptions: out.receptions,
                  nextFolio: (meta.nextFolio as number) ?? 1,
                  nextValeFolio: (meta.nextValeFolio as number) ?? 1,
                  nextReceptionFolio: (meta.nextReceptionFolio as number) ?? 1,
                  currentShiftId: meta.currentShiftId as string | undefined,
                } as Dump);
              }
            };
            req.onerror = () => reject(req.error);
          }
        };
      }),
  );
}

/** Revisión INDEPENDIENTE de la app: existencias = suma de movimientos, folios únicos, recepciones cuadradas, ventas bien sumadas. */
export function invariants(d: Dump): string[] {
  const bad: string[] = [];
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const pendingBy = new Map<string, number>();
  for (const s of d.sales) {
    if (s.delivery === 'pendiente') for (const it of s.items) pendingBy.set(it.productId, (pendingBy.get(it.productId) ?? 0) + it.qtyMilli);
  }
  for (const p of d.products) {
    const mv = d.stockMoves.filter((m) => m.productId === p.id);
    if (sum(mv.map((m) => m.deltaMilli)) !== p.physicalMilli) bad.push(`físico de ${p.name}/${p.quality ?? ''}: ${p.physicalMilli} ≠ suma de movimientos ${sum(mv.map((m) => m.deltaMilli))}`);
    if (sum(mv.map((m) => m.reservedDeltaMilli)) !== p.reservedMilli) bad.push(`reservado de ${p.name}/${p.quality ?? ''} ≠ suma de movimientos`);
    if ((pendingBy.get(p.id) ?? 0) !== p.reservedMilli) bad.push(`reservado de ${p.name}/${p.quality ?? ''} ≠ vales pendientes`);
  }
  const uniq = (what: string, xs: number[], next: number) => {
    if (new Set(xs).size !== xs.length) bad.push(`${what} repetidos`);
    if (xs.some((x) => x >= next)) bad.push(`${what}: alguno ≥ siguiente (${next})`);
  };
  uniq('folios de venta', d.sales.map((s) => s.folio), d.nextFolio);
  uniq('folios de vale', d.sales.flatMap((s) => (s.valeFolio ? [s.valeFolio] : [])), d.nextValeFolio);
  uniq('folios de recepción', d.receptions.flatMap((r) => (r.folio ? [r.folio] : [])), d.nextReceptionFolio);
  for (const s of d.sales) {
    if (sum(s.items.map((i) => i.totalCents)) !== s.totalCents) bad.push(`venta #${s.folio}: total ≠ renglones`);
    for (const i of s.items) if (i.totalCents !== Math.round((i.unitPriceCents * i.qtyMilli) / 1000)) bad.push(`venta #${s.folio}: renglón mal calculado`);
    if (s.paymentMethod === 'efectivo' && s.receivedCents - s.totalCents !== s.changeCents) bad.push(`venta #${s.folio}: cambio mal calculado`);
  }
  for (const r of d.receptions) {
    const mv = d.stockMoves.filter((m) => m.receptionId === r.id);
    const tag = r.folio ? `R-${r.folio}` : r.id;
    if (r.status === 'borrador' || r.status === 'cancelada') {
      if (mv.length > 0 || r.folio !== undefined) bad.push(`${tag}: ${r.status} con movimientos o folio`);
      continue;
    }
    const ins = mv.filter((m) => m.type === 'recepcion');
    if (ins.length !== 1) bad.push(`${tag}: ${ins.length} movimientos de recepción`);
    else if (ins[0].deltaMilli !== r.confirmedNetMilli) bad.push(`${tag}: el movimiento sumó ${ins[0].deltaMilli} y se confirmó ${r.confirmedNetMilli}`);
    const expected = r.status === 'anulada' ? 0 : (r.confirmedNetMilli ?? 0) + sum(r.corrections.map((c) => c.deltaMilli));
    if (r.netMilli !== expected) bad.push(`${tag}: kilos vigentes ${r.netMilli} ≠ ${expected}`);
    if (r.status === 'anulada' && mv.filter((m) => m.type === 'reversa_recepcion').length !== 1) bad.push(`${tag}: anulada sin una sola reversa`);
  }
  for (const s of d.sales) if (!d.shifts.some((x) => x.id === s.shiftId)) bad.push(`venta #${s.folio}: turno inexistente`);
  return bad;
}

// =====================================================================================================================
// 3b. Sin conexión SIMULADA
// =====================================================================================================================

// Hallazgo (verificado con una sonda): `context.setOffline(true)` NO frena las peticiones que hace el propio service worker. Con
// él activo, una URL que NO está en la caché del service worker «respondía» igual (el worker llegaba al servidor y recibía
// 200), así que una prueba «sin red» no detectaba un recurso que faltara en el precache. Para que la simulación sea más
// estricta se añade `route.abort` sobre TODO, y para que Playwright enrute también lo que pide el service worker hay que activar
// su bandera experimental (se lee cuando el service worker se crea). Si la bandera dejara de existir, la comprobación «lo no
// cacheado falla» de las pruebas lo delata en vez de degradarse en silencio.
// La bandera se activa SOLO mientras dura cada prueba sin conexión (enableStrictOffline/disableStrictOffline en beforeEach/
// afterEach): dejarla puesta cambiaría cómo se comporta `setOffline` en las demás pruebas que corran en el mismo proceso.
// Con esa simulación más estricta, REABRIR la app sin red falla con el servidor de pruebas (`vite preview` responde `Vary:
// Origin`): es un defecto real de la app, no de la simulación (ver reopenOffline). Por eso las pruebas de «con la app ya abierta
// se corta la red» (que pasan) están separadas de la de arranque en frío (que falla y se queda fallando mientras el defecto exista).
const SW_NETWORK_FLAG = 'PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS';

/** Activa la bandera de Playwright que enruta también las peticiones del service worker. Llamar ANTES de abrir la app. */
export function enableStrictOffline(): void {
  process.env[SW_NETWORK_FLAG] = '1';
}

/** Quita la bandera: las pruebas de otros archivos que corran después en el mismo proceso no deben notarla. */
export function disableStrictOffline(): void {
  delete process.env[SW_NETWORK_FLAG];
}

const abortNetwork = (route: Route) => route.abort('internetdisconnected');
const offlineContexts = new WeakSet<BrowserContext>();

/**
 * «Sin conexión» simulada: el navegador se declara sin red (eventos `offline`, navigator.onLine = false) Y ninguna petición sale
 * a la red, ni la de la página ni la del service worker. Lo que el service worker tiene en caché se sigue sirviendo.
 * NO equivale al modo avión real de Android (no apaga radios ni cambia el estado de la red del sistema).
 */
export async function goOffline(context: BrowserContext) {
  if (!process.env[SW_NETWORK_FLAG]) throw new Error('goOffline necesita enableStrictOffline() ANTES de abrir la app (usarlo en un beforeEach)');
  await context.setOffline(true);
  if (!offlineContexts.has(context)) {
    offlineContexts.add(context);
    await context.route('**/*', abortNetwork);
  }
}

/** Vuelve la red: quita el bloqueo y el modo sin conexión. */
export async function goOnline(context: BrowserContext) {
  if (offlineContexts.delete(context)) await context.unroute('**/*', abortNetwork);
  await context.setOffline(false);
}

/**
 * Reabre la app («arranque en frío») con la red cortada de verdad y espera a que pinte. Si no pinta, el error explica por qué:
 * qué pidió el service worker a la red (porque su `cache.match` no encontró la respuesta guardada) y qué `Vary` declaran las
 * respuestas del precache. Hallazgo verificado con una copia de dist/ servida de tres maneras: si el servidor responde con
 * `Vary: Origin` (como `vite preview`, la ruta A de docs/ANDROID.md), `cache.match(req, { ignoreSearch: true })` no encuentra el
 * JS ni el CSS (los módulos y las hojas con `crossorigin` llevan cabecera `Origin`; la respuesta se guardó sin ella) y, sin red,
 * la app queda en blanco. Sin `Vary: Origin`, o con `ignoreVary: true` en el service worker, arranca bien.
 */
export async function reopenOffline(page: Page, context: BrowserContext): Promise<void> {
  const fromWorker: string[] = [];
  const onRequest = (r: PwRequest) => {
    if (r.serviceWorker()) fromWorker.push(new URL(r.url()).pathname);
  };
  context.on('request', onRequest);
  try {
    await page.reload({ waitUntil: 'load' });
    await page.getByTestId('net').waitFor({ state: 'visible', timeout: 8_000 });
  } catch {
    const cached = await page
      .evaluate(async () => {
        const out: string[] = [];
        for (const key of await caches.keys()) {
          const cache = await caches.open(key);
          for (const req of await cache.keys()) {
            const res = await cache.match(req);
            if (res && /\.(js|css)$/.test(new URL(req.url).pathname)) out.push(`${new URL(req.url).pathname} (Vary: ${res.headers.get('vary') ?? 'ninguno'})`);
          }
        }
        return out;
      })
      .catch(() => ['no se pudo leer la caché']);
    throw new Error(
      'La app NO arrancó sin red tras reabrirla: el service worker tuvo que pedir a la red ' +
        `${fromWorker.length > 0 ? fromWorker.join(', ') : '(nada)'} aunque están en su precache. Respuestas guardadas: ${cached.join('; ')}`,
    );
  } finally {
    context.off('request', onRequest);
  }
}

/**
 * Comprobación independiente de cómo se simule la red: TODO lo que la página cargó (documento y recursos) está en la caché del
 * service worker. Devuelve lo que falte. OJO: verifica que el recurso ESTÉ guardado, no que el service worker lo sirva a quien lo
 * pide con cabecera `Origin` (`caches.match(url)` desde la página no la lleva); eso lo comprueba `reopenOffline`.
 */
export async function uncachedResources(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const urls = new Set<string>([location.href]);
    for (const e of performance.getEntriesByType('resource')) urls.add(e.name);
    const missing: string[] = [];
    for (const u of urls) {
      if (new URL(u).origin !== location.origin) {
        missing.push(`${u} (de otro origen)`);
        continue;
      }
      if (!(await caches.match(u, { ignoreSearch: true }))) missing.push(u);
    }
    return missing;
  });
}

// =====================================================================================================================
// 4. Barridos dentro de la página
// =====================================================================================================================

/**
 * Elementos que se salen de la pantalla a lo ancho, o que un contenedor con `overflow` recorta o desplaza de lado
 * (`<main>` tiene `overflow-x: clip` y las hojas `overflow-y: auto`: ahí un desbordamiento NO aparece como barra, se corta).
 * Vacío = sin desbordamiento horizontal. La lista de «Recientes» de la caja se desliza de lado a propósito.
 */
export async function overflowReport(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad = new Set<string>();
    const root = document.documentElement;
    const vw = root.clientWidth;
    const name = (el: Element) => {
      const id = el.getAttribute('data-testid');
      const cls = typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0]}` : '';
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
      return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ''}${cls}${text ? ` «${text}»` : ''}`;
    };
    const rendered = (el: Element) => {
      const h = el as HTMLElement;
      if (typeof h.checkVisibility === 'function' && !h.checkVisibility({ checkVisibilityCSS: true } as never)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'LINK', 'META']);
    if (root.scrollWidth > vw + 1) bad.add(`documento: ancho ${root.scrollWidth} > ventana ${vw}`);
    if (document.body.scrollWidth > vw + 1) bad.add(`body: ancho ${document.body.scrollWidth} > ventana ${vw}`);
    const all = Array.from(document.body.querySelectorAll<HTMLElement>('*')).filter((el) => !skip.has(el.tagName) && rendered(el) && !el.closest('.chips.recent'));
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 || r.left < -1) bad.add(`fuera de la ventana: ${name(el)} ${Math.round(r.left)}..${Math.round(r.right)} (ventana 0..${vw})`);
      // El overflow de un ancestro NO recorta a un elemento con position:fixed (ni a lo que esté dentro de él): se corta ahí la cadena.
      for (let a: HTMLElement | null = el; a && a.parentElement && a.parentElement !== document.body && a.parentElement !== root; a = a.parentElement) {
        if (getComputedStyle(a).position === 'fixed') break;
        const parent: HTMLElement = a.parentElement;
        if (getComputedStyle(parent).overflowX === 'visible') continue;
        const ar = parent.getBoundingClientRect();
        const left = ar.left + parent.clientLeft;
        const right = left + parent.clientWidth;
        if (r.right > right + 1 || r.left < left - 1) bad.add(`recortado por ${name(parent)} (${Math.round(left)}..${Math.round(right)}): ${name(el)} ${Math.round(r.left)}..${Math.round(r.right)}`);
      }
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) continue; // su texto se desplaza por dentro, es normal
      if (getComputedStyle(el).overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1) {
        bad.add(`contenedor más angosto que su contenido: ${name(el)} scrollWidth ${el.scrollWidth} > ${el.clientWidth}`);
      }
    }
    return [...bad];
  });
}

/**
 * Controles que no alcanzan `min` px (44 por omisión) de ancho o de alto. Una casilla o un radio se tocan por su etiqueta
 * (la fila entera), así que se mide la etiqueta. Se agrupan los idénticos («×N»).
 */
export async function touchTargetReport(page: Page, min = 44): Promise<string[]> {
  return page.evaluate((MIN) => {
    const name = (el: Element) => {
      const id = el.getAttribute('data-testid');
      const cls = typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0]}` : '';
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
      return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ''}${cls}${text ? ` «${text}»` : ''}`;
    };
    const rendered = (el: Element) => {
      const h = el as HTMLElement;
      if (typeof h.checkVisibility === 'function' && !h.checkVisibility({ checkVisibilityCSS: true } as never)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const SEL = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=radio], [role=checkbox], [role=switch], [role=link]';
    const found = new Map<string, number>();
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(SEL))) {
      if (!rendered(el)) continue;
      let target: Element = el;
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) target = el.closest('label') ?? el;
      const r = target.getBoundingClientRect();
      if (Math.round(r.width) < MIN || Math.round(r.height) < MIN) {
        const key = `${name(el)} → ${Math.round(r.width)}×${Math.round(r.height)}${target !== el ? ' (su etiqueta)' : ''}`;
        found.set(key, (found.get(key) ?? 0) + 1);
      }
    }
    return [...found].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
  }, min);
}

/** Botones, chips, pestañas y resúmenes cuyo texto no cabe en su caja (se sale o se corta): scrollWidth > clientWidth. */
/**
 * Contraste de color del texto (WCAG 2.1, criterio 1.4.3): 4.5:1 para texto normal y 3:1 para texto grande (≥ 24 px, o ≥ 18.66 px en
 * negritas). Mide el color calculado de cada texto contra el fondo real que tiene detrás (se componen los fondos translúcidos de
 * sus ancestros sobre el primero opaco; la opacidad de los ancestros también cuenta). Se omiten los controles deshabilitados (el
 * criterio exime a los componentes inactivos) y los textos sobre imágenes o degradados, que no se pueden medir así. Devuelve los
 * fallos (vacío = todo cumple) y cuántos textos se midieron, para que «sin fallos» no pueda ser un barrido vacío.
 */
export async function contrastReport(page: Page): Promise<{ failures: string[]; measured: number; skipped: number }> {
  return page.evaluate(() => {
    type RGBA = [number, number, number, number];
    const parse = (c: string): RGBA => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return [0, 0, 0, 0];
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p[3] ?? 1];
    };
    const over = (top: RGBA, under: RGBA): RGBA => {
      const a = top[3] + under[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      const ch = (i: number) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
      return [ch(0), ch(1), ch(2), a];
    };
    const lin = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const lum = (c: RGBA) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    const name = (el: Element) => {
      const id = el.getAttribute('data-testid');
      const cls = typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0]}` : '';
      return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ''}${cls}`;
    };
    const failures = new Map<string, number>();
    let measured = 0;
    let skipped = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !(n.textContent ?? '').trim()) continue;
      seen.add(el);
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(el.tagName)) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const css = getComputedStyle(el);
      if (css.visibility === 'hidden' || css.display === 'none') continue;
      if (el.closest('[disabled], [aria-disabled="true"], [inert], [hidden]')) continue;
      // Color del texto con la opacidad acumulada, y fondo real: se sube por los ancestros hasta un color opaco.
      let opacity = 1;
      let imageBehind = false;
      let bg: RGBA = [0, 0, 0, 0];
      for (let a: Element | null = el; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        opacity *= Number(cs.opacity);
        if (cs.backgroundImage !== 'none') imageBehind = true;
        bg = over(bg, [0, 0, 0, 0]);
        const own = parse(cs.backgroundColor);
        if (own[3] > 0) bg = bg[3] === 0 ? own : over(bg, own);
        if (bg[3] >= 0.999) break;
      }
      if (imageBehind) {
        skipped++;
        continue;
      }
      if (bg[3] < 0.999) bg = over(bg, [255, 255, 255, 1]); // página sobre blanco
      const fg0 = parse(css.color);
      const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * opacity], bg);
      const l1 = Math.max(lum(fg), lum(bg));
      const l2 = Math.min(lum(fg), lum(bg));
      const ratio = (l1 + 0.05) / (l2 + 0.05);
      const size = parseFloat(css.fontSize);
      const bold = Number(css.fontWeight) >= 700 || css.fontWeight === 'bold';
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      measured++;
      if (ratio < need - 0.005) {
        const text = (n.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 28);
        const key = `${name(el)} «${text}» ${ratio.toFixed(2)}:1 (mínimo ${need}:1; texto ${css.color} sobre ${css.backgroundColor === 'rgba(0, 0, 0, 0)' ? 'fondo heredado' : css.backgroundColor})`;
        failures.set(key, (failures.get(key) ?? 0) + 1);
      }
    }
    return { failures: [...failures].map(([k, c]) => (c > 1 ? `${k} ×${c}` : k)), measured, skipped };
  });
}

export async function clippedTextReport(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const name = (el: Element) => {
      const id = el.getAttribute('data-testid');
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ''}${text ? ` «${text}»` : ''}`;
    };
    const rendered = (el: Element) => {
      const h = el as HTMLElement;
      if (typeof h.checkVisibility === 'function' && !h.checkVisibility({ checkVisibilityCSS: true } as never)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const SEL = 'button, summary, [role=tab], [role=radio], .chip, .badge, .net, .tab .lbl, .check';
    const out = new Set<string>();
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(SEL))) {
      if (!rendered(el)) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.add(`${name(el)}: texto más ancho que su caja (${el.scrollWidth} > ${el.clientWidth})`);
      if (el.scrollHeight > el.clientHeight + 1) out.add(`${name(el)}: texto más alto que su caja (${el.scrollHeight} > ${el.clientHeight})`);
    }
    return [...out];
  });
}

/**
 * Baja hasta el final de la página y comprueba que lo ÚLTIMO del contenido queda por encima de las pestañas de abajo (que son
 * fijas) y no tapado por ellas. Vacío = el final es alcanzable.
 */
export async function bottomReachReport(page: Page): Promise<string[]> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  return page.evaluate(() => {
    const bad: string[] = [];
    const rendered = (el: Element) => {
      const h = el as HTMLElement;
      if (typeof h.checkVisibility === 'function' && !h.checkVisibility({ checkVisibilityCSS: true } as never)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const nav = document.querySelector<HTMLElement>('nav.tabs');
    const navShown = !!nav && getComputedStyle(nav).display !== 'none';
    const limit = navShown ? nav!.getBoundingClientRect().top : window.innerHeight;
    let last: { el: Element; bottom: number } | null = null;
    for (const el of Array.from(document.querySelectorAll('main *'))) {
      if (!rendered(el) || el.closest('.overlay')) continue;
      const b = el.getBoundingClientRect().bottom;
      if (!last || b > last.bottom) last = { el, bottom: b };
    }
    if (last && last.bottom > limit + 0.5) {
      const id = last.el.getAttribute('data-testid');
      bad.push(`el final del contenido (${last.el.tagName.toLowerCase()}${id ? `[${id}]` : ''}) queda ${Math.round(last.bottom - limit)} px por debajo del borde de las pestañas`);
    }
    const doc = document.documentElement;
    if (Math.abs(window.scrollY + window.innerHeight - doc.scrollHeight) > 2) bad.push(`no se pudo bajar hasta el final (scrollY ${Math.round(window.scrollY)}, alto ${doc.scrollHeight})`);
    return bad;
  });
}

/**
 * Espera a que terminen los escudos contra el «toque fantasma» de la app: una hoja recién abierta ignora los toques en su
 * pie (clase `arming`, 0.45 s) y la pantalla de fondo ignora los toques 0.45 s tras cerrarse una hoja (clase `shield` en
 * <html>). Una persona no los nota (tarda más en leer); una prueba que mide «qué recibe el toque» sí.
 */
export async function settled(page: Page): Promise<void> {
  await expect(page.locator('.sheet.arming')).toHaveCount(0);
  await expect(page.locator('html.shield')).toHaveCount(0);
}

/**
 * ¿Se puede LLEGAR a este elemento y tocarlo? Lo lleva al centro de la franja visible (entre el encabezado fijo y las
 * pestañas / la barra de registro) y comprueba que cabe entero en la ventana y que lo que recibe el toque es él.
 * Devuelve los problemas (vacío = alcanzable y tocable).
 */
export async function reachReport(target: Locator): Promise<string[]> {
  await settled(target.page());
  return target.evaluate((el) => {
    const bad: string[] = [];
    const id = el.getAttribute('data-testid') ?? el.tagName.toLowerCase();
    const shown = (e: Element | null): e is HTMLElement => !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0;
    const inSheet = !!el.closest('.overlay');
    const band = () => {
      if (inSheet) return { top: 0, bottom: window.innerHeight }; // la hoja cubre el encabezado y las pestañas
      const header = document.querySelector('header.top');
      const nav = document.querySelector('nav.tabs');
      const dock = document.querySelector('[data-testid="rec-dock"]');
      let top = header ? header.getBoundingClientRect().bottom : 0;
      let bottom = window.innerHeight;
      if (shown(nav)) bottom = Math.min(bottom, nav.getBoundingClientRect().top);
      if (shown(dock) && !dock.contains(el)) bottom = Math.min(bottom, dock.getBoundingClientRect().top);
      top = Math.max(top, 0);
      return { top, bottom };
    };
    if (inSheet) {
      // Dentro de una hoja se desplaza la hoja (o su cuerpo), no la página.
      el.scrollIntoView({ block: 'nearest' });
    } else {
      for (let i = 0; i < 4; i++) {
        const r = el.getBoundingClientRect();
        const b = band();
        window.scrollBy(0, (r.top + r.bottom) / 2 - (b.top + b.bottom) / 2);
      }
    }
    const r = el.getBoundingClientRect();
    const b = band();
    if (r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5) {
      bad.push(`«${id}» no cabe en la franja visible: ${Math.round(r.top)}..${Math.round(r.bottom)} fuera de ${Math.round(b.top)}..${Math.round(b.bottom)}`);
    }
    if (r.left < -0.5 || r.right > document.documentElement.clientWidth + 0.5) bad.push(`«${id}» se sale por los lados: ${Math.round(r.left)}..${Math.round(r.right)}`);
    const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    if (!hit || !(hit === el || el.contains(hit))) {
      const h = hit as HTMLElement | null;
      bad.push(`«${id}» está tapado por ${h ? `${h.tagName.toLowerCase()}[${h.getAttribute('data-testid') ?? h.className}]` : 'nada (fuera de la ventana)'}`);
    }
    return bad;
  });
}

export interface SheetInfo {
  problems: string[];
  /** El cuerpo de la hoja tiene más contenido que alto (se desplaza). */
  bodyScrolls: boolean;
  /** Tiene pie fijo con botones (Sheet) y está a la vista. null = esta hoja no tiene pie fijo. */
  footVisible: boolean | null;
}

/**
 * Geometría de una hoja modal abierta (por su data-testid): cabe en la ventana, no se desplaza de lado, el pie con botones
 * (si lo tiene) queda siempre a la vista, y el final del contenido se alcanza desplazando el cuerpo.
 */
export async function sheetReport(page: Page, testid: string): Promise<SheetInfo> {
  return page.evaluate((id) => {
    const problems: string[] = [];
    const overlay = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const sheet = overlay?.querySelector<HTMLElement>('.sheet') ?? null;
    if (!overlay || !sheet) return { problems: [`«${id}» no está abierta`], bodyScrolls: false, footVisible: null };
    const body = overlay.querySelector<HTMLElement>('.sheet-body');
    const foot = overlay.querySelector<HTMLElement>('.sheet-foot');
    const vh = window.innerHeight;
    const vw = document.documentElement.clientWidth;
    const sr = sheet.getBoundingClientRect();
    if (sr.top < -0.5) problems.push(`la hoja se sale por arriba (${Math.round(sr.top)})`);
    if (sr.bottom > vh + 0.5) problems.push(`la hoja se sale por abajo (${Math.round(sr.bottom)} > ${vh})`);
    if (sr.left < -0.5 || sr.right > vw + 0.5) problems.push(`la hoja se sale por los lados (${Math.round(sr.left)}..${Math.round(sr.right)})`);
    if (sheet.scrollWidth > sheet.clientWidth + 1) problems.push(`la hoja se desplaza de lado (${sheet.scrollWidth} > ${sheet.clientWidth})`);
    if (body && body.scrollWidth > body.clientWidth + 1) problems.push(`el cuerpo de la hoja se desplaza de lado (${body.scrollWidth} > ${body.clientWidth})`);
    let footVisible: boolean | null = null;
    if (foot) {
      const fr = foot.getBoundingClientRect();
      footVisible = fr.bottom <= vh + 0.5 && fr.top >= sr.top - 0.5 && fr.height > 0;
      if (!footVisible) problems.push(`el pie con botones no está a la vista (${Math.round(fr.top)}..${Math.round(fr.bottom)} de ${vh})`);
      for (const b of Array.from(foot.querySelectorAll('button'))) {
        const r = b.getBoundingClientRect();
        if (r.top < -0.5 || r.bottom > vh + 0.5 || r.left < -0.5 || r.right > vw + 0.5) {
          problems.push(`el botón «${b.getAttribute('data-testid') ?? b.textContent}» queda fuera de la ventana (${Math.round(r.top)}..${Math.round(r.bottom)})`);
        }
      }
    }
    const scroller = body ?? sheet;
    const bodyScrolls = scroller.scrollHeight > scroller.clientHeight + 1;
    scroller.scrollTop = scroller.scrollHeight;
    const box = scroller.getBoundingClientRect();
    let lastBottom = 0;
    for (const el of Array.from(scroller.querySelectorAll('*'))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) lastBottom = Math.max(lastBottom, r.bottom);
    }
    if (lastBottom > box.bottom + 1) problems.push(`el final del contenido no se alcanza: queda ${Math.round(lastBottom - box.bottom)} px por debajo`);
    scroller.scrollTop = 0;
    return { problems, bodyScrolls, footVisible };
  }, testid);
}

/** Superficie (px²) en que dos elementos se encimen: sirve para ver si un aviso tapa el botón principal. */
export async function overlapArea(a: Locator, b: Locator): Promise<number> {
  const [ra, rb] = await Promise.all([rectOf(a), rectOf(b)]);
  const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
  const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
  return w > 0 && h > 0 ? Math.round(w * h) : 0;
}

/** Quién tiene el foco: el data-testid (o la etiqueta) y si es el cuerpo de la página (= se perdió el foco). */
export const focusInfo = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return { testid: a?.getAttribute('data-testid') ?? '', tag: a?.tagName.toLowerCase() ?? '', lost: !a || a === document.body || a === document.documentElement };
  });

/** Atributos «inert» que hayan quedado puestos (tras cerrar una hoja no debe quedar NADA inerte). */
export const inertLeft = (page: Page) => page.evaluate(() => document.querySelectorAll('[inert], [data-sheet-inert]').length);

// ---- Accesibilidad básica -------------------------------------------------------------------------------------------

export interface NameReport {
  /** Controles sin ningún nombre accesible. */
  unnamed: string[];
  /** Controles cuyo ÚNICO nombre es el texto de ayuda (placeholder), que desaparece al escribir. */
  placeholderOnly: string[];
}

/** Nombre accesible aproximado de cada control visible (aria-labelledby, aria-label, <label>, contenido, title, placeholder). */
export async function controlNameReport(page: Page): Promise<NameReport> {
  return page.evaluate(() => {
    const rendered = (el: Element) => {
      const h = el as HTMLElement;
      if (typeof h.checkVisibility === 'function' && !h.checkVisibility({ checkVisibilityCSS: true } as never)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const describe = (el: Element) => {
      const id = el.getAttribute('data-testid');
      const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
      return `${el.tagName.toLowerCase()}${el instanceof HTMLInputElement ? `[type=${el.type}]` : ''}${id ? `[${id}]` : ''}${t ? ` «${t}»` : ''}`;
    };
    /** Texto de un nodo sin lo que está oculto a los lectores de pantalla (aria-hidden) ni los controles de formulario. */
    const textOf = (n: Node): string => {
      if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? '';
      if (!(n instanceof HTMLElement)) return '';
      if (n.getAttribute('aria-hidden') === 'true' || ['INPUT', 'SELECT', 'TEXTAREA'].includes(n.tagName)) return '';
      return Array.from(n.childNodes).map(textOf).join('');
    };
    const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
    const out: NameReport = { unnamed: [], placeholderOnly: [] };
    const SEL = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=radio], [role=checkbox]';
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(SEL))) {
      if (!rendered(el)) continue;
      const labelledby = (el.getAttribute('aria-labelledby') ?? '')
        .split(/\s+/)
        .map((id) => (id ? clean(textOf(document.getElementById(id) ?? document.createTextNode(''))) : ''))
        .join('');
      let name = labelledby || clean(el.getAttribute('aria-label') ?? '');
      let viaPlaceholder = false;
      if (!name && (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) {
        name = clean(Array.from(el.labels ?? []).map(textOf).join(' '));
      }
      if (!name && !(el instanceof HTMLInputElement && el.type !== 'button' && el.type !== 'submit') && !(el instanceof HTMLSelectElement) && !(el instanceof HTMLTextAreaElement)) {
        name = clean(textOf(el));
      }
      if (!name) name = clean(el.getAttribute('title') ?? '');
      if (!name && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.placeholder) {
        name = clean(el.placeholder);
        viaPlaceholder = true;
      }
      if (!name) out.unnamed.push(describe(el));
      else if (viaPlaceholder) out.placeholderOnly.push(`${describe(el)} → «${name}»`);
    }
    return out;
  });
}

/** Cada diálogo visible debe tener role=dialog, aria-modal="true" y un nombre. */
export async function dialogReport(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid$="-sheet"], [role=dialog]'))) {
      if (el.getBoundingClientRect().height === 0) continue;
      const id = el.getAttribute('data-testid') ?? el.className;
      if (el.getAttribute('role') !== 'dialog') bad.push(`«${id}»: no tiene role="dialog"`);
      if (el.getAttribute('aria-modal') !== 'true') bad.push(`«${id}»: no tiene aria-modal="true"`);
      const named = (el.getAttribute('aria-label') ?? '').trim() || (el.getAttribute('aria-labelledby') ?? '').trim();
      if (!named) bad.push(`«${id}»: el diálogo no tiene nombre (aria-label o aria-labelledby)`);
    }
    return bad;
  });
}

/** Valores de `id` repetidos en la página (dos elementos con el mismo id confunden a los lectores de pantalla). */
export const duplicateIds = (page: Page) =>
  page.evaluate(() => {
    const seen = new Map<string, number>();
    for (const el of Array.from(document.querySelectorAll('[id]'))) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
    return [...seen].filter(([, n]) => n > 1).map(([id, n]) => `${id} ×${n}`);
  });

// ---- Utilidades de texto -----------------------------------------------------------------------------------------

/** Texto sin espacios para probar el peor caso: no hay dónde partir la línea. */
export const unbroken = (n: number, ch = 'W') => ch.repeat(n);

/**
 * Texto largo CON espacios (lo normal), de EXACTAMENTE `n` caracteres, sin espacios al principio ni al final ni dobles (la app
 * recorta y colapsa espacios: así el largo guardado es el mismo).
 */
export function sentence(n: number, seed = 'Lote de limón recibido en el andén'): string {
  let s = '';
  while (s.length < n) s += `${seed}. `;
  let out = s.slice(0, n).replace(/\s+$/, '');
  while (out.length < n) out += 'x';
  return out;
}
