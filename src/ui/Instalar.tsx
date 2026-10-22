import { BRAND } from '../brand';
import { Sheet } from './Sheet';

/**
 * Cómo instalar la app en la pantalla de inicio del iPhone, y el aviso que lo recuerda mientras se usa dentro de Safari.
 * Los pasos describen el flujo de Safari en iPhone (iOS 26 añadió el interruptor «Abrir como app web»); los nombres exactos
 * de los menús pueden variar según la versión de iOS, y no se han podido comprobar en un iPhone físico.
 */
export function InstallSteps() {
  return (
    <ol data-testid="install-steps">
      <li>Abre esta página en <strong>Safari</strong> (no en Chrome ni en el navegador interno de otra app).</li>
      <li>
        Toca el botón <strong>Compartir</strong> (un cuadro con una flecha hacia arriba). En algunas versiones de iOS está
        dentro del menú «…».
      </li>
      <li>Elige <strong>«Añadir a pantalla de inicio»</strong>.</li>
      <li>Si aparece el interruptor <strong>«Abrir como app web»</strong>, déjalo encendido.</li>
      <li>Toca <strong>«Añadir»</strong>. Desde ahora abre la app con el ícono nuevo (<strong>{BRAND.short}</strong>), no desde Safari.</li>
    </ol>
  );
}

/** Aviso fijo bajo el encabezado: solo en iPhone/iPad y solo si la app NO está abierta desde la pantalla de inicio. */
export function InstallNotice({ onHelp, onClose }: { onHelp: () => void; onClose: () => void }) {
  return (
    <div class="notice install" role="status" data-testid="install-notice">
      <strong>Estás usando la app en Safari.</strong> En iPhone, lo que captures aquí <strong>no aparece</strong> en la app
      instalada (son almacenes distintos). Instálala en la pantalla de inicio <strong>antes</strong> de capturar datos reales.
      <div class="actions">
        <button class="small" data-testid="install-help" onClick={onHelp}>
          Cómo instalarla
        </button>
        <button class="small" data-testid="install-dismiss" onClick={onClose}>
          Entendido
        </button>
      </div>
    </div>
  );
}

export function InstallSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet
      title="Instalar en el iPhone"
      testid="install-sheet"
      onClose={onClose}
      foot={
        <div class="actions">
          <button class="primary" data-testid="install-sheet-close" onClick={onClose}>
            Entendido
          </button>
        </div>
      }
    >
      <InstallSteps />
      <p class="notice">
        Lo que ya capturaste en Safari <strong>no pasa solo</strong> a la app instalada. Si ya tienes datos aquí, exporta un respaldo
        (<strong>Más → Respaldo</strong>) y restáuralo dentro de la app instalada.
      </p>
      <p class="hint">
        Haz un respaldo seguido: es la única copia de tus datos. Safari puede borrar los datos de un sitio que no se usa en varios
        días; Apple dice que las apps de la pantalla de inicio no entran en esa regla, pero un respaldo reciente es la única
        garantía.
      </p>
    </Sheet>
  );
}
