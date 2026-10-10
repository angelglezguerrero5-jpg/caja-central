import { lineTotalCents } from '../domain/money';
import { buildShiftReport } from '../domain/report';
import type { Backup } from '../domain/types';
import { exportBackup, getCurrentShift, type DB } from './repo';

export interface AuditResult {
  ok: boolean;
  issues: string[];
  stats: { sales: number; vales: number; products: number; stockMoves: number; shifts: number };
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
    const lines = s.items.map((i) => lineTotalCents(i.unitPriceCents, i.qtyMilli));
    s.items.forEach((i, k) => i.totalCents !== lines[k] && bad(`${tag}: renglón ${k + 1} mal calculado`));
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
    if (s.status === 'anulada' && !s.voidReason) bad(`${tag}: venta anulada sin motivo`);
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

  return {
    ok: issues.length === 0,
    issues,
    stats: {
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
