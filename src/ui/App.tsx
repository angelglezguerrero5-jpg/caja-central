import { useCallback, useEffect, useState } from 'preact/hooks';
import { openDatabase, seedIfEmpty, type DB } from '../db/repo';
import { Ctx, errMsg } from './ctx';
import { Caja } from './Caja';
import { Vales } from './Vales';
import { Inventario } from './Inventario';
import { Corte } from './Corte';
import { Mas } from './Mas';

type Tab = 'caja' | 'vales' | 'inventario' | 'corte' | 'mas';
const TABS: Array<[Tab, string]> = [
  ['caja', 'Caja'],
  ['vales', 'Vales'],
  ['inventario', 'Inventario'],
  ['corte', 'Corte'],
  ['mas', 'Más'],
];

export function App() {
  const [db, setDb] = useState<DB | null>(null);
  const [fatal, setFatal] = useState('');
  const [tab, setTab] = useState<Tab>('caja');
  const [version, setVersion] = useState(0);
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'error' } | null>(null);
  const [online, setOnline] = useState(navigator.onLine);

  const showToast = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => {
    setToast({ msg, kind });
    window.setTimeout(() => setToast((t) => (t?.msg === msg ? null : t)), kind === 'error' ? 5000 : 2200);
  }, []);
  useEffect(() => {
    openDatabase()
      .then(async (d) => {
        await seedIfEmpty(d);
        setDb(d);
      })
      .catch((e) => setFatal(errMsg(e)));
    // Cualquier fallo no previsto (p. ej. de almacenamiento) se muestra, nunca se pierde en silencio.
    const onRejection = (ev: PromiseRejectionEvent) => showToast(`Error inesperado: ${errMsg(ev.reason)}`, 'error');
    window.addEventListener('unhandledrejection', onRejection);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  if (fatal) {
    return (
      <div class="fatal" role="alert">
        <h1>No se pudo abrir la base de datos</h1>
        <p>{fatal}</p>
        <p>Cierra otras pestañas de la app y recarga. No se perdió ningún dato.</p>
      </div>
    );
  }
  if (!db) return <p class="loading">Cargando caja…</p>;

  return (
    <Ctx.Provider value={{ db, version, bump, toast: showToast }}>
      <header class="top">
        <strong>🍋 Venta de Limones</strong>
        <span class={online ? 'net on' : 'net off'} data-testid="net">
          {online ? 'En línea' : 'Sin internet · funciona igual'}
        </span>
      </header>
      <main>
        {tab === 'caja' && <Caja />}
        {tab === 'vales' && <Vales />}
        {tab === 'inventario' && <Inventario />}
        {tab === 'corte' && <Corte />}
        {tab === 'mas' && <Mas />}
      </main>
      <nav class="tabs" aria-label="Secciones">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            class={tab === id ? 'tab active' : 'tab'}
            data-testid={`tab-${id}`}
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {toast && (
        <div class={`toast ${toast.kind}`} role="status" data-testid="toast">
          {toast.msg}
        </div>
      )}
    </Ctx.Provider>
  );
}
