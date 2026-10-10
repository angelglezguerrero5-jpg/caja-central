import { useEffect, useState } from 'preact/hooks';
import { listSalesByDay } from '../db/repo';
import { formatMoney, formatQty } from '../domain/money';
import { localDay } from '../domain/report';
import type { Sale } from '../domain/types';
import { useApp } from './ctx';

function stateLabel(s: Sale): string {
  if (s.status === 'anulada') return `ANULADA (${s.voidReason})`;
  if (s.delivery === 'pendiente') return `VALE V-${s.valeFolio} · PENDIENTE`;
  if (s.delivery === 'entregado') return `VALE V-${s.valeFolio} · ENTREGADO`;
  if (s.delivery === 'cancelado') return `VALE V-${s.valeFolio} · CANCELADO`;
  return 'Entregada';
}

export function Historial() {
  const { db, version } = useApp();
  const [day, setDay] = useState(localDay());
  const [sales, setSales] = useState<Sale[]>([]);

  useEffect(() => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) listSalesByDay(db, day).then(setSales);
  }, [db, version, day]);

  const valid = sales.filter((s) => s.status === 'completada');
  const total = valid.reduce((a, s) => a + s.totalCents, 0);

  return (
    <section data-testid="historial">
      <h2>Historial de ventas</h2>
      <label class="field">
        <span>Día</span>
        <input type="date" data-testid="hist-day" value={day} onInput={(e) => setDay((e.target as HTMLInputElement).value)} />
      </label>
      <p class="hint" data-testid="hist-summary">
        {valid.length} ventas · {formatMoney(total)}
        {sales.length !== valid.length && ` · ${sales.length - valid.length} anuladas`}
      </p>
      {sales.length === 0 && <p class="empty">Sin ventas ese día.</p>}
      {sales.map((s) => (
        <article class={s.status === 'anulada' ? 'card inactive' : 'card'} key={s.id} data-testid="hist-row">
          <header>
            <strong>#{s.folio}</strong>
            <span>{formatMoney(s.totalCents)}</span>
          </header>
          <p class="hint">
            {new Date(s.createdAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })} ·{' '}
            {s.items.map((i) => `${i.name} ${formatQty(i.qtyMilli, i.unit)}`).join(', ')} · {s.paymentMethod} ·{' '}
            {stateLabel(s)}
            {s.stockOverride && ' · existencia autorizada'}
          </p>
        </article>
      ))}
    </section>
  );
}
