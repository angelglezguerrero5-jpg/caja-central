import { useEffect, useState } from 'preact/hooks';
import { addStockMove, availableMilli, listProducts, saveProduct } from '../db/repo';
import { formatMoney, formatQty, parseMoney, parseQty } from '../domain/money';
import type { Product, Unit } from '../domain/types';
import { errMsg, useApp } from './ctx';

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
  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [newUnit, setNewUnit] = useState<Unit>('kg');

  useEffect(() => {
    listProducts(db).then(setProducts);
  }, [db, version]);

  async function submitMove() {
    if (!moving) return;
    const q = parseQty(qtyText) ?? (moving.kind === 'ajuste' && qtyText.trim() === '0' ? 0 : null);
    if (q === null) return toast('Cantidad inválida', 'error');
    try {
      await addStockMove(db, moving.p.id, moving.kind, q, note);
      toast(`${KIND_LABEL[moving.kind]} registrada`);
      setMoving(null);
      setQtyText('');
      setNote('');
      bump();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }

  async function addProduct() {
    const price = parseMoney(newPrice);
    if (!price) return toast('Precio inválido', 'error');
    try {
      await saveProduct(db, { name: newName, unit: newUnit, priceCents: price, active: true });
      setNewName('');
      setNewPrice('');
      toast('Variedad agregada');
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
            <strong>{p.name}</strong>
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
            <button onClick={() => toggle(p)}>{p.active ? 'Ocultar' : 'Activar'}</button>
          </div>
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
                <span>Nota (opcional)</span>
                <input value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
              </label>
              <div class="actions">
                <button class="primary" data-testid="move-save" onClick={submitMove}>
                  Guardar
                </button>
                <button onClick={() => setMoving(null)}>Cancelar</button>
              </div>
            </div>
          )}
        </article>
      ))}

      <h3>Nueva variedad</h3>
      <div class="inline-form">
        <label class="field">
          <span>Nombre</span>
          <input
            data-testid="new-name"
            value={newName}
            onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="field">
          <span>Precio por unidad</span>
          <input
            data-testid="new-price"
            inputMode="decimal"
            value={newPrice}
            onInput={(e) => setNewPrice((e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="field">
          <span>Unidad</span>
          <select value={newUnit} onChange={(e) => setNewUnit((e.target as HTMLSelectElement).value as Unit)}>
            <option value="kg">kg</option>
            <option value="pieza">pieza</option>
            <option value="caja">caja</option>
            <option value="arpilla">arpilla</option>
          </select>
        </label>
        <button class="primary" data-testid="add-product" onClick={addProduct}>
          Agregar variedad
        </button>
      </div>
    </section>
  );
}
