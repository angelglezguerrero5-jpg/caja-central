import { useEffect, useState } from 'preact/hooks';
import { listProducts, saveProduct } from '../db/repo';
import {
  CALIBER_NUMBER_PRESETS,
  ORIGIN_PRESETS,
  QUALITY_PRESETS,
  SIZE_PRESETS,
  UNSPECIFIED,
  VARIETY_PRESETS,
  caliberKey,
  canonicalizeClass,
  classificationKey,
  customValues,
  knownValues,
  productLabel,
  varietyKey,
} from '../domain/classification';
import { formatMoney, parsePrice } from '../domain/money';
import type { Product, Unit } from '../domain/types';
import { ChipRow } from './Chips';
import { errMsg, useApp } from './ctx';

const centsToText = (c: number) => (c === 0 ? '' : c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));

interface Props {
  /** Si se pasa, el formulario EDITA ese producto en lugar de crear uno. */
  initial?: Product;
  onSaved?: (p: Product) => void;
  onCancel?: () => void;
  /**
   * Prefijo de los data-testid (new- en el alta global, edit- en edición en línea, recnew- en Recepción): así no se
   * repiten identificadores cuando hay dos formularios montados a la vez. El prefijo «new» conserva add-product / edit-cancel.
   */
  idPrefix?: string;
  /** Unidad fija (p. ej. «kg» al dar de alta desde Recepción): no se pregunta. */
  fixedUnit?: Unit;
  /** El precio se puede dejar para después (marcado por defecto): al recibir mercancía no hace falta. */
  defaultNoPrice?: boolean;
}

/**
 * Alta / edición de una clasificación de limón: variedad · origen · calidad · calibre · unidad · precio.
 * La app NO trae variedades ni precios de ejemplo. Todo se puede dejar sin especificar salvo la variedad.
 * Los chips (presets y valores ya usados, como "Torreones") solo rellenan los campos de texto.
 */
export function NuevaVariedad({ initial, onSaved, onCancel, idPrefix = 'new', fixedUnit, defaultNoPrice }: Props) {
  const { db, version, bump, toast } = useApp();
  const [name, setName] = useState(initial?.name ?? '');
  const [origin, setOrigin] = useState(initial?.origin ?? '');
  const [quality, setQuality] = useState(initial?.quality ?? '');
  const [caliber, setCaliber] = useState(initial?.caliber ?? '');
  const [unit, setUnit] = useState<Unit>(fixedUnit ?? initial?.unit ?? 'kg');
  const [price, setPrice] = useState(initial ? centsToText(initial.priceCents) : '');
  const [noPrice, setNoPrice] = useState(initial ? initial.priceCents === 0 : !!defaultNoPrice);
  const [all, setAll] = useState<Product[]>([]);
  const [saving, setSaving] = useState(false);
  const editing = !!initial;
  const id = (k: string) => `${idPrefix}-${k}`;
  const addId = idPrefix === 'new' ? 'add-product' : id('add');
  const cancelId = idPrefix === 'new' ? 'edit-cancel' : id('cancel');

  useEffect(() => {
    listProducts(db).then(setAll);
  }, [db, version]);

  async function save() {
    if (saving) return;
    const cents = noPrice ? 0 : parsePrice(price);
    if (!noPrice && !cents) {
      return toast('Escribe el precio por unidad (mayor a cero) o marca «Sin precio todavía»', 'error');
    }
    setSaving(true);
    try {
      const saved = await saveProduct(db, {
        ...(initial ? { id: initial.id } : {}),
        name, origin, quality, caliber, unit,
        priceCents: cents ?? 0,
        pendingPrice: noPrice,
        active: initial?.active ?? true,
      });
      if (!editing) {
        setName('');
        setOrigin('');
        setQuality('');
        setCaliber('');
        setPrice('');
        setNoPrice(!!defaultNoPrice);
        setUnit(fixedUnit ?? 'kg'); // cada alta empieza en kg: la unidad de la anterior no se hereda
      }
      toast(editing ? 'Clasificación actualizada' : 'Variedad agregada');
      bump();
      onSaved?.(saved);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setSaving(false);
    }
  }

  // Los valores propios (ej. «Torreones») solo se sugieren dentro de la variedad en la que ya se usaron; los atajos
  // confirmados (Primera, 2X, Oaxaca…) valen para todas. Así nada se «hereda» a otra variedad sin que lo decidas.
  const known = knownValues(all);
  const sameVariety = (p: Product) => varietyKey(name) === '' || varietyKey(p.name) === varietyKey(name);
  const inVariety = knownValues(all.filter(sameVariety));
  const customVarieties = customValues(known.varieties, VARIETY_PRESETS, varietyKey);
  const customOrigins = customValues(inVariety.origins, ORIGIN_PRESETS);
  const customQualities = customValues(inVariety.qualities, QUALITY_PRESETS);
  const customCalibers = customValues(inVariety.calibers, [...SIZE_PRESETS, ...CALIBER_NUMBER_PRESETS], caliberKey);

  // Vista previa de cómo quedará y aviso de duplicado ANTES de guardar. Se calcula con la MISMA función que usa el guardado
  // (alias, «no especificado», ortografía de los atajos), así la vista previa dice exactamente lo que se va a guardar.
  const candidate = { ...canonicalizeClass(all, { name, origin, quality, caliber }, initial), unit };
  const preview = candidate.name ? productLabel(candidate) : '';
  const dup = candidate.name
    ? all.find((p) => p.id !== initial?.id && classificationKey(p) === classificationKey(candidate))
    : undefined;

  const text = { autoComplete: 'off', autoCapitalize: 'words', spellCheck: false, enterKeyHint: 'next' } as const;

  return (
    <div class="inline-form classify" data-testid={id('variety')}>
      <div class="field">
        <span>Tipo de limón (variedad)</span>
        <ChipRow
          label="Variedad"
          testid={id('chips-variety')}
          options={[...VARIETY_PRESETS, ...customVarieties]}
          value={name}
          keyFn={varietyKey}
          onPick={setName}
        />
        <input
          data-testid={id('name')}
          aria-label="Tipo de limón, escribirlo"
          placeholder="Sin semilla, Con semilla u otra…"
          value={name}
          {...text}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="field">
        <span>Origen del limón (opcional)</span>
        <ChipRow
          label="Origen"
          testid={id('chips-origin')}
          options={[...ORIGIN_PRESETS, ...customOrigins]}
          noneLabel={UNSPECIFIED.origin}
          value={origin}
          onPick={setOrigin}
        />
        <input
          data-testid={id('origin')}
          aria-label="Otro origen, escribirlo"
          placeholder="Otro origen…"
          value={origin}
          {...text}
          onInput={(e) => setOrigin((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="field">
        <span>Calidad (opcional)</span>
        <ChipRow
          label="Calidad"
          testid={id('chips-quality')}
          options={[...QUALITY_PRESETS, ...customQualities]}
          noneLabel={UNSPECIFIED.quality}
          value={quality}
          onPick={setQuality}
        />
        <input
          data-testid={id('quality')}
          aria-label="Otra calidad, escribirla"
          placeholder="Otra calidad…"
          value={quality}
          {...text}
          onInput={(e) => setQuality((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="field">
        <span>Calibre o tamaño (opcional)</span>
        <ChipRow label="Tamaño" testid={id('chips-size')} options={SIZE_PRESETS} value={caliber} keyFn={caliberKey} onPick={setCaliber} />
        <ChipRow
          label="Calibre"
          testid={id('chips-caliber')}
          options={[...CALIBER_NUMBER_PRESETS, ...customCalibers]}
          noneLabel={UNSPECIFIED.caliber}
          value={caliber}
          keyFn={caliberKey}
          onPick={setCaliber}
        />
        <input
          inputMode="text"
          data-testid={id('caliber')}
          aria-label="Otro calibre, escribirlo"
          placeholder="Otro calibre…"
          value={caliber}
          {...text}
          autoCapitalize="characters"
          enterKeyHint="done"
          onInput={(e) => setCaliber((e.target as HTMLInputElement).value)}
        />
        <p class="help">
          Si usas un nombre propio (por ejemplo «Torreones»), escríbelo en Calidad o en Calibre, donde tú lo manejes. Los
          tamaños (1X, 2X, 3X) y los calibres (200 a 500) son listas distintas: la app no los equipara.
        </p>
      </div>

      {!fixedUnit && (
        <label class="field">
          <span>Se vende por</span>
          <select
            data-testid={id('unit')}
            value={unit}
            disabled={editing && !!initial && (initial.physicalMilli !== 0 || initial.reservedMilli !== 0)}
            onChange={(e) => setUnit((e.target as HTMLSelectElement).value as Unit)}
          >
            <option value="kg">kg</option>
            <option value="pieza">pieza</option>
            <option value="caja">caja</option>
            <option value="arpilla">arpilla</option>
          </select>
        </label>
      )}

      <label class="field">
        <span>Precio por unidad (MXN)</span>
        <input
          data-testid={id('price')}
          inputMode="decimal"
          aria-label="Precio por unidad en pesos"
          disabled={noPrice}
          placeholder={noPrice ? 'Sin precio todavía' : '0.00'}
          value={noPrice ? '' : price}
          autoComplete="off"
          onInput={(e) => setPrice((e.target as HTMLInputElement).value)}
        />
      </label>
      <label class="check">
        <input
          type="checkbox"
          data-testid={id('no-price')}
          checked={noPrice}
          onChange={(e) => setNoPrice((e.target as HTMLInputElement).checked)}
        />
        Sin precio todavía (lo capturo al vender)
      </label>

      {preview && (
        <p class="sum-line" data-testid={id('preview')}>
          Quedará como: {preview}
          {unit !== 'kg' && ` (por ${unit})`}
        </p>
      )}
      {dup && (
        <p class="notice" role="alert" data-testid={id('dup')}>
          Ya existe esta clasificación: «{productLabel(dup)}»
          {dup.priceCents > 0 ? ` (${formatMoney(dup.priceCents)}/${dup.unit})` : ''}. Úsala en lugar de crear otra.
        </p>
      )}

      <div class="actions">
        <button class="primary" data-testid={addId} disabled={saving} onClick={save}>
          {editing ? 'Guardar cambios' : 'Agregar variedad'}
        </button>
        {editing && onCancel && (
          <button data-testid={cancelId} onClick={onCancel}>
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}
