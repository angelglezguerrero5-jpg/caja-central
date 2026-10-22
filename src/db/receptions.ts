import { classificationOf, productLabel } from '../domain/classification';
import {
  FUTURE_TOLERANCE_MS,
  MAX_CONTAINERS,
  MAX_NET_MILLI,
  MAX_TEXT,
  MIN_YEAR,
  currentNetMilli,
  normalizeFields,
  possibleDuplicates,
  validateFields,
  computeNet,
  type ReceptionFields,
} from '../domain/reception';
import { MAX_REASON, checkedText } from '../domain/limits';
import { localDay } from '../domain/report';
import type { Product, Reception, ReceptionAck, ReceptionEdit, ReceptionStatus, StockMove } from '../domain/types';
import { NegativeStockError, abortWith, moveStock, negativeAuthorized, newId, now, runRw, type DB } from './repo';

/**
 * Recepción de mercancía. TODA operación es una sola transacción (documento + inventario + folio):
 * o ocurre completa o no ocurre. Los kilos entran al inventario EXACTAMENTE una vez, mediante un único
 * movimiento 'recepcion' enlazado (receptionId ↔ stockMoveId) con id DETERMINISTA (rcp:<id>:in): aunque fallara
 * el chequeo de estado, un segundo intento chocaría con ese id y la transacción se revertiría.
 * Nada se borra: las correcciones y anulaciones son movimientos nuevos con motivo.
 *
 * Estados:  borrador → { borrador, confirmada, cancelada }   confirmada → { confirmada (corregir kilos / datos), anulada }
 *           cancelada y anulada son TERMINALES. Tras confirmar son inmutables el producto, el modo de peso y los datos
 *           de captura; solo cambian los kilos (movimiento de corrección) y, con motivo, fecha/proveedor/referencia/
 *           observaciones/envases (edición de datos, sin tocar inventario).
 */

/** Ese id ya estaba confirmado: NO se vuelve a sumar (doble toque / reintento). La interfaz lo trata como éxito. */
export class DuplicateReceptionError extends Error {
  constructor(public reception: Reception) {
    super(`La recepción ya estaba registrada (R-${reception.folio})`);
  }
}

/**
 * El mismo intento (id) ya se registró, pero con OTRO contenido (otro producto, presentación, modo o kilos): no es un
 * reintento idempotente. La interfaz muestra lo que quedó guardado y ofrece registrar lo escrito como una recepción nueva.
 */
export class ReceptionIdConflictError extends Error {
  constructor(public reception: Reception) {
    super(`Ese intento ya se registró como R-${reception.folio} con otros datos`);
  }
}

/** Avisos que hay que reconocer antes de corregir o anular (p. ej. ya hubo un conteo físico después de la recepción). */
export class ReceptionWarningError extends Error {
  constructor(public warnings: string[]) {
    super('Revisa antes de continuar: ' + warnings.join(' '));
  }
}

/** Avisos que el usuario debe reconocer antes de confirmar (parece repetida, conteo posterior, entrada manual igual). */
export class PossibleDuplicateReceptionError extends Error {
  constructor(public matches: Reception[], public warnings: string[]) {
    super('Revisa antes de registrar: ' + warnings.join(' '));
  }
}

export class ReceptionValidationError extends Error {
  constructor(public errors: string[]) {
    super(errors.join(' · ') || 'Recepción inválida');
  }
}

export interface ConfirmOptions {
  /** Reconocer los avisos (posible duplicado, conteo posterior, entrada manual igual) y registrar de todos modos. */
  acknowledgeDuplicate?: boolean;
  /** Instante de la operación (pruebas). */
  at?: Date;
}

const toIso = (d: Date) => d.toISOString();
const fmt = (iso: string) => new Date(iso).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const DAY_MS = 24 * 3600 * 1000;

function negative(product: Product, availableAfter: number): NegativeStockError {
  return new NegativeStockError(availableAfter, productLabel(product), product.reservedMilli);
}

/** Arma el registro a partir de los campos ya normalizados. */
function build(fields: ReceptionFields, id: string, existing: Reception | undefined, atIso: string): Reception {
  const receivedAt = fields.receivedAt ? toIso(new Date(fields.receivedAt)) : (existing?.receivedAt ?? atIso);
  const net = computeNet(fields);
  return {
    id,
    status: 'borrador',
    createdAt: existing?.createdAt ?? atIso,
    updatedAt: atIso,
    receivedAt,
    day: localDay(new Date(receivedAt)),
    packaging: fields.packaging,
    weightMode: fields.weightMode,
    corrections: [],
    ...(fields.supplier ? { supplier: fields.supplier } : {}),
    ...(fields.reference ? { reference: fields.reference } : {}),
    ...(fields.notes ? { notes: fields.notes } : {}),
    ...(fields.productId ? { productId: fields.productId } : {}),
    ...(fields.containers !== undefined ? { containers: fields.containers } : {}),
    ...(fields.netDirectMilli !== undefined ? { netDirectMilli: fields.netDirectMilli } : {}),
    ...(fields.weighingsMilli ? { weighingsMilli: fields.weighingsMilli } : {}),
    ...(fields.unitNetMilli !== undefined ? { unitNetMilli: fields.unitNetMilli } : {}),
    ...(fields.grossMilli !== undefined ? { grossMilli: fields.grossMilli } : {}),
    ...(fields.tareMilli !== undefined ? { tareMilli: fields.tareMilli } : {}),
    ...(net.ok ? { netMilli: net.netMilli } : {}),
  };
}

/** Guarda (o actualiza) un BORRADOR. No toca el inventario. Idempotente por id. */
export async function saveReceptionDraft(db: DB, input: ReceptionFields, opts: { at?: Date } = {}): Promise<Reception> {
  const at = opts.at ?? new Date();
  const fields = normalizeFields(input);
  const errors = validateFields(fields, { forConfirm: false, now: at });
  if (errors.length) throw new ReceptionValidationError(errors);
  const id = input.id ?? newId();
  return runRw(db, ['receptions'], async (tx) => {
    const existing: Reception | undefined = await tx.objectStore('receptions').get(id);
    if (existing && existing.status !== 'borrador') {
      throw abortWith(tx, `Esta recepción ya está ${existing.status}: no se puede editar como borrador`);
    }
    const rec = build(fields, id, existing, toIso(at));
    await tx.objectStore('receptions').put(rec);
    return rec;
  });
}

/** Campos editables de una recepción guardada (para reabrir un borrador en el formulario). Siempre lleva el `id`. */
export function receptionToFields(r: Reception): ReceptionFields & { id: string } {
  const fields = normalizeFields({
    receivedAt: r.receivedAt,
    supplier: r.supplier,
    reference: r.reference,
    notes: r.notes,
    productId: r.productId,
    packaging: r.packaging,
    containers: r.containers,
    weightMode: r.weightMode,
    netDirectMilli: r.netDirectMilli,
    weighingsMilli: r.weighingsMilli,
    unitNetMilli: r.unitNetMilli,
    grossMilli: r.grossMilli,
    tareMilli: r.tareMilli,
  });
  return { ...fields, id: r.id };
}

/**
 * Avisos que pide confirmar una recepción: se parece a otra ya registrada, ya hubo un conteo físico después de la llegada
 * o hay una entrada manual de los mismos kilos. Solo LEE (sirve tanto al confirmar como a la vista previa).
 */
async function collectConfirmWarnings(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  product: Product,
  base: Reception,
  netMilli: number,
  id: string,
  at: Date,
): Promise<{ dups: Reception[]; warnings: string[] }> {
  const warnings: string[] = [];
  const receivedAtMs = Date.parse(base.receivedAt);
  const all: Reception[] = await tx.objectStore('receptions').getAll();
  const dups = possibleDuplicates(
    {
      id,
      productId: product.id,
      reference: base.reference,
      supplier: base.supplier,
      netMilli,
      day: base.day,
      receivedAtMs,
      atMs: at.getTime(),
    },
    all,
  );
  if (dups.length) {
    warnings.push(
      'Ya hay una recepción parecida: ' +
        dups.map((d) => `R-${d.folio} (${fmt(d.receivedAt)}, ${(currentNetMilli(d) / 1000).toLocaleString('es-MX')} kg)`).join(', ') +
        '. ¿Es otra distinta?',
    );
  }
  const moves: StockMove[] = await tx.objectStore('stockMoves').index('byProduct').getAll(product.id);
  const laterCount = moves.filter((m) => m.type === 'ajuste' && Date.parse(m.createdAt) > receivedAtMs);
  if (laterCount.length) {
    warnings.push(
      `Ya hubo un conteo físico de esta clasificación el ${fmt(laterCount[laterCount.length - 1].createdAt)}, después de la llegada: estos kilos podrían estar ya contados.`,
    );
  }
  const sameManual = moves.filter(
    (m) => m.type === 'entrada' && m.deltaMilli === netMilli && at.getTime() - Date.parse(m.createdAt) <= DAY_MS,
  );
  if (sameManual.length) {
    warnings.push('Hay una entrada manual de los mismos kilos de las últimas 24 horas: podría ser la misma mercancía.');
  }
  return { dups, warnings };
}

/** Núcleo de la confirmación; corre DENTRO de una transacción con receptions, products, stockMoves y meta. */
async function confirmInTx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  fields: ReceptionFields,
  id: string,
  opts: ConfirmOptions,
  at: Date,
): Promise<Reception> {
  const atIso = toIso(at);
  const store = tx.objectStore('receptions');
  const existing: Reception | undefined = await store.get(id);
  if (existing?.status === 'confirmada') {
    abortWith(tx, 'duplicada');
    // Mismo id y mismo contenido = reintento idempotente (éxito). Mismo id con otro contenido = conflicto (nunca éxito).
    const again = computeNet(fields);
    const same =
      again.ok && fields.productId === existing.productId && fields.packaging === existing.packaging &&
      fields.weightMode === existing.weightMode && again.netMilli === existing.confirmedNetMilli;
    throw same ? new DuplicateReceptionError(existing) : new ReceptionIdConflictError(existing);
  }
  if (existing && existing.status !== 'borrador') {
    throw abortWith(tx, `Esta recepción ya está ${existing.status === 'cancelada' ? 'cancelada' : existing.status}: captura una nueva`);
  }

  const product: Product | undefined = fields.productId ? await tx.objectStore('products').get(fields.productId) : undefined;
  const errors = validateFields(fields, { forConfirm: true, now: at, product: product ?? null });
  if (errors.length) throw new ReceptionValidationError(errors);
  const net = computeNet(fields);
  if (!net.ok) throw new ReceptionValidationError([net.error]); // no debería pasar tras validar

  const base = build(fields, id, existing, atIso);

  // ----- Avisos (se reconocen explícitamente; nunca bloquean para siempre)
  const { dups, warnings } = await collectConfirmWarnings(tx, product!, base, net.netMilli, id, at);
  if (warnings.length > 0 && !opts.acknowledgeDuplicate) throw new PossibleDuplicateReceptionError(dups, warnings);
  const acknowledged: ReceptionAck[] = warnings.length > 0 ? [{ at: atIso, op: 'confirmar', warnings }] : [];

  // ----- Folio + movimiento + documento
  const meta = tx.objectStore('meta');
  const folio: number = (await meta.get('nextReceptionFolio'))?.value ?? 1;
  const moveId = `rcp:${id}:in`;
  await moveStock(tx, product!.id, 'recepcion', net.netMilli, 0, `Recepción R-${folio}`, atIso, undefined, id, moveId);
  const rec: Reception = {
    ...base,
    status: 'confirmada',
    folio,
    productId: product!.id,
    productLabel: productLabel(product!),
    cls: classificationOf(product!),
    netMilli: net.netMilli,
    confirmedAt: atIso,
    confirmedNetMilli: net.netMilli,
    stockMoveId: moveId,
    ...(acknowledged.length ? { acknowledged } : {}),
  };
  await store.put(rec);
  await meta.put({ key: 'nextReceptionFolio', value: folio + 1 });
  return rec;
}


/**
 * Vista previa SOLO LECTURA de lo que pasaría al confirmar: errores de validación, avisos que habría que reconocer y, si ese
 * mismo intento ya estaba registrado, el registro guardado (y si lo escrito es lo mismo o algo distinto). No cambia nada.
 */
export async function previewReceptionWarnings(
  db: DB,
  input: ReceptionFields & { id: string },
  at = new Date(),
): Promise<{ errors: string[]; matches: Reception[]; warnings: string[]; already?: { reception: Reception; same: boolean } }> {
  const fields = normalizeFields(input);
  const tx = db.transaction(['receptions', 'products', 'stockMoves'], 'readonly');
  const existing: Reception | undefined = await tx.objectStore('receptions').get(input.id);
  const net = computeNet(fields);
  if (existing?.status === 'confirmada') {
    await tx.done;
    const same =
      net.ok && fields.productId === existing.productId && fields.packaging === existing.packaging &&
      fields.weightMode === existing.weightMode && net.netMilli === existing.confirmedNetMilli;
    return { errors: [], matches: [], warnings: [], already: { reception: existing, same } };
  }
  const product: Product | undefined = fields.productId ? await tx.objectStore('products').get(fields.productId) : undefined;
  const errors = validateFields(fields, { forConfirm: true, now: at, product: product ?? null });
  if (errors.length || !net.ok || !product) {
    await tx.done;
    return { errors: errors.length ? errors : net.ok ? [] : [net.error], matches: [], warnings: [] };
  }
  const base = build(fields, input.id, existing, toIso(at));
  const { dups, warnings } = await collectConfirmWarnings(tx, product, base, net.netMilli, input.id, at);
  await tx.done;
  return { errors: [], matches: dups, warnings };
}

const CONFIRM_STORES = ['receptions', 'products', 'stockMoves', 'meta'];

/**
 * Confirma una recepción (la crea si no existía, o completa su borrador) y suma los kilos al inventario
 * físico UNA sola vez, todo en una transacción. El `id` es OBLIGATORIO: reintentar con el mismo id no vuelve a sumar.
 */
export async function confirmReception(db: DB, input: ReceptionFields & { id: string }, opts: ConfirmOptions = {}): Promise<Reception> {
  if (!input.id || typeof input.id !== 'string') throw new Error('Falta el identificador de la recepción');
  const at = opts.at ?? new Date();
  const fields = normalizeFields(input);
  // Validación de forma antes de abrir la transacción (el producto se valida dentro, con datos frescos).
  const pre = validateFields(fields, { forConfirm: false, now: at }).filter((e) => !e.startsWith('El borrador está vacío'));
  if (pre.length) throw new ReceptionValidationError(pre);
  return runRw(db, CONFIRM_STORES, (tx) => confirmInTx(tx, fields, input.id, opts, at));
}

/** Confirma un borrador guardado. El borrador se lee DENTRO de la transacción (no se pierden ediciones concurrentes). */
export async function confirmReceptionDraft(db: DB, id: string, opts: ConfirmOptions = {}): Promise<Reception> {
  const at = opts.at ?? new Date();
  return runRw(db, CONFIRM_STORES, async (tx) => {
    const draft: Reception | undefined = await tx.objectStore('receptions').get(id);
    if (!draft) throw abortWith(tx, 'Borrador no encontrado');
    if (draft.status === 'confirmada') {
      abortWith(tx, 'duplicada');
      throw new DuplicateReceptionError(draft);
    }
    return confirmInTx(tx, receptionToFields(draft), id, opts, at);
  });
}

/** Descarta un BORRADOR (queda el registro como 'cancelada'; el inventario no se toca). */
export async function cancelReceptionDraft(db: DB, id: string, reason = ''): Promise<Reception> {
  const why = checkedText(reason, 'Motivo', MAX_REASON);
  const at = now();
  return runRw(db, ['receptions', 'products'], async (tx) => {
    const r: Reception | undefined = await tx.objectStore('receptions').get(id);
    if (!r) throw abortWith(tx, 'Recepción no encontrada');
    if (r.status !== 'borrador') throw abortWith(tx, 'Solo se pueden cancelar borradores; una recepción confirmada se anula');
    // El historial debe poder decir QUÉ limón era el borrador descartado: se guarda la etiqueta de ese momento.
    const prod: Product | undefined = r.productId ? await tx.objectStore('products').get(r.productId) : undefined;
    const cancelled: Reception = {
      ...r,
      status: 'cancelada',
      updatedAt: at,
      cancelledAt: at,
      ...(prod && !r.productLabel ? { productLabel: productLabel(prod) } : {}),
      ...(why ? { cancelReason: why } : {}),
    };
    await tx.objectStore('receptions').put(cancelled);
    return cancelled;
  });
}

/**
 * Avisos de una recepción ya confirmada: si DESPUÉS de registrarla hubo un conteo físico o una merma de esa clasificación,
 * esa cifra pudo haber incluido ya estos kilos; corregir o anular bajaría la existencia otra vez.
 */
function laterCountWarnings(moves: StockMove[], r: Reception): string[] {
  if (!r.confirmedAt) return [];
  const t = Date.parse(r.confirmedAt);
  const later = moves.filter((m) => (m.type === 'ajuste' || m.type === 'merma') && Date.parse(m.createdAt) > t);
  if (later.length === 0) return [];
  const last = later[later.length - 1];
  return [
    `Después de registrar esta recepción hubo un ${last.type === 'ajuste' ? 'conteo físico' : 'registro de merma'} de esta clasificación el ${fmt(last.createdAt)}: ` +
      'ese dato pudo haber incluido ya estos kilos. Si continúas, la existencia baja otra vez; después registra la diferencia como conteo físico.',
  ];
}

/**
 * Corrige los kilos netos de una recepción CONFIRMADA con un movimiento auditado (± diferencia). El movimiento
 * original no se toca. Si la corrección dejaría el disponible en negativo se exige autorización explícita
 * (NegativeStockError; `allowNegative` = true o el piso que se le mostró a la persona). Si ya hubo un conteo físico
 * después de la recepción se exige reconocer el aviso (ReceptionWarningError). No se corrige a 0: eso es anular.
 */
export async function correctReception(
  db: DB,
  id: string,
  newNetMilli: number,
  reason: string,
  allowNegative: boolean | number = false,
  acknowledge = false,
): Promise<Reception> {
  const why = checkedText(reason, 'Motivo', MAX_REASON);
  if (!why) throw new Error('Indica el motivo de la corrección');
  if (!Number.isSafeInteger(newNetMilli) || newNetMilli <= 0) throw new Error('Los kilos corregidos deben ser mayores a cero');
  if (newNetMilli > MAX_NET_MILLI) throw new Error('Los kilos corregidos exceden el máximo permitido');
  return runRw(db, ['receptions', 'products', 'stockMoves'], async (tx) => {
    const r: Reception | undefined = await tx.objectStore('receptions').get(id);
    if (!r) throw abortWith(tx, 'Recepción no encontrada');
    if (r.status !== 'confirmada') throw abortWith(tx, 'Solo se corrigen recepciones confirmadas');
    const current = currentNetMilli(r);
    if (newNetMilli === current) throw abortWith(tx, 'Los kilos ya son esos: no hay nada que corregir');
    const product: Product | undefined = await tx.objectStore('products').get(r.productId!);
    if (!product) throw abortWith(tx, 'El producto de esta recepción ya no existe');
    const delta = newNetMilli - current;
    const availableAfter = product.physicalMilli + delta - product.reservedMilli;
    let authorized: number | undefined;
    if (delta < 0 && availableAfter < 0) {
      if (!negativeAuthorized(allowNegative, availableAfter)) {
        abortWith(tx, '');
        throw negative(product, availableAfter);
      }
      authorized = availableAfter;
    }
    const moves: StockMove[] = await tx.objectStore('stockMoves').index('byProduct').getAll(product.id);
    const warnings = laterCountWarnings(moves, r);
    if (warnings.length > 0 && !acknowledge) {
      abortWith(tx, '');
      throw new ReceptionWarningError(warnings);
    }
    const at = now();
    const moveId = `rcp:${id}:c${r.corrections.length + 1}`;
    await moveStock(tx, product.id, 'correccion_recepcion', delta, 0, `Corrección R-${r.folio}: ${why}`, at, undefined, id, moveId, authorized);
    const updated: Reception = {
      ...r,
      netMilli: newNetMilli,
      updatedAt: at,
      corrections: [
        ...r.corrections,
        { id: newId(), at, reason: why, previousNetMilli: current, newNetMilli, deltaMilli: delta, stockMoveId: moveId },
      ],
      ...(warnings.length ? { acknowledged: [...(r.acknowledged ?? []), { at, op: 'corregir' as const, warnings }] } : {}),
    };
    await tx.objectStore('receptions').put(updated);
    return updated;
  });
}

/** Núcleo de la anulación; corre dentro de una transacción con receptions, products y stockMoves. */
async function voidInTx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  id: string,
  why: string,
  allowNegative: boolean | number,
  acknowledge: boolean,
): Promise<Reception> {
  const r: Reception | undefined = await tx.objectStore('receptions').get(id);
  if (!r) throw abortWith(tx, 'Recepción no encontrada');
  if (r.status !== 'confirmada') throw abortWith(tx, 'Solo se anulan recepciones confirmadas');
  const current = currentNetMilli(r);
  const product: Product | undefined = await tx.objectStore('products').get(r.productId!);
  if (!product) throw abortWith(tx, 'El producto de esta recepción ya no existe');
  const availableAfter = product.physicalMilli - current - product.reservedMilli;
  let authorized: number | undefined;
  if (availableAfter < 0) {
    if (!negativeAuthorized(allowNegative, availableAfter)) {
      abortWith(tx, '');
      throw negative(product, availableAfter);
    }
    authorized = availableAfter;
  }
  const moves: StockMove[] = await tx.objectStore('stockMoves').index('byProduct').getAll(product.id);
  const warnings = laterCountWarnings(moves, r);
  if (warnings.length > 0 && !acknowledge) {
    abortWith(tx, '');
    throw new ReceptionWarningError(warnings);
  }
  const at = now();
  const moveId = `rcp:${id}:void`;
  await moveStock(tx, product.id, 'reversa_recepcion', -current, 0, `Anula R-${r.folio}: ${why}`, at, undefined, id, moveId, authorized);
  const voided: Reception = {
    ...r,
    status: 'anulada',
    netMilli: 0,
    updatedAt: at,
    voidedAt: at,
    voidReason: why,
    voidStockMoveId: moveId,
    ...(warnings.length ? { acknowledged: [...(r.acknowledged ?? []), { at, op: 'anular' as const, warnings }] } : {}),
  };
  await tx.objectStore('receptions').put(voided);
  return voided;
}

/** Anula una recepción CONFIRMADA: reversa auditada de sus kilos vigentes. */
export async function voidReception(
  db: DB,
  id: string,
  reason: string,
  allowNegative: boolean | number = false,
  acknowledge = false,
): Promise<Reception> {
  const why = checkedText(reason, 'Motivo', MAX_REASON);
  if (!why) throw new Error('Indica el motivo de la anulación');
  return runRw(db, ['receptions', 'products', 'stockMoves'], (tx) => voidInTx(tx, id, why, allowNegative, acknowledge));
}

/**
 * Producto equivocado: en UNA transacción anula la recepción y deja un BORRADOR nuevo con los mismos datos
 * (fecha de llegada, proveedor, referencia, presentación, pesos) pero sin producto, listo para elegir el correcto.
 * Las ventas ya hechas con la clasificación equivocada conservan su foto; se regularizan con un ajuste auditado.
 */
export async function voidAndCopyToDraft(
  db: DB,
  id: string,
  reason: string,
  allowNegative: boolean | number = false,
  acknowledge = false,
): Promise<{ voided: Reception; draft: Reception }> {
  const why = checkedText(reason, 'Motivo', MAX_REASON);
  if (!why) throw new Error('Indica el motivo de la anulación');
  return runRw(db, ['receptions', 'products', 'stockMoves'], async (tx) => {
    const voided = await voidInTx(tx, id, why, allowNegative, acknowledge);
    const fields = receptionToFields(voided);
    delete fields.productId;
    const at = now();
    const draft = build({ ...fields, id: undefined }, newId(), undefined, at);
    draft.notes = [voided.notes, `Copia de R-${voided.folio} (anulada: ${why})`].filter(Boolean).join(' · ').slice(0, MAX_TEXT.notes);
    await tx.objectStore('receptions').put(draft);
    return { voided, draft };
  });
}

// ---------- Corrección de DATOS (sin tocar kilos ni inventario) ----------

export interface ReceptionPatch {
  receivedAt?: string;
  supplier?: string;
  reference?: string;
  notes?: string;
  /** null = quitar el dato. */
  containers?: number | null;
}

// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const clean = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();

/**
 * Corrige fecha de llegada, proveedor, referencia, observaciones o cantidad de envases de una recepción CONFIRMADA.
 * NO crea movimientos ni cambia los kilos: deja el antes y el después con su motivo en `dataEdits`.
 * Cambiar la fecha mueve la recepción de día en los reportes (el movimiento conserva su hora real de captura).
 */
export async function annotateReception(db: DB, id: string, patch: ReceptionPatch, reason: string, opts: { at?: Date } = {}): Promise<Reception> {
  const why = checkedText(reason, 'Motivo', MAX_REASON);
  if (!why) throw new Error('Indica el motivo de la corrección');
  const at = opts.at ?? new Date();
  return runRw(db, ['receptions'], async (tx) => {
    const r: Reception | undefined = await tx.objectStore('receptions').get(id);
    if (!r) throw abortWith(tx, 'Recepción no encontrada');
    if (r.status !== 'confirmada') throw abortWith(tx, 'Solo se corrigen datos de recepciones confirmadas');
    const next: Reception = { ...r };
    const changes: ReceptionEdit['changes'] = [];
    const errors: string[] = [];

    for (const [key, label] of [['supplier', 'Proveedor'], ['reference', 'Referencia'], ['notes', 'Observaciones']] as const) {
      if (patch[key] === undefined) continue;
      const raw = patch[key]!;
      if (FORBIDDEN.test(raw)) {
        errors.push(`${label}: contiene caracteres no permitidos`);
        continue;
      }
      const v = clean(raw);
      if (v.length > MAX_TEXT[key]) {
        errors.push(`${label}: máximo ${MAX_TEXT[key]} caracteres`);
        continue;
      }
      if ((r[key] ?? '') === v) continue;
      changes.push({ field: key, ...(r[key] !== undefined ? { before: r[key] } : {}), ...(v ? { after: v } : {}) });
      if (v) next[key] = v;
      else delete next[key];
    }
    if (patch.receivedAt !== undefined) {
      const t = Date.parse(patch.receivedAt);
      if (Number.isNaN(t)) errors.push('La fecha y hora de llegada no es válida');
      else if (new Date(t).getUTCFullYear() < MIN_YEAR) errors.push('La fecha de llegada es demasiado antigua');
      else if (t > at.getTime() + FUTURE_TOLERANCE_MS) errors.push('La fecha de llegada no puede ser futura');
      else if (new Date(t).toISOString() !== r.receivedAt) {
        next.receivedAt = new Date(t).toISOString();
        next.day = localDay(new Date(t));
        changes.push({ field: 'receivedAt', before: r.receivedAt, after: next.receivedAt });
      }
    }
    if (patch.containers !== undefined) {
      if (patch.containers === null) {
        if (r.weightMode === 'por_envase') errors.push('En este modo de peso la cantidad de envases es parte del cálculo: no se puede quitar');
        else if (r.containers !== undefined) {
          changes.push({ field: 'containers', before: r.containers });
          delete next.containers;
        }
      } else if (r.packaging === 'granel') {
        errors.push('A granel no se cuentan cajas ni arpillas');
      } else if (!Number.isSafeInteger(patch.containers) || patch.containers < 1 || patch.containers > MAX_CONTAINERS) {
        errors.push(`La cantidad de envases debe ser un entero entre 1 y ${MAX_CONTAINERS}`);
      } else if (r.weightMode === 'por_envase') {
        errors.push('En este modo de peso los envases definen los kilos: corrige los kilos con «Corregir kilos»');
      } else if (patch.containers !== r.containers) {
        changes.push({ field: 'containers', ...(r.containers !== undefined ? { before: r.containers } : {}), after: patch.containers });
        next.containers = patch.containers;
      }
    }
    if (errors.length) throw new ReceptionValidationError(errors);
    if (changes.length === 0) throw abortWith(tx, 'No hay cambios que guardar');
    next.updatedAt = toIso(at);
    next.dataEdits = [...(r.dataEdits ?? []), { id: newId(), at: toIso(at), reason: why, changes }];
    await tx.objectStore('receptions').put(next);
    return next;
  });
}

// ---------- Consultas ----------

export interface ReceptionFilter {
  status?: ReceptionStatus | ReceptionStatus[];
  /** Día exacto (YYYY-MM-DD). */
  day?: string;
  /** Rango inclusivo de días. */
  from?: string;
  to?: string;
  productId?: string;
}

export async function listReceptions(db: DB, f: ReceptionFilter = {}): Promise<Reception[]> {
  const statuses = f.status === undefined ? undefined : Array.isArray(f.status) ? f.status : [f.status];
  const all = await db.getAll('receptions');
  return all
    .filter(
      (r) =>
        (!statuses || statuses.includes(r.status)) &&
        (!f.day || r.day === f.day) &&
        (!f.from || r.day >= f.from) &&
        (!f.to || r.day <= f.to) &&
        (!f.productId || r.productId === f.productId),
    )
    .sort(
      (a, b) =>
        b.receivedAt.localeCompare(a.receivedAt) ||
        b.createdAt.localeCompare(a.createdAt) ||
        (b.folio ?? 0) - (a.folio ?? 0) ||
        a.id.localeCompare(b.id),
    );
}

export async function getReception(db: DB, id: string): Promise<Reception | undefined> {
  return db.get('receptions', id);
}

const MOVE_ORDER: Record<string, number> = { recepcion: 0, correccion_recepcion: 1, reversa_recepcion: 2 };

/**
 * Movimientos de inventario enlazados a una recepción (original, correcciones y reversa), en orden cronológico.
 * Si dos comparten el mismo milisegundo se desempata por el orden lógico de la operación.
 */
export async function listMovesForReception(db: DB, receptionId: string): Promise<StockMove[]> {
  const moves = await db.getAllFromIndex('stockMoves', 'byReception', receptionId);
  return moves.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (MOVE_ORDER[a.type] ?? 9) - (MOVE_ORDER[b.type] ?? 9));
}

/**
 * Último peso neto por envase que el usuario capturó de verdad para ESTA presentación y ESTE producto
 * (con el folio de donde salió). Sin historial no se sugiere nada: nunca se inventa ni se precarga un valor "típico".
 */
export async function lastUnitNet(
  db: DB,
  packaging: 'caja' | 'arpilla',
  productId: string,
): Promise<{ unitNetMilli: number; folio?: number } | undefined> {
  const confirmed = await listReceptions(db, { status: 'confirmada', productId });
  const hit = confirmed.find((r) => r.packaging === packaging && r.weightMode === 'por_envase' && r.unitNetMilli);
  return hit ? { unitNetMilli: hit.unitNetMilli!, folio: hit.folio } : undefined;
}
