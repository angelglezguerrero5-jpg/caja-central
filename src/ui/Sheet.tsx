import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { NegativeStockError } from '../db/repo';
import { formatQty } from '../domain/money';

interface OpenSheet {
  el: HTMLElement;
  /** Ejecuta el «Volver» de la hoja; false si ahora no se puede cerrar (p. ej. se está guardando). */
  close: () => boolean;
}
/** Hojas abiertas, de la más antigua a la más reciente (la última es la que recibe toques y la tecla Escape). */
const openSheets: OpenSheet[] = [];

/**
 * Escape cierra la hoja de más arriba, esté donde esté el foco (aunque aún no haya entrado a la hoja o haya quedado en la
 * página): por eso el oyente es del documento y no de la hoja.
 */
function onEscape(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const top = openSheets[openSheets.length - 1];
  if (top?.close()) e.preventDefault();
}

/**
 * Mientras hay una hoja abierta, todo lo demás de la pantalla queda `inert`: sin toques, sin foco, sin lector de pantalla.
 * Se marca como inerte cada «hermano» de la hoja y de sus ancestros, NO un contenedor fijo: las hojas se pintan dentro de
 * <main>, y poner `inert` en <main> la dejaría inerte también a ella (los botones no responderían).
 */
function refreshInert() {
  for (const el of Array.from(document.querySelectorAll('[data-sheet-inert]'))) {
    el.removeAttribute('inert');
    el.removeAttribute('data-sheet-inert');
  }
  const top = openSheets[openSheets.length - 1]?.el;
  if (!top) return;
  for (let node: Element | null = top; node && node !== document.body && node.parentElement; node = node.parentElement) {
    for (const sibling of Array.from(node.parentElement!.children)) {
      if (sibling === node || sibling.classList.contains('toast') || sibling.tagName === 'SCRIPT') continue;
      sibling.setAttribute('inert', '');
      sibling.setAttribute('data-sheet-inert', '');
    }
  }
}

/** Tiempo en que se ignoran los toques tras abrir o cerrar una hoja (un doble toque dura menos que esto). */
export const SHIELD_MS = 450;
let shieldTimer = 0;
/**
 * Escudo contra el «toque fantasma»: un doble toque rápido no debe caer sobre lo que aparece o desaparece justo debajo del
 * dedo (p. ej. el «Confirmar» de una hoja recién abierta, que queda donde estaba «Registrar recepción», o las pestañas al
 * cerrarse la hoja). Durante este tiempo la pantalla de fondo ignora los toques (clase `shield` en <html>).
 */
export function shieldTaps() {
  const root = document.documentElement;
  root.classList.add('shield');
  window.clearTimeout(shieldTimer);
  shieldTimer = window.setTimeout(() => root.classList.remove('shield'), SHIELD_MS);
}

/**
 * Hoja modal de abajo hacia arriba: título, cuerpo desplazable y PIE FIJO con los botones (siempre alcanzables, aunque el
 * contenido sea largo). Al abrir mueve el foco a la acción principal (el último botón HABILITADO del pie, o la propia hoja)
 * y al cerrar lo devuelve (a `returnFocus`, o a donde estaba; si ese control ya no existe, a la pantalla). `onClose` es lo
 * que hace la tecla Escape (equivale a «Volver»); no se pasa mientras se está guardando. Los botones del pie ignoran los
 * toques los primeros instantes (ver `shieldTaps`).
 */
export function Sheet({
  title,
  testid,
  children,
  foot,
  onClose,
  returnFocus,
}: {
  title: string;
  testid: string;
  children: ComponentChildren;
  foot?: ComponentChildren;
  onClose?: () => void;
  returnFocus?: () => HTMLElement | null | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const back = useRef(returnFocus);
  back.current = returnFocus;
  const closer = useRef(onClose);
  closer.current = onClose;
  // useLayoutEffect: la hoja nace ya armada, con el foco dentro y con Escape activo antes del primer pintado.
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const mine = overlay.current;
    const box = ref.current;
    let entry: OpenSheet | undefined;
    if (mine) {
      entry = {
        el: mine,
        close: () => {
          if (!closer.current) return false;
          closer.current();
          return true;
        },
      };
      if (openSheets.length === 0) document.addEventListener('keydown', onEscape);
      openSheets.push(entry);
      refreshInert();
    }
    // Abierta hace un instante: sus botones aún no reciben toques (el segundo toque de un doble toque no debe confirmar).
    box?.classList.add('arming');
    const armed = window.setTimeout(() => box?.classList.remove('arming'), SHIELD_MS);
    const buttons = Array.from(box?.querySelectorAll<HTMLElement>('.sheet-foot button:not(:disabled)') ?? []);
    (buttons[buttons.length - 1] ?? box)?.focus();
    return () => {
      window.clearTimeout(armed);
      const at = entry ? openSheets.indexOf(entry) : -1;
      if (at >= 0) openSheets.splice(at, 1);
      if (openSheets.length === 0) document.removeEventListener('keydown', onEscape);
      refreshInert();
      shieldTaps();
      const target = back.current?.() ?? previous;
      if (target && document.contains(target)) target.focus();
      else document.querySelector<HTMLElement>('main')?.focus();
    };
  }, []);
  return (
    <div
      class="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testid}
      ref={overlay}
    >
      <div class="sheet split" ref={ref} tabIndex={-1}>
        <h2>{title}</h2>
        <div class="sheet-body">{children}</div>
        {foot && <div class="sheet-foot">{foot}</div>}
      </div>
    </div>
  );
}

/**
 * Autorización explícita cuando una operación dejaría el disponible en negativo. Muestra el efecto
 * ("quedarán −30 kg") antes de continuar; nunca se autoriza sola.
 */
export function AuthorizeSheet({
  error,
  busy,
  onCancel,
  onAuthorize,
}: {
  error: NegativeStockError;
  busy: boolean;
  onCancel: () => void;
  onAuthorize: () => void;
}) {
  return (
    <Sheet
      title="Se necesita tu autorización"
      testid="authorize-sheet"
      onClose={busy ? undefined : onCancel}
      foot={
        <div class="actions two">
          <button data-testid="authorize-no" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button class="danger" data-testid="authorize-yes" onClick={onAuthorize} disabled={busy}>
            {busy ? 'Guardando…' : 'Autorizar y continuar'}
          </button>
        </div>
      }
    >
      <p class="warn" role="alert" data-testid="authorize-text">
        ⚠ «{error.label}» quedaría con {formatQty(error.availableAfterMilli, 'kg')} disponibles.
        {error.reservedMilli > 0 && ` Hay ${formatQty(error.reservedMilli, 'kg')} apartados por vales.`}
      </p>
      <p class="hint">
        Eso significa que ya se vendió o se apartó más de lo que quedaría en bodega. Autoriza solo si ya revisaste el
        inventario; el movimiento queda registrado.
      </p>
    </Sheet>
  );
}

/**
 * Avisos que hay que reconocer antes de continuar (conteo posterior, posible doble conteo...). Se muestran en ámbar
 * —no son errores— y el botón principal dice claramente qué se está aceptando.
 */
export function WarningsSheet({
  title = 'Revisa antes de continuar',
  warnings,
  busy,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title?: string;
  warnings: string[];
  busy: boolean;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Sheet
      title={title}
      testid="warnings-sheet"
      onClose={busy ? undefined : onCancel}
      foot={
        <div class="actions two">
          <button data-testid="warnings-no" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button class="primary" data-testid="warnings-yes" onClick={onConfirm} disabled={busy}>
            {busy ? 'Guardando…' : confirmLabel}
          </button>
        </div>
      }
    >
      <div class="notice" role="alert" data-testid="warnings-text">
        <ul>
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}
