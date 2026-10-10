import { useState } from 'preact/hooks';
import { saveProduct } from '../db/repo';
import { parseMoney } from '../domain/money';
import type { Unit } from '../domain/types';
import { errMsg, useApp } from './ctx';

/** Alta de variedad con su precio real. La app NO trae variedades ni precios de ejemplo. */
export function NuevaVariedad() {
  const { db, bump, toast } = useApp();
  const [name, setName] = useState('');
  const [quality, setQuality] = useState('');
  const [price, setPrice] = useState('');
  const [unit, setUnit] = useState<Unit>('kg');

  async function add() {
    const cents = parseMoney(price);
    if (!cents) return toast('Escribe el precio por unidad (mayor a cero)', 'error');
    try {
      await saveProduct(db, { name, quality, unit, priceCents: cents, active: true });
      setName('');
      setQuality('');
      setPrice('');
      toast('Variedad agregada');
      bump();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }

  return (
    <div class="inline-form" data-testid="new-variety">
      <label class="field">
        <span>Variedad</span>
        <input
          data-testid="new-name"
          placeholder="Ej. Limón persa"
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
      </label>
      <label class="field">
        <span>Calidad / tamaño / calibre (opcional)</span>
        <input
          data-testid="new-quality"
          value={quality}
          onInput={(e) => setQuality((e.target as HTMLInputElement).value)}
        />
      </label>
      <label class="field">
        <span>Precio por unidad (MXN)</span>
        <input
          data-testid="new-price"
          inputMode="decimal"
          value={price}
          onInput={(e) => setPrice((e.target as HTMLInputElement).value)}
        />
      </label>
      <label class="field">
        <span>Unidad</span>
        <select value={unit} onChange={(e) => setUnit((e.target as HTMLSelectElement).value as Unit)}>
          <option value="kg">kg</option>
          <option value="pieza">pieza</option>
          <option value="caja">caja</option>
          <option value="arpilla">arpilla</option>
        </select>
      </label>
      <button class="primary" data-testid="add-product" onClick={add}>
        Agregar variedad
      </button>
    </div>
  );
}
