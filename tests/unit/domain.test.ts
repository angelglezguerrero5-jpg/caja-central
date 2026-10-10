import { describe, expect, it } from 'vitest';
import { addLine, cartTotalCents, checkPayment, quickCashOptions, removeLine } from '../../src/domain/cart';
import { formatQty, lineTotalCents, parseMoney, parseQty, qtyForAmount } from '../../src/domain/money';
import { buildShiftReport, localDay } from '../../src/domain/report';
import type { Product, Sale } from '../../src/domain/types';

const persa: Product = {
  id: 'p1', name: 'Limón persa', unit: 'kg', priceCents: 3000, active: true, sort: 0,
  physicalMilli: 0, reservedMilli: 0, updatedAt: '',
};
const caja: Product = { ...persa, id: 'p2', name: 'Caja', unit: 'caja', priceCents: 45000 };

describe('money', () => {
  it('parsea dinero y cantidades sin errores de flotante', () => {
    expect(parseMoney('12.5')).toBe(1250);
    expect(parseMoney('0.1')).toBe(10);
    expect(parseMoney('20')).toBe(2000);
    expect(parseMoney('1,99')).toBe(199);
    expect(parseMoney('1.999')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('-3')).toBeNull();
    expect(parseQty('1.25')).toBe(1250);
    expect(parseQty('.5')).toBe(500);
    expect(parseQty('0.333')).toBe(333);
  });

  it('calcula total de línea redondeando al centavo', () => {
    expect(lineTotalCents(3000, 1500)).toBe(4500); // 1.5 kg × $30
    expect(lineTotalCents(3333, 333)).toBe(1110); // 1109.89 → 1110
    expect(lineTotalCents(45000, 2000)).toBe(90000); // 2 cajas
  });

  it('venta por monto redondea gramos hacia abajo', () => {
    expect(qtyForAmount(2000, 3000)).toBe(666); // $20 a $30/kg → 666 g
    expect(lineTotalCents(3000, 666)).toBeLessThanOrEqual(2000);
    expect(qtyForAmount(1000, 0)).toBe(0);
  });

  it('formatea cantidades', () => {
    expect(formatQty(500, 'kg')).toBe('500 g');
    expect(formatQty(1500, 'kg')).toBe('1.5 kg');
    expect(formatQty(2000, 'caja')).toBe('2 caja');
    expect(formatQty(1000, 'pieza')).toBe('1 pza');
  });
});

describe('cart', () => {
  it('acumula el mismo producto y calcula total', () => {
    let c = addLine([], persa, 1000);
    c = addLine(c, persa, 500);
    c = addLine(c, caja, 1000);
    expect(c).toHaveLength(2);
    expect(c[0].qtyMilli).toBe(1500);
    expect(cartTotalCents(c)).toBe(4500 + 45000);
    expect(removeLine(c, 0)).toHaveLength(1);
  });

  it('no acumula si el precio cambió (conserva precio de cada línea)', () => {
    let c = addLine([], persa, 1000);
    c = addLine(c, { ...persa, priceCents: 3200 }, 1000);
    expect(c).toHaveLength(2);
  });

  it('rechaza cantidades inválidas', () => {
    expect(() => addLine([], persa, 0)).toThrow();
    expect(() => addLine([], persa, 1.5)).toThrow();
  });

  it('valida pago y calcula cambio', () => {
    expect(checkPayment(4500, 'efectivo', 5000)).toEqual({ ok: true, changeCents: 500 });
    expect(checkPayment(4500, 'efectivo', 4000).ok).toBe(false);
    expect(checkPayment(4500, 'transferencia', 0)).toEqual({ ok: true, changeCents: 0 });
    expect(checkPayment(0, 'efectivo', 100).ok).toBe(false);
  });

  it('sugiere billetes que cubren el total', () => {
    expect(quickCashOptions(4500)).toEqual([4500, 5000, 10000, 20000, 50000]);
  });
});

describe('report', () => {
  const base = {
    createdAt: '', day: '2026-10-10', shiftId: 's', receivedCents: 0, changeCents: 0,
    delivery: 'inmediata' as const,
  };
  const sales: Sale[] = [
    { ...base, id: 'a', folio: 1, status: 'completada', paymentMethod: 'efectivo', totalCents: 4500,
      items: [{ productId: 'p1', name: 'Limón persa', unit: 'kg', qtyMilli: 1500, unitPriceCents: 3000, totalCents: 4500 }] },
    { ...base, id: 'b', folio: 2, status: 'completada', paymentMethod: 'transferencia', totalCents: 3000, delivery: 'pendiente',
      items: [{ productId: 'p1', name: 'Limón persa', unit: 'kg', qtyMilli: 1000, unitPriceCents: 3000, totalCents: 3000 }] },
    { ...base, id: 'c', folio: 3, status: 'anulada', paymentMethod: 'efectivo', totalCents: 99999,
      items: [{ productId: 'p1', name: 'Limón persa', unit: 'kg', qtyMilli: 9000, unitPriceCents: 3000, totalCents: 99999 }] },
  ];

  it('excluye anuladas, cuenta vales una sola vez y calcula efectivo esperado', () => {
    const r = buildShiftReport({ openingCashCents: 20000 }, sales, [
      { id: 'm', shiftId: 's', createdAt: '', type: 'salida', amountCents: 1000, concept: 'bolsas' },
    ]);
    expect(r.valesCount).toBe(1);
    expect(r.valesCents).toBe(3000);
    expect(r.cashOutCents).toBe(1000);
    expect(r.salesCount).toBe(2);
    expect(r.voidedCount).toBe(1);
    expect(r.totalCents).toBe(7500);
    expect(r.byMethod).toEqual({ efectivo: 4500, transferencia: 3000, tarjeta: 0 });
    expect(r.expectedCashCents).toBe(23500);
    expect(r.byProduct).toEqual([
      { productId: 'p1', name: 'Limón persa', unit: 'kg', qtyMilli: 2500, totalCents: 7500 },
    ]);
  });

  it('día local con ceros', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});
