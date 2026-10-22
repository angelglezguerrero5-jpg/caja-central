import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { listReceptions } from '../db/receptions';
import { listProducts } from '../db/repo';
import { buildMerchandiseReport, type Bucket, type MerchandiseReport } from '../domain/mercancia';
import { formatQty } from '../domain/money';
import { CONTAINER_NOUN, PACKAGING_LABEL } from '../domain/reception';
import { localDay } from '../domain/report';
import { useApp } from './ctx';
import { addDays, fmtDateTime, fmtDay } from './format';

const TYPE_LABEL: Record<string, string> = {
  merma: 'Merma',
  ajuste: 'Conteo físico',
  entrada: 'Entrada manual (sin recepción)',
};

const kg = (n: number) => formatQty(n, 'kg');
const signed = (n: number) => `${n > 0 ? '+' : ''}${kg(n)}`;

/** Sección plegable: lo principal queda arriba y lo demás se abre con un toque. */
function Fold({ title, hint, open, testid, children }: { title: string; hint?: string; open?: boolean; testid: string; children: ComponentChildren }) {
  return (
    <details class="fold" open={open} data-testid={testid}>
      <summary>
        {title} {hint && <small>{hint}</small>}
      </summary>
      {children}
    </details>
  );
}

/** Una tabla por dimensión: lo que llegó y se vendió en el periodo, y cuánto queda AHORA (no depende de las fechas). */
function Buckets({ title, rows, testid }: { title: string; rows: Bucket[]; testid: string }) {
  return (
    <div data-testid={testid}>
      <h4>{title}</h4>
      {rows.length === 0 && <p class="hint">Sin datos en este periodo.</p>}
      {rows.map((b) => (
        <div class="brow" key={b.key || '—'} data-testid={`${testid}-row`}>
          <strong class="blabel">{b.label}</strong>
          <span>
            <small>Llegó</small>
            {kg(b.receivedMilli)}
          </span>
          <span>
            <small>Vendí</small>
            {kg(b.soldMilli)}
          </span>
          <span class={b.availableMilli < 0 ? 'neg' : ''}>
            <small>Disponible ahora</small>
            {kg(b.availableMilli)}
            {b.reservedMilli > 0 && <small> (apartado {kg(b.reservedMilli)})</small>}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Resumen de MERCANCÍA (kilos). No es dinero: no mezcla ingresos por ventas con kilos recibidos y no supone
 * ningún pago al proveedor. El corte de caja no cambia por nada de lo que se ve aquí.
 */
export function ResumenMercancia() {
  const { db, version } = useApp();
  const [from, setFrom] = useState(localDay());
  const [to, setTo] = useState(localDay());
  const [report, setReport] = useState<MerchandiseReport | null>(null);

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return;
    let alive = true;
    (async () => {
      const [receptions, sales, stockMoves, products] = await Promise.all([
        listReceptions(db),
        db.getAll('sales'),
        db.getAll('stockMoves'),
        listProducts(db),
      ]);
      if (alive) setReport(buildMerchandiseReport({ from, to, receptions, sales, stockMoves, products }));
    })();
    return () => {
      alive = false;
    };
  }, [db, version, from, to]);

  const range = from > to;
  const L = report?.ledger;

  return (
    <div data-testid="rec-resumen">
      <div class="row2">
        <label class="field">
          <span>Desde</span>
          <input type="date" data-testid="rep-from" value={from} onInput={(e) => setFrom((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span>Hasta</span>
          <input type="date" data-testid="rep-to" value={to} onInput={(e) => setTo((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      <div class="chips small" role="group" aria-label="Periodos">
        <button class="chip" data-testid="rep-today" onClick={() => (setFrom(localDay()), setTo(localDay()))}>
          Hoy
        </button>
        <button class="chip" data-testid="rep-yesterday" onClick={() => (setFrom(addDays(localDay(), -1)), setTo(addDays(localDay(), -1)))}>
          Ayer
        </button>
        <button class="chip" data-testid="rep-week" onClick={() => (setFrom(addDays(localDay(), -6)), setTo(localDay()))}>
          Últimos 7 días
        </button>
      </div>
      {range && <p class="warn">La fecha inicial es posterior a la final.</p>}

      {report && !range && L && (
        <>
          {!L.reconciles && (
            <p class="notice" role="alert" data-testid="rep-ledger-ok">
              ⚠ Las cuentas de este periodo no cuadran con la existencia actual. Entra a Más → Auditar integridad para ver qué pasó.
            </p>
          )}
          <dl class="report">
            <div>
              <dt>
                Llegó ({report.receptionCount} {report.receptionCount === 1 ? 'recepción' : 'recepciones'})
              </dt>
              <dd data-testid="rep-received" data-milli={report.receivedMilli}>{kg(report.receivedMilli)}</dd>
            </div>
            <div>
              <dt>Vendí</dt>
              <dd data-testid="rep-sold" data-milli={report.soldMilli}>{kg(report.soldMilli)}</dd>
            </div>
            {report.soldInPendingValesMilli > 0 && (
              <div>
                <dt>…de ellos en vales por entregar</dt>
                <dd data-testid="rep-sold-vales">{kg(report.soldInPendingValesMilli)}</dd>
              </div>
            )}
            <div class="strong">
              <dt>Disponible ahora (todo el inventario en kg)</dt>
              <dd data-testid="rep-available" data-milli={report.stockNow.availableMilli} class={report.stockNow.availableMilli < 0 ? 'neg' : ''}>
                {kg(report.stockNow.availableMilli)}
              </dd>
            </div>
            <div>
              <dt>En bodega / apartado por vales</dt>
              <dd data-testid="rep-physical">
                {kg(report.stockNow.physicalMilli)} / {kg(report.stockNow.reservedMilli)}
              </dd>
            </div>
          </dl>
          {report.draftCount > 0 && (
            <p class="notice" data-testid="rep-drafts">
              Hay {report.draftCount} {report.draftCount === 1 ? 'borrador' : 'borradores'} sin registrar: no cuentan en estos kilos
              hasta que los confirmes (pestaña Borradores).
            </p>
          )}
          {report.soldOtherUnits.length > 0 && (
            <p class="hint" data-testid="rep-other-units">
              También se vendió por otras unidades (no se convierten a kilos):{' '}
              {report.soldOtherUnits.map((o) => `${o.qtyMilli / 1000} ${o.unit}`).join(', ')}.
            </p>
          )}
          <p class="hint">
            Recibir mercancía no es un pago al proveedor ni un ingreso: aquí solo se cuentan kilos. Un vale cuenta como vendido el
            día que se cobra; los vales cancelados y las ventas anuladas no cuentan.
          </p>

          <Fold title="Lo que llegó" hint={`${kg(report.receivedMilli)}`} open testid="rep-fold-arrivals">
            <dl class="report" data-testid="rep-arrivals">
              <div>
                <dt>Original (al registrar)</dt>
                <dd data-testid="rep-original">{kg(report.receivedOriginalMilli)}</dd>
              </div>
              <div>
                <dt>Correcciones de kilos</dt>
                <dd data-testid="rep-corrections">{signed(report.correctionsMilli)}</dd>
              </div>
              <div class="strong">
                <dt>Llegó (vigente)</dt>
                <dd>{kg(report.receivedMilli)}</dd>
              </div>
              {report.voidedCount > 0 && (
                <div>
                  <dt>
                    {report.voidedCount} {report.voidedCount === 1 ? 'recepción anulada' : 'recepciones anuladas'} (no cuentan)
                  </dt>
                  <dd data-testid="rep-voided">{kg(report.voidedMilli)}</dd>
                </div>
              )}
            </dl>
          </Fold>

          <Fold title="Cuadre del inventario en kilos" hint={L.reconciles ? '✔ cuadra' : '⚠ no cuadra'} open testid="rep-fold-ledger">
            <dl class="report" data-testid="rep-ledger">
              <div>
                <dt>Había al inicio</dt>
                <dd data-testid="rep-ledger-open">{kg(L.openingMilli)}</dd>
              </div>
              <div>
                <dt>+ Recepciones (con correcciones y anulaciones)</dt>
                <dd data-testid="rep-ledger-rec">{signed(L.receptionsMilli)}</dd>
              </div>
              <div>
                <dt>+ Entradas manuales (sin recepción)</dt>
                <dd data-testid="rep-ledger-manual">{signed(L.manualInMilli)}</dd>
              </div>
              <div>
                <dt>− Salió (ventas y entregas de vales)</dt>
                <dd data-testid="rep-ledger-out">{kg(L.outMilli)}</dd>
              </div>
              <div>
                <dt>− Mermas</dt>
                <dd data-testid="rep-ledger-merma">{kg(L.mermasMilli)}</dd>
              </div>
              <div>
                <dt>± Conteos físicos</dt>
                <dd data-testid="rep-ledger-count">{signed(L.countsMilli)}</dd>
              </div>
              <div class="strong">
                <dt>Quedó al final</dt>
                <dd data-testid="rep-ledger-close" data-milli={L.closingMilli}>{kg(L.closingMilli)}</dd>
              </div>
            </dl>
            {L.reconciles && (
              <p class="ok" data-testid="rep-ledger-cuadra">
                ✔ Cuadra con la existencia actual.
              </p>
            )}
          </Fold>

          <Fold title="Por día" hint={`${report.byDay.length} ${report.byDay.length === 1 ? 'día' : 'días'}`} testid="rep-fold-days">
            {report.byDay.length === 0 && <p class="empty">Sin movimientos en este periodo.</p>}
            {report.byDay.map((d) => (
              <div class="line" key={d.day} data-testid="rep-day-row" data-day={d.day}>
                <span>{fmtDay(d.day)}</span>
                <span>
                  llegó <strong>{kg(d.receivedMilli)}</strong> · vendí <strong>{kg(d.soldMilli)}</strong>
                </span>
              </div>
            ))}
          </Fold>

          <Fold title="Desglose: cuánto llegó, cuánto vendí y cuánto queda" testid="rep-fold-breakdown">
            <p class="hint">«Disponible ahora» es lo que queda hoy en bodega para vender (no depende de las fechas).</p>
            <Buckets title="Por producto" rows={report.byVariety} testid="rep-by-variety" />
            <Buckets title="Por origen" rows={report.byOrigin} testid="rep-by-origin" />
            <Buckets title="Por calidad" rows={report.byQuality} testid="rep-by-quality" />
            <Buckets title="Por calibre o tamaño" rows={report.byCaliber} testid="rep-by-caliber" />
            {report.legacySoldMilli > 0 && (
              <p class="hint" data-testid="rep-legacy">
                {kg(report.legacySoldMilli)} de lo vendido son ventas anteriores a la clasificación: aparecen con el nombre con el
                que se vendieron y sin origen, calidad ni calibre.
              </p>
            )}
            <div data-testid="rep-by-packaging">
              <h4>Por presentación de lo que llegó</h4>
              {report.byPackaging.length === 0 && <p class="hint">Sin recepciones en este periodo.</p>}
              {report.byPackaging.map((p) => (
                <div class="line" key={p.packaging} data-testid="rep-by-packaging-row">
                  <span>{PACKAGING_LABEL[p.packaging]}</span>
                  <span>
                    {p.receptions} {p.receptions === 1 ? 'recepción' : 'recepciones'}
                    {p.packaging !== 'granel' &&
                      ` · ${p.containers} ${p.containers === 1 ? CONTAINER_NOUN[p.packaging].one : CONTAINER_NOUN[p.packaging].many}`}
                    {' · '}
                    <strong>{kg(p.receivedMilli)}</strong>
                  </span>
                </div>
              ))}
              <p class="hint">Las cajas y arpillas se cuentan aparte y no se convierten a kilos. Esto no es existencia: es lo que llegó.</p>
            </div>
          </Fold>

          <Fold title="Existencia por producto (ahora)" testid="rep-fold-stock">
            {report.stockNow.rows.length === 0 && <p class="empty">Aún no hay productos en kilos.</p>}
            {report.stockNow.rows.map((r) => (
              <div class="line" key={r.productId} data-testid="rep-stock-row">
                <span>{r.label}</span>
                <span class={r.availableMilli < 0 ? 'neg' : ''}>
                  disp. <strong>{kg(r.availableMilli)}</strong> (en bodega {kg(r.physicalMilli)}
                  {r.reservedMilli > 0 && `, apartado ${kg(r.reservedMilli)}`})
                </span>
              </div>
            ))}
          </Fold>

          <Fold title="Mermas, conteos y entradas manuales" testid="rep-fold-adjust">
            <dl class="report" data-testid="rep-adjust-totals">
              <div>
                <dt>Mermas</dt>
                <dd data-testid="rep-merma">{kg(report.mermasMilli)}</dd>
              </div>
              <div>
                <dt>Conteos físicos (neto)</dt>
                <dd data-testid="rep-conteo">{signed(report.ajustesMilli)}</dd>
              </div>
              <div>
                <dt>Entradas manuales</dt>
                <dd data-testid="rep-manual">{signed(report.manualInMilli)}</dd>
              </div>
            </dl>
            {report.adjustments.length === 0 && <p class="hint">Sin mermas, conteos ni entradas manuales en este periodo.</p>}
            {report.adjustments.map((a) => (
              <p class="hint" key={a.id} data-testid="rep-adjust-row">
                {fmtDateTime(a.at)} · {TYPE_LABEL[a.type] ?? a.type} · {signed(a.deltaMilli)}
                {a.note && ` · ${a.note}`}
              </p>
            ))}
          </Fold>
        </>
      )}
    </div>
  );
}
