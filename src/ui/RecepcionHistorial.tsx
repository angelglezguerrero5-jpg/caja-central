import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  ReceptionValidationError,
  ReceptionWarningError,
  annotateReception,
  correctReception,
  listMovesForReception,
  listReceptions,
  voidAndCopyToDraft,
  voidReception,
  type ReceptionPatch,
} from '../db/receptions';
import { NegativeStockError, listProducts } from '../db/repo';
import { normalizeKey, productLabel } from '../domain/classification';
import { ambiguousNumberHint, formatQty, parseQty } from '../domain/money';
import { CONTAINER_NOUN, PACKAGING_LABEL, WEIGHT_MODE_LABEL, currentNetMilli } from '../domain/reception';
import type { Product, Reception, ReceptionStatus, StockMove } from '../domain/types';
import { errMsg, useApp } from './ctx';
import { fmtDateTime, localInputToIso, milliToText, toLocalInput } from './format';
import { AuthorizeSheet, WarningsSheet } from './Sheet';

type Filter = 'confirmada' | 'anulada' | 'cancelada' | 'todas';
const FILTERS: Array<[Filter, string]> = [
  ['confirmada', 'Registradas'],
  ['anulada', 'Anuladas'],
  ['cancelada', 'Descartadas'],
  ['todas', 'Todas'],
];
/** Lenguaje de operador: "Registrada" = confirmada (ya sumó), "Descartada" = borrador que se tiró. */
export const STATUS_LABEL: Record<ReceptionStatus, string> = {
  borrador: 'Borrador (sin sumar)',
  confirmada: 'Registrada',
  cancelada: 'Descartada',
  anulada: 'Anulada',
};
const MOVE_LABEL: Record<string, string> = {
  recepcion: 'Recepción (entrada)',
  correccion_recepcion: 'Corrección de kilos',
  reversa_recepcion: 'Anulación (resta los kilos)',
};
const EDIT_FIELD_LABEL: Record<string, string> = {
  receivedAt: 'Fecha de llegada',
  supplier: 'Proveedor',
  reference: 'Referencia',
  notes: 'Observaciones',
  containers: 'Envases',
};

/** Una sola acción abierta a la vez por recepción. */
type Panel = { id: string; kind: 'corregir' | 'datos' | 'anular' | 'detalle' } | null;

/** Algo pidió una autorización o un aviso: `retry` repite la operación con lo ya reconocido. */
interface Auth {
  error: NegativeStockError;
  retry: () => Promise<void>;
}
interface Warned {
  warnings: string[];
  retry: () => Promise<void>;
}
const PAGE = 50;

const clean = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();

function fmtChange(field: string, v: string | number | undefined): string {
  if (v === undefined || v === '') return '—';
  return field === 'receivedAt' ? fmtDateTime(String(v)) : String(v);
}

export function RecepcionHistorial({ onOpenDraft }: { onOpenDraft: (draft: Reception) => void }) {
  const { db, version, bump, toast } = useApp();
  const [filter, setFilter] = useState<Filter>('confirmada');
  const [day, setDay] = useState('');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<Reception[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [panel, setPanel] = useState<Panel>(null);
  const [qtyText, setQtyText] = useState('');
  const [reason, setReason] = useState('');
  const [moves, setMoves] = useState<StockMove[]>([]);
  const [auth, setAuth] = useState<Auth | null>(null);
  const [warned, setWarned] = useState<Warned | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  // campos de "Corregir datos"
  const [eWhen, setEWhen] = useState('');
  const [eSupplier, setESupplier] = useState('');
  const [eReference, setEReference] = useState('');
  const [eNotes, setENotes] = useState('');
  const [eContainers, setEContainers] = useState('');
  const busy = useRef(false);

  useEffect(() => {
    listReceptions(db, {
      status: filter === 'todas' ? ['confirmada', 'anulada', 'cancelada'] : filter,
      ...(day ? { day } : {}),
    }).then(setItems);
  }, [db, version, filter, day]);

  useEffect(() => {
    listProducts(db).then(setProducts);
  }, [db, version]);
  /** Qué producto era: la etiqueta guardada al registrar o descartar; si falta (registros anteriores), la del catálogo de hoy. */
  const labelOf = (r: Reception): string => {
    if (r.productLabel) return r.productLabel;
    const p = r.productId ? products.find((x) => x.id === r.productId) : undefined;
    return p ? productLabel(p) : 'Sin producto elegido';
  };

  const q = normalizeKey(search);
  const matching = useMemo(
    () =>
      items
        .filter(
          (r) =>
            !q ||
            normalizeKey(
              [r.folio !== undefined ? `r-${r.folio}` : '', labelOf(r), r.supplier, r.reference, r.notes, PACKAGING_LABEL[r.packaging]]
                .filter(Boolean)
                .join(' '),
            ).includes(q),
        ),
    [items, q, products],
  );
  const shown = matching.slice(0, limit);
  const totalMilli = matching.filter((r) => r.status === 'confirmada').reduce((s, r) => s + currentNetMilli(r), 0);
  const confirmedShown = matching.filter((r) => r.status === 'confirmada').length;

  function openPanel(r: Reception, kind: NonNullable<Panel>['kind']) {
    if (panel?.id === r.id && panel.kind === kind) return setPanel(null);
    setReason('');
    setQtyText(kind === 'corregir' ? milliToText(currentNetMilli(r)) : '');
    if (kind === 'datos') {
      setEWhen(toLocalInput(new Date(r.receivedAt)));
      setESupplier(r.supplier ?? '');
      setEReference(r.reference ?? '');
      setENotes(r.notes ?? '');
      setEContainers(r.containers === undefined ? '' : String(r.containers));
    }
    setPanel({ id: r.id, kind });
    if (kind === 'detalle') listMovesForReception(db, r.id).then(setMoves);
  }

  function finish(ok: string) {
    toast(ok);
    setPanel(null);
    bump();
  }

  /**
   * Ejecuta una operación que puede pedir DOS cosas, encadenadas y en cualquier orden: autorización de existencia negativa
   * (con el disponible que se le mostró como piso) y reconocer un aviso (p. ej. ya hubo un conteo después). Cada reintento
   * conserva lo que ya se reconoció.
   */
  async function run(op: (allow: boolean | number, ack: boolean) => Promise<unknown>, ok: string, allow: boolean | number = false, ack = false) {
    if (busy.current) return;
    busy.current = true;
    try {
      await op(allow, ack);
      setAuth(null);
      setWarned(null);
      finish(ok);
    } catch (e) {
      setAuth(null);
      setWarned(null);
      if (e instanceof NegativeStockError) {
        setAuth({ error: e, retry: () => run(op, ok, e.availableAfterMilli, ack) });
      } else if (e instanceof ReceptionWarningError) {
        setWarned({ warnings: e.warnings, retry: () => run(op, ok, allow, true) });
      } else toast(e instanceof ReceptionValidationError ? e.message : errMsg(e), 'error');
    } finally {
      busy.current = false;
    }
  }

  async function resolvePending(p: Auth | Warned | null) {
    if (!p) return;
    setAuth(null);
    setWarned(null);
    setAuthBusy(true);
    try {
      await p.retry();
    } finally {
      setAuthBusy(false);
    }
  }

  async function saveData(r: Reception) {
    if (busy.current) return;
    const patch: ReceptionPatch = {};
    if (toLocalInput(new Date(r.receivedAt)) !== eWhen) {
      const iso = localInputToIso(eWhen);
      if (!iso) return toast('Escribe la fecha y hora de llegada', 'error');
      patch.receivedAt = iso;
    }
    if (clean(eSupplier) !== (r.supplier ?? '')) patch.supplier = eSupplier;
    if (clean(eReference) !== (r.reference ?? '')) patch.reference = eReference;
    if (clean(eNotes) !== (r.notes ?? '')) patch.notes = eNotes;
    const cur = r.containers === undefined ? '' : String(r.containers);
    if (eContainers.trim() !== cur) {
      if (eContainers.trim() === '') patch.containers = null;
      else if (/^\d{1,9}$/.test(eContainers.trim())) patch.containers = Number(eContainers.trim());
      else return toast('La cantidad de envases debe ser un número entero', 'error');
    }
    if (Object.keys(patch).length === 0) return toast('No cambiaste ningún dato', 'error');
    busy.current = true;
    try {
      await annotateReception(db, r.id, patch, reason);
      finish(`Datos de R-${r.folio} corregidos (los kilos no cambian)`);
    } catch (e) {
      toast(e instanceof ReceptionValidationError ? e.message : errMsg(e), 'error');
    } finally {
      busy.current = false;
    }
  }

  return (
    <div data-testid="rec-historial">
      <div class="tabs-state" role="tablist" aria-label="Estado">
        {FILTERS.map(([f, label]) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            class={filter === f ? 'active' : ''}
            data-testid={`rec-filter-${f}`}
            onClick={() => setFilter(f)}
          >
            {label}
          </button>
        ))}
      </div>
      <label class="field">
        <span>Buscar (quién lo manda, camión, producto o folio)</span>
        <input
          type="search"
          data-testid="rec-search"
          autoComplete="off"
          placeholder="Ej. Rancho, CAM-1, R-12, Oaxaca"
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
        />
      </label>
      <label class="field">
        <span>Día de llegada (opcional)</span>
        <input type="date" data-testid="rec-hist-day" value={day} onInput={(e) => setDay((e.target as HTMLInputElement).value)} />
      </label>
      {shown.length > 0 && filter !== 'anulada' && filter !== 'cancelada' && (
        <p class="hint" data-testid="rec-hist-total">
          {confirmedShown} {confirmedShown === 1 ? 'recepción registrada' : 'recepciones registradas'} · <strong>{formatQty(totalMilli, 'kg')}</strong> en total
        </p>
      )}
      {matching.length === 0 && <p class="empty">No hay recepciones con ese filtro.</p>}
      {matching.length > 0 && (
        <p class="hint" data-testid="rec-hist-count">
          Mostrando {shown.length} de {matching.length}
        </p>
      )}
      {shown.map((r) => {
        const noun = CONTAINER_NOUN[r.packaging];
        const net = currentNetMilli(r);
        const open = panel?.id === r.id ? panel.kind : null;
        return (
          <article class={r.status === 'confirmada' ? 'card' : 'card inactive'} key={r.id} data-testid="rec-row">
            <header>
              <strong>
                {r.folio !== undefined ? `R-${r.folio}` : 'Sin folio'} · {labelOf(r)}
              </strong>
              <span class={r.status === 'anulada' || r.status === 'cancelada' ? 'badge cancel' : 'badge'}>{STATUS_LABEL[r.status]}</span>
            </header>
            <p class="big" data-testid="rec-row-net">
              {r.status === 'confirmada'
                ? formatQty(net, 'kg')
                : r.status === 'anulada'
                  ? `0 kg (se habían recibido ${formatQty(r.confirmedNetMilli ?? 0, 'kg')})`
                  : '—'}
            </p>
            <p class="hint">
              Llegó {fmtDateTime(r.receivedAt)} · {PACKAGING_LABEL[r.packaging]}
              {r.containers !== undefined && ` · ${r.containers} ${r.containers === 1 ? noun.one : noun.many}`} · {WEIGHT_MODE_LABEL[r.weightMode]}
              {r.unitNetMilli !== undefined && ` (${formatQty(r.unitNetMilli, 'kg')} c/u)`}
              {r.weighingsMilli && ` (${r.weighingsMilli.length} pesadas)`}
              {r.supplier && ` · ${r.supplier}`}
              {r.reference && ` · ref. ${r.reference}`}
            </p>
            {r.confirmedAt && (
              <p class="hint" data-testid="rec-row-captured">
                Capturada {fmtDateTime(r.confirmedAt)}
              </p>
            )}
            {r.notes && <p class="hint">Obs.: {r.notes}</p>}
            {r.corrections.length > 0 && (
              <div class="hint" data-testid="rec-row-corrections">
                Corregida {r.corrections.length} {r.corrections.length === 1 ? 'vez' : 'veces'}: original {formatQty(r.confirmedNetMilli ?? 0, 'kg')}
                {r.corrections.map((c) => (
                  <span key={c.id}>
                    {' '}
                    → {c.deltaMilli > 0 ? '+' : ''}
                    {formatQty(c.deltaMilli, 'kg')} ({c.reason})
                  </span>
                ))}{' '}
                → vigente <strong>{formatQty(net, 'kg')}</strong>
              </div>
            )}
            {r.dataEdits && r.dataEdits.length > 0 && (
              <p class="hint" data-testid="rec-row-dataedits">
                Datos corregidos {r.dataEdits.length} {r.dataEdits.length === 1 ? 'vez' : 'veces'} (ver detalle)
              </p>
            )}
            {r.status === 'anulada' && <p class="hint">Anulada: {r.voidReason}</p>}
            {r.status === 'cancelada' && r.cancelReason && <p class="hint">Descartada: {r.cancelReason}</p>}

            {r.status !== 'cancelada' && (
              <div class="actions">
                {r.status === 'confirmada' && (
                  <>
                    <button data-testid="rec-correct" onClick={() => openPanel(r, 'corregir')}>
                      Corregir kilos
                    </button>
                    <button data-testid="rec-edit-data" onClick={() => openPanel(r, 'datos')}>
                      Corregir datos
                    </button>
                    <button class="danger" data-testid="rec-void" onClick={() => openPanel(r, 'anular')}>
                      Anular
                    </button>
                  </>
                )}
                <button data-testid="rec-moves" onClick={() => openPanel(r, 'detalle')}>
                  Detalle
                </button>
              </div>
            )}

            {open === 'corregir' && (
              <div class="inline-form" data-testid="rec-correct-form">
                <p class="hint">No se borra nada: se agrega un movimiento de corrección con tu motivo.</p>
                <label class="field">
                  <span>Kilos netos correctos</span>
                  <input data-testid="rec-correct-qty" inputMode="decimal" autoComplete="off" value={qtyText} onInput={(e) => setQtyText((e.target as HTMLInputElement).value)} />
                </label>
                {ambiguousNumberHint(qtyText) && (
                  <p class="notice" role="alert" data-testid="rec-correct-ambiguous">
                    {ambiguousNumberHint(qtyText)}
                  </p>
                )}
                <label class="field">
                  <span>Motivo (obligatorio)</span>
                  <input data-testid="rec-correct-reason" maxLength={300} value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
                </label>
                <button
                  class="primary"
                  data-testid="rec-correct-save"
                  disabled={!reason.trim() || parseQty(qtyText) === null}
                  onClick={() => run((neg, ack) => correctReception(db, r.id, parseQty(qtyText)!, reason, neg, ack), `Recepción R-${r.folio} corregida`)}
                >
                  Guardar corrección
                </button>
              </div>
            )}

            {open === 'datos' && (
              <div class="inline-form" data-testid="rec-data-form">
                <p class="hint">
                  Corrige fecha, quién lo manda, camión / nota, observaciones o cantidad de envases. No cambia los kilos ni el inventario; queda
                  el antes y el después con tu motivo.
                </p>
                <label class="field">
                  <span>Fecha y hora de llegada</span>
                  <input type="datetime-local" data-testid="rec-data-when" max={toLocalInput(new Date())} value={eWhen} onInput={(e) => setEWhen((e.target as HTMLInputElement).value)} />
                </label>
                <label class="field">
                  <span>¿Quién lo manda?</span>
                  <input data-testid="rec-data-supplier" maxLength={120} value={eSupplier} onInput={(e) => setESupplier((e.target as HTMLInputElement).value)} />
                </label>
                <label class="field">
                  <span>Camión / nota</span>
                  <input data-testid="rec-data-reference" maxLength={60} value={eReference} onInput={(e) => setEReference((e.target as HTMLInputElement).value)} />
                </label>
                <label class="field">
                  <span>Observaciones</span>
                  <input data-testid="rec-data-notes" maxLength={500} value={eNotes} onInput={(e) => setENotes((e.target as HTMLInputElement).value)} />
                </label>
                {r.packaging !== 'granel' && r.weightMode !== 'por_envase' && (
                  <label class="field">
                    <span>Cuántas {noun.many} (solo para llevar la cuenta)</span>
                    <input data-testid="rec-data-containers" inputMode="numeric" value={eContainers} onInput={(e) => setEContainers((e.target as HTMLInputElement).value)} />
                  </label>
                )}
                <label class="field">
                  <span>Motivo (obligatorio)</span>
                  <input data-testid="rec-data-reason" maxLength={300} value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
                </label>
                <button class="primary" data-testid="rec-data-save" disabled={!reason.trim()} onClick={() => saveData(r)}>
                  Guardar corrección de datos
                </button>
              </div>
            )}

            {open === 'anular' && (
              <div class="inline-form" data-testid="rec-void-form">
                <p class="hint">
                  Se restan {formatQty(net, 'kg')} del inventario con un movimiento de anulación (queda registrado). Si solo te
                  equivocaste de producto, usa «Anular y copiar a borrador»: se anula y se prepara una nueva con los mismos
                  datos para que elijas el correcto.
                </p>
                <label class="field">
                  <span>Motivo (obligatorio)</span>
                  <input data-testid="rec-void-reason" maxLength={300} value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
                </label>
                <div class="actions">
                  <button
                    class="danger"
                    data-testid="rec-void-confirm"
                    disabled={!reason.trim()}
                    onClick={() => run((neg, ack) => voidReception(db, r.id, reason, neg, ack), `Recepción R-${r.folio} anulada`)}
                  >
                    Anular recepción
                  </button>
                  <button
                    data-testid="rec-void-copy"
                    disabled={!reason.trim()}
                    onClick={() =>
                      run(
                        (neg, ack) => voidAndCopyToDraft(db, r.id, reason, neg, ack).then(({ draft }) => onOpenDraft(draft)),
                        `R-${r.folio} anulada: completa el borrador con el producto correcto`,
                      )
                    }
                  >
                    Anular y copiar a borrador
                  </button>
                </div>
              </div>
            )}

            {open === 'detalle' && (
              <div data-testid="rec-detail">
                <ul class="plain moves" data-testid="rec-moves-list">
                  {moves.map((m) => (
                    <li key={m.id}>
                      {fmtDateTime(m.createdAt)} · {MOVE_LABEL[m.type] ?? m.type} · {m.deltaMilli > 0 ? '+' : ''}
                      {formatQty(m.deltaMilli, 'kg')}
                      {m.note && ` · ${m.note}`}
                    </li>
                  ))}
                </ul>
                {r.dataEdits && r.dataEdits.length > 0 && (
                  <ul class="plain moves" data-testid="rec-dataedits-list">
                    {r.dataEdits.map((e) => (
                      <li key={e.id}>
                        {fmtDateTime(e.at)} · Datos corregidos ({e.reason}):{' '}
                        {e.changes.map((c) => `${EDIT_FIELD_LABEL[c.field] ?? c.field}: ${fmtChange(c.field, c.before)} → ${fmtChange(c.field, c.after)}`).join('; ')}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </article>
        );
      })}
      {matching.length > shown.length && (
        <button data-testid="rec-hist-more" onClick={() => setLimit(limit + PAGE)}>
          Mostrar {Math.min(PAGE, matching.length - shown.length)} más
        </button>
      )}
      {auth && <AuthorizeSheet error={auth.error} busy={authBusy} onCancel={() => setAuth(null)} onAuthorize={() => resolvePending(auth)} />}
      {warned && (
        <WarningsSheet
          warnings={warned.warnings}
          busy={authBusy}
          confirmLabel="Entiendo, continuar"
          onCancel={() => setWarned(null)}
          onConfirm={() => resolvePending(warned)}
        />
      )}
    </div>
  );
}
