import { useEffect, useState } from 'preact/hooks';
import { cancelVale, deliverVale, listVales } from '../db/repo';
import { formatMoney, formatQty } from '../domain/money';
import type { RefundMethod, Sale } from '../domain/types';
import { errMsg, useApp } from './ctx';

type State = 'pendiente' | 'entregado' | 'cancelado';
const STATE_LABEL: Record<State, string> = {
  pendiente: 'PENDIENTE',
  entregado: 'ENTREGADO',
  cancelado: 'CANCELADO',
};
const REFUND_LABEL: Record<RefundMethod, string> = {
  efectivo: 'Se devolvió en EFECTIVO (sale de la caja)',
  transferencia: 'Se devolvió por transferencia (fuera de caja)',
  ninguna: 'NO se devolvió dinero',
};

export function Vales() {
  const { db, version, bump, toast } = useApp();
  const [state, setState] = useState<State>('pendiente');
  const [vales, setVales] = useState<Sale[]>([]);
  const [cancelling, setCancelling] = useState<Sale | null>(null);
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState<RefundMethod | ''>('');

  useEffect(() => {
    listVales(db, state).then(setVales);
  }, [db, version, state]);

  async function deliver(v: Sale) {
    try {
      await deliverVale(db, v.id);
      toast(`Vale V-${v.valeFolio} entregado`);
      bump();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }

  function startCancel(v: Sale) {
    setCancelling(v);
    setReason('');
    setRefund(''); // sin valor por defecto: hay que decidirlo
  }

  async function confirmCancel() {
    if (!cancelling || !refund) return;
    try {
      await cancelVale(db, cancelling.id, reason, refund);
      toast(`Vale V-${cancelling.valeFolio} cancelado`);
      setCancelling(null);
      bump();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }

  return (
    <section data-testid="vales">
      <h2>Vales</h2>
      <p class="hint">Ya están pagados. Entregar solo descuenta la mercancía reservada; no cobra otra vez.</p>
      <div class="tabs-state" role="tablist">
        {(Object.keys(STATE_LABEL) as State[]).map((st) => (
          <button
            key={st}
            role="tab"
            aria-selected={state === st}
            class={state === st ? 'active' : ''}
            data-testid={`vales-${st}`}
            onClick={() => setState(st)}
          >
            {STATE_LABEL[st]}
          </button>
        ))}
      </div>
      {vales.length === 0 && <p class="empty">No hay vales en estado {STATE_LABEL[state]}.</p>}
      {vales.map((v) => (
        <article class="card" key={v.id} data-testid="vale">
          <header>
            <strong>Vale V-{v.valeFolio}</strong>
            <span class={v.delivery === 'cancelado' ? 'badge cancel' : 'badge'}>{formatMoney(v.totalCents)} pagado</span>
          </header>
          <p class="hint">Venta #{v.folio}{v.customerName && ` · ${v.customerName}`}</p>
          <ul>
            {v.items.map((it, i) => (
              <li key={i}>
                {it.name} · {formatQty(it.qtyMilli, it.unit)}
              </li>
            ))}
          </ul>
          {v.delivery === 'entregado' && v.deliveredAt && (
            <p class="hint">Entregado {new Date(v.deliveredAt).toLocaleString('es-MX')}</p>
          )}
          {v.delivery === 'cancelado' && (
            <p class="hint" data-testid="cancel-info">
              Cancelado: {v.cancelReason} · {REFUND_LABEL[v.refundMethod ?? 'ninguna']}
              {v.refundMethod && v.refundMethod !== 'ninguna' && ` (${formatMoney(v.refundCents ?? 0)})`}
            </p>
          )}
          {v.delivery === 'pendiente' && (
            <div class="actions">
              <button class="primary" data-testid="deliver" onClick={() => deliver(v)}>
                Entregar
              </button>
              <button class="danger" data-testid="cancel-vale" onClick={() => startCancel(v)}>
                Cancelar
              </button>
            </div>
          )}
        </article>
      ))}

      {cancelling && (
        <div class="overlay" role="dialog" aria-modal="true" data-testid="cancel-sheet">
          <div class="sheet">
            <h2>Cancelar vale V-{cancelling.valeFolio}</h2>
            <p class="hint">
              El cliente pagó {formatMoney(cancelling.totalCents)}. Indica qué pasó con ese dinero: el sistema no
              asume que se devuelve.
            </p>
            <label class="field">
              <span>Motivo</span>
              <input data-testid="cancel-reason" value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
            </label>
            {(Object.keys(REFUND_LABEL) as RefundMethod[]).map((m) => (
              <label class="radio" key={m}>
                <input
                  type="radio"
                  name="refund"
                  data-testid={`refund-${m}`}
                  checked={refund === m}
                  onChange={() => setRefund(m)}
                />
                {REFUND_LABEL[m]}
              </label>
            ))}
            <div class="actions two">
              <button data-testid="cancel-back" onClick={() => setCancelling(null)}>
                Volver
              </button>
              <button
                class="danger"
                data-testid="cancel-confirm"
                disabled={!reason.trim() || !refund}
                onClick={confirmCancel}
              >
                Cancelar vale
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
