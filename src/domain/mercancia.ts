import { caliberKey, classificationOf, isUnspecified, keyOf, productLabel, varietyKey } from './classification';
import { currentNetMilli } from './reception';
import { localDay } from './report';
import type { Classification, Packaging, Product, Reception, Sale, StockMove, Unit } from './types';

/**
 * Reporte de MERCANCÍA (kilos). Es independiente del corte de caja: no toca dinero y no mezcla los
 * ingresos por ventas con los kilos recibidos. Recibir mercancía NO implica pago al proveedor.
 *
 * Definiciones (docs/DISENO-CLASIFICACION-RECEPCION.md §6):
 *  - Recibido: recepciones CONFIRMADAS por su día de llegada, con los kilos vigentes (original + correcciones).
 *    Las anuladas, los borradores y las canceladas no cuentan. Recibido = Original + Correcciones.
 *  - Vendido: ventas completadas por su día de venta. Un vale cuenta cuando se vende (ya está pagado), no cuando se
 *    entrega; un vale cancelado y una venta anulada no cuentan. Solo los renglones en kg suman a los kilos; las demás
 *    unidades se informan aparte, sin convertirlas.
 *  - Existencia: la ACTUAL de los productos en kg (no depende del rango). En los grupos (variedad, procedencia, calidad,
 *    calibre) se agrupa por la clasificación ACTUAL del producto.
 *  - Lo recibido y lo vendido se agrupan por la clasificación con que se registraron ("foto"): si luego se corrige
 *    el nombre de un producto, el historial conserva cómo se llamaba entonces. Las ventas hechas ANTES de la
 *    clasificación (sin foto) se agrupan por el nombre con que se vendieron; nunca se les asigna una clasificación nueva.
 *  - Cuadre (ledger): se calcula con los MOVIMIENTOS de inventario por su día real de captura; es lo que concilia
 *    con la existencia. Las correcciones y anulaciones de recepciones ya van dentro de "Recibido" (por día de
 *    llegada) y por eso aquí se muestran aparte, solo como información.
 */

export interface MerchandiseInput {
  /** Día inicial y final (YYYY-MM-DD, local), ambos incluidos. */
  from: string;
  to: string;
  receptions: Reception[];
  sales: Sale[];
  stockMoves: StockMove[];
  products: Product[];
}

export interface Bucket {
  key: string;
  label: string;
  receivedMilli: number;
  soldMilli: number;
  /** Existencia ACTUAL de los productos en kg de este grupo (no depende del rango). */
  physicalMilli: number;
  reservedMilli: number;
  availableMilli: number;
}

export interface DayRow {
  day: string;
  receivedMilli: number;
  receptions: number;
  soldMilli: number;
}

export interface PackagingRow {
  packaging: Packaging;
  receptions: number;
  /** Cajas/arpillas registradas (informativo; no se convierten a kilos). */
  containers: number;
  receivedMilli: number;
}

export interface StockRow {
  productId: string;
  label: string;
  physicalMilli: number;
  reservedMilli: number;
  availableMilli: number;
}

export interface AdjustmentRow {
  id: string;
  at: string;
  day: string;
  productId: string;
  type: StockMove['type'];
  deltaMilli: number;
  note: string;
}

/**
 * Cuadre del inventario en kg por MOVIMIENTOS del periodo:
 *   final = inicial + recepciones netas + entradas manuales − salidas (ventas y entregas) − mermas ± conteos.
 */
export interface Ledger {
  openingMilli: number;
  /** recepcion + correccion_recepcion + reversa_recepcion (neto) */
  receptionsMilli: number;
  manualInMilli: number;
  /** Kilos que salieron de bodega: ventas inmediatas y entregas de vale, menos anulaciones que los devolvieron. */
  outMilli: number;
  mermasMilli: number;
  /** Conteos físicos (neto, con signo). */
  countsMilli: number;
  closingMilli: number;
  /** Movimientos posteriores al rango (para conciliar con la existencia de hoy). */
  laterMovesMilli: number;
  /** final + posteriores = existencia física actual. false = revisar los datos (Más → Verificar). */
  reconciles: boolean;
}

export interface MerchandiseReport {
  from: string;
  to: string;
  /** Original + correcciones de las recepciones confirmadas del periodo. */
  receivedMilli: number;
  receivedOriginalMilli: number;
  /** Informativo: ya incluido en receivedMilli. */
  correctionsMilli: number;
  receptionCount: number;
  voidedCount: number;
  /** Kilos que tenían las anuladas (NO cuentan en receivedMilli). */
  voidedMilli: number;
  /** Borradores pendientes (todos, sin importar el rango). */
  draftCount: number;
  soldMilli: number;
  /** Parte de soldMilli que está en vales pagados aún no entregados. */
  soldInPendingValesMilli: number;
  /** Parte de soldMilli vendida antes de la clasificación (sin foto): se agrupa por nombre. */
  legacySoldMilli: number;
  soldOtherUnits: Array<{ unit: Unit; qtyMilli: number }>;
  byDay: DayRow[];
  byVariety: Bucket[];
  byOrigin: Bucket[];
  byQuality: Bucket[];
  byCaliber: Bucket[];
  byPackaging: PackagingRow[];
  /** Existencia ACTUAL de productos en kg (no depende del rango). */
  stockNow: { physicalMilli: number; reservedMilli: number; availableMilli: number; rows: StockRow[] };
  ledger: Ledger;
  /** Mermas, conteos físicos y entradas manuales del periodo (por el día en que se capturaron). */
  adjustments: AdjustmentRow[];
  mermasMilli: number;
  ajustesMilli: number;
  manualInMilli: number;
}

const inRange = (day: string, from: string, to: string) => day >= from && day <= to;

const LABELS = {
  variety: 'Sin variedad',
  origin: 'No especificada',
  quality: 'Sin clasificar',
  caliber: 'No especificado',
} as const;

type Dim = keyof typeof LABELS;
const DIMS: readonly Dim[] = ['variety', 'origin', 'quality', 'caliber'];

/** Clave de agrupación por dimensión: "no especificado" (en cualquier forma) cae en un solo grupo. */
function dimKey(dim: Dim, value: string | undefined): string {
  if (dim === 'variety') return varietyKey(value);
  if (dim === 'caliber') return isUnspecified(value) ? '' : caliberKey(value);
  return keyOf(value);
}

export function buildMerchandiseReport(input: MerchandiseInput): MerchandiseReport {
  const { from, to } = input;
  const productById = new Map(input.products.map((p) => [p.id, p]));
  const kgProducts = input.products.filter((p) => p.unit === 'kg');
  const kgIds = new Set(kgProducts.map((p) => p.id));

  const days = new Map<string, DayRow>();
  const dayRow = (day: string): DayRow => {
    let r = days.get(day);
    if (!r) days.set(day, (r = { day, receivedMilli: 0, receptions: 0, soldMilli: 0 }));
    return r;
  };

  const buckets: Record<Dim, Map<string, Bucket>> = {
    variety: new Map(), origin: new Map(), quality: new Map(), caliber: new Map(),
  };
  const bucketFor = (dim: Dim, c: Classification | undefined, fallbackVariety: string): Bucket => {
    const value = dim === 'variety' ? (c?.variety || fallbackVariety) : c?.[dim];
    const key = dimKey(dim, value);
    const map = buckets[dim];
    let b = map.get(key);
    if (!b) {
      // La primera ortografía que se ve es la que se muestra (las existencias se cargan primero: ortografía actual).
      const label = key === '' ? LABELS[dim] : (value as string);
      map.set(key, (b = { key, label, receivedMilli: 0, soldMilli: 0, physicalMilli: 0, reservedMilli: 0, availableMilli: 0 }));
    }
    return b;
  };
  const addFlow = (c: Classification | undefined, fallbackVariety: string, field: 'receivedMilli' | 'soldMilli', milli: number) => {
    for (const dim of DIMS) bucketFor(dim, c, fallbackVariety)[field] += milli;
  };

  // ----- Existencia actual (kg), por producto y por grupo
  const rows: StockRow[] = kgProducts.map((p) => ({
    productId: p.id,
    label: productLabel(p),
    physicalMilli: p.physicalMilli,
    reservedMilli: p.reservedMilli,
    availableMilli: p.physicalMilli - p.reservedMilli,
  }));
  for (const p of kgProducts) {
    // Un grupo sin existencia ni movimientos no ensucia la tabla: solo se crea si hay algo que mostrar.
    if (p.physicalMilli === 0 && p.reservedMilli === 0) continue;
    for (const dim of DIMS) {
      const b = bucketFor(dim, classificationOf(p), p.name);
      b.physicalMilli += p.physicalMilli;
      b.reservedMilli += p.reservedMilli;
      b.availableMilli += p.physicalMilli - p.reservedMilli;
    }
  }
  const stockNow = {
    physicalMilli: rows.reduce((a, r) => a + r.physicalMilli, 0),
    reservedMilli: rows.reduce((a, r) => a + r.reservedMilli, 0),
    availableMilli: rows.reduce((a, r) => a + r.availableMilli, 0),
    rows,
  };

  // ----- Recibido
  const packRows = new Map<Packaging, PackagingRow>();
  let receivedMilli = 0;
  let receivedOriginalMilli = 0;
  let correctionsMilli = 0;
  let receptionCount = 0;
  let voidedCount = 0;
  let voidedMilli = 0;
  let draftCount = 0;
  for (const r of input.receptions) {
    if (r.status === 'borrador') draftCount++;
    if (!inRange(r.day, from, to)) continue;
    if (r.status === 'anulada') {
      voidedCount++;
      voidedMilli += (r.confirmedNetMilli ?? 0) + r.corrections.reduce((s, c) => s + c.deltaMilli, 0);
      continue;
    }
    if (r.status !== 'confirmada') continue;
    const net = currentNetMilli(r);
    const original = r.confirmedNetMilli ?? 0;
    receivedMilli += net;
    receivedOriginalMilli += original;
    correctionsMilli += net - original;
    receptionCount++;
    const d = dayRow(r.day);
    d.receivedMilli += net;
    d.receptions++;
    const prod = r.productId ? productById.get(r.productId) : undefined;
    const cls = r.cls ?? (prod ? classificationOf(prod) : undefined);
    addFlow(cls, r.productLabel ?? 'Sin variedad', 'receivedMilli', net);
    let pr = packRows.get(r.packaging);
    if (!pr) packRows.set(r.packaging, (pr = { packaging: r.packaging, receptions: 0, containers: 0, receivedMilli: 0 }));
    pr.receptions++;
    pr.containers += r.containers ?? 0;
    pr.receivedMilli += net;
  }

  // ----- Vendido
  let soldMilli = 0;
  let soldInPendingValesMilli = 0;
  let legacySoldMilli = 0;
  const other = new Map<Unit, number>();
  for (const s of input.sales) {
    if (!inRange(s.day, from, to)) continue;
    if (s.status !== 'completada' || s.delivery === 'cancelado') continue;
    for (const it of s.items) {
      if (it.unit !== 'kg') {
        other.set(it.unit, (other.get(it.unit) ?? 0) + it.qtyMilli);
        continue;
      }
      soldMilli += it.qtyMilli;
      if (s.delivery === 'pendiente') soldInPendingValesMilli += it.qtyMilli;
      dayRow(s.day).soldMilli += it.qtyMilli;
      if (!it.cls) legacySoldMilli += it.qtyMilli;
      // Sin foto (venta anterior a la clasificación): solo el nombre con que se vendió, nunca la clasificación de hoy.
      addFlow(it.cls ?? { variety: it.name }, it.name, 'soldMilli', it.qtyMilli);
    }
  }

  // ----- Movimientos: cuadre, mermas, conteos y entradas manuales
  const ledger: Ledger = {
    openingMilli: 0, receptionsMilli: 0, manualInMilli: 0, outMilli: 0, mermasMilli: 0, countsMilli: 0,
    closingMilli: 0, laterMovesMilli: 0, reconciles: true,
  };
  const adjustments: AdjustmentRow[] = [];
  for (const m of input.stockMoves) {
    if (!kgIds.has(m.productId)) continue;
    const day = localDay(new Date(m.createdAt));
    if (day < from) {
      ledger.openingMilli += m.deltaMilli;
      continue;
    }
    if (day > to) {
      ledger.laterMovesMilli += m.deltaMilli;
      continue;
    }
    switch (m.type) {
      case 'recepcion':
      case 'correccion_recepcion':
      case 'reversa_recepcion':
        ledger.receptionsMilli += m.deltaMilli;
        break;
      case 'entrada':
        ledger.manualInMilli += m.deltaMilli;
        break;
      case 'venta':
      case 'entrega_vale':
      case 'anulacion':
        ledger.outMilli += -m.deltaMilli;
        break;
      case 'merma':
        ledger.mermasMilli += -m.deltaMilli;
        break;
      case 'ajuste':
        ledger.countsMilli += m.deltaMilli;
        break;
      case 'reserva':
        break; // solo mueve el reservado
    }
    if (m.type === 'merma' || m.type === 'ajuste' || m.type === 'entrada') {
      adjustments.push({
        id: m.id, at: m.createdAt, day, productId: m.productId, type: m.type, deltaMilli: m.deltaMilli, note: m.note,
      });
    }
  }
  ledger.closingMilli =
    ledger.openingMilli + ledger.receptionsMilli + ledger.manualInMilli - ledger.outMilli - ledger.mermasMilli + ledger.countsMilli;
  ledger.reconciles = ledger.closingMilli + ledger.laterMovesMilli === stockNow.physicalMilli;
  adjustments.sort((a, b) => b.at.localeCompare(a.at));

  const sortBuckets = (m: Map<string, Bucket>) =>
    [...m.values()]
      .filter((b) => b.receivedMilli !== 0 || b.soldMilli !== 0 || b.physicalMilli !== 0 || b.reservedMilli !== 0)
      .sort(
        (a, b) =>
          b.receivedMilli + b.soldMilli - (a.receivedMilli + a.soldMilli) ||
          b.physicalMilli - a.physicalMilli ||
          a.label.localeCompare(b.label),
      );

  return {
    from,
    to,
    receivedMilli,
    receivedOriginalMilli,
    correctionsMilli,
    receptionCount,
    voidedCount,
    voidedMilli,
    draftCount,
    soldMilli,
    soldInPendingValesMilli,
    legacySoldMilli,
    soldOtherUnits: [...other.entries()].map(([unit, qtyMilli]) => ({ unit, qtyMilli })),
    byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    byVariety: sortBuckets(buckets.variety),
    byOrigin: sortBuckets(buckets.origin),
    byQuality: sortBuckets(buckets.quality),
    byCaliber: sortBuckets(buckets.caliber),
    byPackaging: [...packRows.values()].sort((a, b) => b.receivedMilli - a.receivedMilli),
    stockNow,
    ledger,
    adjustments,
    mermasMilli: ledger.mermasMilli,
    ajustesMilli: ledger.countsMilli,
    manualInMilli: ledger.manualInMilli,
  };
}

/**
 * Identidad contable por producto (para pruebas y auditoría):
 * físico = recepciones netas + entradas manuales − ventas netas − mermas ± ajustes.
 */
export function movementTotals(moves: StockMove[]) {
  const t = { recepcionesMilli: 0, entradasManualesMilli: 0, ventasNetasMilli: 0, mermasMilli: 0, ajustesMilli: 0 };
  for (const m of moves) {
    switch (m.type) {
      case 'recepcion':
      case 'correccion_recepcion':
      case 'reversa_recepcion':
        t.recepcionesMilli += m.deltaMilli;
        break;
      case 'entrada':
        t.entradasManualesMilli += m.deltaMilli;
        break;
      case 'venta':
      case 'entrega_vale':
      case 'anulacion':
        t.ventasNetasMilli += -m.deltaMilli; // la anulación de una venta inmediata devuelve kilos (resta de ventas)
        break;
      case 'merma':
        t.mermasMilli += -m.deltaMilli;
        break;
      case 'ajuste':
        t.ajustesMilli += m.deltaMilli;
        break;
      case 'reserva':
        break; // solo mueve el reservado, no el físico
    }
  }
  const physical = t.recepcionesMilli + t.entradasManualesMilli - t.ventasNetasMilli - t.mermasMilli + t.ajustesMilli;
  return { ...t, physicalMilli: physical };
}
