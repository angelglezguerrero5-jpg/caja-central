import { BRAND } from '../brand';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  DuplicateFreightError,
  FreightFolioTakenError,
  FreightValidationError,
  createFreight,
  freightFolioKeys,
  getFreightSettings,
  listFreights,
  saveFreightSettings,
  updateFreight,
  voidFreight,
} from '../db/freights';
import { newId } from '../db/repo';
import { normalizeKey } from '../domain/classification';
import {
  DEFAULT_FREIGHT_SETTINGS,
  DIFFERENCE_TEXT,
  FREIGHT_WEIGHT_MODES,
  FREIGHT_WEIGHT_MODE_LABEL,
  SIDE_LABEL,
  STATE_LABEL,
  classifyDifference,
  computeDifference,
  computeSideNet,
  differenceOf,
  formatDiff,
  formatPercentBp,
  freightState,
  normalizeFreightFields,
  referenceLabel,
  referenceOf,
  sideIsBlank,
  suggestFolio,
  totalsOf,
  validateFreightFields,
  type FreightFields,
  type FreightSideFields,
} from '../domain/freight';
import { ambiguousNumberHint, formatQty, parseQty } from '../domain/money';
import { localDay } from '../domain/report';
import type { Freight, FreightSettings, FreightSide, FreightWeightMode } from '../domain/types';
import { errMsg, useApp } from './ctx';
import { fmtDateTime, localInputToIso, milliToText, toLocalInput } from './format';
import { shieldTaps } from './Sheet';

/**
 * Control de pesaje por flete: lo que pesó la mercancía al SALIR (origen) contra lo que pesó al LLEGAR (destino).
 * No mueve inventario, ventas ni caja; las existencias se mueven en Recepción. La app no sabe por qué hay diferencia:
 * no la llama merma ni deshidratación, solo la compara con un rango de referencia que se puede cambiar.
 */

type Filter = 'todos' | 'incompletos' | 'completos' | 'anulados';
const FILTERS: Array<[Filter, string]> = [
  ['todos', 'Todos'],
  ['incompletos', 'Incompletos'],
  ['completos', 'Completos'],
  ['anulados', 'Anulados'],
];

interface SideDraft {
  mode: FreightWeightMode;
  gross: string;
  tare: string;
  net: string;
  ticket: string;
  scale: string;
}
interface Draft {
  id: string;
  folio: string;
  when: string;
  origin: string;
  destination: string;
  notes: string;
  initial: SideDraft;
  final: SideDraft;
  reason: string;
}

const blankSide = (): SideDraft => ({ mode: 'bruto_tara', gross: '', tare: '', net: '', ticket: '', scale: '' });
const sideDraftOf = (s: FreightSide | undefined): SideDraft =>
  s
    ? {
        mode: s.mode,
        gross: milliToText(s.grossMilli),
        tare: milliToText(s.tareMilli),
        net: s.mode === 'directo' ? milliToText(s.netMilli) : '',
        ticket: s.ticket ?? '',
        scale: s.scale ?? '',
      }
    : blankSide();
const draftOf = (f: Freight): Draft => ({
  id: f.id,
  folio: f.folio,
  when: toLocalInput(new Date(f.date)),
  origin: f.origin,
  destination: f.destination,
  notes: f.notes ?? '',
  initial: sideDraftOf(f.initial),
  final: sideDraftOf(f.final),
  reason: '',
});

const LS_FORM = `${BRAND.ns}.flete.form.v1`;
function lsGet(): Draft | null {
  try {
    const raw = localStorage.getItem(LS_FORM);
    const d = raw ? (JSON.parse(raw) as Draft) : null;
    return d && typeof d.id === 'string' && d.initial && d.final ? d : null;
  } catch {
    return null;
  }
}
function lsSet(d: Draft | null) {
  try {
    if (d) localStorage.setItem(LS_FORM, JSON.stringify(d));
    else localStorage.removeItem(LS_FORM);
  } catch {
    /* solo se pierde la captura en curso al cambiar de pantalla */
  }
}

/** '' → undefined (no capturado); texto ilegible o fuera de límites → NaN (se reporta como inválido). */
const numKg = (t: string): number | undefined => (t.trim() === '' ? undefined : (parseQty(t) ?? NaN));

/** Qué decirle a la persona cuando lo que escribió no es un número usable (vacío = nada que decir). */
function numberProblem(text: string, what: string): string {
  const t = text.trim();
  if (!t || parseQty(t) !== null) return '';
  const ambiguous = ambiguousNumberHint(t);
  if (ambiguous) return `${what}: ${ambiguous}`;
  if (/^\d+([.,]\d+)?$/.test(t)) return `${what}: «${t}» es demasiado grande (máximo 200,000 kg) o tiene demasiados decimales (máximo 3).`;
  return `${what}: no entiendo «${t}». Escribe solo el número; para decimales usa punto (por ejemplo 15.5).`;
}

const sideFields = (s: SideDraft): FreightSideFields => ({
  mode: s.mode,
  ...(s.mode === 'bruto_tara' ? { grossMilli: numKg(s.gross), tareMilli: numKg(s.tare) } : { netMilli: numKg(s.net) }),
  ticket: s.ticket,
  scale: s.scale,
});

/** Nombre de cada dato de la bitácora, en lenguaje llano. */
const FIELD_LABEL: Record<string, string> = {
  folio: 'Folio',
  date: 'Fecha',
  origin: 'Origen',
  destination: 'Destino',
  notes: 'Observaciones',
  status: 'Estado',
};
function fieldLabel(field: string): string {
  if (FIELD_LABEL[field]) return FIELD_LABEL[field];
  const [side, key] = field.split('.');
  const who = side === 'initial' ? 'Peso inicial' : 'Peso final';
  const what: Record<string, string> = {
    mode: 'forma de pesar',
    grossMilli: 'bruto',
    tareMilli: 'tara',
    netMilli: 'neto',
    ticket: 'boleta',
    scale: 'báscula',
  };
  return `${who} · ${what[key] ?? key}`;
}
function changeText(field: string, v: string | number | undefined): string {
  if (v === undefined || v === '') return '—';
  if (field === 'date') return fmtDateTime(String(v));
  if (field.endsWith('Milli')) return formatQty(Number(v), 'kg');
  if (field.endsWith('.mode')) return FREIGHT_WEIGHT_MODE_LABEL[v as FreightWeightMode] ?? String(v);
  if (field === 'status') return v === 'anulado' ? 'Anulado' : 'Vigente';
  return String(v);
}

const kg = (milli: number | undefined) => (milli === undefined ? '—' : formatQty(milli, 'kg'));

/** Evidencias de las básculas de un flete, en una línea: «Boleta origen 123 (Báscula Norte)». */
function evidence(f: Freight): string[] {
  const part = (label: string, s: FreightSide | undefined) =>
    s && (s.ticket || s.scale) ? `${label}${s.ticket ? ` boleta ${s.ticket}` : ''}${s.scale ? ` (báscula ${s.scale})` : ''}` : '';
  return [part('Origen:', f.initial), part('Destino:', f.final)].filter(Boolean);
}

export function Fletes() {
  const { db, version, bump, toast } = useApp();
  const [items, setItems] = useState<Freight[]>([]);
  const [settings, setSettings] = useState<FreightSettings>(DEFAULT_FREIGHT_SETTINGS);
  const [filter, setFilter] = useState<Filter>('todos');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Freight | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [panel, setPanel] = useState<{ id: string; kind: 'historial' | 'anular' } | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [focusSide, setFocusSide] = useState<'initial' | 'final' | null>(null);
  const [refMin, setRefMin] = useState('');
  const [refMax, setRefMax] = useState('');
  const [refOk, setRefOk] = useState(false);
  const busy = useRef(false);
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listFreights(db).then(setItems);
  }, [db, version]);
  useEffect(() => {
    getFreightSettings(db).then((s) => {
      setSettings(s);
      setRefMin(milliToText(s.refMinMilli));
      setRefMax(milliToText(s.refMaxMilli));
      setRefOk(s.validated);
    });
  }, [db, version]);

  // Una captura a medias se conserva al mirar otras pantallas (solo flete nuevo; se guarda en este teléfono, no en la base).
  useEffect(() => {
    const saved = lsGet();
    if (saved) {
      setDraft(saved);
      setOpen(true);
    }
  }, []);
  useEffect(() => {
    if (open && draft && !editing) lsSet(draft);
  }, [draft, open, editing]);

  useEffect(() => {
    if (!open || !focusSide) return;
    const id = focusSide === 'initial' ? 'fl-i' : 'fl-f';
    const el = formRef.current?.querySelector<HTMLElement>(`[data-testid="${id}-gross"], [data-testid="${id}-net"]`);
    el?.focus();
    setFocusSide(null);
  }, [open, focusSide, draft]);

  const ref = referenceOf(settings);

  async function openNew() {
    const taken = await freightFolioKeys(db);
    setEditing(null);
    setDraft({
      id: newId(),
      folio: suggestFolio(taken, localDay(new Date())),
      when: toLocalInput(new Date()),
      origin: '',
      destination: '',
      notes: '',
      initial: blankSide(),
      final: blankSide(),
      reason: '',
    });
    setOpen(true);
  }

  function startEdit(f: Freight) {
    setPanel(null);
    setEditing(f);
    setDraft(draftOf(f));
    setOpen(true);
    setFocusSide(f.initial ? (f.final ? null : 'final') : 'initial');
    window.setTimeout(() => formRef.current?.scrollIntoView({ block: 'start' }), 0);
  }

  function closeForm() {
    setOpen(false);
    setEditing(null);
    setDraft(null);
    lsSet(null);
  }

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const patchSide = (key: 'initial' | 'final', p: Partial<SideDraft>) => setDraft((d) => (d ? { ...d, [key]: { ...d[key], ...p } } : d));

  // ── Lo capturado, convertido y validado (para la vista previa y para guardar) ─────────────────────────────────────
  const built = useMemo(() => {
    if (!draft) return null;
    const date = localInputToIso(draft.when);
    const unchangedDate = editing && draft.when === toLocalInput(new Date(editing.date));
    const fields: FreightFields = normalizeFreightFields({
      id: draft.id,
      folio: draft.folio,
      ...(date === 'invalid' ? {} : unchangedDate ? { date: editing!.date } : date ? { date } : {}),
      origin: draft.origin,
      destination: draft.destination,
      notes: draft.notes,
      initial: sideFields(draft.initial),
      final: sideFields(draft.final),
    });
    const errors = validateFreightFields(fields, { now: new Date() });
    if (date === 'invalid') errors.unshift('Fecha: la fecha no es válida');
    const problems = (['initial', 'final'] as const)
      .flatMap((key) => {
        const s = draft[key];
        return s.mode === 'bruto_tara'
          ? [numberProblem(s.gross, `${SIDE_LABEL[key]} · bruto`), numberProblem(s.tare, `${SIDE_LABEL[key]} · tara`)]
          : [numberProblem(s.net, `${SIDE_LABEL[key]} · neto`)];
      })
      .filter(Boolean);
    const netOf = (s: FreightSideFields | undefined) => {
      if (!s || sideIsBlank(s)) return undefined;
      const r = computeSideNet(s);
      return r.ok ? r.netMilli : undefined;
    };
    const iNet = netOf(fields.initial);
    const fNet = netOf(fields.final);
    const diff = computeDifference(iNet, fNet);
    return { fields, errors, problems, iNet, fNet, diff, klass: classifyDifference(diff, ref) };
  }, [draft, editing, ref]);

  function finish(message: string) {
    toast(message);
    closeForm();
    // El segundo toque de un doble toque cae donde estaba «Guardar flete», que ya no está: durante un instante la pantalla
    // ignora los toques (el mismo escudo que usan las hojas) para que no active lo que quedó debajo.
    shieldTaps();
    bump();
  }

  async function save() {
    if (!draft || !built || busy.current) return;
    if (built.problems.length > 0) return void toast(built.problems[0], 'error');
    if (built.errors.length > 0) return void toast(built.errors[0], 'error');
    busy.current = true;
    try {
      if (editing) {
        const saved = await updateFreight(db, editing.id, built.fields, { reason: draft.reason });
        finish(saved.revisions.length === editing.revisions.length ? `Sin cambios en el flete ${saved.folio}` : `Flete ${saved.folio} corregido`);
      } else {
        const saved = await createFreight(db, built.fields);
        finish(`Flete ${saved.folio} guardado`);
      }
    } catch (e) {
      if (e instanceof DuplicateFreightError) finish(`El flete ${e.freight.folio} ya estaba guardado`); // doble toque o reintento: es un éxito
      else if (e instanceof FreightValidationError) toast(e.errors[0], 'error');
      else if (e instanceof FreightFolioTakenError) toast(e.message, 'error');
      else toast(errMsg(e), 'error');
    } finally {
      busy.current = false;
    }
  }

  async function doVoid(f: Freight) {
    if (busy.current) return;
    busy.current = true;
    try {
      await voidFreight(db, f.id, voidReason);
      toast(`Flete ${f.folio} anulado`);
      setPanel(null);
      setVoidReason('');
      shieldTaps();
      bump();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      busy.current = false;
    }
  }

  async function saveRange(next: FreightSettings) {
    try {
      await saveFreightSettings(db, next);
      toast('Rango de referencia guardado');
      bump();
    } catch (e) {
      toast(e instanceof FreightValidationError ? e.errors[0] : errMsg(e), 'error');
    }
  }

  // ── Lista ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const q = normalizeKey(search);
  const shown = useMemo(
    () =>
      items.filter((f) => {
        const st = freightState(f);
        if (filter === 'incompletos' && st !== 'falta_final' && st !== 'falta_inicial') return false;
        if (filter === 'completos' && st !== 'completo') return false;
        if (filter === 'anulados' && st !== 'anulado') return false;
        return !q || normalizeKey([f.folio, f.origin, f.destination, f.notes, f.initial?.ticket, f.final?.ticket].filter(Boolean).join(' ')).includes(q);
      }),
    [items, filter, q],
  );
  const totals = useMemo(() => totalsOf(shown), [shown]);
  const totalDiff = totals.complete > 0 ? classifyDifference(computeDifference(totals.initialMilli, totals.finalMilli), ref) : null;

  const sideForm = (key: 'initial' | 'final', prefix: 'fl-i' | 'fl-f') => {
    if (!draft) return null;
    const s = draft[key];
    const fields = built?.fields[key];
    const net = key === 'initial' ? built?.iNet : built?.fNet;
    return (
      <fieldset class="card" data-testid={`${prefix}-side`}>
        <legend>
          <strong>{SIDE_LABEL[key]}</strong>
        </legend>
        <div class="chips small" role="group" aria-label={`Cómo capturar el ${SIDE_LABEL[key].toLowerCase()}`}>
          {FREIGHT_WEIGHT_MODES.map((m) => (
            <button
              type="button"
              key={m}
              role="radio"
              aria-checked={s.mode === m}
              class={s.mode === m ? 'chip active' : 'chip'}
              data-testid={`${prefix}-mode-${m}`}
              onClick={() => patchSide(key, { mode: m })}
            >
              {FREIGHT_WEIGHT_MODE_LABEL[m]}
            </button>
          ))}
        </div>
        {s.mode === 'bruto_tara' ? (
          <div class="row2">
            <label class="field">
              <span>Peso bruto (kg)</span>
              <input
                data-testid={`${prefix}-gross`}
                inputMode="decimal"
                autoComplete="off"
                enterKeyHint="next"
                placeholder="0"
                value={s.gross}
                onInput={(e) => patchSide(key, { gross: (e.target as HTMLInputElement).value })}
              />
            </label>
            <label class="field">
              <span>Tara (kg)</span>
              <input
                data-testid={`${prefix}-tare`}
                inputMode="decimal"
                autoComplete="off"
                enterKeyHint="next"
                placeholder="0"
                value={s.tare}
                onInput={(e) => patchSide(key, { tare: (e.target as HTMLInputElement).value })}
              />
            </label>
          </div>
        ) : (
          <label class="field">
            <span>Peso neto (kg)</span>
            <input
              data-testid={`${prefix}-net`}
              inputMode="decimal"
              autoComplete="off"
              enterKeyHint="next"
              placeholder="0"
              value={s.net}
              onInput={(e) => patchSide(key, { net: (e.target as HTMLInputElement).value })}
            />
          </label>
        )}
        {net !== undefined && (
          <p class="big" data-testid={`${prefix}-net-out`} data-milli={net}>
            Neto: {kg(net)}
          </p>
        )}
        <div class="row2">
          <label class="field">
            <span>No. de boleta (opcional)</span>
            <input
              data-testid={`${prefix}-ticket`}
              autoComplete="off"
              autoCapitalize="characters"
              enterKeyHint="next"
              value={s.ticket}
              onInput={(e) => patchSide(key, { ticket: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>Báscula (opcional)</span>
            <input
              data-testid={`${prefix}-scale`}
              autoComplete="off"
              enterKeyHint="next"
              value={s.scale}
              onInput={(e) => patchSide(key, { scale: (e.target as HTMLInputElement).value })}
            />
          </label>
        </div>
        {!fields && sideIsBlank(sideFields(s)) && (
          <p class="help">Puedes dejar esta pesada para después: el flete queda «incompleto» y sin diferencia hasta capturarla.</p>
        )}
      </fieldset>
    );
  };

  const reasonNeeded = !!editing;
  return (
    <section data-testid="fletes">
      <h2>Control de pesaje por flete</h2>
      <p class="hint" data-testid="fl-hint">
        Compara lo que pesó la mercancía al <strong>salir</strong> (origen) contra lo que pesó al <strong>llegar</strong> (destino).
        Este registro <strong>no suma ni resta existencias</strong>: eso se hace en Recepción. La app no sabe por qué hay diferencia (no
        la llama merma ni deshidratación): solo la compara con el rango de referencia.
      </p>

      {!open && (
        <button class="primary" data-testid="fl-new" onClick={openNew}>
          ＋ Nuevo flete
        </button>
      )}

      {open && draft && (
        <div class="card" data-testid="fl-form" ref={formRef}>
          <h3>{editing ? `Corregir o completar el flete ${editing.folio}` : 'Nuevo flete'}</h3>
          <label class="field">
            <span>Folio del flete (no se puede repetir)</span>
            <input
              data-testid="fl-folio"
              autoComplete="off"
              autoCapitalize="characters"
              enterKeyHint="next"
              value={draft.folio}
              onInput={(e) => patch({ folio: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>Fecha y hora del flete</span>
            <input data-testid="fl-date" type="datetime-local" value={draft.when} onInput={(e) => patch({ when: (e.target as HTMLInputElement).value })} />
          </label>
          <div class="row2">
            <label class="field">
              <span>Origen (de dónde sale)</span>
              <input
                data-testid="fl-origin"
                autoComplete="off"
                enterKeyHint="next"
                value={draft.origin}
                onInput={(e) => patch({ origin: (e.target as HTMLInputElement).value })}
              />
            </label>
            <label class="field">
              <span>Destino (a dónde llega)</span>
              <input
                data-testid="fl-destination"
                autoComplete="off"
                enterKeyHint="next"
                value={draft.destination}
                onInput={(e) => patch({ destination: (e.target as HTMLInputElement).value })}
              />
            </label>
          </div>
          {sideForm('initial', 'fl-i')}
          {sideForm('final', 'fl-f')}
          <label class="field">
            <span>Observaciones (opcional)</span>
            <input
              data-testid="fl-notes"
              autoComplete="off"
              enterKeyHint="done"
              value={draft.notes}
              onInput={(e) => patch({ notes: (e.target as HTMLInputElement).value })}
            />
          </label>

          {built?.diff && (
            <div class="notice" data-testid="fl-preview">
              <strong>Diferencia de peso:</strong>{' '}
              <span data-testid="fl-diff" data-milli={built.diff.diffMilli}>
                {formatDiff(built.diff.diffMilli)}
              </span>{' '}
              (<span data-testid="fl-pct" data-bp={built.diff.percentBp}>{formatPercentBp(built.diff.percentBp)}</span> del peso inicial)
              {built.klass && (
                <div data-testid="fl-class" data-class={built.klass}>
                  {DIFFERENCE_TEXT[built.klass]}
                  {built.klass !== 'final_mayor' && built.klass !== 'sin_diferencia' && built.klass !== 'sin_referencia' && !settings.validated && ' (referencia pendiente de validación)'}
                </div>
              )}
            </div>
          )}
          {built && built.problems.length > 0 && (
            <p class="notice" role="alert" data-testid="fl-input-problem">
              {built.problems[0]}
            </p>
          )}
          {built && built.problems.length === 0 && built.errors.length > 0 && (
            <div class="notice" data-testid="fl-missing">
              Falta o está mal: {built.errors[0]}
              {built.errors.length > 1 && ` (y ${built.errors.length - 1} más)`}
            </div>
          )}
          {reasonNeeded && (
            <label class="field">
              <span>Motivo de la corrección (obligatorio si cambias algo que ya estaba capturado)</span>
              <input
                data-testid="fl-reason"
                autoComplete="off"
                enterKeyHint="done"
                maxLength={300}
                value={draft.reason}
                onInput={(e) => patch({ reason: (e.target as HTMLInputElement).value })}
              />
            </label>
          )}
          <div class="actions two">
            <button data-testid="fl-cancel" onClick={closeForm}>
              Cancelar
            </button>
            <button class="primary" data-testid="fl-save" aria-disabled={!built || built.errors.length > 0 || built.problems.length > 0} onClick={save}>
              {editing ? 'Guardar corrección' : 'Guardar flete'}
            </button>
          </div>
        </div>
      )}

      <h3>Fletes</h3>
      <div class="tabs-state" role="group" aria-label="Filtrar fletes">
        {FILTERS.map(([id, label]) => (
          <button key={id} aria-pressed={filter === id} class={filter === id ? 'active' : ''} data-testid={`fl-filter-${id}`} onClick={() => setFilter(id)}>
            {label}
          </button>
        ))}
      </div>
      <label class="field">
        <span>Buscar por folio, origen, destino o boleta</span>
        <input data-testid="fl-search" type="search" autoComplete="off" value={search} onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />
      </label>

      <div class="card" data-testid="fl-summary" data-complete={totals.complete} data-incomplete={totals.incomplete} data-diff-milli={totals.diffMilli}>
        <p class="hint" data-testid="fl-count">
          {shown.length === 0
            ? 'No hay fletes con ese filtro.'
            : `${shown.length} ${shown.length === 1 ? 'flete' : 'fletes'}: ${totals.complete} ${totals.complete === 1 ? 'completo' : 'completos'}, ${totals.incomplete} ${totals.incomplete === 1 ? 'incompleto' : 'incompletos'}, ${totals.voided} ${totals.voided === 1 ? 'anulado' : 'anulados'}.`}
        </p>
        {totals.complete > 0 && (
          <dl class="report">
            <div>
              <dt>Peso inicial total</dt>
              <dd data-testid="fl-sum-initial" data-milli={totals.initialMilli}>{kg(totals.initialMilli)}</dd>
            </div>
            <div>
              <dt>Peso final total</dt>
              <dd data-testid="fl-sum-final" data-milli={totals.finalMilli}>{kg(totals.finalMilli)}</dd>
            </div>
            <div class="strong">
              <dt>Diferencia total</dt>
              <dd data-testid="fl-sum-diff" data-milli={totals.diffMilli} data-bp={totals.percentBp ?? ''}>
                {formatDiff(totals.diffMilli)}
                {totals.percentBp !== null && ` (${formatPercentBp(totals.percentBp)})`}
              </dd>
            </div>
          </dl>
        )}
        {totalDiff && <p class="hint">{DIFFERENCE_TEXT[totalDiff]} (suma de los fletes completos de la lista).</p>}
      </div>

      {shown.map((f) => {
        const st = freightState(f);
        const d = differenceOf(f);
        const klass = classifyDifference(d, ref);
        const isOpen = panel?.id === f.id;
        return (
          <article class={st === 'anulado' ? 'card inactive' : 'card'} key={f.id} data-testid="fl-row" data-folio={f.folio} data-state={st}>
            <header>
              <strong>{f.folio}</strong>
              <span class={st === 'anulado' ? 'badge cancel' : 'badge'} data-testid="fl-state">
                {STATE_LABEL[st]}
              </span>
            </header>
            <p class="hint">
              {fmtDateTime(f.date)} · {f.origin} → {f.destination}
            </p>
            <div class="brow">
              <div>
                <small>Inicial (origen)</small>
                <span data-testid="fl-initial" data-milli={f.initial?.netMilli ?? ''}>{kg(f.initial?.netMilli)}</span>
              </div>
              <div>
                <small>Final (destino)</small>
                <span data-testid="fl-final" data-milli={f.final?.netMilli ?? ''}>{kg(f.final?.netMilli)}</span>
              </div>
              <div>
                <small>Diferencia</small>
                <span data-testid="fl-difference" data-milli={d?.diffMilli ?? ''} data-bp={d?.percentBp ?? ''}>
                  {d ? `${formatDiff(d.diffMilli)} · ${formatPercentBp(d.percentBp)}` : '—'}
                </span>
              </div>
            </div>
            {klass && st !== 'anulado' && (
              <p class={klass === 'final_mayor' ? 'notice' : 'hint'} data-testid="fl-row-class" data-class={klass}>
                {DIFFERENCE_TEXT[klass]}
                {klass !== 'final_mayor' && klass !== 'sin_diferencia' && klass !== 'sin_referencia' && !settings.validated && ' (referencia pendiente de validación)'}
              </p>
            )}
            {st !== 'anulado' && st !== 'completo' && (
              <p class="hint" data-testid="fl-row-incomplete">
                {st === 'falta_final' ? 'Falta el peso final (destino): sin él no hay diferencia.' : 'Falta el peso inicial (origen): sin él no hay diferencia.'}
              </p>
            )}
            {evidence(f).length > 0 && (
              <p class="hint" data-testid="fl-row-evidence">
                {evidence(f).join(' · ')}
              </p>
            )}
            {f.notes && <p class="hint">{f.notes}</p>}
            {st === 'anulado' && <p class="hint">Anulado: {f.voidReason}</p>}
            <div class="actions">
              {st !== 'anulado' && (
                <button data-testid="fl-edit" onClick={() => startEdit(f)}>
                  {st === 'falta_final' ? 'Registrar peso final' : st === 'falta_inicial' ? 'Registrar peso inicial' : 'Corregir'}
                </button>
              )}
              <button data-testid="fl-history-btn" onClick={() => setPanel(isOpen && panel?.kind === 'historial' ? null : { id: f.id, kind: 'historial' })}>
                Bitácora{f.revisions.length > 0 ? ` (${f.revisions.length})` : ''}
              </button>
              {st !== 'anulado' && (
                <button
                  class="danger"
                  data-testid="fl-void"
                  onClick={() => {
                    setVoidReason('');
                    setPanel(isOpen && panel?.kind === 'anular' ? null : { id: f.id, kind: 'anular' });
                  }}
                >
                  Anular
                </button>
              )}
            </div>
            {isOpen && panel?.kind === 'historial' && (
              <div data-testid="fl-history">
                {f.revisions.length === 0 ? (
                  <p class="hint">Sin correcciones: está como se capturó.</p>
                ) : (
                  <ul class="plain">
                    {[...f.revisions].reverse().map((r) => (
                      <li key={r.id} data-testid="fl-revision">
                        <strong>{fmtDateTime(r.at)}</strong> · {r.reason}
                        <ul class="plain">
                          {r.changes.map((c) => (
                            <li key={c.field} class="hint">
                              {fieldLabel(c.field)}: {changeText(c.field, c.before)} → {changeText(c.field, c.after)}
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {isOpen && panel?.kind === 'anular' && (
              <div class="inline-form" data-testid="fl-void-panel">
                <p class="warn">Anular no borra nada: el flete queda guardado, marcado como anulado, y su folio no se puede volver a usar.</p>
                <label class="field">
                  <span>Motivo (obligatorio)</span>
                  <input
                    data-testid="fl-void-reason"
                    autoComplete="off"
                    maxLength={300}
                    value={voidReason}
                    onInput={(e) => setVoidReason((e.target as HTMLInputElement).value)}
                  />
                </label>
                <div class="actions two">
                  <button data-testid="fl-void-no" onClick={() => setPanel(null)}>
                    No anular
                  </button>
                  <button class="danger" data-testid="fl-void-yes" aria-disabled={voidReason.trim() === ''} onClick={() => (voidReason.trim() === '' ? toast('Escribe el motivo', 'error') : doVoid(f))}>
                    Sí, anular
                  </button>
                </div>
              </div>
            )}
          </article>
        );
      })}

      <details class="fold" data-testid="fl-settings">
        <summary>
          Rango de referencia <small data-testid="fl-ref-label">{referenceLabel(settings)}</small>
        </summary>
        <p class="hint">
          Es solo un punto de comparación para la diferencia de peso de cada flete. No dice por qué hay diferencia. Mientras no lo marques
          como validado, la app lo muestra como «pendiente de validación».
        </p>
        <div class="row2">
          <label class="field">
            <span>Mínimo (kg)</span>
            <input data-testid="fl-ref-min" inputMode="decimal" autoComplete="off" value={refMin} onInput={(e) => setRefMin((e.target as HTMLInputElement).value)} />
          </label>
          <label class="field">
            <span>Máximo (kg)</span>
            <input data-testid="fl-ref-max" inputMode="decimal" autoComplete="off" value={refMax} onInput={(e) => setRefMax((e.target as HTMLInputElement).value)} />
          </label>
        </div>
        <label class="check">
          <input type="checkbox" data-testid="fl-ref-validated" checked={refOk} onChange={(e) => setRefOk((e.target as HTMLInputElement).checked)} />
          Ya validé este rango
        </label>
        <div class="actions">
          <button
            class="primary"
            data-testid="fl-ref-save"
            onClick={() => {
              const lo = numKg(refMin);
              const hi = numKg(refMax);
              if (Number.isNaN(lo) || Number.isNaN(hi)) return void toast('Escribe los kilos del rango como número (por ejemplo 200)', 'error');
              void saveRange({ validated: refOk, ...(lo !== undefined ? { refMinMilli: lo } : {}), ...(hi !== undefined ? { refMaxMilli: hi } : {}) });
            }}
          >
            Guardar rango
          </button>
          <button data-testid="fl-ref-off" onClick={() => void saveRange({ validated: false })}>
            No usar rango
          </button>
          <button data-testid="fl-ref-default" onClick={() => void saveRange({ ...DEFAULT_FREIGHT_SETTINGS })}>
            Volver a 200–300 kg
          </button>
        </div>
      </details>
    </section>
  );
}
