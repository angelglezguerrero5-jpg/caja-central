import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { cancelReceptionDraft, listReceptions } from '../db/receptions';
import { listProducts } from '../db/repo';
import { productLabel } from '../domain/classification';
import { formatQty } from '../domain/money';
import { CONTAINER_NOUN, PACKAGING_LABEL, computeNet } from '../domain/reception';
import type { Product, Reception } from '../domain/types';
import { errMsg, useApp } from './ctx';
import { fmtDateTime } from './format';
import { RecepcionHistorial, STATUS_LABEL } from './RecepcionHistorial';
import { RecepcionNueva } from './RecepcionNueva';
import { ResumenMercancia } from './ResumenMercancia';
import './recepcion.css';

type Sub = 'nueva' | 'borradores' | 'historial' | 'resumen';

/** Íconos de las sub-pestañas (trazos simples, decorativos: la etiqueta de texto es la que cuenta). */
const ICON: Record<Sub, JSX.Element> = {
  nueva: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M12 8v8M8 12h8" />
    </>
  ),
  borradores: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  historial: <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />,
  resumen: <path d="M3 20h18M6 20v-8M12 20V5M18 20v-11" />,
};

/**
 * Recepción de mercancía: registrar lo que llega al andén (kilos netos, presentación, clasificación), con borradores,
 * historial auditable y resumen de kilos. La captura de "Nueva" se conserva al mirar otras secciones.
 */
export function Recepcion({ active }: { active: boolean }) {
  const { db, version } = useApp();
  const [sub, setSub] = useState<Sub>('nueva');
  const [draftToLoad, setDraftToLoad] = useState<Reception | null>(null);
  const [draftCount, setDraftCount] = useState(0);

  useEffect(() => {
    listReceptions(db, { status: 'borrador' }).then((d) => setDraftCount(d.length));
  }, [db, version]);

  // Palabras de bodega: lo que se está recibiendo, lo que quedó pendiente, lo que ya entró y los totales.
  const SUBS: Array<[Sub, string]> = [
    ['nueva', 'Nueva entrada'],
    ['borradores', draftCount > 0 ? `Pendientes (${draftCount})` : 'Pendientes'],
    ['historial', 'Entradas anteriores'],
    ['resumen', 'Totales'],
  ];

  return (
    <section data-testid="recepcion">
      <h2>Recepción de mercancía</h2>
      <div class="tabs-state rec-subtabs" role="tablist" aria-label="Recepción">
        {SUBS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={sub === id}
            class={`${sub === id ? 'active' : ''}${id === 'borradores' && draftCount > 0 ? ' has-count' : ''}`}
            data-testid={`rec-sub-${id}`}
            onClick={() => setSub(id)}
          >
            <svg class="rec-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              {ICON[id]}
            </svg>
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div hidden={sub !== 'nueva'}>
        <RecepcionNueva
          active={active && sub === 'nueva'}
          loadDraft={draftToLoad}
          onDraftLoaded={() => setDraftToLoad(null)}
          onGoDrafts={() => setSub('borradores')}
        />
      </div>
      {sub === 'borradores' && (
        <Borradores
          onOpen={(r) => {
            setDraftToLoad(r);
            setSub('nueva');
          }}
        />
      )}
      {sub === 'historial' && (
        <RecepcionHistorial
          onOpenDraft={(d) => {
            setDraftToLoad(d);
            setSub('nueva');
          }}
        />
      )}
      {sub === 'resumen' && <ResumenMercancia />}
    </section>
  );
}

function Borradores({ onOpen }: { onOpen: (r: Reception) => void }) {
  const { db, version, bump, toast } = useApp();
  const [drafts, setDrafts] = useState<Reception[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [discarding, setDiscarding] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [d, p] = await Promise.all([listReceptions(db, { status: 'borrador' }), listProducts(db)]);
      setDrafts(d.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setProducts(p);
    })();
  }, [db, version]);

  async function discard(r: Reception) {
    try {
      await cancelReceptionDraft(db, r.id, 'borrador descartado');
      setDiscarding(null);
      toast('Borrador descartado: no cambió el inventario');
      bump();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }

  return (
    <div data-testid="rec-borradores">
      <p class="hint">
        Aquí quedan las entradas que guardaste para después (borradores), por ejemplo porque aún no sabías el peso. NO suman al
        inventario hasta que las abras y toques «Registrar entrada».
      </p>
      {drafts.length === 0 && <p class="empty">Nada pendiente. No hay borradores.</p>}
      {drafts.map((r) => {
        const prod = products.find((p) => p.id === r.productId);
        const net = computeNet(r);
        const noun = CONTAINER_NOUN[r.packaging];
        return (
          <article class="card" key={r.id} data-testid="rec-draft-row">
            <header>
              <strong>{prod ? productLabel(prod) : 'Sin producto elegido'}</strong>
              <span class="badge">{STATUS_LABEL.borrador}</span>
            </header>
            <p class="hint">
              {PACKAGING_LABEL[r.packaging]}
              {r.containers !== undefined && ` · ${r.containers} ${r.containers === 1 ? noun.one : noun.many}`}
              {r.supplier && ` · ${r.supplier}`}
              {r.reference && ` · ref. ${r.reference}`} · {fmtDateTime(r.receivedAt)}
            </p>
            <p class={net.ok ? 'ok' : 'warn'}>
              {net.ok ? `Kilos netos: ${formatQty(net.netMilli, 'kg')}` : `Falta: ${net.error}`}
            </p>
            {discarding === r.id ? (
              <div class="actions">
                <span class="hint">¿Descartar este borrador? Queda en el historial como descartado.</span>
                <button class="danger" data-testid="rec-draft-cancel-yes" onClick={() => discard(r)}>
                  Sí, descartar
                </button>
                <button data-testid="rec-draft-cancel-no" onClick={() => setDiscarding(null)}>
                  No
                </button>
              </div>
            ) : (
              <div class="actions">
                <button class="primary" data-testid="rec-draft-open" onClick={() => onOpen(r)}>
                  Abrir y completar
                </button>
                <button class="danger" data-testid="rec-draft-cancel" onClick={() => setDiscarding(r.id)}>
                  Descartar
                </button>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
