import type { Unit } from './types';

const mxn = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  minimumFractionDigits: 2,
});

export function formatMoney(cents: number): string {
  return mxn.format(cents / 100);
}

/** Total de una línea: precio por unidad × cantidad, redondeado al centavo. */
export function lineTotalCents(unitPriceCents: number, qtyMilli: number): number {
  return Math.round((unitPriceCents * qtyMilli) / 1000);
}

/**
 * Convierte texto del teclado ("1.5", "1,5", "20") a un entero escalado.
 * Devuelve null si el texto no es un número positivo válido.
 */
function parseScaled(text: string, scale: number, maxDecimals: number): number | null {
  const t = text.trim().replace(',', '.');
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null;
  const [int, dec = ''] = t.split('.');
  if (dec.length > maxDecimals) return null;
  const value = Number(int || '0') * scale + Number(dec.padEnd(maxDecimals, '0') || '0') * (scale / 10 ** maxDecimals);
  return Number.isSafeInteger(value) ? value : null;
}

/** "12.50" → 1250 centavos. */
export function parseMoney(text: string): number | null {
  return parseScaled(text, 100, 2);
}

/** "1.250" → 1250 milésimas (gramos si es kg). */
export function parseQty(text: string): number | null {
  return parseScaled(text, 1000, 3);
}

/**
 * Cantidad que se obtiene con un monto dado ("dame $20 de limón").
 * Se redondea hacia abajo al gramo/milésima para no regalar producto.
 */
export function qtyForAmount(amountCents: number, unitPriceCents: number): number {
  if (unitPriceCents <= 0) return 0;
  return Math.floor((amountCents * 1000) / unitPriceCents);
}

export function formatQty(qtyMilli: number, unit: Unit): string {
  if (unit === 'kg') {
    if (Math.abs(qtyMilli) < 1000) return `${qtyMilli} g`;
    const kg = qtyMilli / 1000;
    return `${kg.toLocaleString('es-MX', { maximumFractionDigits: 3 })} kg`;
  }
  const n = qtyMilli / 1000;
  const label = unit === 'pieza' ? 'pza' : unit;
  return `${n.toLocaleString('es-MX', { maximumFractionDigits: 3 })} ${label}`;
}

export const UNIT_LABEL: Record<Unit, string> = {
  kg: 'kg',
  pieza: 'pieza',
  caja: 'caja',
  arpilla: 'arpilla',
};
