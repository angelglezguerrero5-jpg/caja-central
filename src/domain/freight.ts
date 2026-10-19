import { MIN_YEAR } from './reception';
import { MAX_REASON, checkedText, normalizeText } from './limits';
import { MAX_QTY_MILLI } from './money';
import type { Freight, FreightSettings, FreightWeightMode } from './types';

/**
 * Control de pesaje por flete: peso INICIAL (origen) y peso FINAL (destino), su diferencia y el porcentaje respecto al
 * inicial. Todo es aritmética entera en milésimas de kg; la diferencia y el porcentaje NO se guardan, se calculan.
 *
 *   peso neto  = peso bruto − tara                 (o el neto capturado, si la boleta solo trae el neto)
 *   diferencia = peso neto inicial − peso neto final   (positiva = llegó MENOS que lo que salió)
 *   porcentaje = diferencia ÷ peso neto inicial × 100
 *
 * Esta pieza NO decide por qué hay diferencia: no la llama merma ni deshidratación. Solo la compara con una referencia
 * configurable (por omisión 200–300 kg, pendiente de validación).
 */

export const FREIGHT_WEIGHT_MODES: readonly FreightWeightMode[] = ['bruto_tara', 'directo'];
export const FREIGHT_WEIGHT_MODE_LABEL: Record<FreightWeightMode, string> = {
  bruto_tara: 'Bruto − tara',
  directo: 'Solo tengo el neto',
};
export const SIDE_LABEL = { initial: 'Peso inicial (origen)', final: 'Peso final (destino)' } as const;

/** Un solo flete no puede pasar de esto (sensatez + seguridad numérica). 200 000 kg. */
export const MAX_FREIGHT_NET_MILLI = MAX_QTY_MILLI;
export const MAX_FREIGHT_TEXT = { folio: 40, place: 120, ticket: 60, scale: 120, notes: 500 } as const;
/** Tolerancia para relojes desajustados al validar que la fecha no sea futura. */
export const FREIGHT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Referencia por omisión: 200–300 kg de diferencia, PENDIENTE DE VALIDACIÓN. */
export const DEFAULT_FREIGHT_SETTINGS: FreightSettings = { refMinMilli: 200_000, refMaxMilli: 300_000, validated: false };

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const fmtKg = (milli: number) => `${(milli / 1000).toLocaleString('es-MX', { maximumFractionDigits: 3 })} kg`;

/** Lo que captura la persona para UNA pesada. Solo cuentan los campos del modo activo. */
export interface FreightSideFields {
  mode: FreightWeightMode;
  grossMilli?: number;
  tareMilli?: number;
  /** Solo modo directo. */
  netMilli?: number;
  ticket?: string;
  scale?: string;
}

export interface FreightFields {
  id?: string;
  folio?: string;
  date?: string;
  origin?: string;
  destination?: string;
  notes?: string;
  initial?: FreightSideFields;
  final?: FreightSideFields;
}

export type SideNetResult =
  | { ok: true; netMilli: number }
  | { ok: false; missing: boolean; error: string };

/**
 * Peso neto de una pesada. `missing: true` = falta un dato; `missing: false` = hay un dato inválido (negativo, cero donde
 * no se vale, tara mayor o igual al bruto...). Nunca mezcla un neto capturado con uno calculado.
 */
export function computeSideNet(s: FreightSideFields): SideNetResult {
  const missing = (error: string): SideNetResult => ({ ok: false, missing: true, error });
  const invalid = (error: string): SideNetResult => ({ ok: false, missing: false, error });
  switch (s.mode) {
    case 'bruto_tara': {
      if (s.grossMilli === undefined) return missing('Escribe el peso bruto');
      if (!isInt(s.grossMilli) || s.grossMilli <= 0) return invalid('El peso bruto debe ser mayor a cero');
      if (s.grossMilli > MAX_FREIGHT_NET_MILLI) return invalid(`El peso bruto no puede pasar de ${fmtKg(MAX_FREIGHT_NET_MILLI)}`);
      if (s.tareMilli === undefined) return missing('Escribe la tara (0 si no hay)');
      if (!isInt(s.tareMilli) || s.tareMilli < 0) return invalid('La tara no puede ser negativa');
      if (s.tareMilli >= s.grossMilli) return invalid('La tara debe ser menor al peso bruto');
      return { ok: true, netMilli: s.grossMilli - s.tareMilli };
    }
    case 'directo': {
      if (s.netMilli === undefined) return missing('Escribe el peso neto');
      if (!isInt(s.netMilli) || s.netMilli <= 0) return invalid('El peso neto debe ser mayor a cero');
      if (s.netMilli > MAX_FREIGHT_NET_MILLI) return invalid(`El peso neto no puede pasar de ${fmtKg(MAX_FREIGHT_NET_MILLI)}`);
      return { ok: true, netMilli: s.netMilli };
    }
    default:
      return invalid('Modo de peso desconocido');
  }
}

const cleanText = (s: string | undefined): string | undefined => {
  const t = normalizeText(s);
  return t === '' ? undefined : t;
};

/** ¿La pesada no tiene ningún dato capturado? (se trata como «no hay pesada» y no como una pesada incompleta) */
export function sideIsBlank(s: FreightSideFields | undefined): boolean {
  return !s || (s.grossMilli === undefined && s.tareMilli === undefined && s.netMilli === undefined && !cleanText(s.ticket) && !cleanText(s.scale));
}

/** Limpia textos y deja SOLO los campos del modo activo. */
export function normalizeSide(s: FreightSideFields): FreightSideFields {
  const ticket = cleanText(s.ticket);
  const scale = cleanText(s.scale);
  return {
    mode: s.mode,
    ...(s.mode === 'bruto_tara' && s.grossMilli !== undefined ? { grossMilli: s.grossMilli } : {}),
    ...(s.mode === 'bruto_tara' && s.tareMilli !== undefined ? { tareMilli: s.tareMilli } : {}),
    ...(s.mode === 'directo' && s.netMilli !== undefined ? { netMilli: s.netMilli } : {}),
    ...(ticket ? { ticket } : {}),
    ...(scale ? { scale } : {}),
  };
}

export function normalizeFreightFields(f: FreightFields): FreightFields {
  const folio = cleanText(f.folio);
  const origin = cleanText(f.origin);
  const destination = cleanText(f.destination);
  const notes = cleanText(f.notes);
  const initial = f.initial && !sideIsBlank(f.initial) ? normalizeSide(f.initial) : undefined;
  const final = f.final && !sideIsBlank(f.final) ? normalizeSide(f.final) : undefined;
  return {
    ...(f.id ? { id: f.id } : {}),
    ...(folio ? { folio } : {}),
    ...(f.date ? { date: f.date } : {}),
    ...(origin ? { origin } : {}),
    ...(destination ? { destination } : {}),
    ...(notes ? { notes } : {}),
    ...(initial ? { initial } : {}),
    ...(final ? { final } : {}),
  };
}

/** Folio normalizado: el que decide si dos folios son el mismo (mayúsculas/minúsculas y espacios no cuentan). */
export const folioKeyOf = (folio: string): string => normalizeText(folio).toUpperCase();

function textError(raw: string | undefined, label: string, max: number): string | null {
  try {
    checkedText(raw, label, max);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function dateError(iso: string | undefined, label: string, now: Date): string | null {
  if (iso === undefined) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return `${label}: la fecha no es válida`;
  if (new Date(t).getUTCFullYear() < MIN_YEAR) return `${label}: la fecha es demasiado antigua`;
  if (t > now.getTime() + FREIGHT_FUTURE_TOLERANCE_MS) return `${label}: la fecha no puede ser futura`;
  return null;
}

/** Errores de UNA pesada ya normalizada (lista vacía = válida). */
export function validateSide(s: FreightSideFields, label: string): string[] {
  const errors: string[] = [];
  const net = computeSideNet(s);
  if (!net.ok) errors.push(`${label}: ${net.error}`);
  const t = textError(s.ticket, `${label} · boleta`, MAX_FREIGHT_TEXT.ticket);
  if (t) errors.push(t);
  const b = textError(s.scale, `${label} · báscula`, MAX_FREIGHT_TEXT.scale);
  if (b) errors.push(b);
  return errors;
}

/**
 * Errores de un flete ya normalizado (lista vacía = se puede guardar). Un flete necesita folio, origen, destino y al menos
 * UNA pesada válida; la otra puede llegar después (queda «incompleto» y sin diferencia).
 */
export function validateFreightFields(f: FreightFields, opts: { now: Date }): string[] {
  const errors: string[] = [];
  if (!f.folio) errors.push('Escribe el folio del flete');
  else {
    const e = textError(f.folio, 'Folio', MAX_FREIGHT_TEXT.folio);
    if (e) errors.push(e);
  }
  const de = dateError(f.date, 'Fecha', opts.now);
  if (de) errors.push(de);
  if (!f.origin) errors.push('Escribe el origen del flete (de dónde sale)');
  else {
    const e = textError(f.origin, 'Origen', MAX_FREIGHT_TEXT.place);
    if (e) errors.push(e);
  }
  if (!f.destination) errors.push('Escribe el destino del flete (a dónde llega)');
  else {
    const e = textError(f.destination, 'Destino', MAX_FREIGHT_TEXT.place);
    if (e) errors.push(e);
  }
  const ne = textError(f.notes, 'Observaciones', MAX_FREIGHT_TEXT.notes);
  if (ne) errors.push(ne);
  if (!f.initial && !f.final) errors.push('Captura al menos una pesada: el peso inicial (origen) o el final (destino)');
  if (f.initial) errors.push(...validateSide(f.initial, SIDE_LABEL.initial));
  if (f.final) errors.push(...validateSide(f.final, SIDE_LABEL.final));
  return errors;
}

/** Valida el motivo de una corrección o anulación (obligatorio y acotado). */
export function checkedReason(raw: string | undefined): string {
  const t = checkedText(raw, 'Motivo', MAX_REASON);
  if (!t) throw new Error('Escribe el motivo');
  return t;
}

// ── Diferencia, porcentaje y referencia ──────────────────────────────────────────────────────────────────────────────

export interface FreightDifference {
  /** Peso neto inicial − peso neto final, en milésimas de kg. Positiva = llegó menos que lo que salió. */
  diffMilli: number;
  /** Porcentaje respecto al peso inicial en centésimas de punto (250 = 2.50 %). Mismo signo que la diferencia. */
  percentBp: number;
}

/** n ÷ d redondeado al entero más cercano (mitades alejándose de cero), solo con enteros: sin errores de coma flotante. */
function roundDiv(n: number, d: number): number {
  const q = Math.floor((2 * Math.abs(n) + d) / (2 * d));
  return n < 0 ? -q : q;
}

/**
 * Diferencia y porcentaje, o `null` si no se pueden calcular: falta uno de los pesos, o el inicial no es mayor a cero
 * (dividir entre cero). Con datos válidos de captura nunca ocurre lo segundo.
 */
export function computeDifference(initialNetMilli: number | undefined, finalNetMilli: number | undefined): FreightDifference | null {
  if (!isInt(initialNetMilli) || !isInt(finalNetMilli) || initialNetMilli <= 0 || finalNetMilli <= 0) return null;
  const diffMilli = initialNetMilli - finalNetMilli;
  return { diffMilli, percentBp: roundDiv(diffMilli * 10_000, initialNetMilli) };
}

/** Diferencia de un flete (null si está incompleto). */
export const differenceOf = (f: Pick<Freight, 'initial' | 'final'>): FreightDifference | null =>
  computeDifference(f.initial?.netMilli, f.final?.netMilli);

/** "2.50 %" / "−1.00 %". */
export function formatPercentBp(bp: number): string {
  const s = (Math.abs(bp) / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${bp < 0 ? '−' : ''}${s} %`;
}

/** "250 kg" / "−100 kg" / "800 g". */
export function formatDiff(diffMilli: number): string {
  const abs = Math.abs(diffMilli);
  const text = abs < 1000 ? `${abs} g` : `${(abs / 1000).toLocaleString('es-MX', { maximumFractionDigits: 3 })} kg`;
  return `${diffMilli < 0 ? '−' : ''}${text}`;
}

export type DifferenceClass = 'sin_referencia' | 'final_mayor' | 'sin_diferencia' | 'dentro' | 'debajo' | 'encima';

export interface FreightRange {
  minMilli: number;
  maxMilli: number;
}

/** Rango de referencia vigente, o null si se desactivó. */
export function referenceOf(s: FreightSettings): FreightRange | null {
  return s.refMinMilli !== undefined && s.refMaxMilli !== undefined ? { minMilli: s.refMinMilli, maxMilli: s.refMaxMilli } : null;
}

/**
 * Compara la diferencia con la referencia. Solo CLASIFICA contra el rango; nunca dice por qué hay diferencia.
 * Un peso final MAYOR que el inicial no es «cero diferencia»: se marca aparte porque suele ser una boleta mal capturada.
 */
export function classifyDifference(d: FreightDifference | null, ref: FreightRange | null): DifferenceClass | null {
  if (!d) return null;
  if (d.diffMilli < 0) return 'final_mayor';
  if (d.diffMilli === 0) return 'sin_diferencia';
  if (!ref) return 'sin_referencia';
  if (d.diffMilli < ref.minMilli) return 'debajo';
  if (d.diffMilli > ref.maxMilli) return 'encima';
  return 'dentro';
}

export const DIFFERENCE_TEXT: Record<DifferenceClass, string> = {
  sin_referencia: 'Sin rango de referencia configurado',
  final_mayor: 'El peso final es MAYOR que el inicial: revisa las boletas y el pesaje',
  sin_diferencia: 'Sin diferencia de peso',
  dentro: 'Dentro del rango de referencia',
  debajo: 'Por debajo del rango de referencia',
  encima: 'Por encima del rango de referencia',
};

/** "200–300 kg" (+ «pendiente de validación»). */
export function referenceLabel(s: FreightSettings): string {
  const r = referenceOf(s);
  if (!r) return 'Sin rango de referencia';
  const kg = (m: number) => (m / 1000).toLocaleString('es-MX', { maximumFractionDigits: 3 });
  return `${kg(r.minMilli)}–${kg(r.maxMilli)} kg${s.validated ? '' : ' · pendiente de validación'}`;
}

/** Errores de la configuración del rango (lista vacía = válida). */
export function validateFreightSettings(s: FreightSettings): string[] {
  const errors: string[] = [];
  if (typeof s.validated !== 'boolean') errors.push('Falta indicar si el rango ya está validado');
  const hasMin = s.refMinMilli !== undefined;
  const hasMax = s.refMaxMilli !== undefined;
  if (hasMin !== hasMax) errors.push('Escribe el mínimo y el máximo del rango (o deja los dos vacíos para no usar rango)');
  else if (hasMin && hasMax) {
    const lo = s.refMinMilli as number;
    const hi = s.refMaxMilli as number;
    if (!isInt(lo) || !isInt(hi) || lo < 0 || hi < 0) errors.push('El rango no puede tener kilos negativos');
    else if (hi > MAX_FREIGHT_NET_MILLI) errors.push(`El máximo del rango no puede pasar de ${fmtKg(MAX_FREIGHT_NET_MILLI)}`);
    else if (lo > hi) errors.push('El mínimo del rango no puede ser mayor que el máximo');
  }
  return errors;
}

// ── Estado y totales ─────────────────────────────────────────────────────────────────────────────────────────────────

export type FreightState = 'completo' | 'falta_inicial' | 'falta_final' | 'anulado';

export function freightState(f: Pick<Freight, 'status' | 'initial' | 'final'>): FreightState {
  if (f.status === 'anulado') return 'anulado';
  if (f.initial && f.final) return 'completo';
  return f.initial ? 'falta_final' : 'falta_inicial';
}

export const STATE_LABEL: Record<FreightState, string> = {
  completo: 'Completo',
  falta_inicial: 'Falta el peso inicial',
  falta_final: 'Falta el peso final',
  anulado: 'Anulado',
};

export interface FreightTotals {
  /** Fletes vigentes (no anulados). */
  active: number;
  complete: number;
  incomplete: number;
  voided: number;
  /** Sumas de los fletes COMPLETOS vigentes. */
  initialMilli: number;
  finalMilli: number;
  diffMilli: number;
  /** Porcentaje de la suma (diferencia total ÷ inicial total), null sin fletes completos. */
  percentBp: number | null;
}

export function totalsOf(list: Freight[]): FreightTotals {
  let initialMilli = 0;
  let finalMilli = 0;
  let complete = 0;
  let incomplete = 0;
  let voided = 0;
  for (const f of list) {
    const st = freightState(f);
    if (st === 'anulado') voided++;
    else if (st === 'completo') {
      complete++;
      initialMilli += f.initial!.netMilli;
      finalMilli += f.final!.netMilli;
    } else incomplete++;
  }
  const d = computeDifference(initialMilli, finalMilli);
  return {
    active: complete + incomplete,
    complete,
    incomplete,
    voided,
    initialMilli,
    finalMilli,
    diffMilli: initialMilli - finalMilli,
    percentBp: complete > 0 && d ? d.percentBp : null,
  };
}

/** Siguiente folio libre con el formato F-AAMMDD-NN para un día local YYYY-MM-DD (sin tocar los ya usados). */
export function suggestFolio(takenKeys: ReadonlySet<string>, day: string): string {
  const ymd = day.slice(2).replace(/-/g, '');
  for (let n = 1; n < 100_000; n++) {
    const candidate = `F-${ymd}-${String(n).padStart(2, '0')}`;
    if (!takenKeys.has(folioKeyOf(candidate))) return candidate;
  }
  return `F-${ymd}-${takenKeys.size + 1}`;
}
