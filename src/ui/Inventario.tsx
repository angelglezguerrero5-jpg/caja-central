import { useEffect, useRef, useState } from 'preact/hooks';
import {
  ManualEntryWarningError,
  NegativeStockError,
  addStockMove,
  availableMilli,
  listProducts,
  listStockMoves,
  setProductActive,
} from '../db/repo';
import { listReceptions } from '../db/receptions';
import { productLabel } from '../domain/classification';
import { movementTotals } from '../domain/mercancia';
import { ambiguousNumberHint, formatMoney, formatQty, parseQty } from '../domain/money';
import type { Product, StockMove } from '../domain/types';
import { errMsg, useApp } from './ctx';
import { Fletes } from './Fletes';
import { fmtDateTime } from './format';
import { NuevaVariedad } from './NuevaVariedad';
import { AuthorizeSheet, WarningsSheet } from './Sheet';
import './inventario.css';

type MoveKind = 'entrada' | 'merma' | 'ajuste';
/** Botones de acción de cada tarjeta: lo que pasó con la mercancía, en palabras del puesto. */
const KIND_BUTTON: Record<MoveKind, string> = {
  entrada: '＋ Entró',
  merma: '− Merma',
  ajuste: 'Contar',
};
/** Título del formulario que abre cada botón (explica en una línea para qué sirve). */
const KIND_TITLE: Record<MoveKind, string> = {
  entrada: '＋ Entró mercancía',
  merma: '− Merma: se echó a perder o se perdió',
  ajuste: 'Contar: escribe lo que hay de verdad',
};

/**
 * Umbral de «Poco»: menos de 10 unidades disponibles de la medida del producto (10 kg, 10 cajas, 10 piezas…). Es solo un
 * aviso visual de la tarjeta; no frena ventas ni movimientos.
 */
const LOW_STOCK_MILLI = 10_000;
type StockStatus = 'ok' | 'poco' | 'agotado' | 'negativo';
const STATUS_LABEL: Record<StockStatus, string> = {
  ok: 'Disponible',
  poco: 'Poco',
  agotado: 'Agotado',
  negativo: 'Negativo',
};
/** Estado según lo DISPONIBLE (en bodega − apartado en vales), que es lo que se puede vender. */
function stockStatus(p: Product): StockStatus {
  const a = availableMilli(p);
  if (a < 0) return 'negativo';
  if (a === 0) return 'agotado';
  return a < LOW_STOCK_MILLI ? 'poco' : 'ok';
}

/** Nombres para los avisos de arriba: los primeros tres y «y N más», para que el aviso no crezca sin fin. */
function someNames(list: Product[]): string {
  const names = list.slice(0, 3).map(productLabel);
  return list.length > 3 ? `${names.join(', ')} y ${list.length - 3} más` : names.join(', ');
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Encabezado informativo: cuánto hay en bodega (kilos; las otras medidas aparte, porque no se suman con kilos) y qué
 * productos piden atención. No cambia nada: solo resume lo que ya dicen las tarjetas.
 */
function Resumen({ products }: { products: Product[] }) {
  const byUnit = new Map<Product['unit'], number>();
  for (const p of products) byUnit.set(p.unit, (byUnit.get(p.unit) ?? 0) + p.physicalMilli);
  // Kilos primero; cajas, piezas y arpillas no se suman con kilos y se muestran aparte.
  const [main, ...rest] = [...byUnit]
    .sort(([a], [b]) => (a === 'kg' ? -1 : b === 'kg' ? 1 : 0))
    .map(([u, m]) => formatQty(m, u));
  const agotados = products.filter((p) => p.active && stockStatus(p) === 'agotado');
  const negativos = products.filter((p) => stockStatus(p) === 'negativo');
  const apartados = products.filter((p) => p.reservedMilli > 0);
  return (
    <div class="inv-summary" data-testid="inv-summary">
      <div class="inv-total">
        <span class="inv-total-label">Total en bodega</span>
        <span class="inv-total-qty" data-testid="inv-total">
          {main}
        </span>
        {rest.length > 0 && (
          <span class="inv-total-more" data-testid="inv-total-other">
            y además {rest.join(' · ')}
          </span>
        )}
      </div>
      {(agotados.length > 0 || negativos.length > 0 || apartados.length > 0) && (
        <ul class="inv-alerts" aria-label="Avisos de inventario">
          {negativos.length > 0 && (
            <li class="inv-alert neg" data-testid="inv-alert-negativo">
              <span class="inv-dot" aria-hidden="true" />
              <span>
                {plural(negativos.length, 'producto', 'productos')} con existencia negativa (autorizada): {someNames(negativos)}
              </span>
            </li>
          )}
          {agotados.length > 0 && (
            <li class="inv-alert out" data-testid="inv-alert-agotado">
              <span class="inv-dot" aria-hidden="true" />
              <span>
                {plural(agotados.length, 'producto agotado', 'productos agotados')}: {someNames(agotados)}
              </span>
            </li>
          )}
          {apartados.length > 0 && (
            <li class="inv-alert res" data-testid="inv-alert-reservado">
              <span class="inv-dot" aria-hidden="true" />
              <span>
                {plural(apartados.length, 'producto', 'productos')} con mercancía apartada por vales:{' '}
                {apartados
                  .slice(0, 3)
                  .map((p) => `${productLabel(p)} (${formatQty(p.reservedMilli, p.unit)})`)
                  .join(', ')}
                {apartados.length > 3 && ` y ${apartados.length - 3} más`}
              </span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
/** Movimientos que se muestran de entrada en «Movimientos»; «Ver más» agrega otra tanda. */
const MOVES_PAGE = 15;
/** Aviso de éxito de cada tipo de movimiento. */
const KIND_DONE: Record<MoveKind, string> = {
  entrada: 'Entrada manual registrada',
  merma: 'Merma registrada',
  ajuste: 'Conteo físico registrado',
};

/** Nombre de cada tipo de movimiento en el historial (en minúsculas, como lista corrida). */
const MOVE_LABEL: Record<StockMove['type'], string> = {
  entrada: 'entrada manual',
  merma: 'merma',
  ajuste: 'conteo físico (ajuste)',
  venta: 'venta',
  reserva: 'reserva por vale',
  entrega_vale: 'entrega de vale',
  anulacion: 'anulación',
  recepcion: 'recepción de mercancía',
  correccion_recepcion: 'corrección de recepción',
  reversa_recepcion: 'recepción anulada',
};

function Existencias() {
  const { db, version, bump, toast } = useApp();
  const [products, setProducts] = useState<Product[]>([]);
  const [totals, setTotals] = useState<Record<string, ReturnType<typeof movementTotals>>>({});
  const [moving, setMoving] = useState<{ p: Product; kind: MoveKind } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [qtyText, setQtyText] = useState('');
  const [note, setNote] = useState('');
  // Guarda contra doble pulsación: el estado de React llega tarde, la referencia es inmediata.
  const submitting = useRef(false);
  const [auth, setAuth] = useState<{ error: NegativeStockError; run: () => Promise<void> } | null>(null);
  const [warning, setWarning] = useState<{ warnings: string[]; run: () => Promise<void> } | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [history, setHistory] = useState<{
    id: string;
    moves: StockMove[];
    folios: Record<string, number | undefined>;
    shown: number;
  } | null>(null);

  useEffect(() => {
    (async () => {
      const [list, moves] = await Promise.all([listProducts(db), db.getAll('stockMoves')]);
      setProducts(list);
      const by: Record<string, StockMove[]> = {};
      for (const m of moves) (by[m.productId] ??= []).push(m);
      setTotals(Object.fromEntries(Object.entries(by).map(([id, ms]) => [id, movementTotals(ms)])));
    })();
  }, [db, version]);

  /**
   * Registra el movimiento. Puede pedir DOS cosas, en cualquier orden y encadenadas: autorización de existencia negativa
   * (con el disponible que se le muestra a la persona como piso) y reconocer el aviso de «ya se recibió en Recepción».
   */
  async function submitMove() {
    if (!moving || submitting.current) return;
    const q = parseQty(qtyText) ?? (moving.kind === 'ajuste' && qtyText.trim() === '0' ? 0 : null);
    if (q === null) {
      return toast(ambiguousNumberHint(qtyText) || 'Escribe cuántos kilos (más de cero); para decimales usa punto, por ejemplo 15.5', 'error');
    }
    const { p, kind } = moving;
    const done = () => {
      toast(`${KIND_DONE[kind]}`);
      setMoving(null);
      setQtyText('');
      setNote('');
      setAuth(null);
      setWarning(null);
      bump();
    };
    const attempt = async (allow: boolean | number, ack: boolean): Promise<void> => {
      try {
        await addStockMove(db, p.id, kind, q, note, allow, ack);
        done();
      } catch (e) {
        setAuth(null);
        setWarning(null);
        if (e instanceof NegativeStockError) {
          setAuth({ error: e, run: () => attempt(e.availableAfterMilli, ack) });
        } else if (e instanceof ManualEntryWarningError) {
          setWarning({ warnings: [e.message], run: () => attempt(allow, true) });
        } else toast(errMsg(e), 'error');
      }
    };
    submitting.current = true;
    try {
      await attempt(false, false);
    } finally {
      submitting.current = false;
    }
  }

  async function runPending(kind: 'auth' | 'warning') {
    const pending = kind === 'auth' ? auth : warning;
    if (!pending || submitting.current) return;
    submitting.current = true;
    setAuthBusy(true);
    try {
      await pending.run();
    } catch (e) {
      setAuth(null);
      setWarning(null);
      toast(errMsg(e), 'error');
    } finally {
      submitting.current = false;
      setAuthBusy(false);
    }
  }

  async function toggle(p: Product) {
    try {
      await setProductActive(db, p.id, !p.active);
      bump();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }

  async function toggleHistory(p: Product) {
    if (history?.id === p.id) return setHistory(null);
    // Se traen todos (ya vienen del más nuevo al más viejo) y se muestran por tandas: nunca se recorta en silencio.
    const [moves, recs] = await Promise.all([listStockMoves(db, p.id, Number.MAX_SAFE_INTEGER), listReceptions(db)]);
    setHistory({ id: p.id, moves, folios: Object.fromEntries(recs.map((r) => [r.id, r.folio])), shown: MOVES_PAGE });
  }

  /** Abrir o cancelar un movimiento empieza siempre en blanco: lo escrito en uno no pasa a otro producto. */
  function startMove(p: Product, kind: MoveKind) {
    setQtyText('');
    setNote('');
    setMoving({ p, kind });
  }
  function cancelMove() {
    setQtyText('');
    setNote('');
    setMoving(null);
  }

  return (
    <section data-testid="inventario" class="inv">
      <h2>Inventario por producto</h2>
      {products.length > 0 && <Resumen products={products} />}
      <p class="help" data-testid="inv-glossary">
        En bodega = lo que hay físicamente · Apartado = pagado en vales por entregar · Disponible = lo que se puede vender.
      </p>
      {products.length === 0 && <p class="empty">Aún no hay productos. Agrégalos abajo.</p>}
      {products.map((p) => {
        const t = totals[p.id];
        const status = stockStatus(p);
        const open = moving?.p.id === p.id ? moving.kind : null;
        return (
          <article
            class={`card inv-card is-${status}${p.active ? '' : ' inactive'}`}
            key={p.id}
            data-testid="inv-row"
            data-status={status}
          >
            <header>
              <strong>{productLabel(p)}</strong>
              <span>{p.priceCents > 0 ? `${formatMoney(p.priceCents)}/${p.unit}` : 'Sin precio'}</span>
            </header>
            <div class="inv-hero">
              <div class="inv-hero-main">
                <span class="inv-hero-label">Disponible para vender</span>
                <span data-testid="stock-available" class={availableMilli(p) < 0 ? 'inv-hero-qty neg' : 'inv-hero-qty'}>
                  {formatQty(availableMilli(p), p.unit)}
                </span>
              </div>
              <span class={`inv-status s-${status}`} data-testid="inv-status">
                {STATUS_LABEL[status]}
              </span>
            </div>
            <dl class="stock inv-split">
              <div>
                <dt>En bodega</dt>
                <dd data-testid="stock-physical">{formatQty(p.physicalMilli, p.unit)}</dd>
              </div>
              <div>
                <dt>Apartado en vales</dt>
                <dd data-testid="stock-reserved">{formatQty(p.reservedMilli, p.unit)}</dd>
              </div>
            </dl>
            {availableMilli(p) < 0 && (
              <p class="warn" data-testid="stock-negative">
                ⚠ Quedan {formatQty(availableMilli(p), p.unit)}: se vendió o apartó más de lo que hay. Regularízalo con una recepción
                o un conteo físico.
              </p>
            )}
            <div class="inv-moves" role="group" aria-label={`Registrar movimiento de ${productLabel(p)}`}>
              {(['entrada', 'merma', 'ajuste'] as MoveKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  class={open === k ? `inv-move m-${k} active` : `inv-move m-${k}`}
                  aria-pressed={open === k}
                  data-testid={`move-${k}`}
                  onClick={() => startMove(p, k)}
                >
                  {KIND_BUTTON[k]}
                </button>
              ))}
            </div>
            {open && (
              <div class={`inline-form inv-form f-${open}`} data-testid="move-form">
                <p class="inv-form-title">{KIND_TITLE[open]}</p>
                <label class="field">
                  <span>
                    {open === 'ajuste' ? 'Existencia real contada' : 'Cantidad'} ({p.unit})
                  </span>
                  <input
                    data-testid="move-qty"
                    inputMode="decimal"
                    autoComplete="off"
                    value={qtyText}
                    onInput={(e) => setQtyText((e.target as HTMLInputElement).value)}
                  />
                </label>
                {open === 'entrada' && (
                  <p class="hint" data-testid="move-entrada-hint">
                    Úsala para el inventario inicial o mercancía que no viene de un proveedor. Si llegó mercancía de un proveedor,
                    regístrala en Recepción: así queda con fecha, camión y peso.
                  </p>
                )}
                {open === 'ajuste' && (
                  <p class="hint">
                    Ahora dice {formatQty(p.physicalMilli, p.unit)} en bodega. La app guarda la diferencia con lo que cuentes.
                  </p>
                )}
                <label class="field">
                  <span>{open === 'entrada' ? 'Nota (opcional)' : 'Motivo (obligatorio)'}</span>
                  <input
                    data-testid="move-note"
                    autoComplete="off"
                    value={note}
                    onInput={(e) => setNote((e.target as HTMLInputElement).value)}
                  />
                </label>
                <div class="actions two">
                  <button data-testid="move-cancel" onClick={cancelMove}>
                    Cancelar
                  </button>
                  <button
                    class="primary"
                    data-testid="move-save"
                    disabled={open !== 'entrada' && !note.trim()}
                    onClick={submitMove}
                  >
                    Guardar
                  </button>
                </div>
              </div>
            )}
            {t && (
              // Siempre a la vista (no plegados): son la cuenta que respalda la existencia y se leen de un vistazo.
              <div class="inv-more">
                <p class="inv-more-title">Entradas y salidas acumuladas</p>
                <dl class="stock small" aria-label="Movimientos acumulados">
                  <div>
                    <dt>Recepciones</dt>
                    <dd data-testid="stock-recibido">{formatQty(t.recepcionesMilli, p.unit)}</dd>
                  </div>
                  <div>
                    <dt>Entradas manuales</dt>
                    <dd data-testid="stock-manual">{formatQty(t.entradasManualesMilli, p.unit)}</dd>
                  </div>
                  <div>
                    <dt>Vendido</dt>
                    <dd data-testid="stock-vendido">{formatQty(t.ventasNetasMilli, p.unit)}</dd>
                  </div>
                  <div>
                    <dt>Mermas</dt>
                    <dd data-testid="stock-merma">{formatQty(t.mermasMilli, p.unit)}</dd>
                  </div>
                  <div>
                    <dt>Conteos</dt>
                    <dd data-testid="stock-ajuste">{formatQty(t.ajustesMilli, p.unit)}</dd>
                  </div>
                </dl>
              </div>
            )}
            <div class="inv-tools">
              <button class="inv-history" data-testid="show-moves" aria-expanded={history?.id === p.id} onClick={() => toggleHistory(p)}>
                {history?.id === p.id ? 'Cerrar historial' : 'Ver historial de este producto'}
              </button>
              <button data-testid="edit-product" onClick={() => setEditing(editing === p.id ? null : p.id)}>
                Editar
              </button>
              <button onClick={() => toggle(p)}>{p.active ? 'Ocultar' : 'Activar'}</button>
            </div>
            {editing === p.id && (
              <>
                <p class="hint">
                  Las ventas y recepciones anteriores conservan el nombre y el precio con que se hicieron.
                </p>
                {(p.physicalMilli !== 0 || p.reservedMilli !== 0 || (totals[p.id] && totals[p.id].recepcionesMilli !== 0)) && (
                  <p class="notice" data-testid="edit-moves-warning">
                    Este producto ya tiene movimientos: si cambias cómo se llama, TODO su inventario pasa a llamarse así (lo anterior
                    queda guardado abajo y en cada venta o recepción vieja). Si en realidad es otra cosa, mejor oculta este y crea uno nuevo.
                  </p>
                )}
                <NuevaVariedad idPrefix="edit" initial={p} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />
              </>
            )}
            {p.classEdits && p.classEdits.length > 0 && (
              <ul class="plain" data-testid="class-edits">
                {p.classEdits.map((e) => (
                  <li key={e.at} class="hint">
                    Editada el {fmtDateTime(e.at)}: «{[e.before.variety, e.before.origin, e.before.quality, e.before.caliber].filter(Boolean).join(' · ')}» →
                    «{[e.after.variety, e.after.origin, e.after.quality, e.after.caliber].filter(Boolean).join(' · ')}»
                  </li>
                ))}
              </ul>
            )}
            {history?.id === p.id && (
              <ul class="plain moves" data-testid="moves-list">
                {history.moves.length === 0 && <li>Sin movimientos.</li>}
                {history.moves.slice(0, history.shown).map((m) => (
                  <li key={m.id}>
                    {new Date(m.createdAt).toLocaleString('es-MX')} · {MOVE_LABEL[m.type] ?? m.type}
                    {m.receptionId && history.folios[m.receptionId] !== undefined && ` R-${history.folios[m.receptionId]}`} ·{' '}
                    {m.deltaMilli !== 0 && `${m.deltaMilli > 0 ? '+' : ''}${m.deltaMilli / 1000} ${p.unit === 'kg' ? 'kg' : p.unit} físico`}
                    {m.reservedDeltaMilli !== 0 && ` ${m.reservedDeltaMilli > 0 ? '+' : ''}${m.reservedDeltaMilli / 1000} reservado`}
                    {m.note && ` · ${m.note}`}
                  </li>
                ))}
                {history.moves.length > history.shown && (
                  <li class="hint" data-testid="moves-more-note">
                    Mostrando los últimos {history.shown} de {history.moves.length} movimientos.{' '}
                    <button class="link" data-testid="moves-more" onClick={() => setHistory({ ...history, shown: history.shown + 50 })}>
                      Ver 50 más
                    </button>
                  </li>
                )}
              </ul>
            )}
          </article>
        );
      })}

      <h3 class="inv-add-title">Agregar producto</h3>
      <NuevaVariedad />
      {auth && <AuthorizeSheet error={auth.error} busy={authBusy} onCancel={() => setAuth(null)} onAuthorize={() => runPending('auth')} />}
      {warning && (
        <WarningsSheet
          warnings={warning.warnings}
          busy={authBusy}
          confirmLabel="Registrar de todos modos"
          onCancel={() => setWarning(null)}
          onConfirm={() => runPending('warning')}
        />
      )}
    </section>
  );
}

type Sub = 'existencias' | 'fletes';

/**
 * Inventario: las existencias por clasificación y, aparte, el control de pesaje por flete (peso de origen contra peso de
 * destino). Las existencias se quedan montadas al mirar los fletes para no perder un movimiento a medio capturar.
 */
export function Inventario() {
  const [sub, setSub] = useState<Sub>('existencias');
  const SUBS: Array<[Sub, string]> = [
    ['existencias', 'Existencias'],
    ['fletes', 'Fletes'],
  ];
  return (
    <>
      <div class="tabs-state" role="tablist" aria-label="Inventario">
        {SUBS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={sub === id} class={sub === id ? 'active' : ''} data-testid={`inv-sub-${id}`} onClick={() => setSub(id)}>
            {label}
          </button>
        ))}
      </div>
      <div hidden={sub !== 'existencias'}>
        <Existencias />
      </div>
      {sub === 'fletes' && <Fletes />}
    </>
  );
}
