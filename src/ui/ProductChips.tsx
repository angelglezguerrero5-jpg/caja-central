import { useEffect, useState } from 'preact/hooks';
import { classLabel, varietyKey } from '../domain/classification';
import { formatMoney } from '../domain/money';
import type { Product } from '../domain/types';
import { Sheet } from './Sheet';

interface Props {
  /** Productos entre los que se puede elegir (ya filtrados: activos, solo kg, etc.). */
  products: Product[];
  selectedId: string | undefined;
  onSelect: (p: Product) => void;
  /** Se llama cuando hay que dejar SIN producto elegido (solo con `requireClass`, al cambiar de variedad). */
  onClear?: () => void;
  /** data-testid de los chips de variedad y de clasificación. */
  testids: { variety: string; cls: string };
  /** Marca los productos que aún no tienen precio. */
  flagMissingPrice?: boolean;
  /** Sin producto elegido NO se marca ninguno (por defecto se marca el primero). */
  allowEmpty?: boolean;
  /** Si la variedad tiene varias clasificaciones, no se elige ninguna sola: hay que tocar una. */
  requireClass?: boolean;
  /** Qué producto elegir al tocar una variedad con varias clasificaciones (por defecto, el primero). */
  pickForVariety?: (list: Product[]) => Product;
  /** Más clasificaciones que esto: se muestra solo la elegida y un botón «Ver todas». */
  manyThreshold?: number;
}

/** Texto de un chip de clasificación: "Oaxaca · Primera · 2X", más la unidad si no es kg. */
export function classChipLabel(p: Product): string {
  const base = classLabel(p);
  const unit = p.unit === 'kg' ? '' : p.unit;
  return [base, unit].filter(Boolean).join(' · ') || 'Única';
}

/**
 * Selección en dos pasos y sin formulario: 1) variedad  2) clasificación (procedencia · calidad · calibre),
 * esta última solo si esa variedad tiene más de una combinación. Con muchas combinaciones (> `manyThreshold`) se muestra
 * solo la elegida y una hoja «Ver todas». Una variedad con dos ortografías es UNA sola ficha.
 */
export function ProductChips({
  products,
  selectedId,
  onSelect,
  onClear,
  testids,
  flagMissingPrice,
  allowEmpty,
  requireClass,
  pickForVariety = (l) => l[0],
  manyThreshold = 6,
}: Props) {
  const chosen = products.find((p) => p.id === selectedId);
  const selected = chosen ?? (allowEmpty ? undefined : products[0]);
  const groups = new Map<string, Product[]>();
  for (const p of products) {
    const k = varietyKey(p.name);
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const [openKey, setOpenKey] = useState(() => (selected ? varietyKey(selected.name) : ''));
  const [showAll, setShowAll] = useState(false);
  // Si el producto elegido cambia desde fuera (p. ej. un borrador), el grupo abierto lo sigue.
  useEffect(() => {
    if (chosen) setOpenKey(varietyKey(chosen.name));
  }, [chosen?.id]);
  const activeKey = groups.has(openKey) ? openKey : selected ? varietyKey(selected.name) : '';
  const classes = groups.get(activeKey) ?? [];

  function pickVariety(key: string) {
    const list = groups.get(key)!;
    setOpenKey(key);
    if (requireClass && list.length > 1) {
      if (chosen && varietyKey(chosen.name) !== key) onClear?.();
      return;
    }
    onSelect(pickForVariety(list));
  }
  const many = classes.length > manyThreshold;

  return (
    <>
      <div class="chips" role="group" aria-label="Variedad">
        {[...groups.entries()].map(([key, list]) => {
          const active = key === activeKey && (!!chosen || !allowEmpty);
          return (
            <button
              type="button"
              key={key}
              role="radio"
              aria-checked={active}
              class={active ? 'chip active' : 'chip'}
              data-testid={testids.variety}
              onClick={() => pickVariety(key)}
            >
              {list[0].name}
            </button>
          );
        })}
      </div>
      {classes.length > 1 && !many && (
        <div class="chips small cls" role="group" aria-label="Clasificación: procedencia, calidad y calibre">
          {classes.map((p) => (
            <button
              type="button"
              key={p.id}
              role="radio"
              aria-checked={p.id === chosen?.id}
              class={p.id === chosen?.id ? 'chip active' : 'chip'}
              data-testid={testids.cls}
              onClick={() => onSelect(p)}
            >
              {classChipLabel(p)}
              {flagMissingPrice && p.priceCents === 0 && <small class="warn-text"> · sin precio</small>}
            </button>
          ))}
        </div>
      )}
      {classes.length > 1 && many && (
        <div class="chips small" role="group" aria-label="Clasificación">
          {chosen && varietyKey(chosen.name) === activeKey && (
            <button type="button" class="chip active" data-testid={testids.cls} aria-checked="true" role="radio">
              {classChipLabel(chosen)}
            </button>
          )}
          <button type="button" class="chip" data-testid={`${testids.cls}-all`} onClick={() => setShowAll(true)}>
            Ver las {classes.length} clasificaciones
          </button>
        </div>
      )}
      {requireClass && classes.length > 1 && !chosen && (
        <p class="notice" data-testid={`${testids.cls}-hint`}>
          Elige la clasificación de «{classes[0].name}».
        </p>
      )}
      {showAll && (
        <Sheet
          title="Elige la clasificación"
          testid={`${testids.cls}-sheet`}
          onClose={() => setShowAll(false)}
          foot={
            <div class="actions">
              <button data-testid={`${testids.cls}-sheet-close`} onClick={() => setShowAll(false)}>
                Cerrar
              </button>
            </div>
          }
        >
          {classes.map((p) => (
            <button
              type="button"
              key={p.id}
              class={p.id === chosen?.id ? 'chip active full' : 'chip full'}
              data-testid={`${testids.cls}-sheet-item`}
              onClick={() => {
                onSelect(p);
                setShowAll(false);
              }}
            >
              <strong>{classChipLabel(p)}</strong>
              <small>{p.priceCents > 0 ? `${formatMoney(p.priceCents)}/${p.unit}` : 'sin precio'}</small>
            </button>
          ))}
        </Sheet>
      )}
    </>
  );
}
