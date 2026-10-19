import {
  DEFAULT_FREIGHT_SETTINGS,
  checkedReason,
  computeSideNet,
  folioKeyOf,
  normalizeFreightFields,
  validateFreightFields,
  validateFreightSettings,
  type FreightFields,
  type FreightSideFields,
} from '../domain/freight';
import { localDay } from '../domain/report';
import type { Freight, FreightRevision, FreightSettings, FreightSide } from '../domain/types';
import { abortWith, newId, runRw, type DB } from './repo';

/**
 * Control de pesaje por flete. Cada operación es UNA transacción sobre el almacén `freights`: o ocurre completa o no ocurre.
 * Un flete NO toca inventario, ventas ni caja (las existencias se mueven en Recepción), así que no hay nada más que cuadrar.
 *
 *  - Folio único: el índice `byFolioKey` (único) lo garantiza aunque dos ventanas guarden a la vez; la comparación ignora
 *    mayúsculas y espacios de sobra. Un flete anulado CONSERVA su folio (no se reutiliza).
 *  - Idempotencia: la pantalla reparte un `id` por intento; repetir el mismo id (doble toque, reintento) no crea otro flete.
 *  - Nada se borra: cambiar un dato ya capturado exige motivo y queda en la bitácora `revisions` (antes → después); anular
 *    conserva todo y exige motivo. Completar una pesada que faltaba no necesita motivo (no se pisa nada).
 */

/** Ese id ya estaba registrado: NO se crea otro flete (doble toque / reintento). La interfaz lo trata como éxito. */
export class DuplicateFreightError extends Error {
  constructor(public freight: Freight) {
    super(`El flete ya estaba registrado (${freight.folio})`);
  }
}

/** Ya existe OTRO flete con ese folio (aunque cambien mayúsculas o espacios). */
export class FreightFolioTakenError extends Error {
  constructor(public freight: Freight) {
    super(`Ya existe un flete con el folio ${freight.folio}. El folio no se puede repetir`);
  }
}

export class FreightValidationError extends Error {
  constructor(public errors: string[]) {
    super(errors.join(' · ') || 'Flete inválido');
  }
}

const toIso = (d: Date) => d.toISOString();

function sideOf(s: FreightSideFields): FreightSide {
  const net = computeSideNet(s);
  if (!net.ok) throw new FreightValidationError([net.error]);
  return {
    mode: s.mode,
    ...(s.mode === 'bruto_tara' ? { grossMilli: s.grossMilli, tareMilli: s.tareMilli } : {}),
    netMilli: net.netMilli,
    ...(s.ticket ? { ticket: s.ticket } : {}),
    ...(s.scale ? { scale: s.scale } : {}),
  } as FreightSide;
}

/** Arma el registro a partir de campos ya normalizados y válidos. */
function build(f: FreightFields, id: string, existing: Freight | undefined, atIso: string): Freight {
  const date = f.date ? toIso(new Date(f.date)) : (existing?.date ?? atIso);
  return {
    id,
    folio: f.folio!,
    folioKey: folioKeyOf(f.folio!),
    status: 'activo',
    createdAt: existing?.createdAt ?? atIso,
    updatedAt: atIso,
    date,
    day: localDay(new Date(date)),
    origin: f.origin!,
    destination: f.destination!,
    ...(f.notes ? { notes: f.notes } : {}),
    ...(f.initial ? { initial: sideOf(f.initial) } : {}),
    ...(f.final ? { final: sideOf(f.final) } : {}),
    revisions: existing?.revisions ?? [],
  };
}

/** Todos los datos que se pueden corregir de un flete, en un mapa plano (para comparar antes y después). */
export function flattenFreight(f: Pick<Freight, 'folio' | 'date' | 'origin' | 'destination' | 'notes' | 'initial' | 'final'>): Record<string, string | number | undefined> {
  const out: Record<string, string | number | undefined> = {
    folio: f.folio,
    date: f.date,
    origin: f.origin,
    destination: f.destination,
    notes: f.notes,
  };
  for (const [key, s] of [['initial', f.initial], ['final', f.final]] as const) {
    out[`${key}.mode`] = s?.mode;
    out[`${key}.grossMilli`] = s?.grossMilli;
    out[`${key}.tareMilli`] = s?.tareMilli;
    out[`${key}.netMilli`] = s?.netMilli;
    out[`${key}.ticket`] = s?.ticket;
    out[`${key}.scale`] = s?.scale;
  }
  return out;
}

/** Cambios entre dos fotos de un flete; `overwrites` = alguno pisa o quita un dato que ya estaba capturado. */
export function diffFreights(before: Freight, after: Freight): { changes: FreightRevision['changes']; overwrites: boolean } {
  const a = flattenFreight(before);
  const b = flattenFreight(after);
  const changes: FreightRevision['changes'] = [];
  let overwrites = false;
  for (const field of Object.keys(a)) {
    if (a[field] === b[field]) continue;
    changes.push({ field, ...(a[field] !== undefined ? { before: a[field] } : {}), ...(b[field] !== undefined ? { after: b[field] } : {}) });
    if (a[field] !== undefined) overwrites = true;
  }
  return { changes, overwrites };
}

function prepare(input: FreightFields, at: Date): FreightFields {
  const fields = normalizeFreightFields(input);
  const errors = validateFreightFields(fields, { now: at });
  if (errors.length) throw new FreightValidationError(errors);
  return fields;
}

/** Registra un flete nuevo. Idempotente por `id`; el folio no se puede repetir. */
export async function createFreight(db: DB, input: FreightFields, opts: { at?: Date } = {}): Promise<Freight> {
  const at = opts.at ?? new Date();
  const fields = prepare(input, at);
  const id = input.id ?? newId();
  const key = folioKeyOf(fields.folio!);
  return runRw(db, ['freights'], async (tx) => {
    const store = tx.objectStore('freights');
    const same: Freight | undefined = await store.get(id);
    if (same) throw new DuplicateFreightError(same);
    const taken: Freight | undefined = await store.index('byFolioKey').get(key);
    if (taken) throw new FreightFolioTakenError(taken);
    const rec = build(fields, id, undefined, toIso(at));
    await store.add(rec); // add (no put): si otra ventana se adelantó con el mismo folio, el índice único aborta
    return rec;
  });
}

/**
 * Corrige o completa un flete. Si cambia un dato que YA estaba capturado se necesita `reason` y queda en la bitácora; si solo
 * se agregan datos que faltaban (la pesada de destino, la boleta...) no hace falta motivo. Sin cambios no escribe nada.
 */
export async function updateFreight(db: DB, id: string, input: FreightFields, opts: { reason?: string; at?: Date } = {}): Promise<Freight> {
  const at = opts.at ?? new Date();
  const fields = prepare({ ...input, id }, at);
  return runRw(db, ['freights'], async (tx) => {
    const store = tx.objectStore('freights');
    const existing: Freight | undefined = await store.get(id);
    if (!existing) throw abortWith(tx, 'El flete ya no existe');
    if (existing.status === 'anulado') throw abortWith(tx, 'Un flete anulado no se puede corregir');
    const next = build(fields, id, existing, toIso(at));
    const { changes, overwrites } = diffFreights(existing, next);
    if (changes.length === 0) return existing;
    let reason = 'Se completó el registro';
    if (overwrites) {
      reason = checkedReason(opts.reason);
    } else if (opts.reason?.trim()) {
      reason = checkedReason(opts.reason);
    }
    if (next.folioKey !== existing.folioKey) {
      const taken: Freight | undefined = await store.index('byFolioKey').get(next.folioKey);
      if (taken && taken.id !== id) throw new FreightFolioTakenError(taken);
    }
    const revision: FreightRevision = { id: newId(), at: toIso(at), reason, changes };
    const saved: Freight = { ...next, revisions: [...existing.revisions, revision] };
    await store.put(saved);
    return saved;
  });
}

/** Anula un flete (queda guardado, con su motivo, y conserva el folio). */
export async function voidFreight(db: DB, id: string, reason: string, opts: { at?: Date } = {}): Promise<Freight> {
  const at = opts.at ?? new Date();
  const why = checkedReason(reason);
  return runRw(db, ['freights'], async (tx) => {
    const store = tx.objectStore('freights');
    const existing: Freight | undefined = await store.get(id);
    if (!existing) throw abortWith(tx, 'El flete ya no existe');
    if (existing.status === 'anulado') throw abortWith(tx, 'Este flete ya está anulado');
    const atIso = toIso(at);
    const revision: FreightRevision = { id: newId(), at: atIso, reason: why, changes: [{ field: 'status', before: 'activo', after: 'anulado' }] };
    const saved: Freight = { ...existing, status: 'anulado', voidedAt: atIso, voidReason: why, updatedAt: atIso, revisions: [...existing.revisions, revision] };
    await store.put(saved);
    return saved;
  });
}

/** Todos los fletes, del más reciente al más viejo (por fecha del flete y luego por captura). */
export async function listFreights(db: DB): Promise<Freight[]> {
  const all = await db.getAll('freights');
  return all.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export async function getFreight(db: DB, id: string): Promise<Freight | undefined> {
  return db.get('freights', id);
}

/** Folios (normalizados) ya usados, para sugerir uno libre. */
export async function freightFolioKeys(db: DB): Promise<Set<string>> {
  return new Set((await db.getAll('freights')).map((f) => f.folioKey));
}

// ── Configuración del rango de referencia ───────────────────────────────────────────────────────────────────────────

function isSettings(v: unknown): v is FreightSettings {
  return typeof v === 'object' && v !== null && validateFreightSettings(v as FreightSettings).length === 0;
}

/** Configuración vigente; si nunca se cambió, la de fábrica (200–300 kg, pendiente de validación). */
export async function getFreightSettings(db: DB): Promise<FreightSettings> {
  const rec = await db.get('meta', 'freightSettings');
  return isSettings(rec?.value) ? { ...(rec!.value as FreightSettings) } : { ...DEFAULT_FREIGHT_SETTINGS };
}

export async function saveFreightSettings(db: DB, s: FreightSettings): Promise<FreightSettings> {
  const clean: FreightSettings = {
    validated: s.validated,
    ...(s.refMinMilli !== undefined ? { refMinMilli: s.refMinMilli } : {}),
    ...(s.refMaxMilli !== undefined ? { refMaxMilli: s.refMaxMilli } : {}),
  };
  const errors = validateFreightSettings(clean);
  if (errors.length) throw new FreightValidationError(errors);
  await runRw(db, ['meta'], async (tx) => {
    await tx.objectStore('meta').put({ key: 'freightSettings', value: clean });
  });
  return clean;
}

