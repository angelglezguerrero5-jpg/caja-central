import { lineTotalCents } from './money';
import type { CartLine, PaymentMethod, Product, SaleItem } from './types';

/** Nombre mostrable: variedad + calidad opcional. */
export function productLabel(p: Pick<Product, 'name' | 'quality'>): string {
  return p.quality ? `${p.name} · ${p.quality}` : p.name;
}

export function addLine(cart: CartLine[], product: Product, qtyMilli: number): CartLine[] {
  if (!Number.isSafeInteger(qtyMilli) || qtyMilli <= 0) {
    throw new Error('Cantidad inválida');
  }
  // Mismo producto y mismo precio → se acumula en una sola línea.
  const idx = cart.findIndex(
    (l) => l.productId === product.id && l.unitPriceCents === product.priceCents,
  );
  if (idx >= 0) {
    return cart.map((l, i) => (i === idx ? { ...l, qtyMilli: l.qtyMilli + qtyMilli } : l));
  }
  return [
    ...cart,
    {
      productId: product.id,
      name: productLabel(product),
      unit: product.unit,
      qtyMilli,
      unitPriceCents: product.priceCents,
    },
  ];
}

export function removeLine(cart: CartLine[], index: number): CartLine[] {
  return cart.filter((_, i) => i !== index);
}

export function toSaleItems(cart: CartLine[]): SaleItem[] {
  return cart.map((l) => ({ ...l, totalCents: lineTotalCents(l.unitPriceCents, l.qtyMilli) }));
}

export function cartTotalCents(cart: CartLine[]): number {
  return toSaleItems(cart).reduce((s, i) => s + i.totalCents, 0);
}

export interface PaymentCheck {
  ok: boolean;
  changeCents: number;
  error?: string;
}

export function checkPayment(
  totalCents: number,
  method: PaymentMethod,
  receivedCents: number,
): PaymentCheck {
  if (totalCents <= 0) return { ok: false, changeCents: 0, error: 'El ticket está vacío' };
  if (method !== 'efectivo') return { ok: true, changeCents: 0 };
  if (!Number.isSafeInteger(receivedCents) || receivedCents < totalCents) {
    return { ok: false, changeCents: 0, error: 'El efectivo recibido no cubre el total' };
  }
  return { ok: true, changeCents: receivedCents - totalCents };
}

/** Billetes sugeridos para cobro rápido: monto exacto + billetes que lo cubren. */
export function quickCashOptions(totalCents: number): number[] {
  const bills = [2000, 5000, 10000, 20000, 50000, 100000];
  const opts = [totalCents];
  for (const b of bills) {
    if (b > totalCents && opts.length < 5) opts.push(b);
  }
  return opts;
}
