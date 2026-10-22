import { MAX_CLASS_LEN, classificationKey, isUnspecified, productLabel } from '../domain/classification';
import { computeSideNet, differenceOf, folioKeyOf } from '../domain/freight';
import { MAX_MONEY_CENTS, MAX_PRICE_CENTS, MAX_QTY_MILLI, formatQty, lineTotalCents } from '../domain/money';
import { computeNet } from '../domain/reception';
import { buildShiftReport } from '../domain/report';
import type { Backup, StockMove } from '../domain/types';
import { exportBackup, getCurrentShift, type DB } from './repo';

export interface AuditResult {
  /** true = ninguna inconsistencia (las advertencias no cuentan). */
  ok: boolean;
  /** Inconsistencias reales: los números guardados no se pueden reconstruir. */
  issues: string[];
  /** Cosas raras que se toleran (datos capturados con versiones anteriores): no impiden usar la app. */
  warnings: string[];
  stats: { sales: number; vales: number; products: number; stockMoves: number; shifts: number; receptions: number; freights: number };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * Auditoría de integridad sobre una foto de los datos. Verifica que los números
 * guardados se puedan reconstruir desde los movimientos y las ventas; no corrige nada.
 */
export function auditData(b: Backup, currentShiftId?: string): AuditResult {
  const issues: string[] = [];
  const bad = (m: string) => issues.push(m);

  // --- Inventario: el saldo debe ser la suma de sus movimientos
  const pendingByProduct = new Map<string, number>();
  for (const s of b.sales) {
    if (s.delivery !== 'pendiente') continue;
    for (const it of s.items) pendingByProduct.set(it.productId, (pendingByProduct.get(it.productId) ?? 0) + it.qtyMilli);
  }
  for (const p of b.products) {
    const moves = b.stockMoves.filter((m) => m.productId === p.id);
    const phys = sum(moves.map((m) => m.deltaMilli));
    const res = sum(moves.map((m) => m.reservedDeltaMilli));
    if (phys !== p.physicalMilli) bad(`Inventario físico de "${p.name}" (${p.physicalMilli}) no coincide con sus movimientos (${phys})`);
    if (res !== p.reservedMilli) bad(`Reservado de "${p.name}" (${p.reservedMilli}) no coincide con sus movimientos (${res})`);
    const pend = pendingByProduct.get(p.id) ?? 0;
    if (pend !== p.reservedMilli) bad(`Reservado de "${p.name}" (${p.reservedMilli}) no coincide con sus vales pendientes (${pend})`);
  }

  // --- Folios
  const folios = new Set<number>();
  const valeFolios = new Set<number>();
  for (const s of b.sales) {
    if (folios.has(s.folio)) bad(`Folio de venta repetido: ${s.folio}`);
    folios.add(s.folio);
    if (s.folio >= b.nextFolio) bad(`La venta #${s.folio} es mayor o igual al siguiente folio (${b.nextFolio})`);
    if (s.valeFolio !== undefined) {
      if (valeFolios.has(s.valeFolio)) bad(`Folio de vale repetido: V-${s.valeFolio}`);
      valeFolios.add(s.valeFolio);
      if (s.valeFolio >= b.nextValeFolio) bad(`El vale V-${s.valeFolio} es mayor o igual al siguiente folio de vale`);
    }
  }

  // --- Cada venta
  const shiftIds = new Set(b.shifts.map((x) => x.id));
  for (const s of b.sales) {
    const tag = `Venta #${s.folio}`;
    if (!shiftIds.has(s.shiftId)) bad(`${tag}: pertenece a un turno que no existe`);
    s.items.forEach((i, k) => {
      try {
        if (i.totalCents !== lineTotalCents(i.unitPriceCents, i.qtyMilli)) bad(`${tag}: renglón ${k + 1} mal calculado`);
      } catch {
        bad(`${tag}: renglón ${k + 1} con importe fuera de rango`);
      }
    });
    if (sum(s.items.map((i) => i.totalCents)) !== s.totalCents) bad(`${tag}: el total no coincide con sus renglones`);
    if (s.paymentMethod === 'efectivo' && s.receivedCents - s.totalCents !== s.changeCents) {
      bad(`${tag}: cambio mal calculado`);
    }
    if (s.paymentMethod !== 'efectivo' && (s.receivedCents !== s.totalCents || s.changeCents !== 0)) {
      bad(`${tag}: pago no efectivo con recibido/cambio inconsistente`);
    }
    if (s.delivery === 'inmediata' && s.valeFolio !== undefined) bad(`${tag}: venta inmediata con folio de vale`);
    if (s.delivery !== 'inmediata' && s.valeFolio === undefined) bad(`${tag}: vale sin folio de vale`);
    if (s.delivery === 'entregado' && !s.deliveredAt) bad(`${tag}: vale entregado sin fecha de entrega`);
    if (s.delivery === 'cancelado') {
      if (!s.cancelReason) bad(`${tag}: vale cancelado sin motivo`);
      if (!s.refundMethod) bad(`${tag}: vale cancelado sin decisión sobre el dinero`);
    }
    if (s.status === 'anulada' && !s.voidedAt) bad(`${tag}: venta anulada sin fecha`);
  }

  // --- Devoluciones en efectivo ↔ vales cancelados con devolución en efectivo
  const refunded = sum(
    b.sales.filter((s) => s.delivery === 'cancelado' && s.refundMethod === 'efectivo').map((s) => s.refundCents ?? 0),
  );
  const refundMoves = sum(b.cashMovements.filter((m) => m.type === 'devolucion').map((m) => m.amountCents));
  if (refunded !== refundMoves) bad(`Devoluciones en efectivo de vales (${refunded}) ≠ movimientos de caja (${refundMoves})`);
  for (const m of b.cashMovements) if (!shiftIds.has(m.shiftId)) bad(`Movimiento de caja "${m.concept}" sin turno`);

  // --- Turnos: un solo abierto, y los cerrados deben poder reconstruirse
  const open = b.shifts.filter((x) => !x.closedAt);
  if (open.length > 1) bad(`Hay ${open.length} turnos abiertos a la vez`);
  if (open.length === 1 && currentShiftId !== open[0].id) bad('El turno abierto no es el turno actual de la app');
  if (open.length === 0 && currentShiftId) bad('El turno actual apunta a un turno cerrado o inexistente');
  for (const sh of b.shifts.filter((x) => x.closedAt)) {
    const r = buildShiftReport(
      sh,
      b.sales.filter((x) => x.shiftId === sh.id),
      b.cashMovements.filter((m) => m.shiftId === sh.id),
    );
    if (sh.expectedCashCents !== r.expectedCashCents) {
      bad(`Corte del ${sh.closedAt}: esperado guardado (${sh.expectedCashCents}) ≠ recalculado (${r.expectedCashCents})`);
    }
    if (sh.countedCashCents !== undefined && sh.differenceCents !== sh.countedCashCents - r.expectedCashCents) {
      bad(`Corte del ${sh.closedAt}: diferencia mal calculada`);
    }
  }

  auditStockMoves(b, bad);
  auditReceptions(b, bad);
  const warnings: string[] = [];
  auditFreights(b, bad, (m) => warnings.push(m));
  auditCatalog(b, (m) => warnings.push(m));
  auditOutliers(b, (m) => warnings.push(m));

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    stats: {
      receptions: b.receptions.length,
      freights: b.freights.length,
      sales: b.sales.length,
      vales: b.sales.filter((s) => s.valeFolio !== undefined).length,
      products: b.products.length,
      stockMoves: b.stockMoves.length,
      shifts: b.shifts.length,
    },
  };
}

export async function auditDatabase(db: DB): Promise<AuditResult> {
  const [backup, shift] = await Promise.all([exportBackup(db), getCurrentShift(db)]);
  return auditData(backup, shift?.id);
}

/**
 * Movimientos de inventario:
 *  - signo y reservado coherentes con su tipo (una venta nunca suma, una recepción nunca resta, etc.);
 *  - los de venta/vale enlazan a una venta que existe, y los demás no;
 *  - cada venta tiene EXACTAMENTE los movimientos que le corresponden por sus renglones y su estado
 *    (inmediata: venta · anulada: venta+anulación · vale pendiente: reserva · entregado: reserva+entrega ·
 *    cancelado: reserva+anulación). Esto cruza el libro de inventario con las ventas, que son datos independientes.
 */
function auditStockMoves(b: Backup, bad: (m: string) => void): void {
  const saleById = new Map(b.sales.map((s) => [s.id, s]));
  const productIds = new Set(b.products.map((p) => p.id));
  const ids = new Set<string>();
  const bySale = new Map<string, StockMove[]>();
  const SALE_TYPES = ['venta', 'reserva', 'entrega_vale', 'anulacion'];

  for (const m of b.stockMoves) {
    const tag = `Movimiento "${m.type}"${m.note ? ` (${m.note})` : ''}`;
    if (ids.has(m.id)) bad(`${tag}: identificador repetido`);
    ids.add(m.id);
    if (!productIds.has(m.productId)) bad(`${tag}: apunta a una variedad que no existe`);
    const d = m.deltaMilli;
    const r = m.reservedDeltaMilli;
    const wrong = (what: string) => bad(`${tag}: ${what}`);
    if (m.authorizedNegativeAfterMilli !== undefined && !(d < 0 && m.authorizedNegativeAfterMilli < 0)) {
      wrong('marcado como negativo autorizado, pero no resta kilos o el disponible resultante no es negativo');
    }

    switch (m.type) {
      case 'recepcion':
        if (!(d > 0) || r !== 0) wrong('una recepción debe sumar kilos y no mover el reservado');
        break;
      case 'correccion_recepcion':
        if (d === 0 || r !== 0) wrong('una corrección debe cambiar los kilos y no mover el reservado');
        break;
      case 'reversa_recepcion':
        if (!(d < 0) || r !== 0) wrong('una anulación de recepción debe restar kilos y no mover el reservado');
        break;
      case 'entrada':
        if (!(d > 0) || r !== 0) wrong('una entrada debe sumar kilos y no mover el reservado');
        break;
      case 'merma':
        if (!(d < 0) || r !== 0) wrong('una merma debe restar kilos y no mover el reservado');
        if (!m.note.trim()) wrong('merma sin motivo');
        break;
      case 'ajuste':
        if (r !== 0) wrong('un conteo físico no mueve el reservado');
        if (!m.note.trim()) wrong('conteo físico sin motivo');
        break;
      case 'venta':
        if (!(d < 0) || r !== 0) wrong('una venta debe restar kilos y no mover el reservado');
        break;
      case 'reserva':
        if (d !== 0 || !(r > 0)) wrong('una reserva no mueve kilos físicos y aparta una cantidad positiva');
        break;
      case 'entrega_vale':
        if (!(d < 0) || r !== d) wrong('una entrega debe restar los mismos kilos del físico y del reservado');
        break;
      case 'anulacion':
        if (!((d > 0 && r === 0) || (d === 0 && r < 0))) wrong('una anulación devuelve kilos al físico o libera el reservado');
        break;
      default:
        wrong('tipo de movimiento desconocido');
    }

    if (SALE_TYPES.includes(m.type)) {
      if (!m.saleId) wrong('no apunta a ninguna venta');
      else if (!saleById.has(m.saleId)) wrong('apunta a una venta que no existe');
      else bySale.set(m.saleId, [...(bySale.get(m.saleId) ?? []), m]);
    } else if (m.saleId !== undefined) {
      wrong('no debería estar enlazado a una venta');
    }
  }

  // Cruce por venta: lo esperado según renglones y estado vs lo que realmente se registró.
  const keyOf = (productId: string, type: string, d: number, r: number) => `${productId}|${type}|${d}|${r}`;
  for (const s of b.sales) {
    const expected = new Map<string, number>();
    const add = (map: Map<string, number>, k: string) => map.set(k, (map.get(k) ?? 0) + 1);
    for (const it of s.items) {
      if (!productIds.has(it.productId)) continue; // variedad que ya no existe: no genera movimientos
      const q = it.qtyMilli;
      if (s.delivery === 'inmediata') {
        add(expected, keyOf(it.productId, 'venta', -q, 0));
        if (s.status === 'anulada') add(expected, keyOf(it.productId, 'anulacion', q, 0));
      } else {
        add(expected, keyOf(it.productId, 'reserva', 0, q));
        if (s.delivery === 'entregado') add(expected, keyOf(it.productId, 'entrega_vale', -q, -q));
        if (s.delivery === 'cancelado') add(expected, keyOf(it.productId, 'anulacion', 0, -q));
      }
    }
    const actual = new Map<string, number>();
    for (const m of bySale.get(s.id) ?? []) add(actual, keyOf(m.productId, m.type, m.deltaMilli, m.reservedDeltaMilli));
    let missing = 0;
    let extra = 0;
    for (const [k, n] of expected) missing += Math.max(0, n - (actual.get(k) ?? 0));
    for (const [k, n] of actual) extra += Math.max(0, n - (expected.get(k) ?? 0));
    if (missing || extra) {
      const what = [missing && `faltan ${missing}`, extra && `sobran o no coinciden ${extra}`].filter(Boolean).join(' y ');
      bad(`Venta #${s.folio}: sus movimientos de inventario no coinciden con sus renglones (${what})`);
    }
  }
}

/**
 * Catálogo: advertencias sobre datos capturados con versiones anteriores. No son errores (no se corrigen solos):
 * conviene revisarlos, pero no impiden vender, recibir ni restaurar.
 */
/**
 * Datos que la versión 1 dejó guardar y que hoy no se podrían capturar (una cantidad o un precio por encima de los topes de
 * captura, normalmente un error de dedo). Se conservan tal cual —el historial no se reescribe— pero se avisa, para que no pasen
 * desapercibidos.
 */
function auditOutliers(b: Backup, warn: (m: string) => void): void {
  const sales = b.sales.filter(
    (s) =>
      s.totalCents > MAX_MONEY_CENTS ||
      s.receivedCents > MAX_MONEY_CENTS ||
      s.items.some((i) => i.qtyMilli > MAX_QTY_MILLI || i.unitPriceCents > MAX_PRICE_CENTS || i.totalCents > MAX_MONEY_CENTS),
  );
  if (sales.length > 0) {
    const first = sales[0];
    const big = first.items.find((i) => i.qtyMilli > MAX_QTY_MILLI);
    const example = big ? `la venta #${first.folio} trae ${formatQty(big.qtyMilli, big.unit)}` : `la venta #${first.folio}`;
    warn(
      `Hay ${sales.length} ${sales.length === 1 ? 'venta' : 'ventas'} con cantidades o importes por encima de lo que hoy se permite capturar ` +
        `(por ejemplo ${example}). Se conservan como están; revísalas por si fueron un error de dedo.`,
    );
  }
  const prices = b.products.filter((p) => p.priceCents > MAX_PRICE_CENTS);
  if (prices.length > 0) {
    warn(`«${productLabel(prices[0])}»${prices.length > 1 ? ` y ${prices.length - 1} más tienen` : ' tiene'} un precio por encima de lo que hoy se permite capturar; corrígelo en Inventario → Editar.`);
  }
  const cash =
    b.shifts.filter((x) => x.openingCashCents > MAX_MONEY_CENTS || (x.countedCashCents ?? 0) > MAX_MONEY_CENTS).length +
    b.cashMovements.filter((m) => m.amountCents > MAX_MONEY_CENTS).length;
  if (cash > 0) warn(`Hay ${cash} ${cash === 1 ? 'registro' : 'registros'} de caja (fondos, conteos o salidas) por encima de lo que hoy se permite capturar.`);
}

function auditCatalog(b: Backup, warn: (m: string) => void): void {
  const byKey = new Map<string, string[]>();
  for (const p of b.products) {
    // Un duplicado ya OCULTO y sin existencias ni apartados no reparte nada: el consejo «ocultar uno» debe poder cumplirse.
    const inUse = p.active || p.physicalMilli !== 0 || p.reservedMilli !== 0;
    if (inUse) {
      const k = classificationKey(p);
      byKey.set(k, [...(byKey.get(k) ?? []), productLabel(p)]);
    }
    for (const [label, v] of [['variedad', p.name], ['procedencia', p.origin], ['calidad', p.quality], ['calibre', p.caliber]] as const) {
      if (v === undefined) continue;
      if (v.length > MAX_CLASS_LEN) warn(`«${productLabel(p).slice(0, 50)}…»: la ${label} tiene más de ${MAX_CLASS_LEN} caracteres (capturada antes de este límite)`);
      if (label !== 'variedad' && isUnspecified(v)) warn(`«${productLabel(p)}»: la ${label} dice «${v}» en vez de quedar vacía; significan lo mismo`);
    }
  }
  for (const labels of byKey.values()) {
    if (labels.length > 1) {
      warn(`Hay ${labels.length} productos con la misma clasificación («${labels[0]}»): su inventario está repartido; conviene ocultar uno de ellos`);
    }
  }
  // Existencia disponible negativa: ocurre cuando se autoriza vender o restar más de lo que hay. Se informa para que no
  // pase desapercibida y se distingue si quedó alguna autorización registrada o no.
  const authorizedIds = new Set<string>();
  for (const m of b.stockMoves) if (m.authorizedNegativeAfterMilli !== undefined) authorizedIds.add(m.productId);
  const overridden = new Set(b.sales.filter((s) => s.stockOverride).flatMap((s) => s.items.map((i) => i.productId)));
  for (const p of b.products) {
    const available = p.physicalMilli - p.reservedMilli;
    if (available >= 0) continue;
    const kg = `${(available / 1000).toLocaleString('es-MX')} ${p.unit}`;
    warn(
      authorizedIds.has(p.id) || overridden.has(p.id)
        ? `«${productLabel(p)}» tiene existencia disponible negativa (${kg}), con autorizaciones registradas. Regularízala con una recepción o un conteo físico.`
        : `«${productLabel(p)}» tiene existencia disponible negativa (${kg}) SIN ninguna autorización registrada: revisa qué pasó y regularízala con un conteo físico.`,
    );
  }
}

/**
 * Recepciones de mercancía: cada una debe poder reconstruirse desde sus movimientos de inventario.
 *  - confirmada: exactamente UN movimiento 'recepcion' enlazado, por los kilos originales; cada corrección tiene su
 *    movimiento y la cadena previa→nueva es coherente; los kilos vigentes = original + correcciones.
 *  - anulada: además, exactamente una reversa por los kilos vigentes; vigentes = 0.
 *  - borrador/cancelada: no tienen movimientos ni folio.
 *  - el peso neto se puede recalcular desde el modo de peso activo y no hay campos de otro modo.
 */
function auditReceptions(b: Backup, bad: (m: string) => void): void {
  const recById = new Map(b.receptions.map((r) => [r.id, r]));
  const productById = new Map(b.products.map((p) => [p.id, p]));
  const movesByRec = new Map<string, Backup['stockMoves']>();
  const RECEPTION_TYPES = ['recepcion', 'correccion_recepcion', 'reversa_recepcion'];

  for (const m of b.stockMoves) {
    if (m.receptionId !== undefined) {
      if (!recById.has(m.receptionId)) bad(`Movimiento de inventario "${m.note}" apunta a una recepción que no existe`);
      if (!RECEPTION_TYPES.includes(m.type)) bad(`Movimiento "${m.type}" no debería estar enlazado a una recepción`);
      const list = movesByRec.get(m.receptionId) ?? [];
      list.push(m);
      movesByRec.set(m.receptionId, list);
    } else if (RECEPTION_TYPES.includes(m.type)) {
      bad(`Movimiento "${m.type}" sin recepción asociada`);
    }
  }

  const folios = new Set<number>();
  for (const r of b.receptions) {
    const tag = `Recepción ${r.folio !== undefined ? `R-${r.folio}` : r.id.slice(0, 8)}`;
    const moves = movesByRec.get(r.id) ?? [];
    const of = (type: string) => moves.filter((m) => m.type === type);

    // Modo de peso excluyente y coherente con la presentación
    const modeFields: Record<string, Array<keyof typeof r>> = {
      directo: ['netDirectMilli'],
      por_envase: ['unitNetMilli'],
      bruto_tara: ['grossMilli', 'tareMilli'],
    };
    for (const [mode, fields] of Object.entries(modeFields)) {
      if (mode !== r.weightMode && fields.some((f) => r[f] !== undefined)) {
        bad(`${tag}: tiene datos de otro modo de peso (${mode}) además de "${r.weightMode}"`);
      }
    }
    if (r.packaging === 'granel' && r.containers !== undefined) bad(`${tag}: a granel no debería tener cajas/arpillas`);
    if (r.weightMode === 'por_envase' && r.packaging === 'granel') bad(`${tag}: envases × peso no aplica a granel`);

    if (r.status === 'borrador' || r.status === 'cancelada') {
      if (r.folio !== undefined) bad(`${tag}: un ${r.status} no debería tener folio`);
      if (moves.length > 0) bad(`${tag}: un ${r.status} no debe tener movimientos de inventario (${moves.length})`);
      if (r.status === 'cancelada' && !r.cancelledAt) bad(`${tag}: cancelada sin fecha`);
      continue;
    }

    // confirmada o anulada
    if (r.folio === undefined) bad(`${tag}: confirmada sin folio`);
    else {
      if (folios.has(r.folio)) bad(`Folio de recepción repetido: R-${r.folio}`);
      folios.add(r.folio);
      if (r.folio >= b.nextReceptionFolio) bad(`${tag}: folio mayor o igual al siguiente folio de recepción`);
    }
    if (!r.confirmedAt || r.confirmedNetMilli === undefined || !r.stockMoveId || !r.productId) {
      bad(`${tag}: faltan datos de confirmación (fecha, kilos, movimiento o producto)`);
      continue;
    }
    const product = productById.get(r.productId);
    if (!product) bad(`${tag}: su variedad ya no existe`);
    else if (product.unit !== 'kg') bad(`${tag}: la variedad no se vende por kg`);

    const net = computeNet(r);
    if (!net.ok) bad(`${tag}: no se puede recalcular el peso neto (${net.error})`);
    else if (net.netMilli !== r.confirmedNetMilli) {
      bad(`${tag}: kilos confirmados (${r.confirmedNetMilli}) ≠ recalculados desde el modo "${r.weightMode}" (${net.netMilli})`);
    }

    const entradas = of('recepcion');
    if (entradas.length !== 1) bad(`${tag}: debe tener exactamente 1 movimiento de recepción y tiene ${entradas.length}`);
    else {
      const e = entradas[0];
      if (e.id !== r.stockMoveId) bad(`${tag}: el movimiento enlazado no es el registrado`);
      if (e.deltaMilli !== r.confirmedNetMilli) bad(`${tag}: el movimiento sumó ${e.deltaMilli} y se confirmaron ${r.confirmedNetMilli}`);
      if (e.productId !== r.productId) bad(`${tag}: el movimiento es de otra variedad`);
    }

    // Correcciones
    const corrMoves = of('correccion_recepcion');
    if (corrMoves.length !== r.corrections.length) {
      bad(`${tag}: ${r.corrections.length} correcciones registradas y ${corrMoves.length} movimientos de corrección`);
    }
    let running = r.confirmedNetMilli;
    for (const c of r.corrections) {
      const mv = corrMoves.find((m) => m.id === c.stockMoveId);
      if (!mv) bad(`${tag}: una corrección no tiene su movimiento de inventario`);
      else if (mv.deltaMilli !== c.deltaMilli) bad(`${tag}: una corrección (${c.deltaMilli}) no coincide con su movimiento (${mv.deltaMilli})`);
      if (c.previousNetMilli !== running) bad(`${tag}: cadena de correcciones rota (esperaba ${running}, dice ${c.previousNetMilli})`);
      if (c.newNetMilli !== c.previousNetMilli + c.deltaMilli) bad(`${tag}: una corrección no cuadra (${c.previousNetMilli} + ${c.deltaMilli} ≠ ${c.newNetMilli})`);
      if (!c.reason.trim()) bad(`${tag}: una corrección sin motivo`);
      running = c.newNetMilli;
    }

    // Correcciones de DATOS: solo bitácora (nunca cambian kilos ni inventario) y siempre con motivo
    const EDITABLE = ['supplier', 'reference', 'notes', 'receivedAt', 'containers'];
    for (const e of r.dataEdits ?? []) {
      if (!e.reason.trim()) bad(`${tag}: una corrección de datos sin motivo`);
      if (e.changes.length === 0) bad(`${tag}: una corrección de datos sin cambios`);
      for (const c of e.changes) if (!EDITABLE.includes(c.field)) bad(`${tag}: una corrección de datos toca un campo no editable (${c.field})`);
    }

    const reversas = of('reversa_recepcion');
    if (r.status === 'confirmada') {
      if (reversas.length > 0) bad(`${tag}: confirmada pero tiene una reversa`);
      if (r.netMilli !== running) bad(`${tag}: kilos vigentes (${r.netMilli}) ≠ original + correcciones (${running})`);
    } else {
      // anulada
      if (!r.voidedAt || !r.voidReason?.trim() || !r.voidStockMoveId) bad(`${tag}: anulada sin fecha, motivo o movimiento`);
      if (reversas.length !== 1) bad(`${tag}: anulada debe tener exactamente 1 reversa y tiene ${reversas.length}`);
      else {
        if (reversas[0].id !== r.voidStockMoveId) bad(`${tag}: la reversa enlazada no es la registrada`);
        if (reversas[0].deltaMilli !== -running) bad(`${tag}: la reversa (${reversas[0].deltaMilli}) no revierte los kilos vigentes (${running})`);
      }
      if (r.netMilli !== 0) bad(`${tag}: anulada debe tener 0 kilos vigentes`);
    }
  }
}

/**
 * Fletes: el folio es único, cada pesada se puede recalcular (neto = bruto − tara), los anulados tienen su motivo y toda
 * corrección deja antes, después y motivo. Un peso final MAYOR que el inicial no es una inconsistencia, pero se avisa.
 */
function auditFreights(b: Backup, bad: (m: string) => void, warn: (m: string) => void): void {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const f of b.freights) {
    const tag = `Flete ${f.folio}`;
    if (ids.has(f.id)) bad(`${tag}: id repetido`);
    ids.add(f.id);
    if (!f.folio.trim()) bad('Hay un flete sin folio');
    if (f.folioKey !== folioKeyOf(f.folio)) bad(`${tag}: el folio normalizado guardado (${f.folioKey}) no corresponde a su folio`);
    if (keys.has(f.folioKey)) bad(`Folio de flete repetido: ${f.folio}`);
    keys.add(f.folioKey);
    if (!f.origin.trim() || !f.destination.trim()) bad(`${tag}: sin origen o sin destino`);
    if (!f.initial && !f.final) bad(`${tag}: no tiene ninguna pesada`);
    for (const [name, s] of [['peso inicial', f.initial], ['peso final', f.final]] as const) {
      if (!s) continue;
      const net = computeSideNet({ mode: s.mode, grossMilli: s.grossMilli, tareMilli: s.tareMilli, netMilli: s.mode === 'directo' ? s.netMilli : undefined });
      if (!net.ok) bad(`${tag}: ${name} inválido (${net.error})`);
      else if (net.netMilli !== s.netMilli) bad(`${tag}: ${name}: neto guardado (${s.netMilli}) ≠ recalculado (${net.netMilli})`);
      if (s.mode === 'directo' && (s.grossMilli !== undefined || s.tareMilli !== undefined)) bad(`${tag}: ${name} es «solo neto» pero trae bruto o tara`);
    }
    if (f.status === 'anulado') {
      if (!f.voidedAt || !f.voidReason?.trim()) bad(`${tag}: anulado sin fecha o motivo`);
      if (!f.revisions.some((r) => r.changes.some((c) => c.field === 'status' && c.after === 'anulado'))) bad(`${tag}: anulado sin su registro en la bitácora`);
    } else if (f.voidedAt || f.voidReason) bad(`${tag}: vigente pero con datos de anulación`);
    for (const r of f.revisions) {
      if (!r.reason.trim()) bad(`${tag}: una corrección sin motivo`);
      if (r.changes.length === 0) bad(`${tag}: una corrección sin cambios`);
    }
    const d = differenceOf(f);
    if (d && d.diffMilli < 0) warn(`${tag}: el peso final es MAYOR que el inicial (revisa las boletas)`);
  }
}
