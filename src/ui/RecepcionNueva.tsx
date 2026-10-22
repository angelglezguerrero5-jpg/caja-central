import type { ComponentChildren } from 'preact';
import { BRAND } from '../brand';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  DuplicateReceptionError,
  PossibleDuplicateReceptionError,
  ReceptionIdConflictError,
  ReceptionValidationError,
  confirmReception,
  lastUnitNet,
  listReceptions,
  previewReceptionWarnings,
  receptionToFields,
  saveReceptionDraft,
} from '../db/receptions';
import { listProducts, newId } from '../db/repo';
import { productLabel, referenceKey } from '../domain/classification';
import { ambiguousNumberHint, formatQty, parseCount, parseQty } from '../domain/money';
import { localDay } from '../domain/report';
import {
  CONTAINER_NOUN,
  MAX_WEIGHINGS,
  PACKAGINGS,
  PACKAGING_LABEL,
  WEIGHT_GLOSSARY,
  WEIGHT_MODES,
  computeNet,
  currentNetMilli,
  normalizeFields,
  validateFields,
  type ReceptionFields,
} from '../domain/reception';
import type { Packaging, Product, Reception, WeightMode } from '../domain/types';
import { errMsg, useApp } from './ctx';
import { dayLabel, fmtDateTime, localInputToIso, milliToText, toLocalInput } from './format';
import { NuevaVariedad } from './NuevaVariedad';
import { ProductChips } from './ProductChips';
import { Sheet } from './Sheet';

const LS_PACKAGING = `${BRAND.ns}.rec.packaging`;
const LS_MODE = (pk: Packaging) => `${BRAND.ns}.rec.mode.${pk}`;
/** Lo que se está capturando, para no perderlo si Android cierra la app en segundo plano. */
const FORM_KEY = `${BRAND.ns}.rec.form.v1`;

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* solo se pierde la comodidad de recordar */
  }
}
function lsRemove(k: string) {
  try {
    localStorage.removeItem(k);
  } catch {
    /* nada que quitar */
  }
}

/** Modo de peso natural de cada presentación: a granel se capturan kilos; cajas y arpillas se cuentan × lo que pesa cada una. */
const defaultMode = (pk: Packaging): WeightMode => (pk === 'granel' ? 'directo' : 'por_envase');
function rememberedMode(pk: Packaging): WeightMode {
  const m = lsGet(LS_MODE(pk)) as WeightMode | null;
  return m && WEIGHT_MODES.includes(m) && !(pk === 'granel' && m === 'por_envase') ? m : defaultMode(pk);
}

interface Snapshot {
  attemptId: string;
  productId: string;
  packaging: Packaging;
  mode: WeightMode;
  netText: string;
  useWeighings: boolean;
  weighings: number[];
  containersText: string;
  unitText: string;
  grossText: string;
  tareText: string;
  supplier: string;
  reference: string;
  notes: string;
  whenText: string;
  whenEdited: boolean;
}

const isStr = (x: unknown): x is string => typeof x === 'string' && x.length <= 600;

/** Lee el formulario guardado; si algo no cuadra con lo esperado se ignora completo (nunca se confía a ciegas). */
function readSnapshot(): Snapshot | null {
  const raw = lsGet(FORM_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Record<string, unknown>;
    const strings = ['netText', 'containersText', 'unitText', 'grossText', 'tareText', 'supplier', 'reference', 'notes', 'whenText'];
    const ok =
      isStr(s.attemptId) && s.attemptId.length > 0 && isStr(s.productId) &&
      PACKAGINGS.includes(s.packaging as Packaging) && WEIGHT_MODES.includes(s.mode as WeightMode) &&
      strings.every((k) => isStr(s[k])) &&
      typeof s.useWeighings === 'boolean' && typeof s.whenEdited === 'boolean' &&
      Array.isArray(s.weighings) && s.weighings.length <= MAX_WEIGHINGS;
    if (!ok) return null;
    // Una pesada ilegible (≤ 0 o no entera) no hace perder el resto de lo capturado: solo esa pesada se descarta.
    const weighings = (s.weighings as unknown[]).filter((n): n is number => Number.isSafeInteger(n) && (n as number) > 0);
    return { ...(s as unknown as Snapshot), weighings };
  } catch {
    return null;
  }
}

const hasContent = (s: Pick<Snapshot, 'netText' | 'weighings' | 'containersText' | 'unitText' | 'grossText' | 'tareText' | 'supplier' | 'reference' | 'notes'>) =>
  !!(s.netText || s.weighings.length || s.containersText || s.unitText || s.grossText || s.tareText || s.supplier || s.reference || s.notes);

/** '' → undefined (no capturado); texto ilegible o fuera de límites → NaN (se reporta como inválido). */
const numKg = (t: string): number | undefined => (t.trim() === '' ? undefined : (parseQty(t) ?? NaN));
const numCount = (t: string): number | undefined => (t.trim() === '' ? undefined : (parseCount(t) ?? NaN));

/** Qué decirle a la persona cuando lo que escribió no es un número usable (vacío = nada que decir). */
function numberProblem(text: string, kind: 'kg' | 'count', noun = 'piezas'): string {
  const t = text.trim();
  if (!t) return '';
  if (kind === 'count') {
    return parseCount(t) !== null ? '' : `No entiendo «${t}». Escribe solo un número entero de ${noun} (por ejemplo 40).`;
  }
  if (parseQty(t) !== null) return '';
  const ambiguous = ambiguousNumberHint(t);
  if (ambiguous) return ambiguous;
  if (/^\d+([.,]\d+)?$/.test(t)) return `«${t}» es demasiado grande (máximo 200,000 kg) o tiene demasiados decimales (máximo 3).`;
  return `No entiendo «${t}». Escribe solo el número; para decimales usa punto (por ejemplo 15.5).`;
}

interface Props {
  active: boolean;
  /** Borrador que se abrió desde la lista para completarlo. */
  loadDraft: Reception | null;
  onDraftLoaded: () => void;
  /** Lleva a la lista de borradores. */
  onGoDrafts?: () => void;
}

interface Warn {
  matches: Reception[];
  warnings: string[];
}

const kgOf = (n: number) => formatQty(n, 'kg');
/** Ventana en que un segundo toque tras una operación exitosa se ignora en silencio (la hoja ya se cerró; ver SHIELD_MS). */
const GHOST_MS = 700;

export function RecepcionNueva({ active, loadDraft, onDraftLoaded, onGoDrafts }: Props) {
  const { db, version, bump, toast } = useApp();
  const [snap0] = useState(readSnapshot);
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState(snap0?.productId ?? '');
  const [packaging, setPackaging] = useState<Packaging>(
    snap0?.packaging ?? (PACKAGINGS.includes(lsGet(LS_PACKAGING) as Packaging) ? (lsGet(LS_PACKAGING) as Packaging) : 'granel'),
  );
  const [mode, setMode] = useState<WeightMode>(() => snap0?.mode ?? rememberedMode(snap0?.packaging ?? ((lsGet(LS_PACKAGING) as Packaging) || 'granel')));
  const [netText, setNetText] = useState(snap0?.netText ?? '');
  const [useWeighings, setUseWeighings] = useState(snap0?.useWeighings ?? false);
  const [weighings, setWeighings] = useState<number[]>(snap0?.weighings ?? []);
  const [weighText, setWeighText] = useState('');
  const [containersText, setContainersText] = useState(snap0?.containersText ?? '');
  const [unitText, setUnitText] = useState(snap0?.unitText ?? '');
  const [grossText, setGrossText] = useState(snap0?.grossText ?? '');
  const [tareText, setTareText] = useState(snap0?.tareText ?? '');
  const [supplier, setSupplier] = useState(snap0?.supplier ?? '');
  const [reference, setReference] = useState(snap0?.reference ?? '');
  const [notes, setNotes] = useState(snap0?.notes ?? '');
  const whenEdited = useRef(snap0?.whenEdited ?? false);
  const [whenText, setWhenText] = useState(() => (snap0?.whenEdited ? snap0.whenText : toLocalInput(new Date())));
  const [lastUnit, setLastUnit] = useState<{ unitNetMilli: number; folio?: number } | undefined>();
  const [showNewClass, setShowNewClass] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [warn, setWarn] = useState<Warn>({ matches: [], warnings: [] });
  const [conflict, setConflict] = useState<Reception | null>(null);
  const [saving, setSaving] = useState(false);
  const [receptions, setReceptions] = useState<Reception[]>([]);
  const [restored, setRestored] = useState(!!snap0 && hasContent(snap0));
  const [clearArmed, setClearArmed] = useState(false);
  const [parked, setParked] = useState<string | null>(null);
  // Solo presentación: qué pasos terminados se ven cerrados en su línea resumen (1 = qué llegó, 3 = cuánto pesa) y si ya se
  // eligió a propósito la presentación. No toca ningún dato ni cálculo.
  const [folded, setFolded] = useState<{ 1: boolean; 3: boolean }>({ 1: !!snap0?.productId, 3: false });
  const [packTouched, setPackTouched] = useState(!!snap0 && hasContent(snap0));
  // Un id por intento de recepción: reintentar (doble toque, recarga) con el mismo id NO suma dos veces.
  const attemptId = useRef(snap0?.attemptId ?? newId());
  const firstInput = useRef<HTMLInputElement>(null);
  const weighInput = useRef<HTMLInputElement>(null);
  const productBlock = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  // Cuándo terminó la última operación buena: el segundo toque de un doble toque sobre «Guardar borrador» o «＋ Sumar» cae sobre
  // un formulario ya vacío y no debe regañar con un aviso rojo sobre algo que sí se hizo. (El de «Confirmar» lo absorbe el
  // escudo de la hoja: ver Sheet.tsx. «Registrar recepción» NO lleva esta guarda a propósito: un toque ahí siempre se explica.)
  const justDone = useRef({ what: '', at: 0 });
  const markDone = (what: 'weigh' | 'draft') => {
    justDone.current = { what, at: Date.now() };
  };
  const justNow = (what: 'weigh' | 'draft') => justDone.current.what === what && Date.now() - justDone.current.at < GHOST_MS;

  useEffect(() => {
    listProducts(db).then((all) => setProducts(all.filter((p) => p.active && p.unit === 'kg')));
    listReceptions(db).then(setReceptions);
  }, [db, version]);

  const selected = products.find((p) => p.id === productId) ?? undefined;
  // La última registrada se lee de la BASE (no de la memoria): sigue ahí aunque Android haya cerrado la app.
  const latest = useMemo(
    () => receptions.filter((r) => r.status === 'confirmada' && r.confirmedAt).sort((a, b) => b.confirmedAt!.localeCompare(a.confirmedAt!))[0],
    [receptions],
  );
  // Proveedores usados antes (los más recientes): un toque en vez de teclearlos. Nunca se inventa ninguno.
  const recentSuppliers = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of [...receptions].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))) {
      const k = referenceKey(r.supplier);
      if (!r.supplier || !k || seen.has(k)) continue;
      seen.add(k);
      out.push(r.supplier);
      if (out.length === 5) break;
    }
    return out;
  }, [receptions]);

  // Último peso por envase REAL que el usuario capturó para ESTA clasificación y presentación (nunca se inventa uno).
  useEffect(() => {
    if (packaging === 'granel' || !selected) return setLastUnit(undefined);
    let alive = true;
    lastUnitNet(db, packaging, selected.id).then((v) => alive && setLastUnit(v));
    return () => {
      alive = false;
    };
  }, [db, version, packaging, selected?.id]);

  useEffect(() => {
    if (!active) return;
    // La hora "ahora" del formulario no se queda vieja si no se tocó.
    if (!whenEdited.current) setWhenText(toLocalInput(new Date()));
  }, [active]);

  // ---- Campos y cálculo (la fuente de verdad del peso es siempre UN modo)
  const weighSum = weighings.reduce((a, b) => a + b, 0);
  const netDirect: number | undefined =
    mode === 'directo' && useWeighings ? (weighings.length ? weighSum : undefined) : numKg(netText);
  const fields: ReceptionFields & { id: string } = {
    ...normalizeFields({
      receivedAt: whenEdited.current ? localInputToIso(whenText) : undefined,
      supplier,
      reference,
      notes,
      productId: selected?.id,
      packaging,
      containers: numCount(containersText),
      weightMode: mode,
      netDirectMilli: netDirect,
      weighingsMilli: mode === 'directo' && useWeighings && weighings.length >= 2 ? weighings : undefined,
      unitNetMilli: numKg(unitText),
      grossMilli: numKg(grossText),
      tareMilli: numKg(tareText),
    }),
    id: attemptId.current,
  };
  const net = computeNet(fields);
  const confirmErrors = validateFields(fields, { forConfirm: true, product: selected ?? null });
  const draftErrors = validateFields(fields, { forConfirm: false });
  const noun = CONTAINER_NOUN[packaging];
  const receivedDate = fields.receivedAt && fields.receivedAt !== 'invalid' ? new Date(fields.receivedAt) : new Date();
  const receivedDay = localDay(receivedDate);
  const today = localDay();
  const content = {
    netText, weighings, containersText, unitText, grossText, tareText, supplier, reference, notes,
  };
  const touched = !!selected || hasContent(content);

  // Lo que escribió y no se pudo leer (coma ambigua, texto, demasiado grande...).
  const problem =
    (mode === 'directo' && !useWeighings ? numberProblem(netText, 'kg') : '') ||
    (mode === 'directo' && useWeighings ? numberProblem(weighText, 'kg') : '') ||
    (mode === 'por_envase' ? numberProblem(unitText, 'kg') : '') ||
    (mode === 'bruto_tara' ? numberProblem(grossText, 'kg') || numberProblem(tareText, 'kg') : '') ||
    numberProblem(containersText, 'count', noun.many);

  // ---- Autoguardado del formulario (si Android cierra la app, al volver sigue todo y con el MISMO id de intento)
  useEffect(() => {
    const t = window.setTimeout(() => {
      const snap: Snapshot = {
        attemptId: attemptId.current, productId, packaging, mode, netText, useWeighings, weighings, containersText,
        unitText, grossText, tareText, supplier, reference, notes, whenText, whenEdited: whenEdited.current,
      };
      if (hasContent(snap)) lsSet(FORM_KEY, JSON.stringify(snap));
      else lsRemove(FORM_KEY);
    }, 300);
    return () => window.clearTimeout(t);
  }, [productId, packaging, mode, netText, useWeighings, weighings, containersText, unitText, grossText, tareText, supplier, reference, notes, whenText]);

  function pickProduct(p: Product) {
    setProductId(p.id);
    // Elegido el producto, su paso se cierra en una línea («Chayote · Primera») que se toca para cambiarlo.
    setFolded((f) => ({ ...f, 1: true }));
  }
  function pickPackaging(pk: Packaging) {
    setPackTouched(true);
    setPackaging(pk);
    lsSet(LS_PACKAGING, pk);
    // El modo natural de la presentación (o el último que se usó con ella): a granel kilos; cajas/arpillas × lo que pesa cada una.
    setMode(rememberedMode(pk));
    if (pk === 'granel') setContainersText('');
  }
  function pickMode(m: WeightMode) {
    setMode(m);
    lsSet(LS_MODE(packaging), m);
  }

  function resetWeights() {
    setNetText('');
    setUseWeighings(false);
    setWeighings([]);
    setWeighText('');
    setContainersText('');
    setUnitText('');
    setGrossText('');
    setTareText('');
  }

  /** Deja el formulario listo para OTRA recepción: sin datos del lote anterior (el siguiente camión no hereda nada). */
  function resetAll(clearProduct = true) {
    resetWeights();
    setNotes('');
    setSupplier('');
    setReference('');
    whenEdited.current = false;
    setWhenText(toLocalInput(new Date()));
    setRestored(false);
    setClearArmed(false);
    setFolded({ 1: false, 3: false });
    setPackTouched(false);
    // La clasificación se elige SIEMPRE a propósito: lo más caro de equivocar no se hereda de la recepción anterior.
    if (clearProduct) setProductId('');
  }

  function setWhen(d: Date) {
    whenEdited.current = true;
    setWhenText(toLocalInput(d));
  }

  // Abrir un borrador guardado en el formulario. Si había una captura en curso, primero se estaciona como borrador.
  useEffect(() => {
    if (!loadDraft) return;
    (async () => {
      if (hasContent(content) && draftErrors.length === 0 && attemptId.current !== loadDraft.id) {
        try {
          await saveReceptionDraft(db, fields);
          toast('Tu captura anterior quedó guardada en Borradores');
          bump();
        } catch {
          /* si no se pudo estacionar, el formulario actual se reemplaza igual: el autoguardado ya no lo conserva */
        }
      }
      const f = receptionToFields(loadDraft);
      attemptId.current = loadDraft.id;
      setProductId(f.productId ?? '');
      setPackaging(f.packaging);
      setMode(f.weightMode);
      setNetText(f.weighingsMilli ? '' : milliToText(f.netDirectMilli));
      setUseWeighings(!!f.weighingsMilli);
      setWeighings(f.weighingsMilli ?? []);
      setContainersText(f.containers === undefined ? '' : String(f.containers));
      setUnitText(milliToText(f.unitNetMilli));
      setGrossText(milliToText(f.grossMilli));
      setTareText(milliToText(f.tareMilli));
      setSupplier(f.supplier ?? '');
      setReference(f.reference ?? '');
      setNotes(f.notes ?? '');
      setWhenText(toLocalInput(new Date(loadDraft.receivedAt)));
      whenEdited.current = true;
      setRestored(false);
      setFolded({ 1: !!f.productId, 3: false });
      setPackTouched(true);
      onDraftLoaded();
      toast('Borrador abierto: completa lo que falta');
    })();
  }, [loadDraft?.id]);

  // ---- Pesadas
  function addWeighing() {
    const w = parseQty(weighText);
    if (w === null || w <= 0) {
      if (!weighText.trim() && justNow('weigh')) return; // segundo toque de un doble toque sobre «＋ Sumar»
      return toast(numberProblem(weighText, 'kg') || 'Escribe los kilos de la pesada (mayor a cero)', 'error');
    }
    if (weighings.length >= MAX_WEIGHINGS) return toast(`Máximo ${MAX_WEIGHINGS} pesadas`, 'error');
    markDone('weigh');
    setWeighings([...weighings, w]);
    setWeighText('');
    weighInput.current?.focus();
  }
  function toggleWeighings() {
    if (!useWeighings) {
      const cur = parseQty(netText);
      setWeighings(cur ? [cur] : []);
      setNetText('');
      setUseWeighings(true);
    } else {
      setNetText(weighings.length ? milliToText(weighSum) : '');
      setWeighings([]);
      setWeighText('');
      setUseWeighings(false);
    }
  }

  /** Reconstruye "10 arpillas × 15 kg" para la hoja de confirmación. */
  function describe(): string {
    if (!net.ok) return '';
    if (mode === 'por_envase') {
      return `${fields.containers} ${fields.containers === 1 ? noun.one : noun.many} × ${kgOf(fields.unitNetMilli!)}`;
    }
    if (mode === 'bruto_tara') return `bruto ${kgOf(fields.grossMilli!)} − tara ${kgOf(fields.tareMilli!)}`;
    if (fields.weighingsMilli) return `${fields.weighingsMilli.length} pesadas: ${fields.weighingsMilli.map(kgOf).join(' + ')}`;
    return 'kilos netos capturados';
  }

  /** El botón nunca queda «muerto»: si falta algo, dice qué y lleva ahí. */
  function explainMissing() {
    const first = confirmErrors[0] ?? 'Revisa los datos';
    toast(first, 'error');
    if (!selected) productBlock.current?.scrollIntoView({ block: 'center' });
    else firstInput.current?.focus();
  }
  const onEnter = () => (confirmErrors.length === 0 ? openConfirm() : explainMissing());

  function finishAlready(rec: Reception) {
    attemptId.current = newId();
    resetAll();
    lsRemove(FORM_KEY);
    setConfirming(false);
    setConflict(null);
    setWarn({ matches: [], warnings: [] });
    bump();
    toast(`Esta recepción ya estaba registrada como R-${rec.folio} (${kgOf(currentNetMilli(rec))}). No se sumó otra vez.`);
  }

  async function openConfirm() {
    if (busy.current) return;
    if (confirmErrors.length > 0) return explainMissing();
    busy.current = true;
    try {
      // Todos los avisos (parecida a otra, conteo posterior, entrada manual igual) se muestran ANTES de tocar «Confirmar».
      const pre = await previewReceptionWarnings(db, fields);
      if (pre.already) {
        if (pre.already.same) return finishAlready(pre.already.reception);
        setConflict(pre.already.reception);
        setConfirming(true);
        return;
      }
      if (pre.errors.length > 0) return void toast(pre.errors[0], 'error');
      setConflict(null);
      setWarn({ matches: pre.matches, warnings: pre.warnings });
      setConfirming(true);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      busy.current = false;
    }
  }

  async function confirmWith(f: ReceptionFields & { id: string }, acknowledge: boolean) {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      let rec: Reception;
      let already = false;
      try {
        rec = await confirmReception(db, f, { acknowledgeDuplicate: acknowledge });
      } catch (e) {
        if (e instanceof DuplicateReceptionError) {
          rec = e.reception; // ya estaba registrada con este mismo contenido: éxito, sin sumar de nuevo
          already = true;
        } else if (e instanceof ReceptionIdConflictError) {
          setConflict(e.reception); // ya estaba registrada pero con OTROS datos: nunca se da por buena
          return;
        } else if (e instanceof PossibleDuplicateReceptionError) {
          setConflict(null);
          setWarn({ matches: e.matches, warnings: e.warnings });
          return; // la hoja sigue abierta: ahora pide reconocer los avisos
        } else throw e;
      }
      attemptId.current = newId();
      resetAll();
      lsRemove(FORM_KEY);
      setConfirming(false);
      setConflict(null);
      setWarn({ matches: [], warnings: [] });
      bump();
      toast(
        already
          ? `Esta recepción ya estaba registrada como R-${rec.folio} (${kgOf(currentNetMilli(rec))}). No se sumó otra vez.`
          : `Recepción R-${rec.folio} registrada: +${kgOf(currentNetMilli(rec))}`,
      );
    } catch (e) {
      setConfirming(false);
      const msg = e instanceof ReceptionValidationError ? e.message : errMsg(e);
      // Si ese borrador se descartó desde otra pantalla, el siguiente intento debe ser una recepción nueva.
      if (/cancelada|anulada/.test(msg)) attemptId.current = newId();
      toast(msg, 'error');
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  /** «Registrar lo escrito como una recepción NUEVA» cuando el mismo intento ya se había registrado con otros datos. */
  function registerAsNew() {
    const f = { ...fields, id: newId() };
    attemptId.current = f.id;
    setConflict(null);
    return confirmWith(f, false);
  }

  async function saveDraft() {
    if (busy.current) return;
    if (draftErrors.length > 0) {
      if (justNow('draft')) return; // doble toque: el borrador ya se guardó y el formulario quedó limpio
      return void toast(draftErrors[0], 'error');
    }
    busy.current = true;
    try {
      const d = await saveReceptionDraft(db, fields);
      markDone('draft');
      // Guardar un borrador = estacionar: el formulario queda limpio para atender lo siguiente.
      attemptId.current = newId();
      resetAll();
      lsRemove(FORM_KEY);
      setParked(new Date(d.updatedAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }));
      toast(`Borrador guardado${d.netMilli === undefined ? ' (aún sin peso neto)' : ''}: no suma al inventario`);
      bump();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      busy.current = false;
    }
  }

  function clearAll() {
    if (!clearArmed) {
      setClearArmed(true);
      window.setTimeout(() => setClearArmed(false), 3500);
      return;
    }
    attemptId.current = newId();
    resetAll();
    lsRemove(FORM_KEY);
    toast('Formulario limpio');
  }

  function sameTruck() {
    if (!latest) return;
    setSupplier(latest.supplier ?? '');
    setReference(latest.reference ?? '');
    setNotes(latest.notes ?? '');
    setWhen(new Date(latest.receivedAt));
    toast('Mismo camión: elige la siguiente clasificación y captura sus kilos');
  }

  // ---- Pasos (solo presentación: qué está hecho, cuál sigue y qué se ve cerrado en su línea resumen)
  const weightTyped = !!(netText || weighings.length || containersText || unitText || grossText || tareText);
  const done1 = !!selected;
  const done2 = done1 && (packTouched || weightTyped);
  // Un paso con algo ilegible o que no cuadra nunca cuenta como terminado: se queda abierto.
  const done3 = net.ok && !problem;
  const current = !done1 ? 1 : !done2 ? 2 : !done3 ? 3 : 4;
  const shut1 = folded[1] && done1;
  const shut3 = folded[3] && done3;
  const STEP_TITLE = ['', '¿Qué llegó?', '¿Cómo llegó?', '¿Cuánto pesa?', '¿De quién y cuándo?'];
  const nounCap = noun.many.charAt(0).toUpperCase() + noun.many.slice(1);
  const countText = fields.containers !== undefined ? `${fields.containers} ${fields.containers === 1 ? noun.one : noun.many}` : '';

  /** Detalle corto del peso para la barra y la línea resumen: «12 cajas», «10 cajas × 12.5 kg», «3 pesadas». */
  function weightDetail(): string {
    if (!net.ok) return '';
    if (mode === 'por_envase' || mode === 'bruto_tara') return [mode === 'bruto_tara' ? countText : '', describe()].filter(Boolean).join(' · ');
    const parts = [countText || (packaging === 'granel' ? PACKAGING_LABEL.granel : '')];
    if (fields.weighingsMilli) parts.push(`${fields.weighingsMilli.length} pesadas`);
    return parts.filter(Boolean).join(' · ');
  }

  // Resumen vivo de la barra: «Chayote · Primera · 12 cajas» sobre los kilos. Si falta algo, dice qué.
  const netHint = net.ok
    ? [selected ? productLabel(selected) : '', weightDetail()].filter(Boolean).join(' · ') || describe()
    : confirmErrors[0] ?? (net.missing ? net.error : `⚠ ${net.error}`);
  const avg =
    net.ok && mode !== 'por_envase' && fields.containers && fields.containers > 0
      ? Math.round(net.netMilli / fields.containers)
      : undefined;

  const dateNote =
    receivedDay !== today
      ? `Llegó ${dayLabel(receivedDay)}: se contará en ese día en el Resumen («Totales»); el inventario se suma ahora.`
      : !whenEdited.current && new Date().getHours() < 6
        ? 'Es de madrugada. Si el camión llegó anoche, toca «Ayer» y ajusta la hora.'
        : '';

  const enter = { onKeyDown: (e: KeyboardEvent) => e.key === 'Enter' && onEnter() };
  const available = selected ? selected.physicalMilli - selected.reservedMilli : 0;

  /** Tocar un campo de «¿De quién y cuándo?» con el peso ya completo cierra «¿Cuánto pesa?» en su línea («240 kg»). */
  function onLotClick(e: MouseEvent) {
    if (done3 && (e.target as HTMLElement).tagName === 'INPUT') setFolded((f) => (f[3] ? f : { ...f, 3: true }));
  }

  /** Encabezado de un paso. Terminado y plegable: es un botón que abre y cierra el paso (su línea resumen). */
  // Se llama como función (no como <Componente/>): así Preact no vuelve a montar el botón en cada tecla y el foco no se pierde.
  function stepHead(p: { n: 1 | 2 | 3 | 4; done: boolean; open?: boolean; foldable?: boolean; optional?: boolean; children?: ComponentChildren }) {
    const mark = (
      <span class={p.done ? 'rec-num done' : p.n === current ? 'rec-num now' : 'rec-num'}>
        {p.done ? '✓' : p.n}
      </span>
    );
    const title = (
      <span class="rec-q">
        {STEP_TITLE[p.n]}
        {p.optional && <small> (opcional)</small>}
      </span>
    );
    if (p.foldable && p.done) {
      return (
        <h3 class="rec-h">
          <button
            type="button"
            class={p.open ? 'rec-head open' : 'rec-head'}
            aria-expanded={!!p.open}
            aria-controls={`rec-step-${p.n}-body`}
            data-testid={`rec-step-${p.n}-sum`}
            onClick={() => setFolded((f) => ({ ...f, [p.n as 1 | 3]: !!p.open }))}
          >
            {mark}
            <span class="rec-head-txt">
              {title}
              {p.children && <span class="rec-ans">{p.children}</span>}
            </span>
            <span class="rec-edit">{p.open ? 'Cerrar' : 'Cambiar'}</span>
          </button>
        </h3>
      );
    }
    return (
      <h3 class="rec-h">
        <span class="rec-head static">
          {mark}
          <span class="rec-head-txt">
            {title}
            {p.children && <span class="rec-ans">{p.children}</span>}
          </span>
        </span>
      </h3>
    );
  }

  const selectedLine = selected && (
    <span data-testid="rec-selected">
      <strong>{productLabel(selected)}</strong>
      <span class="rec-ans-more">
        {' '}
        · en bodega ahora: {kgOf(selected.physicalMilli)}
        {selected.reservedMilli > 0 && ` (apartado por vales: ${kgOf(selected.reservedMilli)})`}
        {available < 0 && <span class="neg"> · ⚠ disponible negativo ({kgOf(available)}): esta recepción lo cubre</span>}
        {selected.priceCents === 0 && ' · sin precio todavía (ponle precio en Caja antes de venderlo)'}
      </span>
    </span>
  );

  return (
    <div data-testid="rec-nueva" class="rec">
      {restored && (
        <div class="notice" role="status" data-testid="rec-restored">
          Recuperé lo que estabas capturando. Revísalo antes de registrar.{' '}
          <button class="link" onClick={clearAll}>
            {clearArmed ? 'Toca otra vez para borrar' : 'Empezar de cero'}
          </button>
        </div>
      )}
      {parked && (
        <div class="notice" role="status" data-testid="rec-parked">
          Borrador guardado {parked}: NO suma al inventario.{' '}
          <button class="link" data-testid="rec-go-drafts" onClick={onGoDrafts}>
            Ver pendientes
          </button>
        </div>
      )}

      <div class="rec-progress" data-testid="rec-progress">
        <p aria-live="polite">
          <strong>Paso {current} de 4</strong> ·{' '}
          {current === 4 ? 'Ya puedes registrar. Lo de abajo es opcional.' : STEP_TITLE[current]}
        </p>
        <div class="rec-bar" aria-hidden="true">
          {[1, 2, 3, 4].map((n) => (
            <span key={n} class={(n === 1 ? done1 : n === 2 ? done2 : n === 3 ? done3 : false) ? 'on' : n === current ? 'now' : ''} />
          ))}
        </div>
      </div>

      <section class={`rec-step${current === 1 ? ' cur' : ''}`} ref={productBlock}>
        {stepHead({ n: 1, done: done1, open: !shut1, foldable: true, children: selectedLine })}
        <div id="rec-step-1-body" class="rec-body" hidden={shut1}>
          {products.length === 0 ? (
            <div class="rec-empty" data-testid="rec-sin-productos">
              <p class="rec-empty-title">Agrega tu primer producto</p>
              <p class="hint">
                Para recibir mercancía primero da de alta lo que vendes (se recibe por kilo). El precio puede quedar «Sin precio
                todavía».
              </p>
            </div>
          ) : (
            <>
              {!selected && !touched && (
                <p class="hint" data-testid="rec-pick-hint">
                  Toca el producto que llegó.
                </p>
              )}
              <div class="rec-products">
                <ProductChips
                  products={products}
                  selectedId={selected?.id}
                  onSelect={pickProduct}
                  onClear={() => setProductId('')}
                  testids={{ variety: 'rec-variety', cls: 'rec-class' }}
                  allowEmpty
                  requireClass
                />
              </div>
            </>
          )}
        </div>
        <button
          class={products.length === 0 ? 'primary rec-first' : 'link rec-newprod'}
          data-testid="rec-new-class-toggle"
          onClick={() => setShowNewClass(true)}
        >
          {products.length === 0 ? '＋ Agregar mi primer producto' : '＋ ¿No está? Agregar producto nuevo'}
        </button>
      </section>

      <section class={`rec-step${current === 2 ? ' cur' : ''}`}>
        {stepHead({ n: 2, done: done2 })}
        <div class="chips rec-seg" role="group" aria-label="Presentación: cómo llegó">
          {PACKAGINGS.map((pk) => (
            <button
              type="button"
              key={pk}
              role="radio"
              aria-checked={packaging === pk}
              class={packaging === pk ? 'chip active' : 'chip'}
              data-testid={`rec-pack-${pk}`}
              onClick={() => pickPackaging(pk)}
            >
              {PACKAGING_LABEL[pk]}
            </button>
          ))}
        </div>
      </section>

      <section class={`rec-step${current === 3 ? ' cur' : ''}`}>
        {stepHead({
          n: 3,
          done: done3,
          open: !shut3,
          foldable: true,
          children: done3 && (
            <>
              <strong>{kgOf(net.netMilli)}</strong>
              {weightDetail() && ` · ${weightDetail()}`}
            </>
          ),
        })}
        <div id="rec-step-3-body" class="rec-body" hidden={shut3}>
          <div class="rec-modes" role="group" aria-label="Cómo capturar el peso">
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'directo'}
              class={mode === 'directo' ? 'chip rec-mode-main active' : 'chip rec-mode-main'}
              data-testid="rec-mode-directo"
              onClick={() => pickMode('directo')}
            >
              Ya tengo los kilos netos
            </button>
            <p class="rec-alt-q">
              {packaging === 'granel' ? '¿Lo pesaste con todo y envase?' : `¿Quieres pesar ${noun.one} por ${noun.one}, o con todo y envase?`}
            </p>
            <div class="rec-alt">
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'por_envase'}
                disabled={packaging === 'granel'}
                hidden={packaging === 'granel'}
                class={mode === 'por_envase' ? 'chip active' : 'chip'}
                data-testid="rec-mode-por_envase"
                onClick={() => pickMode('por_envase')}
              >
                {nounCap} × kilos de cada una
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'bruto_tara'}
                class={mode === 'bruto_tara' ? 'chip active' : 'chip'}
                data-testid="rec-mode-bruto_tara"
                onClick={() => pickMode('bruto_tara')}
              >
                Bruto − tara
              </button>
            </div>
            {mode !== 'bruto_tara' && <p class="rec-gloss">{WEIGHT_GLOSSARY}</p>}
          </div>
          <p class="help" data-testid="rec-mode-help">
            {mode === 'directo'
              ? 'Escribe los kilos de mercancía (sin caja ni costal). Si pesaste por partes, usa «Sumar varias pesadas».'
              : mode === 'por_envase'
                ? `Cuenta las ${noun.many} y escribe cuánto pesa (solo la mercancía) cada una. La app no supone ese peso.`
                : WEIGHT_GLOSSARY}
          </p>

          {mode === 'directo' && !useWeighings && (
            <label class="field rec-big">
              <span>Kilos netos recibidos</span>
              <input
                ref={firstInput}
                data-testid="rec-net-direct"
                inputMode="decimal"
                autoComplete="off"
                enterKeyHint="go"
                placeholder="0"
                value={netText}
                {...enter}
                onInput={(e) => setNetText((e.target as HTMLInputElement).value)}
              />
            </label>
          )}
          {mode === 'directo' && useWeighings && (
            <div data-testid="rec-weigh">
              <div class="row2 weigh-add">
                <label class="field">
                  <span>Kilos de esta pesada</span>
                  <input
                    ref={weighInput}
                    data-testid="rec-weigh-input"
                    inputMode="decimal"
                    autoComplete="off"
                    enterKeyHint="done"
                    placeholder="0"
                    value={weighText}
                    onInput={(e) => setWeighText((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => e.key === 'Enter' && addWeighing()}
                  />
                </label>
                <button class="primary add-weigh" data-testid="rec-weigh-add" onClick={addWeighing}>
                  ＋ Sumar
                </button>
              </div>
              <ul class="plain weigh-list">
                {weighings.map((w, i) => (
                  <li key={i} data-testid="rec-weigh-item">
                    <span>
                      Pesada {i + 1}: <strong>{kgOf(w)}</strong>
                    </span>
                    <button
                      class="small"
                      data-testid="rec-weigh-remove"
                      aria-label={`Quitar la pesada ${i + 1}`}
                      onClick={() => setWeighings(weighings.filter((_, k) => k !== i))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              <p class="hint" data-testid="rec-weigh-total">
                {weighings.length} {weighings.length === 1 ? 'pesada' : 'pesadas'} = {kgOf(weighSum)}
              </p>
            </div>
          )}
          {mode === 'directo' && (
            <button class="link" data-testid="rec-weigh-toggle" onClick={toggleWeighings}>
              {useWeighings ? 'Capturar un solo total' : 'Sumar varias pesadas'}
            </button>
          )}

          {mode === 'por_envase' && (
            <div class="row2">
              <label class="field rec-big">
                <span>¿Cuántas {noun.many}?</span>
                <input
                  ref={firstInput}
                  data-testid="rec-containers"
                  inputMode="numeric"
                  autoComplete="off"
                  enterKeyHint="next"
                  placeholder="0"
                  value={containersText}
                  onInput={(e) => setContainersText((e.target as HTMLInputElement).value)}
                />
              </label>
              <label class="field rec-big">
                <span>Kilos netos por {noun.one}</span>
                <input
                  data-testid="rec-unit-net"
                  inputMode="decimal"
                  autoComplete="off"
                  enterKeyHint="go"
                  placeholder="0"
                  value={unitText}
                  {...enter}
                  onInput={(e) => setUnitText((e.target as HTMLInputElement).value)}
                />
              </label>
            </div>
          )}
          {mode === 'por_envase' && lastUnit !== undefined && unitText.trim() === '' && (
            <button class="chip" data-testid="rec-use-last" onClick={() => setUnitText(milliToText(lastUnit.unitNetMilli))}>
              Usar {kgOf(lastUnit.unitNetMilli)} por {noun.one}
              {lastUnit.folio !== undefined && ` (lo que capturaste en R-${lastUnit.folio})`}
            </button>
          )}
          {mode === 'bruto_tara' && (
            <div class="row2">
              <label class="field rec-big">
                <span>Peso bruto (kg)</span>
                <input
                  ref={firstInput}
                  data-testid="rec-gross"
                  inputMode="decimal"
                  autoComplete="off"
                  enterKeyHint="next"
                  placeholder="0"
                  value={grossText}
                  onInput={(e) => setGrossText((e.target as HTMLInputElement).value)}
                />
              </label>
              <label class="field rec-big">
                <span>Tara (kg)</span>
                <input
                  data-testid="rec-tare"
                  inputMode="decimal"
                  autoComplete="off"
                  enterKeyHint="go"
                  placeholder="0"
                  value={tareText}
                  {...enter}
                  onInput={(e) => setTareText((e.target as HTMLInputElement).value)}
                />
              </label>
            </div>
          )}
          {mode !== 'por_envase' && packaging !== 'granel' && (
            <label class="field">
              <span>¿Cuántas {noun.many}? (opcional, solo para llevar la cuenta)</span>
              <input
                data-testid="rec-containers"
                inputMode="numeric"
                autoComplete="off"
                value={containersText}
                onInput={(e) => setContainersText((e.target as HTMLInputElement).value)}
              />
            </label>
          )}
          {problem && (
            <p class="notice" role="alert" data-testid="rec-input-problem">
              {problem}
            </p>
          )}
          {avg !== undefined && (
            <p class="hint" data-testid="rec-avg">
              Eso da {kgOf(avg)} por {noun.one} (promedio, solo informativo).
            </p>
          )}
        </div>
      </section>

      <section class={`rec-step${current === 4 ? ' cur' : ''}`} onClick={onLotClick}>
        {stepHead({ n: 4, done: false, optional: true })}
        <label class="field">
          <span>¿Quién lo manda?</span>
          <input data-testid="rec-supplier" autoComplete="off" autoCapitalize="words" value={supplier} onInput={(e) => setSupplier((e.target as HTMLInputElement).value)} />
        </label>
        {recentSuppliers.length > 0 && (
          <div class="chips small" role="group" aria-label="Quién lo mandó antes" data-testid="rec-supplier-chips">
            {recentSuppliers.map((s) => (
              <button type="button" key={s} class={referenceKey(s) === referenceKey(supplier) ? 'chip active' : 'chip'} data-testid="rec-supplier-chip" onClick={() => setSupplier(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        <label class="field">
          <span>Camión / nota</span>
          <input data-testid="rec-reference" autoComplete="off" autoCapitalize="characters" value={reference} onInput={(e) => setReference((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span>Fecha y hora de llegada</span>
          <input
            type="datetime-local"
            data-testid="rec-datetime"
            max={toLocalInput(new Date())}
            value={whenText}
            onInput={(e) => {
              whenEdited.current = true;
              setWhenText((e.target as HTMLInputElement).value);
            }}
          />
        </label>
        <div class="chips small" role="group" aria-label="Atajos de fecha">
          <button type="button" class="chip" data-testid="rec-date-now" onClick={() => ((whenEdited.current = false), setWhenText(toLocalInput(new Date())))}>
            Ahora
          </button>
          <button type="button" class="chip" data-testid="rec-date-yesterday" onClick={() => setWhen(new Date(Date.now() - 24 * 3600 * 1000))}>
            Ayer
          </button>
        </div>
        {dateNote && (
          <p class="hint" data-testid="rec-date-hint">
            {dateNote}
          </p>
        )}
        <label class="field">
          <span>Observaciones</span>
          <input data-testid="rec-notes" autoComplete="off" value={notes} onInput={(e) => setNotes((e.target as HTMLInputElement).value)} />
        </label>
      </section>

      {touched && confirmErrors.length > 0 && (
        <div class="notice" data-testid="rec-missing">
          Para registrar falta:
          <ul>
            {confirmErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div class="actions two">
        <button data-testid="rec-save-draft" aria-disabled={draftErrors.length > 0} onClick={saveDraft}>
          Guardar para después
        </button>
        <button data-testid="rec-clear" onClick={clearAll}>
          {clearArmed ? 'Toca otra vez' : 'Limpiar'}
        </button>
      </div>
      <p class="hint" data-testid="rec-draft-hint">
        {draftErrors.length > 0 && touched
          ? `Para guardar un borrador: ${draftErrors[0].replace(/^El borrador está vacío: /, '').toLowerCase()}`
          : '«Guardar para después» la deja en «Pendientes» como borrador y NO suma al inventario (por ejemplo, si aún no tienes el peso). Para sumar toca «Registrar entrada».'}
      </p>
      {latest && (
        <div class="last" data-testid="rec-last">
          Última registrada: R-{latest.folio} · {latest.productLabel} · {kgOf(currentNetMilli(latest))} · {fmtDateTime(latest.confirmedAt!)}
          <div class="actions">
            <button class="small" data-testid="rec-same-truck" onClick={sameTruck}>
              ＋ Otro producto del mismo camión
            </button>
          </div>
        </div>
      )}

      <div class="dock rec-dock" data-testid="rec-dock">
        <div class="dock-net">
          <strong data-testid="rec-net" data-milli={net.ok ? net.netMilli : ''}>
            {net.ok ? kgOf(net.netMilli) : '—'}
          </strong>
          <small data-testid="rec-net-hint" class={net.ok || net.missing || confirmErrors.length ? '' : 'warn'}>
            {netHint}
          </small>
        </div>
        <button class="confirm" data-testid="rec-confirm" aria-disabled={confirmErrors.length > 0 || saving} onClick={openConfirm}>
          Registrar entrada
        </button>
      </div>

      {showNewClass && (
        <Sheet
          title="Nuevo producto"
          testid="rec-newclass-sheet"
          onClose={() => setShowNewClass(false)}
          foot={
            <div class="actions">
              <button data-testid="rec-newclass-close" onClick={() => setShowNewClass(false)}>
                Cerrar
              </button>
            </div>
          }
        >
          <p class="hint">Se vende por kilo. El precio puede quedar «Sin precio todavía»: no hace falta para recibir.</p>
          <NuevaVariedad
            idPrefix="recnew"
            fixedUnit="kg"
            defaultNoPrice
            onSaved={(p) => {
              pickProduct(p);
              setShowNewClass(false);
            }}
          />
        </Sheet>
      )}

      {confirming && selected && net.ok && (
        <Sheet
          title={conflict ? 'Esa captura ya se había registrado' : 'Confirmar entrada'}
          testid="rec-sheet"
          onClose={saving ? undefined : () => (setConfirming(false), setConflict(null))}
          foot={
            conflict ? (
              <div class="actions two">
                <button data-testid="rec-confirm-no" disabled={saving} onClick={() => (setConfirming(false), setConflict(null))}>
                  Volver
                </button>
                <button class="primary" data-testid="rec-conflict-new" disabled={saving} onClick={registerAsNew}>
                  {saving ? 'Guardando…' : 'Registrar lo escrito como nueva'}
                </button>
              </div>
            ) : (
              <div class="actions two">
                <button data-testid="rec-confirm-no" disabled={saving} onClick={() => setConfirming(false)}>
                  Volver
                </button>
                {warn.warnings.length > 0 ? (
                  <button class="danger" data-testid="rec-dup-ack" disabled={saving} onClick={() => confirmWith(fields, true)}>
                    {saving ? 'Guardando…' : 'Registrar de todos modos'}
                  </button>
                ) : (
                  <button class="primary" data-testid="rec-confirm-yes" disabled={saving} onClick={() => confirmWith(fields, false)}>
                    {saving ? 'Guardando…' : 'Confirmar'}
                  </button>
                )}
              </div>
            )
          }
        >
          {conflict ? (
            <div data-testid="rec-conflict">
              <p class="notice" role="alert">
                Este intento ya se registró como <strong>R-{conflict.folio}</strong> ({kgOf(currentNetMilli(conflict))} · {conflict.productLabel}), y
                lo que tienes escrito es distinto ({kgOf(net.netMilli)} · {productLabel(selected)}). R-{conflict.folio} se queda como está.
              </p>
              <p class="hint">Si lo que escribiste es otra entrega, regístrala como nueva.</p>
            </div>
          ) : (
            <>
              <p class="sum-line" data-testid="rec-sheet-product">
                {productLabel(selected)}
              </p>
              <p class="sum-total" data-testid="rec-sheet-net" data-milli={net.netMilli}>
                +{kgOf(net.netMilli)}
              </p>
              <p data-testid="rec-sheet-detail">
                {PACKAGING_LABEL[packaging]}
                {fields.containers !== undefined && ` · ${fields.containers} ${fields.containers === 1 ? noun.one : noun.many}`} · {describe()}
              </p>
              {avg !== undefined && (
                <p class="hint" data-testid="rec-sheet-avg">
                  Promedio: {kgOf(avg)} por {noun.one} (informativo).
                </p>
              )}
              <p data-testid="rec-sheet-stock">
                En bodega: <span class={selected.physicalMilli < 0 ? 'neg' : ''}>{kgOf(selected.physicalMilli)}</span> →{' '}
                <strong>{kgOf(selected.physicalMilli + net.netMilli)}</strong>
                {selected.reservedMilli > 0 && (
                  <>
                    {' '}
                    · Disponible: <span class={available < 0 ? 'neg' : ''}>{kgOf(available)}</span> → <strong>{kgOf(available + net.netMilli)}</strong>
                  </>
                )}
              </p>
              {available < 0 && (
                <p class="hint" data-testid="rec-sheet-covers">
                  Hoy hay {kgOf(-available)} vendidos o apartados sin existencia: esta recepción los cubre.
                </p>
              )}
              {(fields.supplier || fields.reference) && (
                <p class="hint">{[fields.supplier && `Lo manda: ${fields.supplier}`, fields.reference && `Camión / nota: ${fields.reference}`].filter(Boolean).join(' · ')}</p>
              )}
              <p class="hint">Llegó: {fmtDateTime(receivedDate.toISOString())}</p>
              {receivedDay !== today && (
                <p class="notice" data-testid="rec-sheet-old">
                  La llegada es de {dayLabel(receivedDay)}: se contará en ese día en el Resumen, pero el inventario se suma ahora.
                </p>
              )}
              <p class="rec-sheet-note">Esto sumará los kilos al inventario una sola vez. No es un pago al proveedor.</p>
              {warn.warnings.length > 0 && (
                <div class="notice" role="alert" data-testid="rec-dup-warning">
                  Revisa antes de registrar:
                  <ul>
                    {warn.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </Sheet>
      )}
    </div>
  );
}
