import type { Unit } from './types';

/**
 * Límites de seguridad numérica. precio × cantidad = 10 000 000 × 200 000 000 = 2e15 < 2^53, así que ningún
 * total puede desbordar la aritmética entera de JavaScript.
 */
export const MAX_QTY_MILLI = 200_000_000; // 200 000 kg (o unidades) por operación
export const MAX_PRICE_CENTS = 10_000_000; // $100 000 por unidad de venta
export const MAX_MONEY_CENTS = 100_000_000_000; // $1 000 000 000 (efectivo recibido, fondos, salidas)
/** Saldo de inventario (en milésimas) que ninguna suma de movimientos debe rebasar: 1 000 000 de toneladas. */
export const MAX_STOCK_MILLI = 1_000_000_000_000;

/**
 * Topes para datos YA GUARDADOS (respaldos y bases migradas). Son más amplios que los de captura porque la versión 1 no tenía
 * topes: una cantidad mal tecleada (p. ej. 1 000 000 kg) pudo quedar en el historial y el respaldo que la propia app exporta
 * tiene que poder restaurarse. Siguen siendo enteros seguros; lo que rebase los topes de captura se avisa en la auditoría.
 */
export const HIST_QTY_MILLI = MAX_STOCK_MILLI; // 1 000 000 t por renglón
export const HIST_PRICE_CENTS = MAX_MONEY_CENTS; // $1 000 000 000 por unidad
export const HIST_MONEY_CENTS = 10_000_000_000_000; // $100 000 000 000 en importes, efectivo, fondos y salidas

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
  const product = unitPriceCents * qtyMilli;
  if (!Number.isSafeInteger(product)) throw new RangeError('El importe es demasiado grande');
  return Math.round(product / 1000);
}

/**
 * "1,500" es AMBIGUO en México: la app muestra 1 500 kg como "1,500 kg", pero con coma decimal sería 1.5. No se adivina:
 * se rechaza y se pide escribirlo sin coma. Con dos o más grupos ("1,500,000") o con punto decimal ("1,500.5") la coma
 * solo puede ser de miles y se acepta; con 1 o 2 decimales ("15,5") es coma decimal.
 */
export function isAmbiguousNumber(text: string): boolean {
  return /^\d+,\d{3}$/.test(text.trim());
}

/** Aviso en lenguaje llano para un número ambiguo; '' si no lo es. */
export function ambiguousNumberHint(text: string): string {
  const t = text.trim();
  if (!isAmbiguousNumber(t)) return '';
  const [i, d] = t.split(',');
  const thousands = `${Number(i)}${d}`; // 1,200 → 1200
  const decimal = `${Number(i)}.${d}`.replace(/\.?0+$/, ''); // 1,200 → 1.2
  return `«${t}» se puede leer como ${thousands} o como ${decimal}. Escribe ${thousands} o ${decimal} para que quede claro.`;
}

function normalizeSeparators(t: string): string | null {
  if (/^\d{1,3}(,\d{3})+\.\d+$/.test(t) || /^\d{1,3}(,\d{3}){2,}$/.test(t)) return t.replace(/,/g, ''); // miles
  if (isAmbiguousNumber(t)) return null;
  return t.replace(',', '.'); // coma decimal: 15,5
}

/**
 * Convierte texto del teclado ("1.5", "1,5", "20") a un entero escalado.
 * Devuelve null si el texto no es un número positivo válido o es ambiguo (ver isAmbiguousNumber).
 */
function parseScaled(text: string, scale: number, maxDecimals: number, max: number): number | null {
  const norm = normalizeSeparators(text.trim());
  if (norm === null) return null;
  const t = norm;
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null;
  const [int, dec = ''] = t.split('.');
  if (dec.length > maxDecimals) return null;
  const value = Number(int || '0') * scale + Number(dec.padEnd(maxDecimals, '0') || '0') * (scale / 10 ** maxDecimals);
  return Number.isSafeInteger(value) && value <= max ? value : null;
}

/** "12.50" → 1250 centavos. */
export function parseMoney(text: string, max = MAX_MONEY_CENTS): number | null {
  return parseScaled(text, 100, 2, max);
}

/** Precio por unidad de venta (más estricto que un monto de efectivo). */
export function parsePrice(text: string): number | null {
  return parseScaled(text, 100, 2, MAX_PRICE_CENTS);
}

/** Cantidad entera (envases, piezas): solo dígitos —sin signo, decimales, comas ni notación científica— de 1 a `max`. */
export function parseCount(text: string, max = 1_000_000_000): number | null {
  const t = text.trim();
  if (!/^\d{1,9}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= max ? n : null;
}

/** "1.250" → 1250 milésimas (gramos si es kg). */
export function parseQty(text: string, max = MAX_QTY_MILLI): number | null {
  return parseScaled(text, 1000, 3, max);
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
