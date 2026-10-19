import { normalizeKey } from '../domain/classification';

interface ChipRowProps {
  /** Nombre accesible del grupo (ej. "Calidad"). */
  label: string;
  options: readonly string[];
  /** Valor actual (texto); el chip activo es el que coincide por clave (sin acentos ni mayúsculas). */
  value: string;
  onPick: (v: string) => void;
  /** Chip extra que deja el campo vacío (ej. "No especificada"). */
  noneLabel?: string;
  testid?: string;
  /** Clave de comparación del chip activo (por defecto sin acentos ni mayúsculas); ej. caliberKey para «3 X» ≡ «3X». */
  keyFn?: (s: string) => string;
}

/**
 * Fila de chips que SOLO rellena un campo de texto: el texto sigue siendo la única fuente de verdad, así que
 * cualquier valor personalizado se puede escribir y los chips son atajos de un toque.
 */
export function ChipRow({ label, options, value, onPick, noneLabel, testid, keyFn = normalizeKey }: ChipRowProps) {
  const key = keyFn(value);
  return (
    <div class="chips small" role="radiogroup" aria-label={label} data-testid={testid}>
      {options.map((o) => {
        const active = key !== '' && keyFn(o) === key;
        return (
          <button
            type="button"
            key={o}
            role="radio"
            aria-checked={active}
            class={active ? 'chip active' : 'chip'}
            onClick={() => onPick(active ? '' : o)}
          >
            {o}
          </button>
        );
      })}
      {noneLabel && (
        <button
          type="button"
          role="radio"
          aria-checked={key === ''}
          class={key === '' ? 'chip active muted' : 'chip muted'}
          onClick={() => onPick('')}
        >
          {noneLabel}
        </button>
      )}
    </div>
  );
}
