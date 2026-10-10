import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { checkPayment, toSaleItems } from '../domain/cart';
import { buildShiftReport, localDay } from '../domain/report';
import type {
  Backup,
  CartLine,
  CashMovement,
  PaymentMethod,
  Product,
  Sale,
  Shift,
  StockMove,
  StockMoveType,
  Unit,
} from '../domain/types';

type MetaKey = 'nextFolio' | 'currentShiftId' | 'cartDraft';

interface LimonesDB extends DBSchema {
  products: { key: string; value: Product };
  sales: {
    key: string;
    value: Sale;
    indexes: { byDay: string; byShift: string; byFolio: number; byDelivery: string };
  };
  shifts: { key: string; value: Shift; indexes: { byOpenedAt: string } };
  cashMovements: { key: string; value: CashMovement; indexes: { byShift: string } };
  stockMoves: { key: string; value: StockMove; indexes: { byProduct: string } };
  meta: { key: MetaKey; value: { key: MetaKey; value: unknown } };
}

export type DB = IDBPDatabase<LimonesDB>;

export const DB_NAME = 'venta-limones';
const DB_VERSION = 1;

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

export function openDatabase(name = DB_NAME): Promise<DB> {
  return openDB<LimonesDB>(name, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore('products', { keyPath: 'id' });
      const sales = db.createObjectStore('sales', { keyPath: 'id' });
      sales.createIndex('byDay', 'day');
      sales.createIndex('byShift', 'shiftId');
      sales.createIndex('byFolio', 'folio', { unique: true });
      sales.createIndex('byDelivery', 'delivery');
      const shifts = db.createObjectStore('shifts', { keyPath: 'id' });
      shifts.createIndex('byOpenedAt', 'openedAt');
      const cash = db.createObjectStore('cashMovements', { keyPath: 'id' });
      cash.createIndex('byShift', 'shiftId');
      const stock = db.createObjectStore('stockMoves', { keyPath: 'id' });
      stock.createIndex('byProduct', 'productId');
      db.createObjectStore('meta', { keyPath: 'key' });
    },
  });
}

const now = () => new Date().toISOString();

/**
 * Abre una transacción de escritura. El rechazo de `tx.done` se marca como
 * manejado (el error igual llega a quien hace `await`), así un fallo no
 * termina como "unhandled rejection".
 */
function rw(db: DB, stores: string[]): AnyTx {
  const tx = db.transaction(stores as never, 'readwrite');
  tx.done.catch(() => undefined);
  return tx;
}

/** Aborta la transacción y devuelve el error para lanzarlo. */
function abortWith(tx: AnyTx, message: string): Error {
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

export function availableMilli(p: Product): number {
  return p.physicalMilli - p.reservedMilli;
}

export const DEFAULT_PRODUCTS: Array<Pick<Product, 'name' | 'unit' | 'priceCents'>> = [
  { name: 'Limón persa', unit: 'kg', priceCents: 3000 },
  { name: 'Limón con semilla', unit: 'kg', priceCents: 3500 },
  { name: 'Limón persa 2da', unit: 'kg', priceCents: 2000 },
];

/** Inserta variedades de ejemplo solo si la base está vacía. */
export async function seedIfEmpty(db: DB): Promise<boolean> {
  const tx = rw(db, ['products']);
  const store = tx.objectStore('products');
  if ((await store.count()) > 0) {
    await tx.done;
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
  await tx.done;
  return true;
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
  name: string;
  unit: Unit;
  priceCents: number;
  active: boolean;
}

/** Crea o edita una variedad. La existencia NO se edita aquí (usa movimientos). */
export async function saveProduct(db: DB, input: ProductInput): Promise<Product> {
  const name = input.name.trim();
  if (!name) throw new Error('El nombre es obligatorio');
  assertPositiveInt(input.priceCents, 'El precio debe ser mayor a cero');
  const tx = rw(db, ['products']);
  const store = tx.objectStore('products');
  const existing: Product | undefined = input.id ? await store.get(input.id) : undefined;
  const product: Product = {
    id: existing?.id ?? input.id ?? newId(),
    name,
    unit: input.unit,
    priceCents: input.priceCents,
    active: input.active,
    sort: existing?.sort ?? (await store.count()),
    physicalMilli: existing?.physicalMilli ?? 0,
    reservedMilli: existing?.reservedMilli ?? 0,
    updatedAt: now(),
  };
  await store.put(product);
  await tx.done;
  return product;
}

/** Cambia solo el precio (desde la caja). Persistente para las siguientes ventas. */
export async function setPrice(db: DB, productId: string, priceCents: number): Promise<Product> {
  assertPositiveInt(priceCents, 'El precio debe ser mayor a cero');
  const tx = rw(db, ['products']);
  const p: Product | undefined = await tx.objectStore('products').get(productId);
  if (!p) throw abortWith(tx, 'Variedad no encontrada');
  const updated = { ...p, priceCents, updatedAt: now() };
  await tx.objectStore('products').put(updated);
  await tx.done;
  return updated;
}

// ---------- Inventario ----------

async function moveStock(
  tx: AnyTx,
  productId: string,
  type: StockMoveType,
  deltaMilli: number,
  reservedDeltaMilli: number,
  note: string,
  at: string,
  saleId?: string,
): Promise<Product | undefined> {
  const store = tx.objectStore('products');
  const p: Product | undefined = await store.get(productId);
  if (!p) return undefined; // variedad borrada: la venta sigue siendo válida
  const updated: Product = {
    ...p,
    physicalMilli: p.physicalMilli + deltaMilli,
    reservedMilli: p.reservedMilli + reservedDeltaMilli,
    updatedAt: at,
  };
  await store.put(updated);
  const move: StockMove = {
    id: newId(),
    productId,
    createdAt: at,
    type,
    deltaMilli,
    reservedDeltaMilli,
    note,
    ...(saleId ? { saleId } : {}),
  };
  await tx.objectStore('stockMoves').put(move);
  return updated;
}

/**
 * Movimiento manual de inventario.
 *  - entrada: llega mercancía (+qty físico)
 *  - merma: producto echado a perder (−qty físico)
 *  - ajuste: conteo físico; `qtyMilli` es la existencia física REAL contada.
 */
export async function addStockMove(
  db: DB,
  productId: string,
  type: 'entrada' | 'merma' | 'ajuste',
  qtyMilli: number,
  note = '',
): Promise<Product> {
  if (type === 'ajuste') {
    if (!Number.isSafeInteger(qtyMilli) || qtyMilli < 0) throw new Error('Existencia inválida');
  } else {
    assertPositiveInt(qtyMilli, 'La cantidad debe ser mayor a cero');
  }
  const tx = rw(db, ['products', 'stockMoves']);
  const p: Product | undefined = await tx.objectStore('products').get(productId);
  if (!p) throw abortWith(tx, 'Variedad no encontrada');
  const delta =
    type === 'entrada' ? qtyMilli : type === 'merma' ? -qtyMilli : qtyMilli - p.physicalMilli;
  const updated = await moveStock(tx, productId, type, delta, 0, note.trim(), now());
  await tx.done;
  return updated!;
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
  if (!Number.isSafeInteger(openingCashCents) || openingCashCents < 0) {
    throw new Error('Fondo inicial inválido');
  }
  const tx = rw(db, ['meta', 'shifts']);
  if (await currentOpenShift(tx)) throw abortWith(tx, 'Ya hay un turno abierto');
  const shift: Shift = { id: newId(), openedAt: now(), openingCashCents };
  await tx.objectStore('shifts').put(shift);
  await tx.objectStore('meta').put({ key: 'currentShiftId', value: shift.id });
  await tx.done;
  return shift;
}

export async function setOpeningCash(db: DB, shiftId: string, cents: number): Promise<void> {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('Fondo inicial inválido');
  const tx = rw(db, ['shifts']);
  const s: Shift | undefined = await tx.objectStore('shifts').get(shiftId);
  if (!s || s.closedAt) throw abortWith(tx, 'El turno no está abierto');
  await tx.objectStore('shifts').put({ ...s, openingCashCents: cents });
  await tx.done;
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
  if (!Number.isSafeInteger(countedCashCents) || countedCashCents < 0) {
    throw new Error('Efectivo contado inválido');
  }
  const tx = rw(db, ['meta', 'shifts', 'sales', 'cashMovements']);
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
  await tx.done;
  return closed;
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
  const c = concept.trim();
  if (!c) throw new Error('Indica el concepto de la salida');
  const tx = rw(db, ['meta', 'shifts', 'cashMovements']);
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
  await tx.done;
  return m;
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
  const items = toSaleItems(input.cart);
  const totalCents = items.reduce((s, i) => s + i.totalCents, 0);
  const received = input.paymentMethod === 'efectivo' ? input.receivedCents : totalCents;
  const pay = checkPayment(totalCents, input.paymentMethod, received);
  if (!pay.ok) throw new Error(pay.error);
  const customerName = input.customerName?.trim() || undefined;

  const at = input.at ?? new Date();
  const atIso = at.toISOString();
  const tx = rw(db, ['sales', 'meta', 'shifts', 'products', 'stockMoves']);
  const saleId = input.id ?? newId();
  const dup: Sale | undefined = await tx.objectStore('sales').get(saleId);
  if (dup) {
    abortWith(tx, 'duplicada');
    throw new DuplicateSaleError(dup);
  }
  const meta = tx.objectStore('meta');
  const shift = await ensureShift(tx, atIso);
  const folio: number = (await meta.get('nextFolio'))?.value ?? 1;
  const sale: Sale = {
    id: saleId,
    folio,
    createdAt: atIso,
    day: localDay(at),
    shiftId: shift.id,
    items,
    totalCents,
    paymentMethod: input.paymentMethod,
    receivedCents: received,
    changeCents: pay.changeCents,
    status: 'completada',
    delivery: input.isVale ? 'pendiente' : 'inmediata',
    ...(customerName ? { customerName } : {}),
  };
  await tx.objectStore('sales').add(sale);
  for (const it of items) {
    if (input.isVale) {
      await moveStock(tx, it.productId, 'reserva', 0, it.qtyMilli, `Vale ${folio}`, atIso, saleId);
    } else {
      await moveStock(tx, it.productId, 'venta', -it.qtyMilli, 0, `Folio ${folio}`, atIso, saleId);
    }
  }
  await meta.put({ key: 'nextFolio', value: folio + 1 });
  await meta.delete('cartDraft');
  await tx.done;
  return sale;
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
  const vales = await db.getAllFromIndex('sales', 'byDelivery', 'pendiente');
  return vales.filter((s) => s.status === 'completada').sort((a, b) => a.folio - b.folio);
}

/**
 * Entrega la mercancía de un vale: sale de bodega y se libera la reserva.
 * NO registra dinero: el cobro se contó cuando se vendió el vale.
 */
export async function deliverVale(db: DB, saleId: string): Promise<Sale> {
  const tx = rw(db, ['sales', 'products', 'stockMoves']);
  const sale: Sale | undefined = await tx.objectStore('sales').get(saleId);
  if (!sale || sale.delivery === 'inmediata') throw abortWith(tx, 'Vale no encontrado');
  if (sale.status === 'anulada') throw abortWith(tx, 'El vale está anulado');
  if (sale.delivery === 'entregado') throw abortWith(tx, 'El vale ya fue entregado');
  const at = now();
  const delivered: Sale = { ...sale, delivery: 'entregado', deliveredAt: at };
  await tx.objectStore('sales').put(delivered);
  for (const it of sale.items) {
    await moveStock(tx, it.productId, 'entrega_vale', -it.qtyMilli, -it.qtyMilli, `Vale ${sale.folio}`, at, sale.id);
  }
  await tx.done;
  return delivered;
}

/** Anula una venta del turno abierto y revierte su efecto en inventario. */
export async function voidSale(db: DB, saleId: string, reason: string): Promise<Sale> {
  const r = reason.trim();
  if (!r) throw new Error('Indica el motivo de la anulación');
  const tx = rw(db, ['sales', 'shifts', 'products', 'stockMoves']);
  const sale: Sale | undefined = await tx.objectStore('sales').get(saleId);
  if (!sale) throw abortWith(tx, 'Venta no encontrada');
  if (sale.status === 'anulada') throw abortWith(tx, 'La venta ya estaba anulada');
  const shift: Shift | undefined = await tx.objectStore('shifts').get(sale.shiftId);
  if (shift?.closedAt) {
    throw abortWith(tx, 'No se puede anular: el turno de esa venta ya fue cerrado');
  }
  const at = now();
  await tx.objectStore('sales').put({ ...sale, status: 'anulada', voidReason: r, voidedAt: at });
  for (const it of sale.items) {
    if (sale.delivery === 'pendiente') {
      // Se libera la reserva; físicamente nunca salió.
      await moveStock(tx, it.productId, 'anulacion', 0, -it.qtyMilli, `Anula ${sale.folio}`, at, sale.id);
    } else {
      await moveStock(tx, it.productId, 'anulacion', it.qtyMilli, 0, `Anula ${sale.folio}`, at, sale.id);
    }
  }
  await tx.done;
  return { ...sale, status: 'anulada', voidReason: r, voidedAt: at };
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

const DATA_STORES = ['products', 'sales', 'shifts', 'cashMovements', 'stockMoves', 'meta'] as const;

export async function exportBackup(db: DB): Promise<Backup> {
  const tx = db.transaction([...DATA_STORES], 'readonly');
  const [products, sales, shifts, cashMovements, stockMoves, folio] = await Promise.all([
    tx.objectStore('products').getAll(),
    tx.objectStore('sales').getAll(),
    tx.objectStore('shifts').getAll(),
    tx.objectStore('cashMovements').getAll(),
    tx.objectStore('stockMoves').getAll(),
    tx.objectStore('meta').get('nextFolio'),
  ]);
  await tx.done;
  return {
    app: 'sistema-venta-limones',
    version: 1,
    exportedAt: now(),
    products,
    sales,
    shifts,
    cashMovements,
    stockMoves,
    nextFolio: (folio?.value as number | undefined) ?? 1,
  };
}

export function validateBackup(data: unknown): Backup {
  const b = data as Partial<Backup> | null;
  if (!b || b.app !== 'sistema-venta-limones' || b.version !== 1) {
    throw new Error('El archivo no es un respaldo válido de esta app');
  }
  for (const k of ['products', 'sales', 'shifts', 'cashMovements', 'stockMoves'] as const) {
    if (!Array.isArray(b[k])) throw new Error(`Respaldo incompleto: falta ${k}`);
  }
  if (!Number.isSafeInteger(b.nextFolio) || (b.nextFolio as number) < 1) {
    throw new Error('Respaldo con folio inválido');
  }
  const ids = new Set<string>();
  let maxFolio = 0;
  for (const s of b.sales!) {
    if (!s || typeof s.id !== 'string' || !Number.isSafeInteger(s.folio)) {
      throw new Error('Respaldo con ventas dañadas');
    }
    if (ids.has(s.id)) throw new Error('Respaldo con ventas duplicadas');
    ids.add(s.id);
    maxFolio = Math.max(maxFolio, s.folio);
  }
  if ((b.nextFolio as number) <= maxFolio) {
    throw new Error('Respaldo inconsistente: el folio siguiente ya fue usado');
  }
  return b as Backup;
}

/**
 * Reemplaza TODOS los datos por los del respaldo, en una sola transacción.
 * Se valida antes de tocar nada: un archivo malo no borra los datos actuales.
 */
export async function importBackup(db: DB, data: unknown): Promise<void> {
  const b = validateBackup(data);
  const tx = rw(db, [...DATA_STORES]);
  for (const s of DATA_STORES) await tx.objectStore(s).clear();
  for (const p of b.products) await tx.objectStore('products').put(p);
  for (const s of b.sales) await tx.objectStore('sales').put(s);
  for (const s of b.shifts) await tx.objectStore('shifts').put(s);
  for (const m of b.cashMovements) await tx.objectStore('cashMovements').put(m);
  for (const m of b.stockMoves) await tx.objectStore('stockMoves').put(m);
  await tx.objectStore('meta').put({ key: 'nextFolio', value: b.nextFolio });
  const open = b.shifts
    .filter((s) => !s.closedAt)
    .sort((x, y) => y.openedAt.localeCompare(x.openedAt))[0];
  if (open) await tx.objectStore('meta').put({ key: 'currentShiftId', value: open.id });
  await tx.done;
}
