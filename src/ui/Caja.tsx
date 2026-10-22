import { BRAND } from '../brand';
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
import { MAX_MONEY_CENTS, ambiguousNumberHint, formatMoney, formatQty, lineTotalCents, parseMoney, parsePrice, parseQty } from '../domain/money';
import { checkPayment, productLabel } from '../domain/cart';
import { classificationOf, varietyKey } from '../domain/classification';
import type { PaymentMethod, Product, Sale } from '../domain/types';
import { errMsg, useApp } from './ctx';
import { NuevaVariedad } from './NuevaVariedad';
import { ProductChips } from './ProductChips';
import { Sheet } from './Sheet';

const BILLS = [20, 50, 100, 200, 500, 1000];
const METHODS: Array<[PaymentMethod, string]> = [
  ['efectivo', 'Efectivo'],
  ['transferencia', 'Transferencia'],
  ['tarjeta', 'Tarjeta'],
];
const LS_VARIETY = `${BRAND.ns}.variety`;
const LS_RECENT = `${BRAND.ns}.recent`;
const LS_LAST_BY_VARIETY = `${BRAND.ns}.lastByVariety`;

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

/** Últimos 30 productos vendidos (el más reciente primero). */
function loadRecent(): string[] {
  try {
    const a: unknown = JSON.parse(lsGet(LS_RECENT) ?? '[]');
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string').slice(0, 30) : [];
  } catch {
    return [];
  }
}
/** Los 3 más vendidos de las últimas 30 ventas: el orden solo cambia si cambian las cuentas, no en cada cobro. */
function topRecent(ids: string[], n = 3): string[] {
  const count = new Map<string, number>();
  for (const id of ids) count.set(id, (count.get(id) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || ids.indexOf(a[0]) - ids.indexOf(b[0])).slice(0, n).map(([id]) => id);
}
function loadLastByVariety(): Record<string, string> {
  try {
    const o: unknown = JSON.parse(lsGet(LS_LAST_BY_VARIETY) ?? '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, string>) : {};
  } catch {
    return {};
  }
}

const centsToText = (c: number) => (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));
const QTY_LABEL = { kg: 'Kilos', pieza: 'Piezas', caja: 'Cajas', arpilla: 'Arpillas' } as const;

export function Caja({ active = true }: { active?: boolean }) {
  const { db, version, bump, toast } = useApp();
  const [products, setProducts] = useState<Product[]>([]);
  const [hiddenCount, setHiddenCount] = useState(0);
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
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [lastByVariety, setLastByVariety] = useState<Record<string, string>>(loadLastByVariety);
  const kgRef = useRef<HTMLInputElement>(null);
  // Un id por intento de venta: si se reintenta (doble toque) no se duplica.
  const attemptId = useRef(newId());

  useEffect(() => {
    listProducts(db).then((all) => {
      setProducts(all.filter((p) => p.active));
      setHiddenCount(all.filter((p) => !p.active).length);
    });
  }, [db, version]);

  // «Última venta»: se vuelve a leer cuando cambian los datos (p. ej. tras restaurar un respaldo o deshacerlo); si esa venta
  // ya no existe, la línea desaparece en lugar de mostrar un importe que ya no está en la base.
  const lastId = last?.id;
  useEffect(() => {
    if (!lastId) return;
    let live = true;
    db.get('sales', lastId).then((s) => live && setLast(s ?? null));
    return () => {
      live = false;
    };
  }, [db, version, lastId]);

  const selected = products.find((p) => p.id === selectedId) ?? products[0];

  // Al abrir la app y al volver a la pestaña de caja, el foco regresa a kilos (el campo aparece cuando ya hay variedades).
  // Sin mover la pantalla (preventScroll): antes se usaba el atributo autofocus, que desplaza la página hasta el campo; un aviso
  // largo arriba (p. ej. «La app se actualizó») lo empujaba hacia abajo y el desplazamiento dejaba el aviso fuera de vista.
  const hasSelected = !!selected;
  useEffect(() => {
    if (active && hasSelected) kgRef.current?.focus({ preventScroll: true });
  }, [active, hasSelected]);

  // Al cambiar de variedad (o al cargar) se muestra su precio guardado; "sin precio todavía" queda vacío.
  useEffect(() => {
    if (selected) setPriceText(selected.priceCents > 0 ? centsToText(selected.priceCents) : '');
  }, [selected?.id, selected?.priceCents]);

  const qty = parseQty(kgText);
  const price = parsePrice(priceText);
  const unitLabel = selected?.unit === 'kg' ? 'kg' : (selected?.unit ?? 'kg');
  const total = qty && price ? lineTotalCents(price, qty) : 0;
  const received = method === 'efectivo' ? (parseMoney(cashText) ?? 0) : total;
  const pay = checkPayment(total, method, received);
  const short = !!selected && !!qty && availableMilli(selected) - qty < 0;
  // Lo que la base rechazaría al guardar se avisa ANTES de abrir la hoja de cobro.
  const tooBig = total > MAX_MONEY_CENTS;
  const canConfirm = !saving && !tooBig && !!selected && !!qty && !!price && pay.ok;

  function selectVariety(p: Product) {
    setSelectedId(p.id);
    lsSet(LS_VARIETY, p.id);
    kgRef.current?.focus();
  }

  // Los últimos productos vendidos quedan a un toque (la etiqueta completa), sin pasar por variedad → clasificación.
  function pushRecent(p: Product) {
    const next = [p.id, ...recent].slice(0, 30);
    setRecent(next);
    lsSet(LS_RECENT, JSON.stringify(next));
    const map = { ...lastByVariety, [varietyKey(p.name)]: p.id };
    setLastByVariety(map);
    lsSet(LS_LAST_BY_VARIETY, JSON.stringify(map));
  }
  const recentProducts = topRecent(recent.filter((id) => products.some((p) => p.id === id)))
    .map((id) => products.find((p) => p.id === id))
    .filter((p): p is Product => !!p);
  /** Al tocar un tipo, se vuelve a la última clasificación que se vendió de ese tipo (un toque menos en lo más repetido). */
  const pickForVariety = (list: Product[]) => list.find((p) => p.id === lastByVariety[varietyKey(list[0].name)]) ?? list[0];

  async function commitPrice() {
    if (!selected || price === null || price <= 0 || price === selected.priceCents) return;
    try {
      await setPrice(db, selected.id, price);
      bump();
      toast(`Precio de ${productLabel(selected)}: ${formatMoney(price)}`);
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
              cls: classificationOf(selected),
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
      pushRecent(selected);
      attemptId.current = newId();
      // Limpia kilos y efectivo; conserva variedad, precio, método y vale.
      setKgText('');
      setCashText('');
      setCustomer('');
      setIsVale(false);
      bump();
      setConfirming(false);
      toast(`Venta #${sale.folio} guardada`);
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
          <h2>{hiddenCount > 0 ? 'No hay variedades a la vista' : 'Primero configura tus variedades'}</h2>
          {hiddenCount > 0 && (
            <p class="notice" role="status" data-testid="caja-ocultas">
              Tienes {hiddenCount} {hiddenCount === 1 ? 'clasificación oculta' : 'clasificaciones ocultas'}. Para venderla(s) ve a
              Inventario y toca «Activar», o da de alta una nueva aquí.
            </p>
          )}
          <p class="hint">
            La app no trae variedades ni precios de ejemplo: escribe los tuyos. Después registra la mercancía que llega en
            Recepción (o tu existencia inicial en Inventario → Entrada manual). Mientras no lo hagas, cada venta pedirá
            autorización por existencia insuficiente.
          </p>
          <NuevaVariedad />
        </div>
      </section>
    );
  }

  return (
    // data-keep-tabs: en la caja rápida las pestañas no se esconden con el teclado (src/ui/keyboard.ts).
    <section class="caja" data-testid="caja" data-keep-tabs>
      <ProductChips
        products={products}
        selectedId={selected?.id}
        onSelect={selectVariety}
        testids={{ variety: 'variety', cls: 'quality' }}
        pickForVariety={pickForVariety}
        flagMissingPrice
      />
      {recentProducts.length >= 2 && products.length > 6 && (
        <div class="chips small recent" role="group" aria-label="Recientes">
          <span class="help">Recientes:</span>
          {recentProducts.map((p) => (
            <button
              type="button"
              key={p.id}
              class={p.id === selected?.id ? 'chip active' : 'chip'}
              data-testid="recent-chip"
              onClick={() => selectVariety(p)}
            >
              {productLabel(p)}
            </button>
          ))}
        </div>
      )}
      {selected && (
        <p class="sum-line" data-testid="selling">
          Vendiendo: {productLabel(selected)}
        </p>
      )}

      <div class="row2">
        <label class="field">
          <span>{QTY_LABEL[selected?.unit ?? 'kg']}</span>
          <input
            ref={kgRef}
            data-testid="kg"
            inputMode="decimal"
            autoComplete="off"
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
            placeholder={selected?.priceCents === 0 ? 'Falta precio' : ''}
            value={priceText}
            onInput={(e) => setPriceText((e.target as HTMLInputElement).value)}
            onBlur={commitPrice}
          />
        </label>
      </div>
      {[ambiguousNumberHint(kgText), ambiguousNumberHint(priceText), method === 'efectivo' ? ambiguousNumberHint(cashText) : ''].filter(Boolean).map((h) => (
        <p class="notice" role="alert" key={h} data-testid="ambiguous">
          {h}
        </p>
      ))}
      {selected && selected.priceCents === 0 && (
        <p class="warn" data-testid="no-price-hint">
          Esta clasificación aún no tiene precio: escríbelo arriba para poder cobrar.
        </p>
      )}
      {selected && (
        <p class="hint" data-testid="stock-hint">
          Disponible: {formatQty(availableMilli(selected), selected.unit)}
          {selected.reservedMilli > 0 && ` · Reservado: ${formatQty(selected.reservedMilli, selected.unit)}`}
          {availableMilli(selected) < 0 && <span class="neg"> ⚠ quedan {formatQty(availableMilli(selected), selected.unit)}: revisa inventario</span>}
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
          {!pay.ok && total > 0 && cashText.trim() !== '' && parseMoney(cashText) !== null && (
            <p class="hint" data-testid="pay-error">
              Faltan {formatMoney(total - received)} para cubrir el total.
            </p>
          )}
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

      {tooBig && (
        <p class="warn" role="alert" data-testid="total-too-big">
          El total rebasa el máximo que la app guarda ({formatMoney(MAX_MONEY_CENTS)}). Revisa los kilos y el precio.
        </p>
      )}
      <button class="confirm" data-testid="confirm" disabled={!canConfirm} onClick={openConfirm}>
        {isVale ? 'Cobrar vale' : 'Cobrar'}
      </button>

      {confirming && selected && qty && price && (
        <Sheet
          title={isVale ? 'Confirmar vale pagado' : 'Confirmar cobro'}
          testid="confirm-sheet"
          onClose={saving ? undefined : cancelConfirm}
          returnFocus={() => kgRef.current}
          foot={
            <div class="actions two">
              <button data-testid="confirm-no" onClick={cancelConfirm} disabled={saving}>
                Volver
              </button>
              <button class={short ? 'danger' : 'primary'} data-testid={short ? 'authorize' : 'confirm-yes'} onClick={confirm} disabled={saving}>
                {saving ? 'Guardando…' : short ? 'Autorizar y cobrar' : 'Confirmar'}
              </button>
            </div>
          }
        >
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
        </Sheet>
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
