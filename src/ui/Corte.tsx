import { useEffect, useState } from 'preact/hooks';
import {
  addCashOut,
  closeShift,
  getCurrentShift,
  listCashMovements,
  listClosedShifts,
  listSalesByShift,
  openShift,
  voidSale,
} from '../db/repo';
import { formatMoney, formatQty, parseMoney } from '../domain/money';
import { buildShiftReport, type ShiftReport } from '../domain/report';
import type { CashMovement, Sale, Shift } from '../domain/types';
import { errMsg, useApp } from './ctx';

export function Corte() {
  const { db, version, bump, toast } = useApp();
  const [shift, setShift] = useState<Shift | undefined>();
  const [sales, setSales] = useState<Sale[]>([]);
  const [moves, setMoves] = useState<CashMovement[]>([]);
  const [report, setReport] = useState<ShiftReport | null>(null);
  const [closed, setClosed] = useState<Shift[]>([]);
  const [openingText, setOpeningText] = useState('');
  const [countedText, setCountedText] = useState('');
  const [outAmount, setOutAmount] = useState('');
  const [outConcept, setOutConcept] = useState('');

  useEffect(() => {
    (async () => {
      const s = await getCurrentShift(db);
      setShift(s);
      setClosed(await listClosedShifts(db, 10));
      if (s) {
        const [sl, mv] = await Promise.all([listSalesByShift(db, s.id), listCashMovements(db, s.id)]);
        setSales(sl);
        setMoves(mv);
        setReport(buildShiftReport(s, sl, mv));
      } else {
        setSales([]);
        setMoves([]);
        setReport(null);
      }
    })();
  }, [db, version]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      bump();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  if (!shift || !report) {
    return (
      <section data-testid="corte">
        <h2>Corte de caja</h2>
        <p class="empty">No hay turno abierto. Se abre solo con la primera venta, o ábrelo con fondo inicial:</p>
        <label class="field">
          <span>Fondo inicial en caja</span>
          <input
            data-testid="opening"
            inputMode="decimal"
            value={openingText}
            onInput={(e) => setOpeningText((e.target as HTMLInputElement).value)}
          />
        </label>
        <button
          class="primary"
          data-testid="open-shift"
          onClick={() => {
            const c = openingText.trim() === '' ? 0 : parseMoney(openingText);
            if (c === null) return toast('Monto inválido', 'error');
            run(() => openShift(db, c), 'Turno abierto');
            setOpeningText('');
          }}
        >
          Abrir turno
        </button>
        <ClosedList closed={closed} />
      </section>
    );
  }

  const counted = parseMoney(countedText);
  const diff = counted === null ? null : counted - report.expectedCashCents;

  return (
    <section data-testid="corte">
      <h2>Corte de caja</h2>
      <p class="hint">Turno abierto {new Date(shift.openedAt).toLocaleString('es-MX')}</p>
      <dl class="report">
        <div><dt>Ventas ({report.salesCount})</dt><dd data-testid="r-total">{formatMoney(report.totalCents)}</dd></div>
        <div><dt>Efectivo</dt><dd data-testid="r-efectivo">{formatMoney(report.byMethod.efectivo)}</dd></div>
        <div><dt>Transferencia</dt><dd>{formatMoney(report.byMethod.transferencia)}</dd></div>
        <div><dt>Tarjeta</dt><dd>{formatMoney(report.byMethod.tarjeta)}</dd></div>
        <div><dt>Vales vendidos ({report.valesCount})</dt><dd>{formatMoney(report.valesCents)}</dd></div>
        <div><dt>Fondo inicial</dt><dd>{formatMoney(report.openingCashCents)}</dd></div>
        <div><dt>Salidas de efectivo</dt><dd>−{formatMoney(report.cashOutCents)}</dd></div>
        <div><dt>Devoluciones de vales</dt><dd data-testid="r-refunds">−{formatMoney(report.refundsCents)}</dd></div>
        <div class="strong"><dt>Efectivo esperado</dt><dd data-testid="r-expected">{formatMoney(report.expectedCashCents)}</dd></div>
      </dl>
      {report.byProduct.length > 0 && (
        <>
          <h3>Por variedad</h3>
          <ul class="plain">
            {report.byProduct.map((p) => (
              <li key={p.productId + p.unit}>
                {p.name}: {formatQty(p.qtyMilli, p.unit)} · {formatMoney(p.totalCents)}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Salida de efectivo</h3>
      <div class="inline-form">
        <input
          placeholder="Monto"
          data-testid="out-amount"
          inputMode="decimal"
          value={outAmount}
          onInput={(e) => setOutAmount((e.target as HTMLInputElement).value)}
        />
        <input
          placeholder="Concepto (bolsas, comida…)"
          data-testid="out-concept"
          value={outConcept}
          onInput={(e) => setOutConcept((e.target as HTMLInputElement).value)}
        />
        <button
          data-testid="out-save"
          onClick={() => {
            const a = parseMoney(outAmount);
            if (!a) return toast('Monto inválido', 'error');
            run(() => addCashOut(db, a, outConcept), 'Salida registrada');
            setOutAmount('');
            setOutConcept('');
          }}
        >
          Registrar salida
        </button>
      </div>
      {moves.map((m) => (
        <p class="hint" key={m.id}>
          −{formatMoney(m.amountCents)} · {m.concept}
        </p>
      ))}

      <h3>Ventas del turno</h3>
      {sales.length === 0 && <p class="empty">Sin ventas todavía.</p>}
      {sales.map((s) => (
        <article class={s.status === 'anulada' ? 'card inactive' : 'card'} key={s.id} data-testid="sale-row">
          <header>
            <strong>#{s.folio}</strong>
            <span>{formatMoney(s.totalCents)}</span>
          </header>
          <p class="hint">
            {s.items.map((i) => `${i.name} ${formatQty(i.qtyMilli, i.unit)}`).join(', ')} · {s.paymentMethod}
            {s.delivery === 'pendiente' && ` · VALE V-${s.valeFolio} pendiente`}
            {s.delivery === 'entregado' && ` · VALE V-${s.valeFolio} entregado`}
            {s.delivery === 'cancelado' && ` · VALE V-${s.valeFolio} cancelado`}
            {s.status === 'anulada' && ` · ANULADA (${s.voidReason})`}
          </p>
          {s.status === 'completada' && s.delivery === 'inmediata' && (
            <button
              class="danger small"
              onClick={() => {
                const reason = window.prompt(`Motivo para anular la venta #${s.folio}:`);
                if (reason) run(() => voidSale(db, s.id, reason), `Venta #${s.folio} anulada`);
              }}
            >
              Anular
            </button>
          )}
        </article>
      ))}

      <h3>Cerrar turno</h3>
      <label class="field">
        <span>Efectivo contado en caja</span>
        <input
          data-testid="counted"
          inputMode="decimal"
          value={countedText}
          onInput={(e) => setCountedText((e.target as HTMLInputElement).value)}
        />
      </label>
      {diff !== null && (
        <p class={diff === 0 ? 'ok' : 'warn'} data-testid="diff">
          {diff === 0 ? 'Cuadra exacto' : diff > 0 ? `Sobran ${formatMoney(diff)}` : `Faltan ${formatMoney(-diff)}`}
        </p>
      )}
      <button
        class="primary"
        data-testid="close-shift"
        disabled={counted === null}
        onClick={() => {
          if (counted === null) return;
          if (!window.confirm('¿Cerrar el turno? Ya no podrás anular sus ventas.')) return;
          run(() => closeShift(db, counted), 'Turno cerrado');
          setCountedText('');
        }}
      >
        Cerrar turno
      </button>
      <ClosedList closed={closed} />
    </section>
  );
}

function ClosedList({ closed }: { closed: Shift[] }) {
  if (closed.length === 0) return null;
  return (
    <>
      <h3>Cortes anteriores</h3>
      {closed.map((s) => (
        <p class="hint" key={s.id} data-testid="closed-shift">
          {new Date(s.closedAt!).toLocaleString('es-MX')} · esperado {formatMoney(s.expectedCashCents ?? 0)} ·
          contado {formatMoney(s.countedCashCents ?? 0)} · dif {formatMoney(s.differenceCents ?? 0)}
        </p>
      ))}
    </>
  );
}
