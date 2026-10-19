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

type MoveKind = 'entrada' | 'merma' | 'ajuste';
/** Movimientos que se muestran de entrada en «Movimientos»; «Ver más» agrega otra tanda. */
const MOVES_PAGE = 15;
const KIND_LABEL: Record<MoveKind, string> = {
  entrada: 'Entrada manual',
  merma: 'Merma',
  ajuste: 'Conteo físico',
};
/** Texto del botón de guardar y del aviso de éxito de cada tipo. */
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
    <section data-testid="inventario">
      <h2>Inventario por variedad</h2>
      <p class="help" data-testid="inv-glossary">
        En bodega = lo que hay físicamente · Apartado = pagado en vales por entregar · Disponible = lo que se puede vender.
      </p>
      {products.length === 0 && <p class="empty">Aún no hay variedades. Agrégalas abajo.</p>}
      {products.map((p) => {
        const t = totals[p.id];
        return (
          <article class={p.active ? 'card' : 'card inactive'} key={p.id} data-testid="inv-row">
            <header>
              <strong>{productLabel(p)}</strong>
              <span>{p.priceCents > 0 ? `${formatMoney(p.priceCents)}/${p.unit}` : 'Sin precio'}</span>
            </header>
            <dl class="stock">
              <div>
                <dt>En bodega</dt>
                <dd data-testid="stock-physical">{formatQty(p.physicalMilli, p.unit)}</dd>
              </div>
              <div>
                <dt>Apartado</dt>
                <dd data-testid="stock-reserved">{formatQty(p.reservedMilli, p.unit)}</dd>
              </div>
              <div>
                <dt>Disponible</dt>
                <dd data-testid="stock-available" class={availableMilli(p) < 0 ? 'neg' : ''}>
                  {formatQty(availableMilli(p), p.unit)}
                </dd>
              </div>
            </dl>
            {availableMilli(p) < 0 && (
              <p class="warn" data-testid="stock-negative">
                ⚠ Quedan {formatQty(availableMilli(p), p.unit)}: se vendió o apartó más de lo que hay. Regularízalo con una recepción
                o un conteo físico.
              </p>
            )}
            {t && (
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
            )}
            <div class="actions">
              {(['entrada', 'merma', 'ajuste'] as MoveKind[]).map((k) => (
                <button key={k} data-testid={`move-${k}`} onClick={() => startMove(p, k)}>
                  {KIND_LABEL[k]}
                </button>
              ))}
              <button data-testid="show-moves" onClick={() => toggleHistory(p)}>
                Movimientos
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
            {moving?.p.id === p.id && (
              <div class="inline-form" data-testid="move-form">
                <label class="field">
                  <span>
                    {moving.kind === 'ajuste' ? 'Existencia real contada' : 'Cantidad'} ({p.unit})
                  </span>
                  <input
                    data-testid="move-qty"
                    inputMode="decimal"
                    value={qtyText}
                    onInput={(e) => setQtyText((e.target as HTMLInputElement).value)}
                  />
                </label>
                {moving.kind === 'entrada' && (
                  <p class="hint" data-testid="move-entrada-hint">
                    Úsala para el inventario inicial o mercancía que no viene de un proveedor. Si llegó mercancía de un proveedor,
                    regístrala en Recepción: así queda con fecha, camión y peso.
                  </p>
                )}
                <label class="field">
                  <span>{moving.kind === 'entrada' ? 'Nota (opcional)' : 'Motivo (obligatorio)'}</span>
                  <input
                    data-testid="move-note"
                    value={note}
                    onInput={(e) => setNote((e.target as HTMLInputElement).value)}
                  />
                </label>
                <div class="actions">
                  <button
                    class="primary"
                    data-testid="move-save"
                    disabled={moving.kind !== 'entrada' && !note.trim()}
                    onClick={submitMove}
                  >
                    Guardar
                  </button>
                  <button data-testid="move-cancel" onClick={cancelMove}>
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </article>
        );
      })}

      <h3>Nueva variedad</h3>
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
