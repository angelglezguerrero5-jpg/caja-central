import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import { checkPayment, toSaleItems } from '../domain/cart';
import {
  canonicalizeClass,
  classValueError,
  classificationKey,
  classificationOf,
  cleanClassValue,
  productLabel,
} from '../domain/classification';
import { MAX_CONCEPT, MAX_NAME, MAX_REASON, checkedText } from '../domain/limits';
import { MAX_MONEY_CENTS, MAX_PRICE_CENTS, MAX_QTY_MILLI, MAX_STOCK_MILLI } from '../domain/money';
import { validateFreightSettings } from '../domain/freight';
import { buildShiftReport, localDay } from '../domain/report';
import { validateBackup } from './backup';
import type {
  Backup,
  CartLine,
  CashMovement,
  Freight,
  FreightSettings,
  PaymentMethod,
  Product,
  Reception,
  RefundMethod,
  Sale,
  Shift,
  StockMove,
  StockMoveType,
  Unit,
} from '../domain/types';

type MetaKey = 'nextFolio' | 'nextValeFolio' | 'nextReceptionFolio' | 'currentShiftId' | 'cartDraft' | 'freightSettings';

interface LimonesDB extends DBSchema {
  products: { key: string; value: Product };
  sales: {
    key: string;
    value: Sale;
    indexes: { byDay: string; byShift: string; byFolio: number; byDelivery: string };
  };
  shifts: { key: string; value: Shift; indexes: { byOpenedAt: string } };
  cashMovements: { key: string; value: CashMovement; indexes: { byShift: string } };
  stockMoves: { key: string; value: StockMove; indexes: { byProduct: string; byReception: string } };
  receptions: {
    key: string;
    value: Reception;
    indexes: { byStatus: string; byDay: string; byProduct: string; byFolio: number };
  };
  freights: { key: string; value: Freight; indexes: { byFolioKey: string; byStatus: string; byDay: string } };
  meta: { key: MetaKey; value: { key: MetaKey; value: unknown } };
}

export type DB = IDBPDatabase<LimonesDB>;

export const DB_NAME = 'venta-limones';
export const DB_VERSION = 3;

// Las migraciones trabajan con el API crudo de idb (sin el esquema tipado): tocan versiones viejas.
export type Migration = (db: IDBPDatabase<unknown>, tx: IDBPTransaction<unknown, string[], 'versionchange'>) => void;

/**
 * Migraciones por versión. Reglas: nunca borrar stores ni datos; solo crear lo que falte
 * (idempotente) y rellenar campos nuevos. Cada versión nueva agrega una entrada aquí
 * y sube DB_VERSION. IndexedDB ejecuta el upgrade en una transacción: si falla, se
 * revierte completo y la base queda en la versión anterior con sus datos intactos.
 */
export const MIGRATIONS: Record<number, Migration> = {
  1: (db) => {
    const make = (name: string, opts: IDBObjectStoreParameters) =>
      db.objectStoreNames.contains(name) ? undefined : db.createObjectStore(name, opts);
    make('products', { keyPath: 'id' });
    const sales = make('sales', { keyPath: 'id' });
    if (sales) {
      sales.createIndex('byDay', 'day');
      sales.createIndex('byShift', 'shiftId');
      sales.createIndex('byFolio', 'folio', { unique: true });
      sales.createIndex('byDelivery', 'delivery');
    }
    const shifts = make('shifts', { keyPath: 'id' });
    shifts?.createIndex('byOpenedAt', 'openedAt');
    const cash = make('cashMovements', { keyPath: 'id' });
    cash?.createIndex('byShift', 'shiftId');
    const stock = make('stockMoves', { keyPath: 'id' });
    stock?.createIndex('byProduct', 'productId');
    make('meta', { keyPath: 'key' });
  },
  // v2: recepción de mercancía. Solo AÑADE (store e índice); no toca productos, ventas, vales, turnos ni movimientos.
  2: (db, tx) => {
    if (!db.objectStoreNames.contains('receptions')) {
      const r = db.createObjectStore('receptions', { keyPath: 'id' });
      r.createIndex('byStatus', 'status');
      r.createIndex('byDay', 'day');
      r.createIndex('byProduct', 'productId');
      r.createIndex('byFolio', 'folio', { unique: true });
    }
    const moves = tx.objectStore('stockMoves');
    if (!moves.indexNames.contains('byReception')) moves.createIndex('byReception', 'receptionId');
  },
  // v3: control de pesaje por flete. Solo AÑADE un almacén (con el folio único como índice); no toca nada de lo anterior.
  3: (db) => {
    if (!db.objectStoreNames.contains('freights')) {
      const f = db.createObjectStore('freights', { keyPath: 'id' });
      f.createIndex('byFolioKey', 'folioKey', { unique: true });
      f.createIndex('byStatus', 'status');
      f.createIndex('byDay', 'day');
    }
  },
};

export interface OpenOptions {
  /** Solo para pruebas: simula versiones futuras del esquema. */
  version?: number;
  migrations?: Record<number, Migration>;
  /** Se llama si otra pestaña pide actualizar el esquema y esta debe cerrarse. */
  onBlocking?: () => void;
  /** Se llama en la pestaña NUEVA cuando otra pestaña (versión anterior) todavía tiene la base abierta y impide actualizar. */
  onBlocked?: () => void;
  /**
   * Se llama si el NAVEGADOR cierra la conexión por su cuenta (no cuando la app llama a close()). Pasa, por ejemplo, en
   * iPhone cuando la app estuvo suspendida mucho rato: la conexión muere y hay que volver a abrir la base.
   */
  onTerminated?: () => void;
  /** Se llama cuando el esquema de una base que YA existía se actualizó (no en una instalación nueva). */
  onUpgrade?: (oldVersion: number, newVersion: number) => void;
}

// Los helpers internos reciben transacciones con distintos conjuntos de
// stores; se tipan de forma laxa para no pelear con los genéricos de idb.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTx = any;

/** crypto.randomUUID solo existe en contextos seguros; en LAN por http no. */
export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    try {
      return crypto.randomUUID();
    } catch {
      /* contexto no seguro: se usa el respaldo */
    }
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function openDatabase(name = DB_NAME, opts: OpenOptions = {}): Promise<DB> {
  const version = opts.version ?? DB_VERSION;
  const migrations = { ...MIGRATIONS, ...opts.migrations };
  let ref: DB | undefined;
  let upgradedFrom: number | undefined;
  return openDB<LimonesDB>(name, version, {
    upgrade(db, oldVersion, _newVersion, tx) {
      tx.done.catch(() => undefined); // si una migración falla, el error llega por openDB
      for (let v = oldVersion + 1; v <= version; v++) {
        migrations[v]?.(db as unknown as IDBPDatabase<unknown>, tx as never);
      }
      if (oldVersion >= 1) upgradedFrom = oldVersion;
    },
    // Otra pestaña con una versión anterior sigue abierta y bloquea la actualización: se avisa en esta.
    blocked() {
      opts.onBlocked?.();
    },
    // Otra pestaña con una versión nueva espera: se cierra esta conexión para no bloquearla.
    blocking() {
      ref?.close();
      opts.onBlocking?.();
    },
    terminated() {
      opts.onTerminated?.();
    },
  }).then((db) => {
    ref = db;
    // Solo si la actualización terminó bien (si falla, openDB rechaza y nunca se llega aquí).
    if (upgradedFrom !== undefined) opts.onUpgrade?.(upgradedFrom, version);
    return db;
  });
}

export const now = () => new Date().toISOString();

/**
 * Abre una transacción de escritura. El rechazo de `tx.done` se marca como
 * manejado (el error igual llega a quien hace `await`), así un fallo no
 * termina como "unhandled rejection".
 */
function rw(db: DB, stores: string[]): AnyTx {
  // durability 'strict': el navegador no confirma hasta que el dato esté en disco (un apagón justo después de
  // "Venta guardada" o "Recepción registrada" no debe perder esa última escritura).
  const tx = db.transaction(stores as never, 'readwrite', { durability: 'strict' } as never);
  tx.done.catch(() => undefined);
  return tx;
}

/**
 * Ejecuta `fn` dentro de una transacción de escritura ATÓMICA: si `fn` lanza cualquier
 * excepción (incluidas las síncronas de IndexedDB como DataError, que NO abortan la
 * transacción por sí solas) se aborta y se revierte todo. Sin esto, la transacción se
 * confirmaría con lo escrito hasta ese momento.
 */
/** @internal expuesta para pruebas */
export async function runRw<T>(db: DB, stores: string[], fn: (tx: AnyTx) => Promise<T>): Promise<T> {
  const tx = rw(db, stores);
  try {
    const result = await fn(tx);
    await tx.done;
    return result;
  } catch (e) {
    try {
      tx.abort();
    } catch {
      /* ya estaba terminada/abortada */
    }
    throw e;
  }
}

/** Aborta la transacción y devuelve el error para lanzarlo. */
export function abortWith(tx: AnyTx, message: string): Error {
  try {
    tx.abort();
  } catch {
    /* ya terminada */
  }
  return new Error(message);
}

function assertPositiveInt(n: number, msg: string) {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(msg);
}

export interface Shortage {
  productId: string;
  name: string;
  availableMilli: number;
  neededMilli: number;
}

/** Se lanza cuando la operación dejaría la existencia DISPONIBLE en negativo sin autorización. */
export class InsufficientStockError extends Error {
  constructor(public shortages: Shortage[]) {
    super(
      'Existencia disponible insuficiente: ' +
        shortages
          .map((s) => `${s.name} (disponible ${s.availableMilli / 1000}, se piden ${s.neededMilli / 1000})`)
          .join('; '),
    );
  }
}

/** La operación dejaría el disponible en negativo; se necesita autorización explícita para continuar. */
export class NegativeStockError extends Error {
  constructor(
    public availableAfterMilli: number,
    public label: string,
    public reservedMilli: number,
  ) {
    super(
      `Quedaría disponible negativo (${availableAfterMilli / 1000} kg) en ${label}` +
        (reservedMilli > 0 ? ` (hay ${reservedMilli / 1000} kg reservados en vales)` : '') +
        '. Se requiere autorización.',
    );
  }
}

export function availableMilli(p: Product): number {
  return p.physicalMilli - p.reservedMilli;
}

export const DEFAULT_PRODUCTS: Array<Pick<Product, 'name' | 'quality' | 'unit' | 'priceCents'>> = [
  { name: 'Limón persa', quality: 'Primera', unit: 'kg', priceCents: 3000 },
  { name: 'Limón persa', quality: 'Segunda', unit: 'kg', priceCents: 2000 },
  { name: 'Limón con semilla', unit: 'kg', priceCents: 3500 },
];

/**
 * SOLO PRUEBAS/DEMOSTRACIÓN: inserta variedades con precios de ejemplo si la base está vacía.
 * La aplicación NO la llama: no debe inventar variedades, precios ni inventario del negocio.
 */
export async function seedIfEmpty(db: DB): Promise<boolean> {
  return runRw(db, ['products'], async (tx) => {
    const store = tx.objectStore('products');
    if ((await store.count()) > 0) {
      return false;
    }
    for (const [i, p] of DEFAULT_PRODUCTS.entries()) {
      await store.put({
        ...p,
        id: newId(),
        active: true,
        sort: i,
        physicalMilli: 0,
        reservedMilli: 0,
        updatedAt: now(),
      });
    }
    return true;
  });
}

// ---------- Variedades ----------

export async function listProducts(db: DB): Promise<Product[]> {
  const all = await db.getAll('products');
  return all.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

export async function getProduct(db: DB, id: string): Promise<Product | undefined> {
  return db.get('products', id);
}

export interface ProductInput {
  id?: string;
  /** Tipo / variedad. */
  name: string;
  origin?: string;
  quality?: string;
  caliber?: string;
  unit: Unit;
  /** Centavos por unidad. Debe ser > 0, salvo que `pendingPrice` sea true (entonces 0). */
  priceCents: number;
  /** true = "sin precio todavía": se necesita para dar de alta una clasificación sin inventar un precio. */
  pendingPrice?: boolean;
  active: boolean;
}

const UNIT_LIST: readonly Unit[] = ['kg', 'pieza', 'caja', 'arpilla'];

/**
 * Crea o edita un producto (combinación variedad · procedencia · calidad · calibre · unidad).
 * La existencia NO se edita aquí (usa movimientos). Los textos se canonizan contra los valores ya conocidos para
 * no crear duplicados por diferencias de escritura, y dos productos con la misma clave no pueden coexistir.
 */
export async function saveProduct(db: DB, input: ProductInput): Promise<Product> {
  if (!UNIT_LIST.includes(input.unit)) throw new Error('Unidad inválida');
  if (input.pendingPrice) {
    if (input.priceCents !== 0) throw new Error('Un producto sin precio debe tener precio 0');
  } else {
    assertPositiveInt(input.priceCents, 'El precio debe ser mayor a cero');
    if (input.priceCents > MAX_PRICE_CENTS) throw new Error('El precio es demasiado alto');
  }
  return runRw(db, ['products', 'stockMoves'], async (tx) => {
    const store = tx.objectStore('products');
    const existing: Product | undefined = input.id ? await store.get(input.id) : undefined;
    const all: Product[] = await store.getAll();

    // Los límites de texto y la unicidad se exigen solo al CREAR o al CAMBIAR un campo de clasificación: los datos
    // anteriores (que pudieron guardarse con reglas más flexibles) no impiden editar el precio u ocultar el producto.
    const fieldsIn = [
      ['name', input.name, 'Variedad'],
      ['origin', input.origin, 'Procedencia'],
      ['quality', input.quality, 'Calidad'],
      ['caliber', input.caliber, 'Calibre'],
    ] as const;
    const unchanged = (f: (typeof fieldsIn)[number][0], raw: string | undefined) =>
      !!existing && cleanClassValue(raw) === (existing[f] ?? '');
    for (const [f, raw, label] of fieldsIn) {
      if (unchanged(f, raw)) continue;
      const e = classValueError(raw, label);
      if (e) throw abortWith(tx, e);
    }
    // Misma función que usa la vista previa del formulario: lo que se muestra es lo que se guarda.
    const { name, origin, quality, caliber } = canonicalizeClass(all, input, existing);
    if (!name) throw abortWith(tx, 'El nombre de la variedad es obligatorio');
    const candidate = { name, origin, quality, caliber, unit: input.unit };
    const changedClass = !existing || classificationKey(existing) !== classificationKey(candidate);
    if (changedClass) {
      const dup = all.find((p) => p.id !== existing?.id && classificationKey(p) === classificationKey(candidate));
      if (dup) throw abortWith(tx, `Ya existe esa clasificación: ${productLabel(dup)}`);
    }
    if (existing && existing.unit !== input.unit) {
      const moves: number = await tx.objectStore('stockMoves').index('byProduct').count(existing.id);
      if (moves > 0 || existing.physicalMilli !== 0 || existing.reservedMilli !== 0) {
        throw abortWith(tx, 'No se puede cambiar la unidad de un producto que ya tiene movimientos');
      }
    }
    // Bitácora: si cambió cómo se escribe la clasificación de un producto que ya existía, queda el antes y el después.
    const edits = [...(existing?.classEdits ?? [])];
    if (existing) {
      const textChanged = (['name', 'origin', 'quality', 'caliber'] as const).some(
        (f) => (existing[f] ?? '') !== ({ name, origin, quality, caliber }[f] ?? ''),
      );
      if (textChanged) edits.push({ at: now(), before: classificationOf(existing), after: classificationOf({ name, origin, quality, caliber }) });
    }
    const product: Product = {
      id: existing?.id ?? input.id ?? newId(),
      name,
      ...(quality ? { quality } : {}),
      ...(origin ? { origin } : {}),
      ...(caliber ? { caliber } : {}),
      unit: input.unit,
      priceCents: input.priceCents,
      active: input.active,
      sort: existing?.sort ?? (await store.count()),
      physicalMilli: existing?.physicalMilli ?? 0,
      reservedMilli: existing?.reservedMilli ?? 0,
      updatedAt: now(),
      ...(edits.length ? { classEdits: edits } : {}),
    };
    await store.put(product);
    return product;
  });
}

/** Muestra u oculta un producto en la caja y en la recepción (no toca precio ni clasificación). */
export async function setProductActive(db: DB, productId: string, active: boolean): Promise<Product> {
  return runRw(db, ['products'], async (tx) => {
    const p: Product | undefined = await tx.objectStore('products').get(productId);
    if (!p) throw abortWith(tx, 'Variedad no encontrada');
    const updated = { ...p, active, updatedAt: now() };
    await tx.objectStore('products').put(updated);
    return updated;
  });
}

/** Cambia solo el precio (desde la caja). Persistente para las siguientes ventas. */
export async function setPrice(db: DB, productId: string, priceCents: number): Promise<Product> {
  assertPositiveInt(priceCents, 'El precio debe ser mayor a cero');
  if (priceCents > MAX_PRICE_CENTS) throw new Error('El precio es demasiado alto');
  return runRw(db, ['products'], async (tx) => {
    const p: Product | undefined = await tx.objectStore('products').get(productId);
    if (!p) throw abortWith(tx, 'Variedad no encontrada');
    const updated = { ...p, priceCents, updatedAt: now() };
    await tx.objectStore('products').put(updated);
    return updated;
  });
}

// ---------- Inventario ----------

export async function moveStock(
  tx: AnyTx,
  productId: string,
  type: StockMoveType,
  deltaMilli: number,
  reservedDeltaMilli: number,
  note: string,
  at: string,
  saleId?: string,
  receptionId?: string,
  moveId?: string,
  authorizedNegativeAfterMilli?: number,
): Promise<Product | undefined> {
  const store = tx.objectStore('products');
  const p: Product | undefined = await store.get(productId);
  if (!p) return undefined; // variedad borrada: la venta sigue siendo válida
  const physical = p.physicalMilli + deltaMilli;
  const reserved = p.reservedMilli + reservedDeltaMilli;
  if (
    !Number.isSafeInteger(physical) || !Number.isSafeInteger(reserved) ||
    Math.abs(physical) > MAX_STOCK_MILLI || Math.abs(reserved) > MAX_STOCK_MILLI
  ) {
    throw new Error('El inventario de esta variedad excedería el máximo permitido');
  }
  const updated: Product = { ...p, physicalMilli: physical, reservedMilli: reserved, updatedAt: at };
  await store.put(updated);
  const move: StockMove = {
    id: moveId ?? newId(),
    productId,
    createdAt: at,
    type,
    deltaMilli,
    reservedDeltaMilli,
    note,
    ...(saleId ? { saleId } : {}),
    ...(receptionId ? { receptionId } : {}),
    ...(authorizedNegativeAfterMilli !== undefined ? { authorizedNegativeAfterMilli } : {}),
  };
  await tx.objectStore('stockMoves').add(move); // add: un id repetido choca y revierte la transacción
  return updated;
}

/**
 * ¿Una autorización cubre este disponible resultante? `true` = cualquiera; un número = piso autorizado (el disponible
 * que se le MOSTRÓ a la persona): si entre el aviso y el reintento otra operación empeoró el resultado, ya no cubre.
 */
export function negativeAuthorized(allow: boolean | number, availableAfterMilli: number): boolean {
  return allow === true || (typeof allow === 'number' && availableAfterMilli >= allow);
}

/** Se registra a mano una entrada de una clasificación que acaba de recibirse en Recepción: posible doble conteo. */
export class ManualEntryWarningError extends Error {
  constructor(public receptions: Reception[]) {
    super(
      'Hace poco se registró en Recepción mercancía de esta misma clasificación (' +
        receptions.map((r) => `R-${r.folio}`).join(', ') +
        '). Si esta entrada es la misma mercancía, se contaría dos veces.',
    );
  }
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * Movimiento manual de inventario.
 *  - entrada: existencia inicial o mercancía que no viene de un proveedor (+qty físico). Lo que llega de un proveedor
 *    se registra en Recepción; si hay una recepción reciente de la misma clasificación se pide reconocer el aviso.
 *  - merma: producto echado a perder (−qty físico)
 *  - ajuste: conteo físico; `qtyMilli` es la existencia física REAL contada.
 * `allowNegative`: false = pedir autorización; true = autorizar cualquier resultado; número = piso autorizado.
 */
export async function addStockMove(
  db: DB,
  productId: string,
  type: 'entrada' | 'merma' | 'ajuste',
  qtyMilli: number,
  note = '',
  allowNegative: boolean | number = false,
  acknowledge = false,
): Promise<Product> {
  const text = checkedText(note, 'Motivo', MAX_REASON);
  // Mermas y ajustes son correcciones: siempre llevan motivo.
  if (type !== 'entrada' && !text) throw new Error('Indica el motivo del movimiento');
  if (type === 'ajuste') {
    if (!Number.isSafeInteger(qtyMilli) || qtyMilli < 0) throw new Error('Existencia inválida');
  } else {
    assertPositiveInt(qtyMilli, 'La cantidad debe ser mayor a cero');
  }
  if (qtyMilli > MAX_QTY_MILLI) throw new Error('La cantidad excede el máximo permitido');
  return runRw(db, ['products', 'stockMoves', 'receptions'], async (tx) => {
    const p: Product | undefined = await tx.objectStore('products').get(productId);
    if (!p) throw abortWith(tx, 'Variedad no encontrada');
    const delta =
      type === 'entrada' ? qtyMilli : type === 'merma' ? -qtyMilli : qtyMilli - p.physicalMilli;
    const availableAfter = p.physicalMilli + delta - p.reservedMilli;
    let authorized: number | undefined;
    if (delta < 0 && availableAfter < 0) {
      if (!negativeAuthorized(allowNegative, availableAfter)) {
        abortWith(tx, '');
        throw new NegativeStockError(availableAfter, productLabel(p), p.reservedMilli);
      }
      authorized = availableAfter;
    }
    if (type === 'entrada' && p.unit === 'kg' && !acknowledge) {
      const recs: Reception[] = await tx.objectStore('receptions').index('byProduct').getAll(productId);
      const recent = recs.filter(
        (r) => r.status === 'confirmada' && !!r.confirmedAt && Date.now() - Date.parse(r.confirmedAt) <= DAY_MS,
      );
      if (recent.length > 0) {
        abortWith(tx, '');
        throw new ManualEntryWarningError(recent);
      }
    }
    const updated = await moveStock(tx, productId, type, delta, 0, text, now(), undefined, undefined, undefined, authorized);
    return updated!;
  });
}

export async function listStockMoves(db: DB, productId: string, limit = 50): Promise<StockMove[]> {
  const moves = await db.getAllFromIndex('stockMoves', 'byProduct', productId);
  return moves.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

// ---------- Turnos ----------

async function currentOpenShift(tx: AnyTx): Promise<Shift | undefined> {
  const ref = await tx.objectStore('meta').get('currentShiftId');
  const shift: Shift | undefined = ref ? await tx.objectStore('shifts').get(ref.value) : undefined;
  return shift && !shift.closedAt ? shift : undefined;
}

/** Devuelve el turno abierto o abre uno con fondo $0 (la caja nunca se bloquea). */
async function ensureShift(tx: AnyTx, at: string): Promise<Shift> {
  const cur = await currentOpenShift(tx);
  if (cur) return cur;
  const s: Shift = { id: newId(), openedAt: at, openingCashCents: 0 };
  await tx.objectStore('shifts').put(s);
  await tx.objectStore('meta').put({ key: 'currentShiftId', value: s.id });
  return s;
}

export async function getCurrentShift(db: DB): Promise<Shift | undefined> {
  const tx = db.transaction(['meta', 'shifts'], 'readonly');
  const s = await currentOpenShift(tx);
  await tx.done;
  return s;
}

export async function openShift(db: DB, openingCashCents: number): Promise<Shift> {
  if (!Number.isSafeInteger(openingCashCents) || openingCashCents < 0 || openingCashCents > MAX_MONEY_CENTS) {
    throw new Error('Fondo inicial inválido');
  }
  return runRw(db, ['meta', 'shifts'], async (tx) => {
    if (await currentOpenShift(tx)) throw abortWith(tx, 'Ya hay un turno abierto');
    const shift: Shift = { id: newId(), openedAt: now(), openingCashCents };
    await tx.objectStore('shifts').put(shift);
    await tx.objectStore('meta').put({ key: 'currentShiftId', value: shift.id });
    return shift;
  });
}

export async function setOpeningCash(db: DB, shiftId: string, cents: number): Promise<void> {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_MONEY_CENTS) throw new Error('Fondo inicial inválido');
  return runRw(db, ['shifts'], async (tx) => {
    const s: Shift | undefined = await tx.objectStore('shifts').get(shiftId);
    if (!s || s.closedAt) throw abortWith(tx, 'El turno no está abierto');
    await tx.objectStore('shifts').put({ ...s, openingCashCents: cents });
  });
}

export async function listSalesByShift(db: DB, shiftId: string): Promise<Sale[]> {
  const sales = await db.getAllFromIndex('sales', 'byShift', shiftId);
  return sales.sort((a, b) => b.folio - a.folio);
}

export async function listCashMovements(db: DB, shiftId: string): Promise<CashMovement[]> {
  const m = await db.getAllFromIndex('cashMovements', 'byShift', shiftId);
  return m.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Cierra el turno actual. El efectivo esperado se calcula aquí, no lo dicta la UI. */
export async function closeShift(db: DB, countedCashCents: number): Promise<Shift> {
  if (!Number.isSafeInteger(countedCashCents) || countedCashCents < 0 || countedCashCents > MAX_MONEY_CENTS) {
    throw new Error('Efectivo contado inválido');
  }
  return runRw(db, ['meta', 'shifts', 'sales', 'cashMovements'], async (tx) => {
    const shift = await currentOpenShift(tx);
    if (!shift) throw abortWith(tx, 'No hay turno abierto');
    const sales: Sale[] = await tx.objectStore('sales').index('byShift').getAll(shift.id);
    const moves: CashMovement[] = await tx.objectStore('cashMovements').index('byShift').getAll(shift.id);
    const expectedCashCents = buildShiftReport(shift, sales, moves).expectedCashCents;
    const closed: Shift = {
      ...shift,
      closedAt: now(),
      countedCashCents,
      expectedCashCents,
      differenceCents: countedCashCents - expectedCashCents,
    };
    await tx.objectStore('shifts').put(closed);
    await tx.objectStore('meta').delete('currentShiftId');
    return closed;
  });
}

export async function listClosedShifts(db: DB, limit = 30): Promise<Shift[]> {
  const all = await db.getAllFromIndex('shifts', 'byOpenedAt');
  return all
    .filter((s) => s.closedAt)
    .reverse()
    .slice(0, limit);
}

/** Salida de efectivo (gasto, retiro, pago a proveedor) con su concepto. */
export async function addCashOut(db: DB, amountCents: number, concept: string): Promise<CashMovement> {
  assertPositiveInt(amountCents, 'El monto debe ser mayor a cero');
  if (amountCents > MAX_MONEY_CENTS) throw new Error('El monto es demasiado grande');
  const c = checkedText(concept, 'Concepto', MAX_CONCEPT);
  if (!c) throw new Error('Indica el concepto de la salida');
  return runRw(db, ['meta', 'shifts', 'cashMovements'], async (tx) => {
    const at = now();
    const shift = await ensureShift(tx, at);
    const m: CashMovement = {
      id: newId(),
      shiftId: shift.id,
      createdAt: at,
      type: 'salida',
      amountCents,
      concept: c,
    };
    await tx.objectStore('cashMovements').put(m);
    return m;
  });
}

// ---------- Ventas y vales ----------

export interface NewSaleInput {
  /** Id único generado al iniciar la venta; reintentar con el mismo id no duplica. */
  id?: string;
  cart: CartLine[];
  paymentMethod: PaymentMethod;
  receivedCents: number;
  /** true → VALE: pagado ahora, mercancía reservada hasta su entrega. */
  isVale?: boolean;
  customerName?: string;
  /** Autorización explícita para vender aunque el disponible quede negativo. */
  allowNegativeStock?: boolean;
  at?: Date;
}

export class DuplicateSaleError extends Error {
  constructor(public sale: Sale) {
    super(`La venta ya estaba registrada (folio ${sale.folio})`);
  }
}

/**
 * Registra una venta de forma atómica, en UNA transacción: folio consecutivo,
 * turno (lo abre si no hay), venta, inventario (salida física o reserva si es
 * vale) y borrado del borrador. Si algo falla no queda nada a medias.
 * Si ya existe una venta con el mismo id lanza DuplicateSaleError sin tocar nada.
 */
export async function createSale(db: DB, input: NewSaleInput): Promise<Sale> {
  // Límites de seguridad numérica y de negocio (antes de calcular nada).
  for (const l of input.cart) {
    if (!Number.isSafeInteger(l.qtyMilli) || l.qtyMilli <= 0 || l.qtyMilli > MAX_QTY_MILLI) {
      throw new Error('Cantidad inválida o excesiva');
    }
    if (!Number.isSafeInteger(l.unitPriceCents) || l.unitPriceCents < 1 || l.unitPriceCents > MAX_PRICE_CENTS) {
      throw new Error('Precio inválido: captura un precio mayor a cero');
    }
  }
  const items = toSaleItems(input.cart);
  const totalCents = items.reduce((s, i) => s + i.totalCents, 0);
  if (!Number.isSafeInteger(totalCents) || totalCents > MAX_MONEY_CENTS) throw new Error('El importe es demasiado grande');
  if (
    input.paymentMethod === 'efectivo' &&
    (!Number.isSafeInteger(input.receivedCents) || input.receivedCents > MAX_MONEY_CENTS)
  ) {
    throw new Error('El efectivo recibido es demasiado grande');
  }
  const received = input.paymentMethod === 'efectivo' ? input.receivedCents : totalCents;
  const pay = checkPayment(totalCents, input.paymentMethod, received);
  if (!pay.ok) throw new Error(pay.error);
  const customerName = checkedText(input.customerName, 'Cliente', MAX_NAME) || undefined;

  const at = input.at ?? new Date();
  const atIso = at.toISOString();
  return runRw(db, ['sales', 'meta', 'shifts', 'products', 'stockMoves'], async (tx) => {
    const saleId = input.id ?? newId();
    const dup: Sale | undefined = await tx.objectStore('sales').get(saleId);
    if (dup) {
      abortWith(tx, 'duplicada');
      throw new DuplicateSaleError(dup);
    }
    const needed = new Map<string, { name: string; qty: number }>();
    for (const it of items) {
      const cur = needed.get(it.productId);
      needed.set(it.productId, { name: it.name, qty: (cur?.qty ?? 0) + it.qtyMilli });
    }
    const shortages: Shortage[] = [];
    const productsById = new Map<string, Product>();
    for (const [productId, n] of needed) {
      const p: Product | undefined = await tx.objectStore('products').get(productId);
      if (p) productsById.set(productId, p);
      if (p && availableMilli(p) - n.qty < 0) {
        shortages.push({ productId, name: n.name, availableMilli: availableMilli(p), neededMilli: n.qty });
      }
    }
    if (shortages.length > 0 && !input.allowNegativeStock) {
      abortWith(tx, 'sin existencia');
      throw new InsufficientStockError(shortages);
    }
    const meta = tx.objectStore('meta');
    const shift = await ensureShift(tx, atIso);
    const folio: number = (await meta.get('nextFolio'))?.value ?? 1;
    let valeFolio: number | undefined;
    if (input.isVale) {
      valeFolio = (await meta.get('nextValeFolio'))?.value ?? 1;
      await meta.put({ key: 'nextValeFolio', value: valeFolio! + 1 });
    }
    // La foto de la clasificación se toma del producto LEÍDO EN ESTA transacción (no de lo que mande la pantalla).
    const sealedItems = items.map((it) => {
      const p = productsById.get(it.productId);
      return p ? { ...it, cls: classificationOf(p) } : it;
    });
    const sale: Sale = {
      id: saleId,
      folio,
      createdAt: atIso,
      day: localDay(at),
      shiftId: shift.id,
      items: sealedItems,
      totalCents,
      paymentMethod: input.paymentMethod,
      receivedCents: received,
      changeCents: pay.changeCents,
      status: 'completada',
      delivery: input.isVale ? 'pendiente' : 'inmediata',
      ...(valeFolio ? { valeFolio } : {}),
      ...(shortages.length > 0 ? { stockOverride: true } : {}),
      ...(customerName ? { customerName } : {}),
    };
    await tx.objectStore('sales').add(sale);
    for (const it of items) {
      if (input.isVale) {
        await moveStock(tx, it.productId, 'reserva', 0, it.qtyMilli, `Vale V-${valeFolio}`, atIso, saleId);
      } else {
        await moveStock(tx, it.productId, 'venta', -it.qtyMilli, 0, `Folio ${folio}`, atIso, saleId);
      }
    }
    await meta.put({ key: 'nextFolio', value: folio + 1 });
    await meta.delete('cartDraft');
    return sale;
  });
}

export async function getSale(db: DB, id: string): Promise<Sale | undefined> {
  return db.get('sales', id);
}

export async function getSaleByFolio(db: DB, folio: number): Promise<Sale | undefined> {
  return db.getFromIndex('sales', 'byFolio', folio);
}

export async function listSalesByDay(db: DB, day: string): Promise<Sale[]> {
  const sales = await db.getAllFromIndex('sales', 'byDay', day);
  return sales.sort((a, b) => b.folio - a.folio);
}

/** Vales pagados que aún no se entregan (de cualquier día/turno). */
export async function listPendingVales(db: DB): Promise<Sale[]> {
  return listVales(db, 'pendiente');
}

export async function listVales(db: DB, state: 'pendiente' | 'entregado' | 'cancelado'): Promise<Sale[]> {
  const vales = await db.getAllFromIndex('sales', 'byDelivery', state);
  return vales.sort((a, b) => (state === 'pendiente' ? a.folio - b.folio : b.folio - a.folio));
}

/**
 * Entrega la mercancía de un vale: sale de bodega y se libera la reserva.
 * NO registra dinero: el cobro se contó cuando se vendió el vale.
 */
export async function deliverVale(db: DB, saleId: string): Promise<Sale> {
  return runRw(db, ['sales', 'products', 'stockMoves'], async (tx) => {
    const sale: Sale | undefined = await tx.objectStore('sales').get(saleId);
    if (!sale || sale.delivery === 'inmediata') throw abortWith(tx, 'Vale no encontrado');
    if (sale.delivery === 'cancelado') throw abortWith(tx, 'El vale está cancelado');
    if (sale.delivery === 'entregado') throw abortWith(tx, 'El vale ya fue entregado');
    const at = now();
    const delivered: Sale = { ...sale, delivery: 'entregado', deliveredAt: at };
    await tx.objectStore('sales').put(delivered);
    for (const it of sale.items) {
      await moveStock(tx, it.productId, 'entrega_vale', -it.qtyMilli, -it.qtyMilli, `Vale V-${sale.valeFolio}`, at, sale.id);
    }
    return delivered;
  });
}

/** Anula una venta del turno abierto y revierte su efecto en inventario. */
export async function voidSale(db: DB, saleId: string, reason: string): Promise<Sale> {
  const r = checkedText(reason, 'Motivo', MAX_REASON);
  if (!r) throw new Error('Indica el motivo de la anulación');
  return runRw(db, ['sales', 'shifts', 'products', 'stockMoves'], async (tx) => {
    const sale: Sale | undefined = await tx.objectStore('sales').get(saleId);
    if (!sale) throw abortWith(tx, 'Venta no encontrada');
    if (sale.status === 'anulada') throw abortWith(tx, 'La venta ya estaba anulada');
    if (sale.delivery !== 'inmediata') throw abortWith(tx, 'Un vale se cancela desde la pestaña Vales');
    const shift: Shift | undefined = await tx.objectStore('shifts').get(sale.shiftId);
    if (shift?.closedAt) {
      throw abortWith(tx, 'No se puede anular: el turno de esa venta ya fue cerrado');
    }
    const at = now();
    await tx.objectStore('sales').put({ ...sale, status: 'anulada', voidReason: r, voidedAt: at });
    for (const it of sale.items) {
      await moveStock(tx, it.productId, 'anulacion', it.qtyMilli, 0, `Anula ${sale.folio}`, at, sale.id);
    }
    return { ...sale, status: 'anulada', voidReason: r, voidedAt: at };
  });
}

/**
 * Cancela un vale PENDIENTE: libera la reserva y registra el motivo. El destino del
 * dinero se decide explícitamente (nunca se asume que se devuelve efectivo):
 *  - efectivo: sale de la caja del turno actual (movimiento 'devolucion').
 *  - transferencia: se devolvió fuera de caja; queda registrado, sin efecto en efectivo.
 *  - ninguna: no se devolvió dinero (queda anotado).
 * Se puede cancelar aunque el turno donde se cobró ya esté cerrado.
 */
export async function cancelVale(
  db: DB,
  saleId: string,
  reason: string,
  refundMethod: RefundMethod,
): Promise<Sale> {
  const r = checkedText(reason, 'Motivo', MAX_REASON);
  if (!r) throw new Error('Indica el motivo de la cancelación');
  if (!['efectivo', 'transferencia', 'ninguna'].includes(refundMethod)) {
    throw new Error('Indica qué se hizo con el dinero');
  }
  return runRw(db, ['sales', 'meta', 'shifts', 'cashMovements', 'products', 'stockMoves'], async (tx) => {
    const sale: Sale | undefined = await tx.objectStore('sales').get(saleId);
    if (!sale || sale.delivery === 'inmediata') throw abortWith(tx, 'Vale no encontrado');
    if (sale.delivery === 'cancelado') throw abortWith(tx, 'El vale ya estaba cancelado');
    if (sale.delivery === 'entregado') throw abortWith(tx, 'El vale ya fue entregado: no se puede cancelar');
    const at = now();
    const refundCents = refundMethod === 'ninguna' ? 0 : sale.totalCents;
    const cancelled: Sale = {
      ...sale,
      delivery: 'cancelado',
      cancelReason: r,
      cancelledAt: at,
      refundMethod,
      refundCents,
    };
    await tx.objectStore('sales').put(cancelled);
    for (const it of sale.items) {
      await moveStock(tx, it.productId, 'anulacion', 0, -it.qtyMilli, `Cancela V-${sale.valeFolio}`, at, sale.id);
    }
    if (refundMethod === 'efectivo') {
      const shift = await ensureShift(tx, at);
      const m: CashMovement = {
        id: newId(),
        shiftId: shift.id,
        createdAt: at,
        type: 'devolucion',
        amountCents: refundCents,
        concept: `Devolución vale V-${sale.valeFolio}`,
        saleId: sale.id,
      };
      await tx.objectStore('cashMovements').put(m);
    }
    return cancelled;
  });
}

// ---------- Borrador del carrito ----------

export async function saveCartDraft(db: DB, cart: CartLine[]): Promise<void> {
  if (cart.length === 0) await db.delete('meta', 'cartDraft');
  else await db.put('meta', { key: 'cartDraft', value: cart });
}

export async function loadCartDraft(db: DB): Promise<CartLine[]> {
  const r = await db.get('meta', 'cartDraft');
  return Array.isArray(r?.value) ? (r!.value as CartLine[]) : [];
}

// ---------- Respaldo ----------

const DATA_STORES = ['products', 'sales', 'shifts', 'cashMovements', 'stockMoves', 'receptions', 'freights', 'meta'] as const;

export async function exportBackup(db: DB): Promise<Backup> {
  const tx = db.transaction([...DATA_STORES], 'readonly');
  const [products, sales, shifts, cashMovements, stockMoves, receptions, freights, folio, valeFolio, receptionFolio, settings] = await Promise.all([
    tx.objectStore('products').getAll(),
    tx.objectStore('sales').getAll(),
    tx.objectStore('shifts').getAll(),
    tx.objectStore('cashMovements').getAll(),
    tx.objectStore('stockMoves').getAll(),
    tx.objectStore('receptions').getAll(),
    tx.objectStore('freights').getAll(),
    tx.objectStore('meta').get('nextFolio'),
    tx.objectStore('meta').get('nextValeFolio'),
    tx.objectStore('meta').get('nextReceptionFolio'),
    tx.objectStore('meta').get('freightSettings'),
  ]);
  await tx.done;
  const stored = settings?.value as FreightSettings | undefined;
  return {
    app: 'sistema-venta-limones',
    version: 3,
    exportedAt: now(),
    products,
    sales,
    shifts,
    cashMovements,
    stockMoves,
    receptions,
    freights,
    ...(stored && validateFreightSettings(stored).length === 0 ? { freightSettings: stored } : {}),
    nextFolio: (folio?.value as number | undefined) ?? 1,
    nextValeFolio: (valeFolio?.value as number | undefined) ?? 1,
    nextReceptionFolio: (receptionFolio?.value as number | undefined) ?? 1,
  };
}

// La validación y el saneamiento viven en ./backup (puros, sin IndexedDB). Se reexporta para no cambiar imports.
export { validateBackup };

/**
 * Reemplaza TODOS los datos por los del respaldo, en una sola transacción.
 * Se valida antes de tocar nada: un archivo malo no borra los datos actuales.
 */
export async function importBackup(db: DB, data: unknown): Promise<void> {
  const b = validateBackup(data);
  return runRw(db, [...DATA_STORES], async (tx) => {
    // Los folios NUNCA bajan: si se restaura un respaldo más viejo, los números que ya se emitieron (tickets, vales,
    // recepciones) no se repiten. Puede haber huecos en la numeración; no hay duplicados.
    const meta = tx.objectStore('meta');
    const current = async (key: string): Promise<number> => {
      const v = (await meta.get(key))?.value;
      return Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : 1;
    };
    const nextFolio = Math.max(b.nextFolio, await current('nextFolio'));
    const nextValeFolio = Math.max(b.nextValeFolio, await current('nextValeFolio'));
    const nextReceptionFolio = Math.max(b.nextReceptionFolio, await current('nextReceptionFolio'));
    for (const s of DATA_STORES) await tx.objectStore(s).clear();
    for (const p of b.products) await tx.objectStore('products').put(p);
    for (const s of b.sales) await tx.objectStore('sales').put(s);
    for (const s of b.shifts) await tx.objectStore('shifts').put(s);
    for (const m of b.cashMovements) await tx.objectStore('cashMovements').put(m);
    for (const m of b.stockMoves) await tx.objectStore('stockMoves').put(m);
    for (const r of b.receptions) await tx.objectStore('receptions').put(r);
    for (const f of b.freights) await tx.objectStore('freights').put(f);
    if (b.freightSettings) await tx.objectStore('meta').put({ key: 'freightSettings', value: b.freightSettings });
    await tx.objectStore('meta').put({ key: 'nextFolio', value: nextFolio });
    await tx.objectStore('meta').put({ key: 'nextValeFolio', value: nextValeFolio });
    await tx.objectStore('meta').put({ key: 'nextReceptionFolio', value: nextReceptionFolio });
    const open = b.shifts
      .filter((s) => !s.closedAt)
      .sort((x, y) => y.openedAt.localeCompare(x.openedAt))[0];
    if (open) await tx.objectStore('meta').put({ key: 'currentShiftId', value: open.id });
  });
}
