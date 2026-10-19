import { referenceKey } from './classification';
import { MAX_QTY_MILLI } from './money';
import type { Packaging, Product, Reception, WeightMode } from './types';

export const PACKAGINGS: readonly Packaging[] = ['granel', 'caja', 'arpilla'];
export const WEIGHT_MODES: readonly WeightMode[] = ['directo', 'por_envase', 'bruto_tara'];

export const PACKAGING_LABEL: Record<Packaging, string> = {
  granel: 'A granel',
  caja: 'Caja limonera',
  arpilla: 'Arpilla',
};
/** Sustantivo para mensajes: "10 cajas", "3 arpillas". */
export const CONTAINER_NOUN: Record<Packaging, { one: string; many: string }> = {
  granel: { one: 'envase', many: 'envases' },
  caja: { one: 'caja', many: 'cajas' },
  arpilla: { one: 'arpilla', many: 'arpillas' },
};
export const WEIGHT_MODE_LABEL: Record<WeightMode, string> = {
  directo: 'Kilos netos capturados',
  por_envase: 'Envases × peso de cada uno',
  bruto_tara: 'Bruto − tara',
};
/** Aclaración que se muestra junto a bruto / tara / neto (lenguaje del andén). */
export const WEIGHT_GLOSSARY = 'Bruto = con la caja o el costal · Tara = la caja o el costal vacío · Neto = solo el limón';

/** Una sola recepción no puede pasar de esto (sensatez + seguridad numérica). */
export const MAX_NET_MILLI = MAX_QTY_MILLI;
export const MAX_CONTAINERS = 100_000;
export const MAX_TEXT = { supplier: 120, reference: 60, notes: 500 } as const;
/** Tolerancia para relojes desajustados al validar que la fecha no sea futura. */
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
export const MIN_YEAR = 2000;

/** Lo que captura el usuario. Solo cuentan los campos del modo de peso activo. */
export interface ReceptionFields {
  id?: string;
  receivedAt?: string;
  supplier?: string;
  reference?: string;
  notes?: string;
  productId?: string;
  packaging: Packaging;
  containers?: number;
  weightMode: WeightMode;
  netDirectMilli?: number;
  /** Modo directo con varias pesadas (≥ 2): netDirectMilli debe ser su suma exacta. */
  weighingsMilli?: number[];
  unitNetMilli?: number;
  grossMilli?: number;
  tareMilli?: number;
}

export const MAX_WEIGHINGS = 100;

export type NetResult =
  | { ok: true; netMilli: number }
  | { ok: false; missing: boolean; error: string };

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const fmtKg = (milli: number) => `${(milli / 1000).toLocaleString('es-MX', { maximumFractionDigits: 3 })} kg`;

/**
 * Kilos netos según el modo de peso activo. `missing: true` = falta un dato (aceptable en un borrador);
 * `missing: false` = hay un dato inválido. Nunca suma un peso calculado con uno capturado.
 */
export function computeNet(f: ReceptionFields): NetResult {
  const missing = (error: string): NetResult => ({ ok: false, missing: true, error });
  const invalid = (error: string): NetResult => ({ ok: false, missing: false, error });
  const noun = CONTAINER_NOUN[f.packaging];

  switch (f.weightMode) {
    case 'directo': {
      if (f.netDirectMilli === undefined) return missing('Escribe los kilos netos');
      if (!isInt(f.netDirectMilli) || f.netDirectMilli <= 0) return invalid('Los kilos netos deben ser mayores a cero');
      if (f.netDirectMilli > MAX_NET_MILLI) return invalid(`Los kilos netos no pueden pasar de ${fmtKg(MAX_NET_MILLI)}`);
      if (f.weighingsMilli !== undefined) {
        const w = f.weighingsMilli;
        if (!Array.isArray(w) || w.length < 2 || w.length > MAX_WEIGHINGS) return invalid(`Las pesadas deben ser entre 2 y ${MAX_WEIGHINGS}`);
        if (!w.every((x) => isInt(x) && x > 0)) return invalid('Cada pesada debe ser mayor a cero');
        const sum = w.reduce((a, b) => a + b, 0);
        if (!Number.isSafeInteger(sum) || sum !== f.netDirectMilli) return invalid('Los kilos netos no coinciden con la suma de las pesadas');
      }
      return { ok: true, netMilli: f.netDirectMilli };
    }
    case 'por_envase': {
      if (f.packaging === 'granel') return invalid('A granel no hay cajas ni arpillas: usa kilos netos o bruto − tara');
      if (f.containers === undefined) return missing(`Escribe cuántas ${noun.many}`);
      if (!isInt(f.containers) || f.containers < 1) return invalid(`La cantidad de ${noun.many} debe ser un entero mayor a cero`);
      if (f.containers > MAX_CONTAINERS) return invalid(`Máximo ${MAX_CONTAINERS.toLocaleString('es-MX')} ${noun.many}`);
      if (f.unitNetMilli === undefined) {
        return missing(`Escribe el peso neto de cada ${noun.one} (si no lo conoces, guarda un borrador)`);
      }
      if (!isInt(f.unitNetMilli) || f.unitNetMilli <= 0) return invalid(`El peso por ${noun.one} debe ser mayor a cero`);
      const net = f.containers * f.unitNetMilli;
      if (!Number.isSafeInteger(net) || net > MAX_NET_MILLI) {
        return invalid(`El total no puede pasar de ${fmtKg(MAX_NET_MILLI)}`);
      }
      return { ok: true, netMilli: net };
    }
    case 'bruto_tara': {
      if (f.grossMilli === undefined) return missing('Escribe el peso bruto');
      if (!isInt(f.grossMilli) || f.grossMilli <= 0) return invalid('El peso bruto debe ser mayor a cero');
      if (f.grossMilli > MAX_NET_MILLI) return invalid(`El peso bruto no puede pasar de ${fmtKg(MAX_NET_MILLI)}`);
      if (f.tareMilli === undefined) return missing('Escribe la tara (0 si no hay)');
      if (!isInt(f.tareMilli) || f.tareMilli < 0) return invalid('La tara no puede ser negativa');
      if (f.tareMilli >= f.grossMilli) return invalid('La tara debe ser menor al peso bruto');
      return { ok: true, netMilli: f.grossMilli - f.tareMilli };
    }
    default:
      return invalid('Modo de peso desconocido');
  }
}

const cleanText = (s: string | undefined): string | undefined => {
  const t = (s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  return t === '' ? undefined : t;
};

/**
 * Deja solo lo que corresponde: textos recortados y SOLO los campos del modo de peso activo
 * (al cambiar de modo se descartan los demás). `containers` no aplica a granel.
 */
export function normalizeFields(f: ReceptionFields): ReceptionFields {
  const out: ReceptionFields = {
    ...(f.id ? { id: f.id } : {}),
    packaging: f.packaging,
    weightMode: f.weightMode,
  };
  if (f.receivedAt) out.receivedAt = f.receivedAt;
  const supplier = cleanText(f.supplier);
  const reference = cleanText(f.reference);
  const notes = cleanText(f.notes);
  if (supplier) out.supplier = supplier;
  if (reference) out.reference = reference;
  if (notes) out.notes = notes;
  if (f.productId) out.productId = f.productId;
  if (f.packaging !== 'granel' && f.containers !== undefined) out.containers = f.containers;
  if (f.weightMode === 'directo' && f.netDirectMilli !== undefined) out.netDirectMilli = f.netDirectMilli;
  if (f.weightMode === 'directo' && Array.isArray(f.weighingsMilli) && f.weighingsMilli.length >= 2) {
    out.weighingsMilli = [...f.weighingsMilli];
  }
  if (f.weightMode === 'por_envase' && f.unitNetMilli !== undefined) out.unitNetMilli = f.unitNetMilli;
  if (f.weightMode === 'bruto_tara') {
    if (f.grossMilli !== undefined) out.grossMilli = f.grossMilli;
    if (f.tareMilli !== undefined) out.tareMilli = f.tareMilli;
  }
  return out;
}

const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export interface ValidateOptions {
  /** true = se va a confirmar: exige producto, peso completo y válido. */
  forConfirm: boolean;
  now?: Date;
  /** Producto destino (ya cargado) para validar unidad/estado al confirmar. */
  product?: Pick<Product, 'unit' | 'active'> | null;
}

/** Lista de errores (vacía = válido). Recibe campos YA normalizados por normalizeFields. */
export function validateFields(f: ReceptionFields, opts: ValidateOptions): string[] {
  const errors: string[] = [];
  const now = opts.now ?? new Date();

  if (!PACKAGINGS.includes(f.packaging)) errors.push('Presentación inválida');
  if (!WEIGHT_MODES.includes(f.weightMode)) errors.push('Modo de peso inválido');
  if (errors.length) return errors;

  for (const [key, label] of [['supplier', 'Proveedor'], ['reference', 'Referencia'], ['notes', 'Observaciones']] as const) {
    const v = f[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') errors.push(`${label}: texto inválido`);
    else if (FORBIDDEN.test(v)) errors.push(`${label}: contiene caracteres no permitidos`);
    else if (v.length > MAX_TEXT[key]) errors.push(`${label}: máximo ${MAX_TEXT[key]} caracteres`);
  }

  if (f.receivedAt !== undefined) {
    const t = Date.parse(f.receivedAt);
    if (Number.isNaN(t)) errors.push('La fecha y hora de recepción no es válida');
    else if (new Date(t).getUTCFullYear() < MIN_YEAR) errors.push('La fecha de recepción es demasiado antigua');
    else if (t > now.getTime() + FUTURE_TOLERANCE_MS) errors.push('La fecha de recepción no puede ser futura');
  }

  if (f.packaging === 'granel' && f.containers !== undefined) errors.push('A granel no se cuentan cajas ni arpillas');
  if (f.containers !== undefined && f.packaging !== 'granel') {
    if (!isInt(f.containers) || f.containers < 1) errors.push('La cantidad de envases debe ser un entero mayor a cero');
    else if (f.containers > MAX_CONTAINERS) errors.push(`Máximo ${MAX_CONTAINERS.toLocaleString('es-MX')} envases`);
  }

  const net = computeNet(f);
  if (!net.ok) {
    // En un borrador solo estorba un dato inválido; que falte es normal.
    if (opts.forConfirm || !net.missing) errors.push(net.error);
  }

  if (opts.forConfirm) {
    if (!f.productId) errors.push('Elige el tipo de limón (variedad y clasificación)');
    else if (!opts.product) errors.push('La variedad elegida ya no existe');
    else if (!opts.product.active) errors.push('La variedad elegida está oculta: actívala en Inventario');
    else if (opts.product.unit !== 'kg') {
      errors.push('La recepción suma kilos: elige una variedad que se venda por kg');
    }
  } else {
    const empty =
      !f.productId && !f.supplier && !f.reference && !f.notes && f.containers === undefined &&
      f.netDirectMilli === undefined && f.unitNetMilli === undefined &&
      f.grossMilli === undefined && f.tareMilli === undefined;
    if (empty) errors.push('El borrador está vacío: captura al menos un dato');
  }
  return errors;
}

export const DUP_REFERENCE_WINDOW_MS = 48 * 3600 * 1000;
export const DUP_SAME_KILOS_WINDOW_MS = 10 * 60 * 1000;

/**
 * Recepciones CONFIRMADAS que podrían ser la misma que se va a registrar con otro id (posible doble captura).
 * Es un aviso, nunca un bloqueo: lo reconoce el usuario. Referencia o proveedor vacíos nunca coinciden.
 *  1. misma referencia (camión), mismo producto y llegada con menos de 48 h de diferencia
 *     (una placa que se repite cada semana NO avisa);
 *  2. mismo proveedor, mismo producto, mismos kilos netos vigentes y mismo día de llegada;
 *  3. mismo producto y mismos kilos confirmados hace menos de 10 minutos (cubre el reintento tras recargar la app).
 */
export function possibleDuplicates(
  candidate: {
    id: string;
    productId: string;
    reference?: string;
    supplier?: string;
    netMilli: number;
    day: string;
    /** Llegada de la recepción nueva (ms). */
    receivedAtMs: number;
    /** Instante en que se está confirmando (ms). */
    atMs: number;
  },
  existing: Reception[],
): Reception[] {
  const ref = referenceKey(candidate.reference);
  const sup = referenceKey(candidate.supplier);
  return existing.filter((r) => {
    if (r.id === candidate.id || r.status !== 'confirmada' || r.productId !== candidate.productId) return false;
    const net = currentNetMilli(r);
    if (ref && referenceKey(r.reference) === ref && Math.abs(Date.parse(r.receivedAt) - candidate.receivedAtMs) <= DUP_REFERENCE_WINDOW_MS) return true;
    if (sup && referenceKey(r.supplier) === sup && net === candidate.netMilli && r.day === candidate.day) return true;
    return net === candidate.netMilli && !!r.confirmedAt && Math.abs(candidate.atMs - Date.parse(r.confirmedAt)) <= DUP_SAME_KILOS_WINDOW_MS;
  });
}

/** Kilos netos vigentes de una recepción (0 si está anulada o es borrador/cancelada). */
export function currentNetMilli(r: Pick<Reception, 'status' | 'confirmedNetMilli' | 'corrections'>): number {
  if (r.status !== 'confirmada') return 0;
  return (r.confirmedNetMilli ?? 0) + r.corrections.reduce((s, c) => s + c.deltaMilli, 0);
}
