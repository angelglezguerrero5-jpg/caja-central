import { useEffect, useState } from 'preact/hooks';
import { deliverVale, listPendingVales, voidSale } from '../db/repo';
import { formatMoney, formatQty } from '../domain/money';
import type { Sale } from '../domain/types';
import { errMsg, useApp } from './ctx';

export function Vales() {
  const { db, version, bump, toast } = useApp();
  const [vales, setVales] = useState<Sale[]>([]);

  useEffect(() => {
    listPendingVales(db).then(setVales);
  }, [db, version]);

  async function deliver(v: Sale) {
    try {
      await deliverVale(db, v.id);
      toast(`Vale #${v.folio} entregado`);
      bump();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }

  async function cancel(v: Sale) {
    const reason = window.prompt(`Motivo para anular el vale #${v.folio}:`);
    if (!reason) return;
    try {
      await voidSale(db, v.id, reason);
      toast(`Vale #${v.folio} anulado`);
      bump();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }

  return (
    <section data-testid="vales">
      <h2>Vales pendientes de entrega</h2>
      <p class="hint">Ya están pagados. Entregar solo descuenta la mercancía reservada.</p>
      {vales.length === 0 && <p class="empty">No hay vales pendientes.</p>}
      {vales.map((v) => (
        <article class="card" key={v.id} data-testid="vale">
          <header>
            <strong>Vale #{v.folio}</strong>
            <span>{formatMoney(v.totalCents)} pagado</span>
          </header>
          {v.customerName && <p>Cliente: {v.customerName}</p>}
          <ul>
            {v.items.map((it, i) => (
              <li key={i}>
                {it.name} · {formatQty(it.qtyMilli, it.unit)}
              </li>
            ))}
          </ul>
          <div class="actions">
            <button class="primary" data-testid="deliver" onClick={() => deliver(v)}>
              Entregar
            </button>
            <button class="danger" onClick={() => cancel(v)}>
              Anular
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
