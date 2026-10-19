import { chromium, devices, expect, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, resolve, sep } from 'node:path';
import type { CashMovement, LegacyBackup, Product, Reception, Sale, Shift, StockMove } from '../../src/domain/types';
import { charge, tab } from './helpers';

/**
 * Ayudas de las pruebas E2E de MIGRACIÓN v1→v2 y RESPALDO / RESTAURACIÓN (migracion.spec.ts y respaldo.spec.ts).
 *
 * Solo se IMPORTAN (lectura) ./helpers y los TIPOS de src/ (los datos de prueba se comprueban contra los tipos reales al
 * compilar). Nada de src/ se toca, y ninguna prueba usa código de la app para producir lo que luego verifica: las bases se
 * siembran con IndexedDB «a pelo» y las cifras esperadas se calculan a mano a partir de los datos sembrados.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Rec = Record<string, any>;

export const DB_NAME = 'venta-limones';
export const UNDO_DB_NAME = 'venta-limones-undo';

// ═══════════════════════════════════════════ IndexedDB «a pelo» ═══════════════════════════════════════════

export interface IndexSpec {
  name: string;
  keyPath: string;
  unique?: boolean;
}
export interface StoreSpec {
  name: string;
  keyPath: string;
  indexes?: IndexSpec[];
  rows?: Rec[];
}

/**
 * Crea una base IndexedDB con las tablas, índices y filas indicados, desde una página del MISMO origen que NO carga la app
 * (solo el JSON del manifiesto): así nada de la app toca la base mientras se siembra. Úsala solo en un contexto nuevo.
 * Las filas se escriben dentro de la propia transacción de creación (todo o nada).
 */
export async function seedDatabase(page: Page, spec: { name?: string; version: number; stores: StoreSpec[] }): Promise<void> {
  await page.goto('/manifest.webmanifest');
  await page.evaluate(
    ({ name, version, stores }) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(name, version);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const s of stores) {
            const os = db.createObjectStore(s.name, { keyPath: s.keyPath });
            for (const ix of s.indexes ?? []) os.createIndex(ix.name, ix.keyPath, { unique: !!ix.unique });
            for (const row of s.rows ?? []) os.put(row);
          }
        };
        req.onsuccess = () => {
          req.result.close();
          resolve();
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('La siembra quedó bloqueada por otra conexión abierta'));
      }),
    { name: spec.name ?? DB_NAME, version: spec.version, stores: spec.stores },
  );
}

export interface Seed {
  products?: Rec[];
  sales?: Rec[];
  shifts?: Rec[];
  cashMovements?: Rec[];
  stockMoves?: Rec[];
  receptions?: Rec[];
  meta?: Rec[];
}

/** Esquema EXACTO de la versión 1: es MIGRATIONS[1] de src/db/repo.ts (idéntico al del último commit, que era v1). */
export function v1Stores(s: Seed, omit: string[] = []): StoreSpec[] {
  const all: StoreSpec[] = [
    { name: 'products', keyPath: 'id', rows: s.products },
    {
      name: 'sales',
      keyPath: 'id',
      indexes: [
        { name: 'byDay', keyPath: 'day' },
        { name: 'byShift', keyPath: 'shiftId' },
        { name: 'byFolio', keyPath: 'folio', unique: true },
        { name: 'byDelivery', keyPath: 'delivery' },
      ],
      rows: s.sales,
    },
    { name: 'shifts', keyPath: 'id', indexes: [{ name: 'byOpenedAt', keyPath: 'openedAt' }], rows: s.shifts },
    { name: 'cashMovements', keyPath: 'id', indexes: [{ name: 'byShift', keyPath: 'shiftId' }], rows: s.cashMovements },
    { name: 'stockMoves', keyPath: 'id', indexes: [{ name: 'byProduct', keyPath: 'productId' }], rows: s.stockMoves },
    { name: 'meta', keyPath: 'key', rows: s.meta },
  ];
  return all.filter((x) => !omit.includes(x.name));
}

/** Esquema de la versión 2: lo de v1 + la tabla `receptions` + el índice `byReception` de los movimientos. */
export function v2Stores(s: Seed): StoreSpec[] {
  const base = v1Stores(s).map((x) =>
    x.name === 'stockMoves' ? { ...x, indexes: [...(x.indexes ?? []), { name: 'byReception', keyPath: 'receptionId' }] } : x,
  );
  return [
    ...base,
    {
      name: 'receptions',
      keyPath: 'id',
      indexes: [
        { name: 'byStatus', keyPath: 'status' },
        { name: 'byDay', keyPath: 'day' },
        { name: 'byProduct', keyPath: 'productId' },
        { name: 'byFolio', keyPath: 'folio', unique: true },
      ],
      rows: s.receptions,
    },
  ];
}

/** Filas de `meta` como las deja la app: contadores de folio y el turno abierto. */
export function metaRows(b: Rec, extra: Rec[] = []): Rec[] {
  const open = (b.shifts as Rec[]).find((s) => !s.closedAt);
  return [
    { key: 'nextFolio', value: b.nextFolio },
    { key: 'nextValeFolio', value: b.nextValeFolio },
    ...(b.nextReceptionFolio !== undefined ? [{ key: 'nextReceptionFolio', value: b.nextReceptionFolio }] : []),
    ...(open ? [{ key: 'currentShiftId', value: open.id }] : []),
    ...extra,
  ];
}

/** Siembra una base de VERSIÓN 1 (como la dejaba la app anterior) a partir de un respaldo v1. */
export async function seedV1(page: Page, b: Rec, opts: { extraMeta?: Rec[]; omit?: string[]; version?: number } = {}): Promise<void> {
  await seedDatabase(page, {
    version: opts.version ?? 1,
    stores: v1Stores(
      { products: b.products, sales: b.sales, shifts: b.shifts, cashMovements: b.cashMovements, stockMoves: b.stockMoves, meta: metaRows(b, opts.extraMeta) },
      opts.omit,
    ),
  });
}

/** Siembra una base de VERSIÓN 2 (la actual) a partir de un respaldo v2. */
export async function seedV2(page: Page, b: LegacyBackup): Promise<void> {
  await seedDatabase(page, {
    version: 2,
    stores: v2Stores({
      products: b.products,
      sales: b.sales,
      shifts: b.shifts,
      cashMovements: b.cashMovements,
      stockMoves: b.stockMoves,
      receptions: b.receptions,
      meta: metaRows(b),
    }),
  });
}

export interface RawStore {
  keyPath: string | string[] | null;
  indexes: string[];
  unique: string[];
  rows: Rec[];
}
export interface RawDb {
  name: string;
  version: number;
  stores: Record<string, RawStore>;
}

/**
 * Lee TODA la base tal como está en el navegador (versión, tablas, índices y filas ordenadas por clave), sin aplicar el
 * esquema de la app. Abre SIN versión (nunca sube ni crea nada) y devuelve null si la base no existe.
 */
export async function readRawDb(page: Page, name = DB_NAME): Promise<RawDb | null> {
  const raw = await page.evaluate(async (dbName): Promise<RawDb | null> => {
    const known = await indexedDB.databases();
    if (!known.some((d) => d.name === dbName)) return null;
    return new Promise<RawDb>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onupgradeneeded = () => req.transaction?.abort(); // si no existiera, no se crea
      req.onerror = () => reject(req.error ?? new Error('no se pudo abrir la base'));
      req.onblocked = () => reject(new Error('lectura bloqueada'));
      req.onsuccess = () => {
        const db = req.result;
        const names = Array.from(db.objectStoreNames);
        const out: RawDb = { name: dbName, version: db.version, stores: {} };
        if (names.length === 0) {
          db.close();
          return resolve(out);
        }
        const tx = db.transaction(names, 'readonly');
        for (const n of names) {
          const os = tx.objectStore(n);
          const idx = Array.from(os.indexNames);
          const entry: RawStore = {
            keyPath: os.keyPath as string | string[] | null,
            indexes: idx,
            unique: idx.filter((i) => os.index(i).unique),
            rows: [],
          };
          out.stores[n] = entry;
          os.getAll().onsuccess = (e) => {
            entry.rows = (e.target as IDBRequest).result as Rec[];
          };
        }
        tx.oncomplete = () => {
          db.close();
          resolve(out);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('lectura abortada'));
        };
      };
    });
  }, name);
  if (!raw) return null;
  for (const s of Object.values(raw.stores)) {
    const kp = typeof s.keyPath === 'string' ? s.keyPath : 'id';
    s.rows.sort((a, b) => (String(a[kp]) < String(b[kp]) ? -1 : String(a[kp]) > String(b[kp]) ? 1 : 0));
  }
  return raw;
}

/** Versión que `indexedDB.databases()` informa para una base (undefined si no existe). */
export const versionOf = (page: Page, name = DB_NAME) =>
  page.evaluate(async (n) => (await indexedDB.databases()).find((d) => d.name === n)?.version, name);

export const rowsOf = <T = Rec>(raw: RawDb | null, store: string): T[] => (raw?.stores[store]?.rows ?? []) as T[];
export const metaOf = (raw: RawDb | null): Record<string, unknown> =>
  Object.fromEntries(rowsOf<{ key: string; value: unknown }>(raw, 'meta').map((m) => [m.key, m.value]));

export const DATA_STORES = ['products', 'sales', 'shifts', 'cashMovements', 'stockMoves', 'receptions'] as const;

/** Las tablas de datos son IDÉNTICAS (registro por registro). Una tabla que no existe equivale a vacía. */
export function expectSameData(after: RawDb | null, before: RawDb | null, why: string, stores: readonly string[] = DATA_STORES): void {
  for (const s of stores) expect(rowsOf(after, s), `${why}: colección «${s}»`).toEqual(rowsOf(before, s));
}

// ═══════════════════════════════════════════ Conjuntos de datos ═══════════════════════════════════════════

/**
 * Carpeta raíz del proyecto (donde está playwright.config.ts). OJO: `config.rootDir` de Playwright es la carpeta de pruebas
 * (tests/e2e), no la raíz del proyecto.
 */
export function raizDelProyecto(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'playwright.config.ts'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('No se encontró la raíz del proyecto (playwright.config.ts) subiendo desde ' + process.cwd());
}

/** Respaldo REAL de la versión anterior (lo generó el código v1): 4 variedades, 7 ventas, 2 turnos, 13 movimientos. */
export function fixtureV1(): Rec {
  return JSON.parse(readFileSync(join(raizDelProyecto(), 'tests/fixtures/backup-v1.json'), 'utf8'));
}

const EDGE_DAY = '2026-10-08'; // un día fijo en el PASADO: la app se abre «días después»
const edgeAt = (hhmm: string) => `${EDGE_DAY}T${hhmm}:00.000Z`; // 14:45Z–15:30Z = 08:45–09:30 hora de la Ciudad de México

/**
 * Datos de v1 con casos límite, escritos como los guardaba v1 (sin clasificación nueva, sin foto de clasificación en las
 * ventas): un producto sin calidad, uno por caja, uno oculto, una existencia NEGATIVA autorizada, un vale pendiente y un
 * borrador de carrito en `meta`. Las cifras esperadas están en migracion.spec.ts, calculadas a mano.
 */
export function edgeV1(): Rec {
  const products = [
    { id: 'e-limon', name: 'Limón', unit: 'kg', priceCents: 2500, active: true, sort: 0, physicalMilli: 80_000, reservedMilli: 0, updatedAt: edgeAt('15:00') },
    { id: 'e-criollo', name: 'Limón criollo', quality: 'Segunda', unit: 'kg', priceCents: 1800, active: true, sort: 1, physicalMilli: -5_000, reservedMilli: 0, updatedAt: edgeAt('15:20') },
    { id: 'e-caja', name: 'Caja limonera', unit: 'caja', priceCents: 45_000, active: true, sort: 2, physicalMilli: 12_000, reservedMilli: 2_000, updatedAt: edgeAt('15:10') },
    { id: 'e-viejo', name: 'Limón viejo', unit: 'kg', priceCents: 1500, active: false, sort: 3, physicalMilli: 3_000, reservedMilli: 0, updatedAt: edgeAt('14:58') },
  ];
  const shifts = [{ id: 'e-turno', openedAt: edgeAt('14:45'), openingCashCents: 50_000 }];
  const stockMoves = [
    { id: 'm1', productId: 'e-limon', createdAt: edgeAt('14:55'), type: 'entrada', deltaMilli: 90_000, reservedDeltaMilli: 0, note: 'inventario inicial' },
    { id: 'm2', productId: 'e-criollo', createdAt: edgeAt('14:56'), type: 'entrada', deltaMilli: 10_000, reservedDeltaMilli: 0, note: '' },
    { id: 'm3', productId: 'e-caja', createdAt: edgeAt('14:57'), type: 'entrada', deltaMilli: 12_000, reservedDeltaMilli: 0, note: 'cajas del proveedor' },
    { id: 'm4', productId: 'e-viejo', createdAt: edgeAt('14:58'), type: 'entrada', deltaMilli: 3_000, reservedDeltaMilli: 0, note: 'sobrante' },
    { id: 'm5', productId: 'e-limon', createdAt: edgeAt('15:00'), type: 'venta', deltaMilli: -10_000, reservedDeltaMilli: 0, note: 'Folio 1', saleId: 's1' },
    { id: 'm6', productId: 'e-caja', createdAt: edgeAt('15:10'), type: 'reserva', deltaMilli: 0, reservedDeltaMilli: 2_000, note: 'Vale V-1', saleId: 's2' },
    { id: 'm7', productId: 'e-criollo', createdAt: edgeAt('15:20'), type: 'venta', deltaMilli: -15_000, reservedDeltaMilli: 0, note: 'Folio 3', saleId: 's3' },
  ];
  const sale = (o: Rec): Rec => ({ day: EDGE_DAY, shiftId: 'e-turno', paymentMethod: 'efectivo', status: 'completada', ...o });
  const sales = [
    sale({
      id: 's1', folio: 1, createdAt: edgeAt('15:00'), delivery: 'inmediata', totalCents: 25_000, receivedCents: 30_000, changeCents: 5_000,
      items: [{ productId: 'e-limon', name: 'Limón', unit: 'kg', qtyMilli: 10_000, unitPriceCents: 2500, totalCents: 25_000 }],
    }),
    sale({
      id: 's2', folio: 2, createdAt: edgeAt('15:10'), delivery: 'pendiente', valeFolio: 1, customerName: 'Abarrotes Lupe', totalCents: 90_000, receivedCents: 90_000, changeCents: 0,
      items: [{ productId: 'e-caja', name: 'Caja limonera', unit: 'caja', qtyMilli: 2_000, unitPriceCents: 45_000, totalCents: 90_000 }],
    }),
    sale({
      id: 's3', folio: 3, createdAt: edgeAt('15:20'), delivery: 'inmediata', stockOverride: true, totalCents: 27_000, receivedCents: 27_000, changeCents: 0,
      items: [{ productId: 'e-criollo', name: 'Limón criollo · Segunda', unit: 'kg', qtyMilli: 15_000, unitPriceCents: 1800, totalCents: 27_000 }],
    }),
  ];
  const cashMovements = [{ id: 'c1', shiftId: 'e-turno', createdAt: edgeAt('15:30'), type: 'salida', amountCents: 2_000, concept: 'hielo' }];
  return {
    app: 'sistema-venta-limones', version: 1, exportedAt: edgeAt('15:40'),
    products, sales, shifts, cashMovements, stockMoves, nextFolio: 4, nextValeFolio: 2,
  };
}
/** El borrador de carrito que v1 dejaba en `meta` (la caja actual ya no lo usa, pero debe conservarse). */
export const EDGE_CART_DRAFT: Rec = {
  key: 'cartDraft',
  value: [{ productId: 'e-limon', name: 'Limón', unit: 'kg', qtyMilli: 5_000, unitPriceCents: 2500 }],
};

export const RICH_DAY = '2026-10-05';
const RICH_T0 = Date.parse(`${RICH_DAY}T15:00:00.000Z`); // 09:00 hora de la Ciudad de México
const richAt = (min: number) => new Date(RICH_T0 + min * 60_000).toISOString();

/**
 * Estado v2 completo y COHERENTE, escrito a mano: dos variedades; recepciones en sus cinco estados (R-1 confirmada,
 * R-2 confirmada y corregida de 300 a 280 kg, R-3 anulada, un borrador y un borrador descartado); una venta, un vale
 * pendiente, un turno abierto y una salida de efectivo. Los totales esperados:
 *   «Sin semilla · Primera · 2X»: físico 130 kg (150 − 20) y reservado 30 kg ·· «Con semilla · Oaxaca»: físico 280 kg
 *   (300 − 20 + 100 − 100) ·· efectivo esperado $785.00 (fondo 200 + venta 600 − salida 15) ·· folios siguientes 3 / 2 / 4.
 */
export function richV2(): LegacyBackup {
  const cls1 = { variety: 'Sin semilla', quality: 'Primera', caliber: '2X' };
  const cls2 = { variety: 'Con semilla', origin: 'Oaxaca' };
  const products: Product[] = [
    { id: 'p-sin', name: 'Sin semilla', quality: 'Primera', caliber: '2X', unit: 'kg', priceCents: 3000, active: true, sort: 0, physicalMilli: 130_000, reservedMilli: 30_000, updatedAt: richAt(10) },
    { id: 'p-con', name: 'Con semilla', origin: 'Oaxaca', unit: 'kg', priceCents: 2500, active: true, sort: 1, physicalMilli: 280_000, reservedMilli: 0, updatedAt: richAt(8) },
  ];
  const recBase = { createdAt: richAt(1), updatedAt: richAt(1), receivedAt: richAt(1), day: RICH_DAY, corrections: [] };
  const receptions: Reception[] = [
    {
      ...recBase, id: 'rec-1', folio: 1, status: 'confirmada', supplier: 'Rancho Sol', reference: 'CAM-1', productId: 'p-sin',
      productLabel: 'Sin semilla · Primera · 2X', cls: cls1, packaging: 'arpilla', containers: 10, weightMode: 'por_envase', unitNetMilli: 15_000,
      netMilli: 150_000, confirmedAt: richAt(1), confirmedNetMilli: 150_000, stockMoveId: 'rcp:rec-1:in',
    },
    {
      ...recBase, id: 'rec-2', folio: 2, status: 'confirmada', createdAt: richAt(2), updatedAt: richAt(4), receivedAt: richAt(2), productId: 'p-con',
      productLabel: 'Con semilla · Oaxaca', cls: cls2, packaging: 'granel', weightMode: 'directo', netDirectMilli: 300_000,
      netMilli: 280_000, confirmedAt: richAt(2), confirmedNetMilli: 300_000, stockMoveId: 'rcp:rec-2:in',
      corrections: [{ id: 'corr-1', at: richAt(4), reason: 'báscula', previousNetMilli: 300_000, newNetMilli: 280_000, deltaMilli: -20_000, stockMoveId: 'rcp:rec-2:c1' }],
    },
    {
      ...recBase, id: 'rec-3', folio: 3, status: 'anulada', createdAt: richAt(5), updatedAt: richAt(6), receivedAt: richAt(5), productId: 'p-con',
      productLabel: 'Con semilla · Oaxaca', cls: cls2, packaging: 'caja', containers: 5, weightMode: 'bruto_tara', grossMilli: 110_000, tareMilli: 10_000,
      netMilli: 0, confirmedAt: richAt(5), confirmedNetMilli: 100_000, stockMoveId: 'rcp:rec-3:in',
      voidedAt: richAt(6), voidReason: 'producto equivocado', voidStockMoveId: 'rcp:rec-3:void',
    },
    {
      ...recBase, id: 'rec-4', status: 'borrador', createdAt: richAt(7), updatedAt: richAt(7), receivedAt: richAt(7), productId: 'p-sin',
      packaging: 'caja', containers: 8, weightMode: 'por_envase',
    },
    {
      ...recBase, id: 'rec-5', status: 'cancelada', createdAt: richAt(8), updatedAt: richAt(9), receivedAt: richAt(8), productId: 'p-con',
      packaging: 'granel', weightMode: 'directo', netDirectMilli: 12_000, netMilli: 12_000, cancelledAt: richAt(9), cancelReason: 'borrador descartado',
    },
  ];
  const mv = (o: Partial<StockMove> & Pick<StockMove, 'id' | 'productId' | 'type' | 'deltaMilli' | 'note'>, at: number): StockMove => ({
    createdAt: richAt(at), reservedDeltaMilli: 0, ...o,
  });
  const stockMoves: StockMove[] = [
    mv({ id: 'rcp:rec-1:in', productId: 'p-sin', type: 'recepcion', deltaMilli: 150_000, note: 'Recepción R-1', receptionId: 'rec-1' }, 1),
    mv({ id: 'rcp:rec-2:in', productId: 'p-con', type: 'recepcion', deltaMilli: 300_000, note: 'Recepción R-2', receptionId: 'rec-2' }, 2),
    mv({ id: 'rcp:rec-2:c1', productId: 'p-con', type: 'correccion_recepcion', deltaMilli: -20_000, note: 'Corrección R-2: báscula', receptionId: 'rec-2' }, 4),
    mv({ id: 'rcp:rec-3:in', productId: 'p-con', type: 'recepcion', deltaMilli: 100_000, note: 'Recepción R-3', receptionId: 'rec-3' }, 5),
    mv({ id: 'rcp:rec-3:void', productId: 'p-con', type: 'reversa_recepcion', deltaMilli: -100_000, note: 'Anula R-3: producto equivocado', receptionId: 'rec-3' }, 6),
    mv({ id: 'mv-sale-1', productId: 'p-sin', type: 'venta', deltaMilli: -20_000, note: 'Folio 1', saleId: 'sale-1' }, 10),
    mv({ id: 'mv-sale-2', productId: 'p-sin', type: 'reserva', deltaMilli: 0, reservedDeltaMilli: 30_000, note: 'Vale V-1', saleId: 'sale-2' }, 11),
  ];
  const sales: Sale[] = [
    {
      id: 'sale-1', folio: 1, createdAt: richAt(10), day: RICH_DAY, shiftId: 'sh-1', totalCents: 60_000, paymentMethod: 'efectivo', receivedCents: 60_000,
      changeCents: 0, status: 'completada', delivery: 'inmediata',
      items: [{ productId: 'p-sin', name: 'Sin semilla · Primera · 2X', unit: 'kg', qtyMilli: 20_000, unitPriceCents: 3000, totalCents: 60_000, cls: cls1 }],
    },
    {
      id: 'sale-2', folio: 2, createdAt: richAt(11), day: RICH_DAY, shiftId: 'sh-1', totalCents: 90_000, paymentMethod: 'tarjeta', receivedCents: 90_000,
      changeCents: 0, status: 'completada', delivery: 'pendiente', valeFolio: 1, customerName: 'Doña Mary',
      items: [{ productId: 'p-sin', name: 'Sin semilla · Primera · 2X', unit: 'kg', qtyMilli: 30_000, unitPriceCents: 3000, totalCents: 90_000, cls: cls1 }],
    },
  ];
  const shifts: Shift[] = [{ id: 'sh-1', openedAt: richAt(0), openingCashCents: 20_000 }];
  const cashMovements: CashMovement[] = [{ id: 'cm-1', shiftId: 'sh-1', createdAt: richAt(12), type: 'salida', amountCents: 1_500, concept: 'bolsas' }];
  return {
    app: 'sistema-venta-limones', version: 2, exportedAt: richAt(60),
    products, sales, shifts, cashMovements, stockMoves, receptions, nextFolio: 3, nextValeFolio: 2, nextReceptionFolio: 4,
  };
}

/**
 * Respaldo v2 sencillo y coherente con `n` ventas de 1 kg ($30, efectivo exacto) de una sola variedad, un turno abierto y un
 * inventario inicial de 10 000 kg. Sirve para respaldos distinguibles (cuántas ventas trae) y para el caso grande.
 */
export function simpleV2(n: number, exportedAt = '2026-01-16T00:00:00.000Z'): LegacyBackup {
  const sales: Sale[] = [];
  const stockMoves: StockMove[] = [
    { id: 'sv-m0', productId: 'sv-p', createdAt: '2026-01-15T15:00:00.000Z', type: 'entrada', deltaMilli: 10_000_000, reservedDeltaMilli: 0, note: 'inventario inicial' },
  ];
  for (let i = 1; i <= n; i++) {
    sales.push({
      id: `sv-s${i}`, folio: i, createdAt: '2026-01-15T16:00:00.000Z', day: '2026-01-15', shiftId: 'sv-sh', totalCents: 3000, paymentMethod: 'efectivo',
      receivedCents: 3000, changeCents: 0, status: 'completada', delivery: 'inmediata',
      items: [{ productId: 'sv-p', name: 'Limón persa · Primera', unit: 'kg', qtyMilli: 1000, unitPriceCents: 3000, totalCents: 3000 }],
    });
    stockMoves.push({ id: `sv-m${i}`, productId: 'sv-p', createdAt: '2026-01-15T16:00:00.000Z', type: 'venta', deltaMilli: -1000, reservedDeltaMilli: 0, note: `Folio ${i}`, saleId: `sv-s${i}` });
  }
  return {
    app: 'sistema-venta-limones', version: 2, exportedAt,
    products: [{ id: 'sv-p', name: 'Limón persa', quality: 'Primera', unit: 'kg', priceCents: 3000, active: true, sort: 0, physicalMilli: 10_000_000 - n * 1000, reservedMilli: 0, updatedAt: '2026-01-15T16:00:00.000Z' }],
    sales,
    shifts: [{ id: 'sv-sh', openedAt: '2026-01-15T14:00:00.000Z', openingCashCents: 0 }],
    cashMovements: [],
    stockMoves,
    receptions: [],
    nextFolio: n + 1, nextValeFolio: 1, nextReceptionFolio: 1,
  };
}

// ═══════════════════════════════════════════ Auditoría y cifras INDEPENDIENTES de la app ═══════════════════════════════════════════

/** Dinero con el formato de la app (es-MX): 185600 → «$1,856.00». Solo da formato; las cantidades se calculan aparte. */
export const mxn = (cents: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 }).format(cents / 100);

/** Efectivo esperado de un turno, calculado desde los registros crudos: fondo + ventas en efectivo − salidas − devoluciones. */
export function cashExpected(raw: RawDb, shiftId: string): number {
  const shift = rowsOf(raw, 'shifts').find((s) => s.id === shiftId);
  if (!shift) throw new Error(`No existe el turno ${shiftId}`);
  const cashIn = rowsOf(raw, 'sales')
    .filter((s) => s.shiftId === shiftId && s.status === 'completada' && s.paymentMethod === 'efectivo')
    .reduce((a, s) => a + s.totalCents, 0);
  const cashOut = rowsOf(raw, 'cashMovements')
    .filter((m) => m.shiftId === shiftId)
    .reduce((a, m) => a + m.amountCents, 0);
  return shift.openingCashCents + cashIn - cashOut;
}

const RECEPTION_MOVES = ['recepcion', 'correccion_recepcion', 'reversa_recepcion'];

/**
 * Auditoría propia de las pruebas (NO usa la de la app): reconstruye desde los registros crudos que cada saldo es la suma de
 * sus movimientos, que lo reservado son los vales pendientes, que los folios no se repiten ni se salen del contador, que cada
 * venta cuadra y que cada recepción tiene exactamente los movimientos que le tocan. Vacío = todo cuadra.
 */
export function auditRaw(raw: RawDb): string[] {
  const bad: string[] = [];
  const products = rowsOf(raw, 'products');
  const sales = rowsOf(raw, 'sales');
  const moves = rowsOf(raw, 'stockMoves');
  const recs = rowsOf(raw, 'receptions');
  const cash = rowsOf(raw, 'cashMovements');
  const shifts = rowsOf(raw, 'shifts');
  const meta = metaOf(raw);
  const next = (k: string): number => (typeof meta[k] === 'number' ? (meta[k] as number) : 1);
  const repeated = (xs: number[]) => xs.filter((x, i) => xs.indexOf(x) !== i);

  for (const p of products) {
    const mv = moves.filter((m) => m.productId === p.id);
    const phys = mv.reduce((a, m) => a + m.deltaMilli, 0);
    const res = mv.reduce((a, m) => a + m.reservedDeltaMilli, 0);
    const pending = sales
      .filter((s) => s.delivery === 'pendiente')
      .flatMap((s) => s.items as Rec[])
      .filter((i) => i.productId === p.id)
      .reduce((a, i) => a + i.qtyMilli, 0);
    if (phys !== p.physicalMilli) bad.push(`«${p.name}»: físico ${p.physicalMilli} ≠ Σ movimientos ${phys}`);
    if (res !== p.reservedMilli) bad.push(`«${p.name}»: reservado ${p.reservedMilli} ≠ Σ movimientos ${res}`);
    if (pending !== p.reservedMilli) bad.push(`«${p.name}»: reservado ${p.reservedMilli} ≠ vales pendientes ${pending}`);
  }

  const saleFolios = sales.map((s) => s.folio);
  for (const f of repeated(saleFolios)) bad.push(`folio de venta repetido: ${f}`);
  for (const f of saleFolios) if (f >= next('nextFolio')) bad.push(`venta #${f} ≥ siguiente folio ${next('nextFolio')}`);
  const valeFolios = sales.filter((s) => s.valeFolio !== undefined).map((s) => s.valeFolio as number);
  for (const f of repeated(valeFolios)) bad.push(`folio de vale repetido: ${f}`);
  for (const f of valeFolios) if (f >= next('nextValeFolio')) bad.push(`vale V-${f} ≥ siguiente folio de vale ${next('nextValeFolio')}`);
  const recFolios = recs.filter((r) => r.folio !== undefined).map((r) => r.folio as number);
  for (const f of repeated(recFolios)) bad.push(`folio de recepción repetido: ${f}`);
  for (const f of recFolios) if (f >= next('nextReceptionFolio')) bad.push(`recepción R-${f} ≥ siguiente folio de recepción ${next('nextReceptionFolio')}`);

  for (const s of sales) {
    const lines = s.items as Rec[];
    for (const i of lines) {
      if (i.totalCents !== Math.round((i.unitPriceCents * i.qtyMilli) / 1000)) bad.push(`venta #${s.folio}: renglón mal calculado`);
    }
    if (lines.reduce((a, i) => a + i.totalCents, 0) !== s.totalCents) bad.push(`venta #${s.folio}: el total no es la suma de sus renglones`);
    if (s.paymentMethod === 'efectivo' && s.receivedCents - s.totalCents !== s.changeCents) bad.push(`venta #${s.folio}: cambio mal calculado`);
    if (!shifts.some((t) => t.id === s.shiftId)) bad.push(`venta #${s.folio}: su turno no existe`);
  }
  const refunded = sales.filter((s) => s.delivery === 'cancelado' && s.refundMethod === 'efectivo').reduce((a, s) => a + (s.refundCents ?? 0), 0);
  const refundMoves = cash.filter((m) => m.type === 'devolucion').reduce((a, m) => a + m.amountCents, 0);
  if (refunded !== refundMoves) bad.push(`devoluciones en efectivo ${refunded} ≠ movimientos de caja ${refundMoves}`);
  if (shifts.filter((s) => !s.closedAt).length > 1) bad.push('hay más de un turno abierto');

  for (const m of moves) {
    if (!products.some((p) => p.id === m.productId)) bad.push(`movimiento ${m.id}: su variedad no existe`);
    if (m.receptionId !== undefined && !recs.some((r) => r.id === m.receptionId)) bad.push(`movimiento ${m.id}: su recepción no existe`);
    if (RECEPTION_MOVES.includes(m.type) && m.receptionId === undefined) bad.push(`movimiento ${m.id} (${m.type}) sin recepción`);
    if (m.saleId !== undefined && !sales.some((s) => s.id === m.saleId)) bad.push(`movimiento ${m.id}: su venta no existe`);
  }

  for (const r of recs) {
    const tag = `recepción ${r.folio !== undefined ? `R-${r.folio}` : String(r.id).slice(0, 8)} (${r.status})`;
    const mine = moves.filter((m) => m.receptionId === r.id);
    const of = (t: string) => mine.filter((m) => m.type === t);
    if (r.productId !== undefined && !products.some((p) => p.id === r.productId)) bad.push(`${tag}: su variedad no existe`);
    if (r.status === 'borrador' || r.status === 'cancelada') {
      if (r.folio !== undefined) bad.push(`${tag}: no debería tener folio`);
      if (mine.length) bad.push(`${tag}: no debería tener movimientos (${mine.length})`);
      continue;
    }
    if (r.folio === undefined) bad.push(`${tag}: sin folio`);
    const entry = of('recepcion');
    if (entry.length !== 1) bad.push(`${tag}: ${entry.length} movimientos de recepción (debe ser 1)`);
    else {
      if (entry[0].deltaMilli !== r.confirmedNetMilli) bad.push(`${tag}: el movimiento sumó ${entry[0].deltaMilli} y se confirmaron ${r.confirmedNetMilli}`);
      if (entry[0].id !== r.stockMoveId) bad.push(`${tag}: stockMoveId no es el movimiento de recepción`);
    }
    if (of('correccion_recepcion').length !== (r.corrections as Rec[]).length) bad.push(`${tag}: correcciones y movimientos de corrección no coinciden`);
    const current = (r.confirmedNetMilli ?? 0) + (r.corrections as Rec[]).reduce((a, c) => a + c.deltaMilli, 0);
    if (r.status === 'confirmada') {
      if (r.netMilli !== current) bad.push(`${tag}: kilos vigentes ${r.netMilli} ≠ original + correcciones ${current}`);
      if (of('reversa_recepcion').length) bad.push(`${tag}: confirmada pero con reversa`);
    } else {
      const rev = of('reversa_recepcion');
      if (rev.length !== 1 || rev[0].deltaMilli !== -current) bad.push(`${tag}: la reversa no revierte exactamente ${current}`);
      if (r.netMilli !== 0) bad.push(`${tag}: anulada con kilos vigentes ${r.netMilli}`);
    }
  }
  return bad;
}

/**
 * Una «foto» cruda de la base (la forma que devuelve readRawDb) armada a partir de un respaldo, SIN navegador. Sirve para probar
 * la propia auditoría de las pruebas: acepta los datos de partida y detecta desajustes que se le inyectan a propósito.
 */
export function rawFromBackup(b: Rec, version = 2): RawDb {
  const key = (r: Rec, kp: string) => String(r[kp]);
  const store = (rows: Rec[], keyPath = 'id'): RawStore => ({
    keyPath,
    indexes: [],
    unique: [],
    // en el mismo orden que readRawDb (por clave), para poder comparar con toEqual
    rows: structuredClone(rows).sort((a, b) => (key(a, keyPath) < key(b, keyPath) ? -1 : key(a, keyPath) > key(b, keyPath) ? 1 : 0)),
  });
  return {
    name: DB_NAME,
    version,
    stores: {
      products: store(b.products),
      sales: store(b.sales),
      shifts: store(b.shifts),
      cashMovements: store(b.cashMovements),
      stockMoves: store(b.stockMoves),
      receptions: store(b.receptions ?? []),
      meta: store(metaRows(b), 'key'),
    },
  };
}

export const expectRawClean = (raw: RawDb | null, why: string) => {
  expect(raw, `${why}: la base debe existir`).not.toBeNull();
  expect(auditRaw(raw!), `${why}: la auditoría independiente debe salir limpia`).toEqual([]);
};

// ═══════════════════════════════════════════ Interfaz: avisos, descargas y archivos ═══════════════════════════════════════════

export const toastOf = (page: Page) => page.getByTestId('toast');
export const expectToast = (page: Page, text: string | RegExp) => expect(toastOf(page)).toContainText(text);
export async function expectErrorToast(page: Page, text: string | RegExp) {
  await expect(toastOf(page)).toHaveClass(/error/);
  await expect(toastOf(page)).toContainText(text);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Texto EXACTO (los filtros por texto de Playwright buscan subcadenas sin distinguir mayúsculas). */
export const exact = (s: string) => new RegExp(`^\\s*${escapeRe(s)}\\s*$`);

/** Espera a que la app muestre la caja (la base abrió bien). */
export const expectAppReady = (page: Page) => expect(page.getByTestId('caja')).toBeVisible();

export interface Download {
  filename: string;
  text: string;
  json: Rec;
}
/** Dispara una descarga y devuelve su nombre y su contenido ya leído. */
export async function captureDownload(page: Page, trigger: () => Promise<unknown>): Promise<Download> {
  const [dl] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const text = readFileSync(await dl.path(), 'utf8');
  return { filename: dl.suggestedFilename(), text, json: JSON.parse(text) };
}
/** Más → Exportar respaldo. */
export async function exportBackupUi(page: Page): Promise<Download> {
  await tab(page, 'mas');
  return captureDownload(page, () => page.getByTestId('export').click());
}

export type UploadFile = string | { name: string; mimeType: string; buffer: Buffer };
export const jsonFile = (data: unknown, name = 'respaldo.json'): UploadFile => ({
  name,
  mimeType: 'application/json',
  buffer: Buffer.from(JSON.stringify(data)),
});
/** El mismo archivo que se descargó, byte por byte (para restaurarlo en otro dispositivo). */
export const uploadOf = (d: Download): UploadFile => ({ name: d.filename, mimeType: 'application/json', buffer: Buffer.from(d.text) });
/** Un archivo con ese texto exacto (JSON roto, vacío…). */
export const textFile = (text: string, name = 'respaldo.json'): UploadFile => ({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
/** Más → elegir el archivo a restaurar (la hoja de restauración o un aviso de error aparecen solos). */
export async function chooseBackup(page: Page, file: UploadFile): Promise<void> {
  await tab(page, 'mas');
  await page.getByTestId('import-file').setInputFiles(file);
}
/** En la hoja de restauración: marca «Entiendo…» si la hoja lo exige y confirma. */
export async function confirmRestoreSheet(page: Page, done: string | RegExp = 'Respaldo restaurado'): Promise<void> {
  await expect(page.getByTestId('restore-sheet')).toBeVisible();
  const understood = page.getByTestId('restore-understood');
  if (await understood.count()) await understood.check();
  await expect(page.getByTestId('restore-confirm')).toBeEnabled();
  await page.getByTestId('restore-confirm').click();
  await expectToast(page, done);
  await expect(page.getByTestId('restore-sheet')).toBeHidden();
}
/**
 * Texto del resultado de la auditoría sin problemas: «Sin inconsistencias (N ventas, N vales, N recepciones, N movimientos)».
 * Verifica las CUENTAS exactas; con 1 acepta singular o plural («1 vale» o «1 vales»), porque aquí no se prueba la redacción
 * (el singular de los avisos se prueba aparte, en respaldo.spec.ts). Sin `movimientos`, solo comprueba el principio del texto.
 */
export function auditoriaOk(ventas: number, vales: number, recepciones: number, movimientos?: number): RegExp {
  const cuenta = (n: number, singular: string, plural: string) => (n === 1 ? `1 (?:${singular}|${plural})` : `${n} ${plural}`);
  const partes = [cuenta(ventas, 'venta', 'ventas'), cuenta(vales, 'vale', 'vales'), cuenta(recepciones, 'recepción', 'recepciones')];
  if (movimientos !== undefined) partes.push(cuenta(movimientos, 'movimiento', 'movimientos'));
  return new RegExp(`Sin inconsistencias \\(${partes.join(', ')}${movimientos !== undefined ? '\\)' : ''}`);
}
/** Más → Auditar integridad; devuelve el bloque con el resultado. */
export async function runAuditUi(page: Page): Promise<Locator> {
  await tab(page, 'mas');
  await page.getByTestId('audit').click();
  const result = page.getByTestId('audit-result');
  await expect(result).toBeVisible();
  return result;
}

export interface InvRow {
  label: string;
  physical: string;
  reserved: string;
  available: string;
}
/** Lo que SE VE en Inventario: una fila por variedad con en bodega / apartado / disponible. */
export async function uiInventory(page: Page): Promise<InvRow[]> {
  await tab(page, 'inventario');
  await expect(page.getByTestId('inventario')).toBeVisible();
  const rows = page.getByTestId('inv-row');
  await expect(rows.first()).toBeVisible();
  return rows.evaluateAll((els) =>
    els.map((el) => {
      const t = (id: string) => el.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? '';
      return { label: el.querySelector('header strong')?.textContent?.trim() ?? '', physical: t('stock-physical'), reserved: t('stock-reserved'), available: t('stock-available') };
    }),
  );
}
export const invRow = (page: Page, label: string | RegExp) =>
  page.getByTestId('inv-row').filter({ has: page.locator('header strong').filter({ hasText: typeof label === 'string' ? exact(label) : label }) });

// ═══════════════════════════════════════════ Interfaz: recepción y ventas por la pantalla ═══════════════════════════════════════════

export interface ReceiveOpts {
  /** Texto EXACTO del chip de variedad («Limón persa», «Con semilla»…). */
  variety: string;
  /** Texto exacto del chip de clasificación («Primera»…), si la variedad tiene varias. */
  cls?: string;
  packaging: 'granel' | 'caja' | 'arpilla';
  mode: 'directo' | 'por_envase' | 'bruto_tara';
  net?: string;
  containers?: string;
  unit?: string;
  gross?: string;
  tare?: string;
  supplier?: string;
  reference?: string;
}
/** Recepción › Nueva: elige variedad, presentación y modo de peso (siempre explícito, la app recuerda el último) y captura. */
export async function fillReception(page: Page, o: ReceiveOpts): Promise<void> {
  await tab(page, 'recepcion');
  await page.getByTestId('rec-sub-nueva').click();
  await expect(page.getByTestId('rec-nueva')).toBeVisible();
  await page.getByTestId('rec-variety').filter({ hasText: exact(o.variety) }).click();
  if (o.cls) await page.getByTestId('rec-class').filter({ hasText: exact(o.cls) }).click();
  await page.getByTestId(`rec-pack-${o.packaging}`).click();
  await expect(page.getByTestId(`rec-pack-${o.packaging}`)).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId(`rec-mode-${o.mode}`).click();
  await expect(page.getByTestId(`rec-mode-${o.mode}`)).toHaveAttribute('aria-checked', 'true');
  if (o.net !== undefined) await page.getByTestId('rec-net-direct').fill(o.net);
  if (o.containers !== undefined) await page.getByTestId('rec-containers').fill(o.containers);
  if (o.unit !== undefined) await page.getByTestId('rec-unit-net').fill(o.unit);
  if (o.gross !== undefined) await page.getByTestId('rec-gross').fill(o.gross);
  if (o.tare !== undefined) await page.getByTestId('rec-tare').fill(o.tare);
  if (o.supplier !== undefined) await page.getByTestId('rec-supplier').fill(o.supplier);
  if (o.reference !== undefined) await page.getByTestId('rec-reference').fill(o.reference);
}
/** «Registrar recepción» → hoja → confirmar. `milli` comprueba los kilos EXACTOS de la hoja (data-milli) antes de confirmar. */
export async function registerReception(page: Page, expected: { toast: string | RegExp; milli?: number; ack?: boolean }): Promise<void> {
  await page.getByTestId('rec-confirm').click();
  await expect(page.getByTestId('rec-sheet')).toBeVisible();
  if (expected.milli !== undefined) await expect(page.getByTestId('rec-sheet-net')).toHaveAttribute('data-milli', String(expected.milli));
  await page.getByTestId(expected.ack ? 'rec-dup-ack' : 'rec-confirm-yes').click();
  await expectToast(page, expected.toast);
  await expect(page.getByTestId('rec-sheet')).toBeHidden();
}
export async function saveReceptionDraftUi(page: Page, toast: string | RegExp): Promise<void> {
  await page.getByTestId('rec-save-draft').click();
  await expectToast(page, toast);
}
export async function receive(page: Page, o: ReceiveOpts, expected: { toast: string | RegExp; milli?: number }): Promise<void> {
  await fillReception(page, o);
  await registerReception(page, expected);
}

async function openRecHistory(page: Page, filter: 'confirmada' | 'anulada' | 'cancelada' | 'todas' = 'confirmada') {
  await tab(page, 'recepcion');
  await page.getByTestId('rec-sub-historial').click();
  await page.getByTestId(`rec-filter-${filter}`).click();
}
export const recRow = (page: Page, folio: number) => page.getByTestId('rec-row').filter({ hasText: new RegExp(`R-${folio} ·`) });

export async function correctReceptionUi(page: Page, folio: number, kg: string, reason: string): Promise<void> {
  await openRecHistory(page);
  const row = recRow(page, folio);
  await row.getByTestId('rec-correct').click();
  await row.getByTestId('rec-correct-qty').fill(kg);
  await row.getByTestId('rec-correct-reason').fill(reason);
  await row.getByTestId('rec-correct-save').click();
  await expectToast(page, `Recepción R-${folio} corregida`);
}
export async function voidReceptionUi(page: Page, folio: number, reason: string): Promise<void> {
  await openRecHistory(page);
  const row = recRow(page, folio);
  await row.getByTestId('rec-void').click();
  await row.getByTestId('rec-void-reason').fill(reason);
  await row.getByTestId('rec-void-confirm').click();
  await expectToast(page, `Recepción R-${folio} anulada`);
}
/** Recepción › Borradores: descarta el borrador cuya tarjeta contiene `hasText`. */
export async function discardDraftUi(page: Page, hasText: string | RegExp): Promise<void> {
  await tab(page, 'recepcion');
  await page.getByTestId('rec-sub-borradores').click();
  const row = page.getByTestId('rec-draft-row').filter({ hasText });
  await row.getByTestId('rec-draft-cancel').click();
  await row.getByTestId('rec-draft-cancel-yes').click();
  await expectToast(page, 'Borrador descartado: no cambió el inventario');
}

/** Vale pagado en efectivo exacto de la variedad que la caja trae elegida. */
export async function sellVale(page: Page, kg: string, customer: string): Promise<void> {
  await tab(page, 'caja');
  await page.getByTestId('kg').fill(kg);
  await page.getByTestId('exact').click();
  await page.getByTestId('is-vale').check();
  await page.getByTestId('customer').fill(customer);
  await charge(page);
}
/** Venta normal pagada exacta de la variedad que la caja trae elegida. */
export async function sellExact(page: Page, kg: string): Promise<void> {
  await tab(page, 'caja');
  await page.getByTestId('kg').fill(kg);
  await page.getByTestId('exact').click();
  await charge(page);
}

// ═══════════════════════════════════════════ Pantallas de teléfono (copiado de teclado.spec.ts) ═══════════════════════════════════════════

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

/** Elementos que se salen de la pantalla a lo ancho (vacío = sin desbordamiento horizontal). */
export async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const bad: string[] = [];
    if (document.documentElement.scrollWidth > vw) bad.push(`documento: ancho ${document.documentElement.scrollWidth} > ${vw}`);
    const sel = 'button, input, select, textarea, h1, h2, h3, p, label, summary, dt, dd, li, .chip';
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
        // Después de cada click se olvida el botón y su posición: un click SIN dedo (el `<a download>` que la propia app dispara)
        // no hereda la posición del toque anterior.
        pressed = null;
        down = [];
        up = [];
      },
      true,
    );
  });
}
const taps = (page: Page) => page.evaluate(() => (window as unknown as { __taps: TapRecord[] }).__taps);
/**
 * El botón recibió el click y NO se movió entre el inicio y el final del toque (el «toque perdido» del teclado). Los clicks
 * SIN dedo encima (p. ej. el `<a download>` que la propia app dispara para bajar un archivo) no cuentan como toques.
 */
export async function expectSolidTap(page: Page, testid: string) {
  const pressed = async () => (await taps(page)).filter((t) => t.down.length > 0);
  await expect.poll(async () => (await pressed()).length, { message: 'el toque no produjo ningún click sobre un botón' }).toBeGreaterThan(0);
  const all = await pressed();
  const tap = all[all.length - 1];
  expect(tap.testid).toBe(testid);
  expect(tap.onButton, 'el click cayó en otro elemento (el botón se movió bajo el dedo)').toBe(true);
  expect(tap.up, 'el botón cambió de lugar entre que se puso el dedo y se levantó').toEqual(tap.down);
}
/** El elemento cabe completo en la ventana (nada recortado arriba, abajo ni a los lados). */
export async function expectInsideViewport(page: Page, l: Locator, what: string) {
  const r = await rectOf(l);
  const vw = page.viewportSize()?.width ?? 0;
  const vh = page.viewportSize()?.height ?? 0;
  expect(r.top, `${what}: se sale por arriba`).toBeGreaterThanOrEqual(-0.5);
  expect(r.bottom, `${what}: se sale por abajo (ventana de ${vh} px)`).toBeLessThanOrEqual(vh + 0.5);
  expect(r.left, `${what}: se sale por la izquierda`).toBeGreaterThanOrEqual(-0.5);
  expect(r.right, `${what}: se sale por la derecha (ventana de ${vw} px)`).toBeLessThanOrEqual(vw + 0.5);
}

// ═══════════════════════════════════════════ Reinicio real: perfil persistente ═══════════════════════════════════════════

/**
 * Abre Chromium con un PERFIL en disco (como el teléfono con la app instalada). Cerrar el contexto cierra el navegador por
 * completo; volver a abrirlo con la misma carpeta es un reinicio real: lo único que sobrevive es lo guardado en disco.
 */
export async function launchProfile(testInfo: TestInfo, dir: string): Promise<BrowserContext> {
  const pixel = devices['Pixel 7'];
  return chromium.launchPersistentContext(dir, {
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox'],
    baseURL: testInfo.project.use.baseURL,
    userAgent: pixel.userAgent,
    viewport: pixel.viewport,
    deviceScaleFactor: pixel.deviceScaleFactor,
    isMobile: pixel.isMobile,
    hasTouch: pixel.hasTouch,
    timezoneId: 'America/Mexico_City',
    locale: 'es-MX',
    serviceWorkers: 'allow',
  });
}

// ═══════════════════════════════════════════ La app ANTERIOR real, compilada y servida ═══════════════════════════════════════════

/** Último commit con la base en versión 1 (la app que está en el teléfono del negocio). */
export const COMMIT_APP_ANTERIOR = '4038e75';

/**
 * Compila la app ANTERIOR (v1) tal como quedó en el commit de referencia y devuelve la carpeta lista para servir. Solo LEE el
 * repositorio (`git archive`): no cambia nada de él. Falla con un mensaje claro si ese commit ya no es la versión 1.
 */
export function compilarAppAnterior(testInfo: TestInfo): string {
  const root = raizDelProyecto();
  const src = testInfo.outputPath('app-anterior');
  mkdirSync(src, { recursive: true });
  execFileSync('sh', ['-c', `git archive ${COMMIT_APP_ANTERIOR} src index.html public vite.config.ts tsconfig.json package.json | tar -x -C "${src}"`], { cwd: root, stdio: 'pipe' });
  const repo = readFileSync(join(src, 'src/db/repo.ts'), 'utf8');
  if (!/export const DB_VERSION = 1;/.test(repo)) throw new Error(`El commit ${COMMIT_APP_ANTERIOR} ya no es la versión 1 de la base (DB_VERSION distinto de 1)`);
  // Dentro del proyecto, Node encuentra node_modules subiendo de carpeta; solo si los resultados están fuera hace falta el enlace.
  if (!src.startsWith(root + sep)) symlinkSync(join(root, 'node_modules'), join(src, 'node_modules'));
  const out = join(src, 'dist');
  execFileSync('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir'], { cwd: src, stdio: 'pipe', timeout: 180_000 });
  return out;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
export interface ServidorEstatico {
  port: number;
  close: () => Promise<void>;
}
/**
 * Sirve una carpeta (una app compilada) por HTTP sin caché. Con `port` fijo se puede CAMBIAR de versión en el mismo origen:
 * se apaga un servidor y se enciende otro en el mismo puerto, como cuando se actualiza la app en el equipo que la sirve.
 */
export function servirCarpeta(dir: string, port = 0): Promise<ServidorEstatico> {
  return new Promise((ok, fallo) => {
    const base = resolve(dir);
    const server = createServer((req, res) => {
      let rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = resolve(base, '.' + rel);
      if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('no encontrado');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(readFileSync(file));
    });
    server.on('error', fallo);
    server.listen(port, '127.0.0.1', () =>
      ok({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((fin) => {
            server.closeAllConnections();
            server.close(() => fin());
          }),
      }),
    );
  });
}
