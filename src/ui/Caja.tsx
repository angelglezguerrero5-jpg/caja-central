import { useEffect, useRef, useState } from 'preact/hooks';
import {
  availableMilli,
  createSale,
  DuplicateSaleError,
  InsufficientStockError,
  listProducts,
  newId,
  setPrice,
} from '../db/repo';
import { formatMoney, formatQty, lineTotalCents, parseMoney, parseQty } from '../domain/money';
import { checkPayment, productLabel } from '../domain/cart';
import type { PaymentMethod, Product, Sale } from '../domain/types';
import { errMsg, useApp } from './ctx';
import { NuevaVariedad } from './NuevaVariedad';

const BILLS = [20, 50, 100, 200, 500, 1000];
const METHODS: Array<[PaymentMethod, string]> = [
  ['efectivo', 'Efectivo'],
  ['transferencia', 'Transferencia'],
  ['tarjeta', 'Tarjeta'],
];
const LS_VARIETY = 'limones.variety';

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
    /* sin almacenamiento local: solo se pierde la preferencia */
  }
}

const centsToText = (c: number) => (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));

export function Caja({ active = true }: { active?: boolean }) {
  const { db, version, bump, toast } = useApp();
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedId, setSelectedId] = useState(lsGet(LS_VARIETY) ?? '');
  const [kgText, setKgText] = useState('');
  const [priceText, setPriceText] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('efectivo');
  const [cashText, setCashText] = useState('');
  const [isVale, setIsVale] = useState(false);
  const [customer, setCustomer] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [last, setLast] = useState<Sale | null>(null);
  const kgRef = useRef<HTMLInputElement>(null);
  // Un id por intento de venta: si se reintenta (doble toque) no se duplica.
  const attemptId = useRef(newId());

  useEffect(() => {
    listProducts(db).then((all) => setProducts(all.filter((p) => p.active)));
  }, [db, version]);

  // Al volver a la pestaña de caja, el foco regresa a kilos.
  useEffect(() => {
    if (active) kgRef.current?.focus();
  }, [active]);

  const selected = products.find((p) => p.id === selectedId) ?? products[0];
  // Variedades (nombres distintos) y, dentro de la elegida, sus calidades.
  const varieties = [...new Set(products.map((p) => p.name))];
  const qualities = selected ? products.filter((p) => p.name === selected.name) : [];

  // Al cambiar de variedad (o al cargar) se muestra su precio guardado.
  useEffect(() => {
    if (selected) setPriceText(centsToText(selected.priceCents));
  }, [selected?.id, selected?.priceCents]);

  const qty = parseQty(kgText);
  const price = parseMoney(priceText);
  const unitLabel = selected?.unit === 'kg' ? 'kg' : (selected?.unit ?? 'kg');
  const total = qty && price ? lineTotalCents(price, qty) : 0;
  const received = method === 'efectivo' ? (parseMoney(cashText) ?? 0) : total;
  const pay = checkPayment(total, method, received);
  const short = !!selected && !!qty && availableMilli(selected) - qty < 0;
  const canConfirm = !saving && !!selected && !!qty && !!price && pay.ok;

  function selectVariety(p: Product) {
    setSelectedId(p.id);
    lsSet(LS_VARIETY, p.id);
    kgRef.current?.focus();
  }

  async function commitPrice() {
    if (!selected || price === null || price <= 0 || price === selected.priceCents) return;
    try {
      await setPrice(db, selected.id, price);
      bump();
      toast(`Precio de ${selected.name}: ${formatMoney(price)}`);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }

  function addBill(b: number) {
    const cur = parseMoney(cashText) ?? 0;
    setCashText(centsToText(cur + b * 100));
  }

  function openConfirm() {
    if (canConfirm) setConfirming(true);
  }

  function cancelConfirm() {
    setConfirming(false);
    kgRef.current?.focus();
  }

  async function confirm() {
    if (!canConfirm || !selected || !qty || !price) return;
    setSaving(true);
    try {
      if (price !== selected.priceCents) await setPrice(db, selected.id, price);
      let sale: Sale | undefined;
      try {
        sale = await createSale(db, {
          id: attemptId.current,
          cart: [
            {
              productId: selected.id,
              name: productLabel(selected),
              unit: selected.unit,
              qtyMilli: qty,
              unitPriceCents: price,
            },
          ],
          paymentMethod: method,
          receivedCents: received,
          isVale,
          customerName: customer,
          allowNegativeStock: short, // solo si el cajero lo autorizó en la hoja de confirmación
        });
      } catch (e) {
        if (e instanceof DuplicateSaleError) sale = e.sale; // ya estaba guardada
        else throw e;
      }
      setLast(sale);
      attemptId.current = newId();
      // Limpia kilos y efectivo; conserva variedad, precio, método y vale.
      setKgText('');
      setCashText('');
      setCustomer('');
      setIsVale(false);
      bump();
      setConfirming(false);
      toast(`Venta #${sale.folio} guardada`);
      kgRef.current?.focus();
    } catch (e) {
      setConfirming(false);
      if (e instanceof InsufficientStockError) bump(); // refresca existencias en pantalla
      toast(errMsg(e), 'error');
    } finally {
      setSaving(false);
    }
  }

  if (products.length === 0) {
    return (
      <section class="caja" data-testid="caja">
        <div data-testid="caja-vacia">
          <h2>Primero configura tus variedades</h2>
          <p class="hint">
            La app no trae variedades ni precios de ejemplo: escribe los tuyos. Después registra tu existencia inicial en
            Inventario → Entrada (mientras no lo hagas, cada venta pedirá autorización por existencia insuficiente).
          </p>
          <NuevaVariedad />
        </div>
      </section>
    );
  }

  return (
    <section class="caja" data-testid="caja">
      <div class="chips" role="radiogroup" aria-label="Variedad">
        {varieties.map((name) => (
          <button
            key={name}
            role="radio"
            aria-checked={name === selected?.name}
            class={name === selected?.name ? 'chip active' : 'chip'}
            data-testid="variety"
            onClick={() => selectVariety(products.find((p) => p.name === name)!)}
          >
            {name}
          </button>
        ))}
      </div>
      {qualities.length > 1 && (
        <div class="chips small" role="radiogroup" aria-label="Calidad o calibre">
          {qualities.map((p) => (
            <button
              key={p.id}
              role="radio"
              aria-checked={p.id === selected?.id}
              class={p.id === selected?.id ? 'chip active' : 'chip'}
              data-testid="quality"
              onClick={() => selectVariety(p)}
            >
              {p.quality ?? 'Única'}
            </button>
          ))}
        </div>
      )}

      <div class="row2">
        <label class="field">
          <span>Kilos</span>
          <input
            ref={kgRef}
            data-testid="kg"
            inputMode="decimal"
            autoComplete="off"
            autoFocus
            placeholder="0"
            value={kgText}
            onInput={(e) => setKgText((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === 'Enter' && openConfirm()}
          />
        </label>
        <label class="field">
          <span>Precio por {unitLabel}</span>
          <input
            data-testid="price"
            inputMode="decimal"
            autoComplete="off"
            value={priceText}
            onInput={(e) => setPriceText((e.target as HTMLInputElement).value)}
            onBlur={commitPrice}
          />
        </label>
      </div>
      {selected && (
        <p class="hint" data-testid="stock-hint">
          Disponible: {formatQty(availableMilli(selected), selected.unit)}
          {selected.reservedMilli > 0 && ` · Reservado: ${formatQty(selected.reservedMilli, selected.unit)}`}
          {availableMilli(selected) < 0 && ' ⚠ revisa inventario'}
        </p>
      )}

      <div class="total" data-testid="total">
        <span>Total</span>
        <strong>{formatMoney(total)}</strong>
      </div>

      <div class="chips" role="radiogroup" aria-label="Forma de pago">
        {METHODS.map(([m, label]) => (
          <button
            key={m}
            role="radio"
            aria-checked={method === m}
            class={method === m ? 'chip active' : 'chip'}
            data-testid={`method-${m}`}
            onClick={() => setMethod(m)}
          >
            {label}
          </button>
        ))}
      </div>

      {method === 'efectivo' && (
        <>
          <label class="field">
            <span>Efectivo recibido</span>
            <input
              data-testid="cash"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={cashText}
              onInput={(e) => setCashText((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && openConfirm()}
            />
          </label>
          <div class="bills">
            {BILLS.map((b) => (
              <button key={b} class="bill" data-testid={`bill-${b}`} onClick={() => addBill(b)}>
                ${b}
              </button>
            ))}
            <button
              class="bill exact"
              data-testid="exact"
              disabled={total <= 0}
              onClick={() => setCashText(centsToText(total))}
            >
              Exacto
            </button>
            <button class="bill clear" data-testid="clear-cash" onClick={() => setCashText('')}>
              Borrar
            </button>
          </div>
          <div class="change" data-testid="change">
            <span>Cambio</span>
            <strong>{pay.ok ? formatMoney(pay.changeCents) : '—'}</strong>
          </div>
        </>
      )}

      <label class="check">
        <input
          type="checkbox"
          data-testid="is-vale"
          checked={isVale}
          onChange={(e) => setIsVale((e.target as HTMLInputElement).checked)}
        />
        Vale: pagado, se entrega después (reserva mercancía)
      </label>
      {isVale && (
        <label class="field">
          <span>Cliente (opcional)</span>
          <input
            data-testid="customer"
            value={customer}
            onInput={(e) => setCustomer((e.target as HTMLInputElement).value)}
          />
        </label>
      )}

      <button class="confirm" data-testid="confirm" disabled={!canConfirm} onClick={openConfirm}>
        {isVale ? 'Cobrar vale' : 'Cobrar'}
      </button>

      {confirming && selected && qty && price && (
        <div class="overlay" role="dialog" aria-modal="true" aria-label="Confirmar cobro" data-testid="confirm-sheet">
          <div class="sheet">
            <h2>{isVale ? 'Confirmar vale pagado' : 'Confirmar cobro'}</h2>
            <p class="sum-line">
              {productLabel(selected)} · {formatQty(qty, selected.unit)} × {formatMoney(price)}
            </p>
            <p class="sum-total" data-testid="sheet-total">{formatMoney(total)}</p>
            <p>
              {METHODS.find(([m]) => m === method)![1]}
              {method === 'efectivo' && (
                <> · recibido {formatMoney(received)} · <strong data-testid="sheet-change">cambio {formatMoney(pay.changeCents)}</strong></>
              )}
            </p>
            {short && selected && qty && (
              <p class="warn" role="alert" data-testid="stock-warning">
                ⚠ Disponible insuficiente: hay {formatQty(Math.max(availableMilli(selected), 0), selected.unit)} y vendes{' '}
                {formatQty(qty, selected.unit)}. La existencia quedará en negativo; requiere tu autorización.
              </p>
            )}
            {isVale && <p class="hint">Se reservará la mercancía hasta entregarla{customer.trim() && ` · ${customer.trim()}`}.</p>}
            <div class="actions two">
              <button data-testid="confirm-no" onClick={cancelConfirm} disabled={saving}>
                Volver
              </button>
              <button
                class={short ? 'danger' : 'primary'}
                data-testid={short ? 'authorize' : 'confirm-yes'}
                autoFocus
                onClick={confirm}
                disabled={saving}
              >
                {saving ? 'Guardando…' : short ? 'Autorizar y cobrar' : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {last && (
        <p class="last" data-testid="last-sale">
          Última: #{last.folio} · {formatMoney(last.totalCents)}
          {last.changeCents > 0 && ` · cambio ${formatMoney(last.changeCents)}`}
          {last.valeFolio && ` · VALE V-${last.valeFolio} pendiente de entrega`}
        </p>
      )}
    </section>
  );
}
