import { BRAND } from '../brand';
import { FREIGHT_WEIGHT_MODES, MAX_FREIGHT_NET_MILLI, validateFreightSettings } from '../domain/freight';
import { HIST_MONEY_CENTS, HIST_PRICE_CENTS, HIST_QTY_MILLI, MAX_STOCK_MILLI } from '../domain/money';
import { MAX_CONTAINERS, MAX_NET_MILLI, MAX_WEIGHINGS } from '../domain/reception';
import type { Backup } from '../domain/types';

/**
 * Validación ESTRICTA y saneamiento de un respaldo, sin tocar IndexedDB.
 *
 * - Un único esquema por tipo de registro sirve para validar la forma y para copiar SOLO los campos conocidos
 *   (cualquier campo extra, incluido "__proto__", se descarta: nunca llega a la base de datos).
 * - Se acepta el formato v1 (sin recepciones), el v2 (con recepciones) y el v3 (actual, con fletes); el resultado siempre es v3.
 * - Solo se valida la FORMA. Las inconsistencias contables (totales, enlaces entre registros) las reporta la
 *   auditoría (auditData) y la restauración se las muestra al usuario antes de confirmar.
 */

type Field =
  | { k: 'str'; opt?: boolean }
  | { k: 'text'; opt?: boolean }
  | { k: 'int'; min?: number; max?: number; opt?: boolean }
  | { k: 'bool'; opt?: boolean }
  | { k: 'enum'; set: readonly string[]; opt?: boolean }
  | { k: 'date'; opt?: boolean }
  | { k: 'day' }
  | { k: 'obj'; spec: Spec; opt?: boolean }
  | { k: 'arr'; spec: Spec; opt?: boolean; nonEmpty?: boolean }
  | { k: 'ints'; min: number; max: number; count: number; opt?: boolean }
  | { k: 'strs'; count: number; opt?: boolean }
  | { k: 'scalar'; opt?: boolean };
type Spec = Record<string, Field>;

const MAX_STR = 2000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNITS = ['kg', 'pieza', 'caja', 'arpilla'] as const;
const METHODS = ['efectivo', 'transferencia', 'tarjeta'] as const;
const DELIVERY = ['inmediata', 'pendiente', 'entregado', 'cancelado'] as const;
const REFUND = ['efectivo', 'transferencia', 'ninguna'] as const;
const MOVE_TYPES = [
  'entrada', 'merma', 'ajuste', 'venta', 'reserva', 'entrega_vale', 'anulacion',
  'recepcion', 'correccion_recepcion', 'reversa_recepcion',
] as const;
const PACKAGINGS = ['granel', 'caja', 'arpilla'] as const;
const WEIGHT_MODES = ['directo', 'por_envase', 'bruto_tara'] as const;
const RECEPTION_STATUS = ['borrador', 'confirmada', 'cancelada', 'anulada'] as const;
const FREIGHT_STATUS = ['activo', 'anulado'] as const;

const S = (opt = false): Field => ({ k: 'str', opt });
const T = (opt = false): Field => ({ k: 'text', opt });
/**
 * Entero seguro con tope. Para dinero, precios y cantidades de ventas se usan los topes HISTÓRICOS (ver money.ts): la versión 1
 * no tenía topes de captura y un respaldo con un dato así de viejo tiene que poder restaurarse. Las recepciones y los saldos
 * de inventario nacieron con topes y conservan los mismos que la escritura.
 */
const I = (min?: number, opt = false, max?: number): Field => ({ k: 'int', min, max, opt });
const FOLIO_MAX = 1_000_000_000;
const MONEY = (opt = false): Field => I(0, opt, HIST_MONEY_CENTS);
const SIGNED_MONEY = (opt = false): Field => I(-HIST_MONEY_CENTS, opt, HIST_MONEY_CENTS);
const STOCK = (): Field => I(-MAX_STOCK_MILLI, false, MAX_STOCK_MILLI);
const B = (opt = false): Field => ({ k: 'bool', opt });
const E = (set: readonly string[], opt = false): Field => ({ k: 'enum', set, opt });
const D = (opt = false): Field => ({ k: 'date', opt });

const CLS: Spec = { variety: S(), origin: S(true), quality: S(true), caliber: S(true) };
/** Una pesada de un flete (origen o destino). */
const FREIGHT_SIDE: Spec = {
  mode: E(FREIGHT_WEIGHT_MODES), grossMilli: I(1, true, MAX_FREIGHT_NET_MILLI), tareMilli: I(0, true, MAX_FREIGHT_NET_MILLI),
  netMilli: I(1, false, MAX_FREIGHT_NET_MILLI), ticket: T(true), scale: T(true),
};
const EDIT_FIELDS = ['receivedAt', 'supplier', 'reference', 'notes', 'containers'] as const;

export const SPECS = {
  product: {
    id: S(), name: S(), quality: S(true), origin: S(true), caliber: S(true), unit: E(UNITS),
    priceCents: I(0, false, HIST_PRICE_CENTS), active: B(), sort: I(-FOLIO_MAX, false, FOLIO_MAX), physicalMilli: STOCK(),
    reservedMilli: STOCK(), updatedAt: D(),
    classEdits: { k: 'arr', opt: true, spec: { at: D(), before: { k: 'obj', spec: CLS }, after: { k: 'obj', spec: CLS } } },
  } as Spec,
  sale: {
    id: S(), folio: I(1, false, FOLIO_MAX), createdAt: D(), day: { k: 'day' }, shiftId: S(),
    items: {
      k: 'arr', nonEmpty: true,
      spec: {
        productId: S(), name: S(), unit: E(UNITS), qtyMilli: I(1, false, HIST_QTY_MILLI),
        unitPriceCents: I(1, false, HIST_PRICE_CENTS), totalCents: MONEY(),
        cls: { k: 'obj', spec: CLS, opt: true },
      },
    },
    totalCents: MONEY(), paymentMethod: E(METHODS), receivedCents: MONEY(), changeCents: MONEY(),
    status: E(['completada', 'anulada']), delivery: E(DELIVERY), valeFolio: I(1, true, FOLIO_MAX), customerName: T(true),
    deliveredAt: D(true), stockOverride: B(true), cancelReason: T(true), cancelledAt: D(true),
    refundMethod: E(REFUND, true), refundCents: MONEY(true), voidReason: T(true), voidedAt: D(true),
  } as Spec,
  shift: {
    id: S(), openedAt: D(), openingCashCents: MONEY(), closedAt: D(true), countedCashCents: MONEY(true),
    expectedCashCents: SIGNED_MONEY(true), differenceCents: SIGNED_MONEY(true),
  } as Spec,
  cashMovement: {
    id: S(), shiftId: S(), createdAt: D(), type: E(['salida', 'devolucion']), amountCents: I(1, false, HIST_MONEY_CENTS), concept: T(), saleId: S(true),
  } as Spec,
  stockMove: {
    id: S(), productId: S(), createdAt: D(), type: E(MOVE_TYPES), deltaMilli: STOCK(), reservedDeltaMilli: STOCK(),
    note: T(), saleId: S(true), receptionId: S(true), authorizedNegativeAfterMilli: I(-MAX_STOCK_MILLI, true, 0),
  } as Spec,
  reception: {
    id: S(), folio: I(1, true, FOLIO_MAX), status: E(RECEPTION_STATUS), createdAt: D(), updatedAt: D(), receivedAt: D(),
    day: { k: 'day' }, supplier: T(true), reference: T(true), notes: T(true), productId: S(true),
    productLabel: T(true), cls: { k: 'obj', spec: CLS, opt: true }, packaging: E(PACKAGINGS), containers: I(1, true, MAX_CONTAINERS),
    weightMode: E(WEIGHT_MODES), netDirectMilli: I(1, true, MAX_NET_MILLI),
    weighingsMilli: { k: 'ints', min: 1, max: MAX_NET_MILLI, count: MAX_WEIGHINGS, opt: true },
    unitNetMilli: I(1, true, MAX_NET_MILLI), grossMilli: I(1, true, MAX_NET_MILLI),
    tareMilli: I(0, true, MAX_NET_MILLI), netMilli: I(0, true, MAX_NET_MILLI), confirmedAt: D(true),
    confirmedNetMilli: I(1, true, MAX_NET_MILLI), stockMoveId: S(true),
    corrections: {
      k: 'arr',
      spec: {
        id: S(), at: D(), reason: T(), previousNetMilli: I(1, false, MAX_NET_MILLI), newNetMilli: I(1, false, MAX_NET_MILLI),
        deltaMilli: I(-MAX_NET_MILLI, false, MAX_NET_MILLI), stockMoveId: S(),
      },
    },
    acknowledged: {
      k: 'arr', opt: true,
      spec: { at: D(), op: E(['confirmar', 'corregir', 'anular']), warnings: { k: 'strs', count: 10 } },
    },
    dataEdits: {
      k: 'arr', opt: true,
      spec: {
        id: S(), at: D(), reason: T(),
        changes: {
          k: 'arr',
          spec: { field: E(EDIT_FIELDS), before: { k: 'scalar', opt: true }, after: { k: 'scalar', opt: true } },
        },
      },
    },
    cancelledAt: D(true), cancelReason: T(true), voidedAt: D(true), voidReason: T(true), voidStockMoveId: S(true),
  } as Spec,
  freight: {
    id: S(), folio: S(), folioKey: S(), status: E(FREIGHT_STATUS), createdAt: D(), updatedAt: D(), date: D(), day: { k: 'day' },
    origin: T(), destination: T(), notes: T(true),
    initial: { k: 'obj', spec: FREIGHT_SIDE, opt: true }, final: { k: 'obj', spec: FREIGHT_SIDE, opt: true },
    revisions: {
      k: 'arr',
      spec: {
        id: S(), at: D(), reason: T(),
        changes: { k: 'arr', spec: { field: S(), before: { k: 'scalar', opt: true }, after: { k: 'scalar', opt: true } } },
      },
    },
    voidedAt: D(true), voidReason: T(true),
  } as Spec,
  freightSettings: {
    validated: B(), refMinMilli: I(0, true, MAX_FREIGHT_NET_MILLI), refMaxMilli: I(0, true, MAX_FREIGHT_NET_MILLI),
  } as Spec,
} as const;

const isRec = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isInt = (x: unknown, min = Number.MIN_SAFE_INTEGER): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= min;
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Primer problema (ruta + motivo) o null si el registro cumple el esquema. */
function problem(spec: Spec, rec: unknown, path = ''): string | null {
  if (!isRec(rec)) return `${path || 'registro'}: no es un objeto`;
  for (const [key, f] of Object.entries(spec)) {
    const here = path ? `${path}.${key}` : key;
    const present = hasOwn(rec, key) && rec[key] !== undefined;
    if (!present) {
      if ('opt' in f && f.opt) continue;
      if (f.k === 'arr' && f.opt) continue;
      return `${here}: falta`;
    }
    const v = rec[key];
    switch (f.k) {
      case 'str':
        if (typeof v !== 'string' || v.length === 0 || v.length > MAX_STR) return `${here}: texto inválido`;
        break;
      case 'text':
        if (typeof v !== 'string' || v.length > MAX_STR) return `${here}: texto inválido`;
        break;
      case 'int':
        if (!isInt(v, f.min) || (f.max !== undefined && (v as number) > f.max)) return `${here}: número entero inválido o fuera de rango`;
        break;
      case 'bool':
        if (typeof v !== 'boolean') return `${here}: debe ser sí/no`;
        break;
      case 'enum':
        if (typeof v !== 'string' || !f.set.includes(v)) return `${here}: valor no permitido`;
        break;
      case 'date':
        // Solo el formato que escribe la app (ISO UTC con milisegundos): '5' o '10/10/2026' no son fechas de un respaldo.
        if (typeof v !== 'string' || !ISO.test(v) || Number.isNaN(Date.parse(v)) || new Date(v).toISOString() !== v) return `${here}: fecha inválida`;
        break;
      case 'day':
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${here}: día inválido`;
        break;
      case 'obj': {
        const p = problem(f.spec, v, here);
        if (p) return p;
        break;
      }
      case 'ints':
        if (!Array.isArray(v) || v.length > f.count || !v.every((x) => isInt(x, f.min) && x <= f.max)) return `${here}: lista de números inválida`;
        break;
      case 'strs':
        if (!Array.isArray(v) || v.length > f.count || !v.every((x) => typeof x === 'string' && x.length <= MAX_STR)) return `${here}: lista de textos inválida`;
        break;
      case 'scalar':
        if (!((typeof v === 'string' && v.length <= MAX_STR) || isInt(v))) return `${here}: valor inválido`;
        break;
      case 'arr': {
        if (!Array.isArray(v)) return `${here}: debe ser una lista`;
        if (f.nonEmpty && v.length === 0) return `${here}: no puede estar vacía`;
        for (let i = 0; i < v.length; i++) {
          const p = problem(f.spec, v[i], `${here}[${i}]`);
          if (p) return p;
        }
        break;
      }
    }
  }
  return null;
}

/** Copia SOLO los campos del esquema (el registro ya debe haber pasado `problem`). */
function sanitize<T>(spec: Spec, rec: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, f] of Object.entries(spec)) {
    if (!hasOwn(rec, key) || rec[key] === undefined) continue;
    const v = rec[key];
    if (f.k === 'obj') out[key] = sanitize(f.spec, v as Record<string, unknown>);
    else if (f.k === 'arr') out[key] = (v as Array<Record<string, unknown>>).map((x) => sanitize(f.spec, x));
    else if (f.k === 'ints' || f.k === 'strs') out[key] = [...(v as unknown[])];
    else out[key] = v;
  }
  return out as T;
}

function checkAll<T>(label: string, spec: Spec, list: unknown[]): T[] {
  return list.map((rec, i) => {
    const p = problem(spec, rec);
    if (p) throw new Error(`Respaldo dañado: ${label} nº ${i + 1} (${p})`);
    return sanitize<T>(spec, rec as Record<string, unknown>);
  });
}

function uniq(label: string, ids: Array<string | number>, what = 'id'): void {
  if (new Set(ids).size !== ids.length) throw new Error(`Respaldo dañado: ${label} con ${what} repetido`);
}

export function validateBackup(data: unknown): Backup {
  const b = data as Record<string, unknown> | null;
  if (!isRec(b) || b.app !== BRAND.id || (b.version !== 1 && b.version !== 2 && b.version !== 3)) {
    throw new Error('El archivo no es un respaldo válido de esta app');
  }
  for (const k of ['products', 'sales', 'shifts', 'cashMovements', 'stockMoves'] as const) {
    if (!Array.isArray(b[k])) throw new Error(`Respaldo incompleto: falta ${k}`);
  }
  // v1 no traía recepciones ni su folio: se acepta y queda vacío. Un v1 que SÍ las trae es un archivo mezclado
  // (editado a mano o dañado) y se rechaza. v2 debe traer todo explícitamente: nada se "adivina".
  if (b.version === 1) {
    if (b.receptions !== undefined || b.nextReceptionFolio !== undefined) {
      throw new Error('Respaldo con formato mezclado: dice ser de la versión anterior pero trae recepciones');
    }
  } else {
    if (!Array.isArray(b.receptions)) throw new Error('Respaldo incompleto: falta receptions');
    if (b.nextValeFolio === undefined) throw new Error('Respaldo incompleto: falta nextValeFolio');
    if (b.nextReceptionFolio === undefined) throw new Error('Respaldo incompleto: falta nextReceptionFolio');
  }
  // Los fletes llegaron con el formato 3. Un archivo 1 o 2 que los trae es mezclado (editado a mano o dañado); uno 3 los trae siempre.
  if (b.version === 3) {
    if (!Array.isArray(b.freights)) throw new Error('Respaldo incompleto: falta freights');
  } else if (b.freights !== undefined || b.freightSettings !== undefined) {
    throw new Error('Respaldo con formato mezclado: dice ser de una versión anterior pero trae fletes');
  }
  if (!isInt(b.nextFolio, 1) || b.nextFolio > FOLIO_MAX + 1) throw new Error('Respaldo con folio inválido');

  const products = checkAll<Backup['products'][number]>('producto', SPECS.product, b.products as unknown[]);
  const sales = checkAll<Backup['sales'][number]>('venta', SPECS.sale, b.sales as unknown[]);
  const shifts = checkAll<Backup['shifts'][number]>('turno', SPECS.shift, b.shifts as unknown[]);
  const cashMovements = checkAll<Backup['cashMovements'][number]>('movimiento de caja', SPECS.cashMovement, b.cashMovements as unknown[]);
  const stockMoves = checkAll<Backup['stockMoves'][number]>('movimiento de inventario', SPECS.stockMove, b.stockMoves as unknown[]);
  const receptions = checkAll<Backup['receptions'][number]>('recepción', SPECS.reception, (b.receptions as unknown[]) ?? []);
  const freights = checkAll<Backup['freights'][number]>('flete', SPECS.freight, (b.freights as unknown[]) ?? []);
  let freightSettings: Backup['freightSettings'];
  if (b.freightSettings !== undefined) {
    const sp = problem(SPECS.freightSettings, b.freightSettings, 'freightSettings');
    if (sp) throw new Error(`Respaldo dañado: configuración de fletes (${sp})`);
    freightSettings = sanitize<NonNullable<Backup['freightSettings']>>(SPECS.freightSettings, b.freightSettings as Record<string, unknown>);
    if (validateFreightSettings(freightSettings).length) throw new Error('Respaldo dañado: configuración de fletes inválida');
  }

  // Unicidad
  // (mensaje histórico conservado para ventas duplicadas)
  if (new Set(sales.map((s) => s.id)).size !== sales.length) throw new Error('Respaldo con ventas duplicadas');
  uniq('productos', products.map((p) => p.id));
  uniq('turnos', shifts.map((p) => p.id));
  uniq('movimientos de caja', cashMovements.map((p) => p.id));
  uniq('movimientos de inventario', stockMoves.map((p) => p.id));
  uniq('recepciones', receptions.map((p) => p.id));
  uniq('fletes', freights.map((p) => p.id));
  uniq('fletes', freights.map((p) => p.folioKey), 'folio');

  // Folios
  const maxFolio = sales.reduce((m, s) => Math.max(m, s.folio), 0);
  if (new Set(sales.map((s) => s.folio)).size !== sales.length) throw new Error('Respaldo con folios de venta repetidos');
  if ((b.nextFolio as number) <= maxFolio) throw new Error('Respaldo inconsistente: el folio siguiente ya fue usado');

  const valeFolios = sales.filter((s) => s.valeFolio !== undefined).map((s) => s.valeFolio as number);
  if (new Set(valeFolios).size !== valeFolios.length) throw new Error('Respaldo con folios de vale repetidos');
  const maxVale = valeFolios.reduce((m, f) => Math.max(m, f), 0);
  const nextVale = b.nextValeFolio === undefined ? maxVale + 1 : b.nextValeFolio;
  if (!isInt(nextVale, 1) || nextVale > FOLIO_MAX + 1) throw new Error('Respaldo con folio de vale inválido');
  if (nextVale <= maxVale) throw new Error('Respaldo inconsistente: el folio de vale siguiente ya fue usado');

  const recFolios = receptions.filter((r) => r.folio !== undefined).map((r) => r.folio as number);
  if (new Set(recFolios).size !== recFolios.length) throw new Error('Respaldo con folios de recepción repetidos');
  const maxRec = recFolios.reduce((m, f) => Math.max(m, f), 0);
  const nextRec = b.nextReceptionFolio === undefined ? maxRec + 1 : b.nextReceptionFolio;
  if (!isInt(nextRec, 1) || nextRec > FOLIO_MAX + 1) throw new Error('Respaldo con folio de recepción inválido');
  if (nextRec <= maxRec) throw new Error('Respaldo inconsistente: el folio de recepción siguiente ya fue usado');

  return {
    app: BRAND.id,
    version: 3,
    exportedAt: typeof b.exportedAt === 'string' ? b.exportedAt.slice(0, 64) : '',
    products,
    sales,
    shifts,
    cashMovements,
    stockMoves,
    receptions,
    freights,
    ...(freightSettings ? { freightSettings } : {}),
    nextFolio: b.nextFolio as number,
    nextValeFolio: nextVale,
    nextReceptionFolio: nextRec,
  };
}
