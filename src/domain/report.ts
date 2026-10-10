import type { CashMovement, PaymentMethod, Sale, Shift, Unit } from './types';

export interface ProductSummary {
  productId: string;
  name: string;
  unit: Unit;
  qtyMilli: number;
  totalCents: number;
}

export interface ShiftReport {
  salesCount: number;
  voidedCount: number;
  totalCents: number;
  byMethod: Record<PaymentMethod, number>;
  byProduct: ProductSummary[];
  openingCashCents: number;
  /** Ventas entregadas al momento (no vales): ya están dentro de los totales. */
  immediateCount: number;
  immediateCents: number;
  /** Vales vendidos (pagados) en este turno: ya están dentro de los totales. */
  valesCount: number;
  valesCents: number;
  /** Salidas de efectivo (gastos, retiros). */
  cashOutCents: number;
  /** Devoluciones en efectivo por vales cancelados. */
  refundsCents: number;
  /** Fondo + ventas en efectivo − salidas − devoluciones (el cambio ya está descontado). */
  expectedCashCents: number;
}

export function buildShiftReport(
  shift: Pick<Shift, 'openingCashCents'>,
  sales: Sale[],
  movements: CashMovement[] = [],
): ShiftReport {
  const byMethod: Record<PaymentMethod, number> = { efectivo: 0, transferencia: 0, tarjeta: 0 };
  const products = new Map<string, ProductSummary>();
  let total = 0;
  let count = 0;
  let immediateCount = 0;
  let immediateCents = 0;
  let valesCount = 0;
  let valesCents = 0;
  let voided = 0;

  for (const s of sales) {
    if (s.status === 'anulada') {
      voided++;
      continue;
    }
    count++;
    total += s.totalCents;
    // Un vale cancelado ya no es vale vigente, pero su cobro sigue en el turno donde
    // ocurrió; la devolución (si la hubo) es un movimiento aparte.
    if (s.delivery === 'inmediata') {
      immediateCount++;
      immediateCents += s.totalCents;
    }
    if (s.delivery === 'pendiente' || s.delivery === 'entregado') {
      valesCount++;
      valesCents += s.totalCents;
    }
    byMethod[s.paymentMethod] += s.totalCents;
    for (const it of s.items) {
      const key = `${it.productId}|${it.unit}`;
      const p = products.get(key) ?? {
        productId: it.productId,
        name: it.name,
        unit: it.unit,
        qtyMilli: 0,
        totalCents: 0,
      };
      p.qtyMilli += it.qtyMilli;
      p.totalCents += it.totalCents;
      products.set(key, p);
    }
  }

  // El cobro de un vale ya está en su venta; entregarlo NO es dinero nuevo.
  let cashOut = 0;
  let refunds = 0;
  for (const m of movements) {
    if (m.type === 'salida') cashOut += m.amountCents;
    else if (m.type === 'devolucion') refunds += m.amountCents;
  }

  return {
    salesCount: count,
    voidedCount: voided,
    totalCents: total,
    byMethod,
    byProduct: [...products.values()].sort((a, b) => b.totalCents - a.totalCents),
    openingCashCents: shift.openingCashCents,
    immediateCount,
    immediateCents,
    valesCount,
    valesCents,
    cashOutCents: cashOut,
    refundsCents: refunds,
    expectedCashCents: shift.openingCashCents + byMethod.efectivo - cashOut - refunds,
  };
}

export function localDay(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
