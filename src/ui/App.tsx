import { BRAND } from '../brand';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { openDatabase, type DB } from '../db/repo';
import { Ctx, errMsg } from './ctx';
import { Caja } from './Caja';
import { EmergencyDump } from './Emergency';
import { Vales } from './Vales';
import { Inventario } from './Inventario';
import { Corte } from './Corte';
import { Mas } from './Mas';
import { Recepcion } from './Recepcion';
import { InstallNotice, InstallSheet } from './Instalar';
import { isIOS, isStandalone } from './platform';

type Tab = 'caja' | 'vales' | 'recepcion' | 'inventario' | 'corte' | 'mas';
/** Pestañas de arriba. Recepción y Más viven en el menú de los tres puntos (MENU_ITEMS). */
const TABS: Array<[Tab, string, string]> = [
  ['caja', 'Caja', '🛒'],
  ['vales', 'Vales', '🎟️'],
  ['inventario', 'Inventario', '📦'],
  ['corte', 'Corte', '🧾'],
];
const MENU_ITEMS: Array<[Tab, string, string]> = [
  ['recepcion', 'Recepción de mercancía', '🚚'],
  ['mas', 'Más (respaldo y ayuda)', '⚙️'],
];

/** Qué decirle a la persona cuando la base no abre (sin jerga y sin culparla). */
function fatalHelp(e: unknown): string {
  const name = (e as { name?: string } | null)?.name;
  if (name === 'VersionError') return errMsg(e);
  if (name === 'AbortError') {
    return 'La actualización de los datos no se pudo completar. No se perdió nada: los datos siguen como estaban. Cierra la app por completo y ábrela otra vez; si vuelve a pasar, descarga la copia de emergencia y pide ayuda.';
  }
  return errMsg(e);
}

export function App() {
  const [db, setDb] = useState<DB | null>(null);
  const [fatal, setFatal] = useState<unknown>(null);
  const [stale, setStale] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [upgradedFrom, setUpgradedFrom] = useState<number | null>(null);
  const [newVersion, setNewVersion] = useState(false);
  const [tab, setTabState] = useState<Tab>('caja');
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  const [version, setVersion] = useState(0);
  const [drafts, setDrafts] = useState(0);
  const [toast, setToast] = useState<{ id: number; msg: string; kind: 'ok' | 'error' } | null>(null);
  const toastSeq = useRef(0);
  const [online, setOnline] = useState(navigator.onLine);
  const opened = useRef(false);
  // iPhone: dentro de Safari los datos NO son los de la app instalada. Se avisa una vez por sesión (se puede cerrar).
  const [installHelp, setInstallHelp] = useState(false);
  const [installDismissed, setInstallDismissed] = useState(false);
  const showInstall = !installDismissed && isIOS() && !isStandalone();
  // Reconexión: el sistema puede cerrar la conexión a IndexedDB de una app suspendida (pasa en iPhone). Estas referencias
  // dejan que los oyentes de abajo vean siempre la conexión y el estado actuales.
  const dbRef = useRef<DB | null>(null);
  const staleRef = useRef(false);
  const reopening = useRef(false);
  const reopenRef = useRef<() => void>(() => undefined);
  dbRef.current = db;
  staleRef.current = stale;

  const showToast = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => {
    // Cada aviso lleva su propio número: si dos avisos iguales salen seguidos, el temporizador del primero no borra al segundo.
    const id = ++toastSeq.current;
    setToast({ id, msg, kind });
    // Con ruido, sol o guantes el aviso visual no basta: una vibración corta confirma, una doble avisa de un error.
    try {
      navigator.vibrate?.(kind === 'ok' ? 40 : [60, 40, 60]);
    } catch {
      /* sin vibración */
    }
    window.setTimeout(() => setToast((t) => (t?.id === id ? null : t)), kind === 'error' ? 8000 : 2400);
  }, []);
  // Al cambiar de pestaña larga se empieza arriba (Caja y Recepción recuerdan dónde estaban).
  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    if (t !== 'caja' && t !== 'recepcion') window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    // Vuelve a abrir la base si el sistema cerró la conexión (nunca si otra ventana con una versión nueva la pidió).
    reopenRef.current = () => {
      if (reopening.current || staleRef.current) return;
      reopening.current = true;
      openDatabase(undefined, {
        onBlocking: () => {
          staleRef.current = true;
          setStale(true);
        },
        onTerminated: () => reopenRef.current(),
      })
        .then((d) => {
          setDb(d);
          setVersion((v) => v + 1); // las pantallas releen sus datos con la conexión nueva
        })
        .catch((e) => setFatal(e ?? new Error('No se pudo abrir la base de datos')))
        .finally(() => {
          reopening.current = false;
        });
    };
    // Al volver a la app (o al restaurarla de la caché de páginas) se comprueba que la conexión siga viva. Abrir una
    // transacción de lectura en una conexión cerrada falla al instante; en una viva no hace nada.
    const probe = () => {
      const d = dbRef.current;
      if (!d || staleRef.current || reopening.current) return;
      try {
        d.transaction('meta', 'readonly').done.catch(() => undefined);
      } catch {
        reopenRef.current();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') probe();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', probe);
    window.addEventListener('focus', probe);
    openDatabase(undefined, {
      // Otra ventana con una versión NUEVA de la app necesita la base: esta se cierra y pide recargar.
      onBlocking: () => {
        staleRef.current = true;
        setStale(true);
      },
      // Esta ventana es la nueva y otra con la versión anterior sigue abierta: se avisa solo si tarda.
      onBlocked: () => window.setTimeout(() => !opened.current && setBlocked(true), 2500),
      onUpgrade: (from) => setUpgradedFrom(from),
      onTerminated: () => reopenRef.current(),
    })
      .then((d) => {
        opened.current = true;
        setBlocked(false);
        setDb(d);
      })
      .catch((e) => setFatal(e ?? new Error('No se pudo abrir la base de datos')));
    // Cualquier fallo no previsto (p. ej. de almacenamiento) se muestra, nunca se pierde en silencio.
    const onRejection = (ev: PromiseRejectionEvent) => showToast(`Error inesperado: ${errMsg(ev.reason)}`, 'error');
    window.addEventListener('unhandledrejection', onRejection);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    const onUpdate = () => setNewVersion(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    window.addEventListener(`${BRAND.ns}:update`, onUpdate);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      window.removeEventListener(`${BRAND.ns}:update`, onUpdate);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', probe);
      window.removeEventListener('focus', probe);
    };
  }, []);

  // Varias ventanas de la app (p. ej. la instalada y una pestaña del navegador) comparten la base: cuando una escribe,
  // las demás refrescan lo que muestran (la base ya es la misma; solo faltaba avisarles).
  const channel = useMemo(() => (typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`${BRAND.id}-db`)), []);
  useEffect(() => {
    if (!channel) return;
    channel.onmessage = () => setVersion((v) => v + 1);
    return () => channel.close();
  }, [channel]);
  const bump = useCallback(() => {
    setVersion((v) => v + 1);
    try {
      channel?.postMessage('changed');
    } catch {
      /* canal cerrado */
    }
  }, [channel]);

  // Borradores pendientes: un contador en la pestaña para que no se queden olvidados sin sumar al inventario.
  useEffect(() => {
    if (!db || stale) return;
    db.countFromIndex('receptions', 'byStatus', 'borrador')
      .then(setDrafts)
      .catch(() => undefined);
  }, [db, version, stale]);

  if (fatal) {
    return (
      <div class="fatal" role="alert" data-testid="fatal">
        <h1>No se pudo abrir la base de datos</h1>
        <p data-testid="fatal-help">{fatalHelp(fatal)}</p>
        <p>
          Cierra otras ventanas de la app y vuelve a abrirla. <strong>No borres los datos de la app ni la desinstales</strong>:
          primero descarga la copia de emergencia.
        </p>
        <EmergencyDump />
        <details>
          <summary>Detalle técnico</summary>
          <p class="hint">{String((fatal as { name?: string })?.name ?? 'Error')}: {errMsg(fatal)}</p>
        </details>
      </div>
    );
  }
  if (stale) {
    return (
      <div class="fatal stale" role="alert" data-testid="stale">
        <h1>La app se actualizó</h1>
        <p>Hay una versión nueva abierta en otra ventana. Esta ya no puede guardar datos para no estorbar.</p>
        <button class="primary" data-testid="reload" onClick={() => location.reload()}>
          Recargar para continuar
        </button>
      </div>
    );
  }
  if (!db) {
    return (
      <div class="loading">
        <p>Cargando caja…</p>
        {blocked && (
          <p class="warn" role="alert" data-testid="blocked">
            Hay otra ventana de la app abierta con una versión anterior y no deja actualizar los datos. Ciérrala (o cierra la app
            por completo) y esta continuará sola.
          </p>
        )}
      </div>
    );
  }

  return (
    <Ctx.Provider value={{ db, version, bump, toast: showToast }}>
      <div class="topbar">
        <header class="top">
          <img src="/icons/logo.svg" alt="" width="32" height="32" class="brand-logo" />
          <strong>{BRAND.name}</strong>
          <span class={online ? 'net on' : 'net off'} data-testid="net" title={online ? undefined : 'La app funciona igual sin internet'}>
            {online ? 'En línea' : 'Sin internet'}
          </span>
          <button
            class={tab === 'recepcion' || tab === 'mas' ? 'menu-btn active' : 'menu-btn'}
            data-testid="menu-btn"
            aria-label={drafts > 0 ? `Más secciones, ${drafts} ${drafts === 1 ? 'borrador pendiente' : 'borradores pendientes'}` : 'Más secciones'}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
            {drafts > 0 && (
              <span class="count" data-testid="menu-count" aria-hidden="true">
                {drafts}
              </span>
            )}
          </button>
        </header>
        <nav class="tabs" aria-label="Secciones">
          {TABS.map(([id, label, icon]) => (
            <button
              key={id}
              class={tab === id ? 'tab active' : 'tab'}
              data-testid={`tab-${id}`}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => setTab(id)}
            >
              <span class="ico" aria-hidden="true">{icon}</span>
              <span class="lbl">{label}</span>
            </button>
          ))}
        </nav>
        {menuOpen && (
          <>
            <div class="menu-backdrop" data-testid="menu-backdrop" onClick={() => setMenuOpen(false)} />
            <div class="menu" role="menu" aria-label="Más secciones" data-testid="menu">
              {MENU_ITEMS.map(([id, label, icon]) => (
                <button
                  key={id}
                  role="menuitem"
                  class={tab === id ? 'menu-item active' : 'menu-item'}
                  data-testid={`menu-${id}`}
                  aria-current={tab === id ? 'page' : undefined}
                  aria-label={id === 'recepcion' && drafts > 0 ? `${label}, ${drafts} ${drafts === 1 ? 'borrador pendiente' : 'borradores pendientes'}` : label}
                  onClick={() => {
                    setMenuOpen(false);
                    setTab(id);
                  }}
                >
                  <span class="ico" aria-hidden="true">{icon}</span>
                  <span class="lbl">{label}</span>
                  {id === 'recepcion' && drafts > 0 && (
                    <span class="count inline" data-testid="menu-recepcion-count" aria-hidden="true">
                      {drafts}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      {upgradedFrom !== null && (
        <div class="notice upgraded" role="status" data-testid="upgraded">
          {upgradedFrom < 2 ? (
            <>
              La app se actualizó: ahora puedes registrar la mercancía que llega en <strong>Recepción</strong> y llevar el control de
              pesaje de tus fletes en <strong>Inventario → Fletes</strong>. Tus ventas, vales, precios e inventario siguen igual. Te
              conviene exportar un respaldo ahora.
            </>
          ) : (
            <>
              La app se actualizó: ahora puedes llevar el control de pesaje de tus fletes en <strong>Inventario → Fletes</strong>. Tus
              ventas, vales, precios, inventario y recepciones siguen igual. Te conviene exportar un respaldo ahora.
            </>
          )}{' '}
          <button
            class="link"
            data-testid="upgraded-go"
            onClick={() => {
              setTab('mas');
              setUpgradedFrom(null);
            }}
          >
            Ir a Respaldo
          </button>{' '}
          <button class="link" data-testid="upgraded-close" onClick={() => setUpgradedFrom(null)}>
            Cerrar
          </button>
        </div>
      )}
      {newVersion && (
        <div class="notice" role="status" data-testid="new-version">
          Hay una versión nueva de la app. Tus datos no se tocan. No se recarga sola para no perder lo que estás capturando:
          actualiza cuando termines.{' '}
          <button class="link" data-testid="new-version-reload" onClick={() => location.reload()}>
            Actualizar ahora
          </button>{' '}
          <button class="link" data-testid="new-version-later" onClick={() => setNewVersion(false)}>
            Después
          </button>
        </div>
      )}
      {showInstall && <InstallNotice onHelp={() => setInstallHelp(true)} onClose={() => setInstallDismissed(true)} />}
      <main tabIndex={-1}>
        <div hidden={tab !== 'caja'}>
          <Caja active={tab === 'caja'} />
        </div>
        {tab === 'vales' && <Vales />}
        <div hidden={tab !== 'recepcion'}>
          <Recepcion active={tab === 'recepcion'} />
        </div>
        {tab === 'inventario' && <Inventario />}
        {tab === 'corte' && <Corte />}
        {tab === 'mas' && <Mas />}
      </main>
      {installHelp && <InstallSheet onClose={() => setInstallHelp(false)} />}
      {toast && (
        <div class={`toast ${toast.kind}`} role="status" data-testid="toast">
          {toast.msg}
        </div>
      )}
    </Ctx.Provider>
  );
}
