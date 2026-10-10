import { useEffect, useState } from 'preact/hooks';
import { addStockMove, availableMilli, listProducts, listStockMoves, saveProduct } from '../db/repo';
import { productLabel } from '../domain/cart';
import { formatMoney, formatQty, parseQty } from '../domain/money';
import type { Product, StockMove } from '../domain/types';
import { errMsg, useApp } from './ctx';
import { NuevaVariedad } from './NuevaVariedad';

type MoveKind = 'entrada' | 'merma' | 'ajuste';
const KIND_LABEL: Record<MoveKind, string> = {
  entrada: 'Entrada',
  merma: 'Merma',
  ajuste: 'Conteo físico',
};

export function Inventario() {
  const { db, version, bump, toast } = useApp();
  const [products, setProducts] = useState<Product[]>([]);
  const [moving, setMoving] = useState<{ p: Product; kind: MoveKind } | null>(null);
  const [qtyText, setQtyText] = useState('');
  const [note, setNote] = useState('');
  const [history, setHistory] = useState<{ id: string; moves: StockMove[] } | null>(null);

  useEffect(() => {
    listProducts(db).then(setProducts);
  }, [db, version]);

  async function submitMove() {
    if (!moving) return;
    const q = parseQty(qtyText) ?? (moving.kind === 'ajuste' && qtyText.trim() === '0' ? 0 : null);
    if (q === null) return toast('Cantidad inválida', 'error');
    try {
      try {
        await addStockMove(db, moving.p.id, moving.kind, q, note);
      } catch (e) {
        // Dejar el disponible en negativo solo con autorización explícita.
        if (e instanceof Error && e.message.includes('Se requiere autorización') &&
            window.confirm(`${e.message}\n\n¿Autorizar de todos modos?`)) {
          await addStockMove(db, moving.p.id, moving.kind, q, note, true);
        } else throw e;
      }
      toast(`${KIND_LABEL[moving.kind]} registrada`);
      setMoving(null);
      setQtyText('');
      setNote('');
      bump();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }

  async function toggle(p: Product) {
    try {
      await saveProduct(db, { ...p, active: !p.active });
      bump();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }

  return (
    <section data-testid="inventario">
      <h2>Inventario por variedad</h2>
      {products.map((p) => (
        <article class={p.active ? 'card' : 'card inactive'} key={p.id} data-testid="inv-row">
          <header>
            <strong>{productLabel(p)}</strong>
            <span>
              {formatMoney(p.priceCents)}/{p.unit}
            </span>
          </header>
          <dl class="stock">
            <div>
              <dt>Físico</dt>
              <dd data-testid="stock-physical">{formatQty(p.physicalMilli, p.unit)}</dd>
            </div>
            <div>
              <dt>Reservado</dt>
              <dd data-testid="stock-reserved">{formatQty(p.reservedMilli, p.unit)}</dd>
            </div>
            <div>
              <dt>Disponible</dt>
              <dd data-testid="stock-available">{formatQty(availableMilli(p), p.unit)}</dd>
            </div>
          </dl>
          <div class="actions">
            {(['entrada', 'merma', 'ajuste'] as MoveKind[]).map((k) => (
              <button key={k} data-testid={`move-${k}`} onClick={() => setMoving({ p, kind: k })}>
                {KIND_LABEL[k]}
              </button>
            ))}
            <button
              data-testid="show-moves"
              onClick={async () =>
                setHistory(history?.id === p.id ? null : { id: p.id, moves: await listStockMoves(db, p.id, 15) })
              }
            >
              Movimientos
            </button>
            <button onClick={() => toggle(p)}>{p.active ? 'Ocultar' : 'Activar'}</button>
          </div>
          {history?.id === p.id && (
            <ul class="plain moves" data-testid="moves-list">
              {history.moves.length === 0 && <li>Sin movimientos.</li>}
              {history.moves.map((m) => (
                <li key={m.id}>
                  {new Date(m.createdAt).toLocaleString('es-MX')} · {m.type} ·{' '}
                  {m.deltaMilli !== 0 && `${m.deltaMilli > 0 ? '+' : ''}${m.deltaMilli / 1000} kg físico`}
                  {m.reservedDeltaMilli !== 0 && ` ${m.reservedDeltaMilli > 0 ? '+' : ''}${m.reservedDeltaMilli / 1000} kg reservado`}
                  {m.note && ` · ${m.note}`}
                </li>
              ))}
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
                <button onClick={() => setMoving(null)}>Cancelar</button>
              </div>
            </div>
          )}
        </article>
      ))}

      <h3>Nueva variedad</h3>
      <NuevaVariedad />
    </section>
  );
}
