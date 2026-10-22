import type { Classification, Product, Unit } from './types';

/**
 * Clasificación comercial de un producto de la Central (chayote, jitomate, limón…). Las listas son SOLO atajos (chips que
 * rellenan un campo de texto): el usuario puede escribir cualquier otro valor, y lo que ya usó aparece como sugerencia.
 * Producto y origen no traen atajos porque dependen del negocio. No se deduce calidad ni precio de la procedencia:
 * son etiquetas, no reglas.
 */
export const VARIETY_PRESETS = [] as const;
export const ORIGIN_PRESETS = [] as const;
export const QUALITY_PRESETS = ['Primera', 'Segunda', 'Tercera'] as const;
export const SIZE_PRESETS = ['Chico', 'Mediano', 'Grande'] as const;
export const CALIBER_NUMBER_PRESETS = [] as const;
export const CALIBER_PRESETS = [...SIZE_PRESETS, ...CALIBER_NUMBER_PRESETS] as const;

/** Textos con los que la interfaz representa "sin dato". Se guardan como campo ausente. */
export const UNSPECIFIED = {
  origin: 'No especificada',
  quality: 'Sin clasificar',
  caliber: 'No especificado',
} as const;

export const MAX_CLASS_LEN = 40;

/** Clave de comparación: sin acentos, minúsculas, espacios colapsados. */
export function normalizeKey(s: string | undefined | null): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clave del producto: sin acentos, minúsculas y espacios colapsados. */
export function varietyKey(s: string | undefined | null): string {
  return normalizeKey(s);
}

/**
 * Clave del calibre: sin espacios internos, sin prefijo "calibre"/"cal."/"#" y con "×" como "x"
 * ("3 X" ≡ "3X", "Calibre 300" ≡ "300"). NUNCA mezcla los tamaños (Chico/Mediano/Grande, 1X/2X) con los números (200–500).
 */
export function caliberKey(s: string | undefined | null): string {
  return normalizeKey(s)
    .replace(/×/g, 'x')
    .replace(/\s+/g, '')
    .replace(/^(calibre|cal\.?|#)/, '');
}

const FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Recorta y colapsa espacios. No valida (ver classValueError). */
export function cleanClassValue(raw: string | undefined | null): string {
  return (raw ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Mensaje de error si el texto no es aceptable como clasificación; null si es válido (o vacío). */
export function classValueError(raw: string | undefined | null, field: string): string | null {
  const text = raw ?? '';
  if (FORBIDDEN_CHARS.test(text)) return `${field}: contiene caracteres no permitidos`;
  if (cleanClassValue(text).length > MAX_CLASS_LEN) return `${field}: máximo ${MAX_CLASS_LEN} caracteres`;
  return null;
}

const UNSPECIFIED_KEYS: ReadonlySet<string> = new Set(
  ['No especificada', 'No especificado', 'Sin clasificar', 'Sin especificar', 'N/A'].map(normalizeKey),
);

export function isUnspecified(raw: string | undefined | null): boolean {
  const k = normalizeKey(raw);
  return k === '' || UNSPECIFIED_KEYS.has(k);
}

/**
 * Valor opcional (procedencia, calidad, calibre): vacío o "no especificado" → undefined; si coincide por
 * clave con un valor conocido (preset o ya usado) se usa SU ortografía, para no crear duplicados por
 * diferencias accidentales de escritura ("primera", "PRIMERA ", "Primera").
 */
export function resolveClassValue(
  raw: string | undefined | null,
  known: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
  keyFn: (v: string) => string = normalizeKey,
): string | undefined {
  let c = cleanClassValue(raw);
  if (!c || isUnspecified(c)) return undefined;
  c = aliases[normalizeKey(c)] ?? c;
  const k = keyFn(c);
  return known.find((v) => keyFn(v) === k) ?? c;
}

/**
 * Formas de decir lo mismo que el contacto usó ("oaxaqueño", "michoacano") → el valor del catálogo.
 * Es solo una comodidad de escritura: no deduce calidad ni precio.
 */
export const ORIGIN_ALIASES: Readonly<Record<string, string>> = {
  oaxaqueno: 'Oaxaca',
  oaxaquena: 'Oaxaca',
  michoacano: 'Michoacán',
  michoacana: 'Michoacán',
};

/** Variedad (obligatoria): igual que resolveClassValue pero comparando con varietyKey. Devuelve '' si vacía. */
export function resolveVariety(raw: string | undefined | null, known: readonly string[]): string {
  const c = cleanClassValue(raw);
  if (!c) return '';
  const k = varietyKey(c);
  return known.find((v) => varietyKey(v) === k) ?? c;
}

type ClassFields = Pick<Product, 'name' | 'origin' | 'quality' | 'caliber'>;

/** Clave de comparación de un valor opcional: "No especificado" (en cualquier forma) equivale a ausente. */
export function keyOf(v: string | undefined | null): string {
  return isUnspecified(v) ? '' : normalizeKey(v);
}

/**
 * Identidad de un producto: dos productos con la misma clave no pueden coexistir.
 * (JSON.stringify evita colisiones por separadores dentro del texto.)
 */
export function classificationKey(p: ClassFields & { unit: Unit }): string {
  const cal = isUnspecified(p.caliber) ? '' : caliberKey(p.caliber);
  return JSON.stringify([varietyKey(p.name), keyOf(p.origin), keyOf(p.quality), cal, p.unit]);
}

export function sameClassification(a: ClassFields & { unit: Unit }, b: ClassFields & { unit: Unit }): boolean {
  return classificationKey(a) === classificationKey(b);
}

/** "Oaxaca · Primera · 2X" (sin variedad). Vacío si no tiene clasificación adicional. */
export function classLabel(p: Pick<Product, 'origin' | 'quality' | 'caliber'>): string {
  return [p.origin, p.quality, p.caliber].filter(Boolean).join(' · ');
}

/** "Con semilla · Oaxaca · Primera · 2X". Con solo nombre y calidad coincide con el formato anterior. */
export function productLabel(p: ClassFields): string {
  return [p.name, p.origin, p.quality, p.caliber].filter(Boolean).join(' · ');
}

export function classificationOf(p: ClassFields): Classification {
  return {
    variety: p.name,
    ...(p.origin ? { origin: p.origin } : {}),
    ...(p.quality ? { quality: p.quality } : {}),
    ...(p.caliber ? { caliber: p.caliber } : {}),
  };
}

export interface KnownValues {
  varieties: string[];
  origins: string[];
  qualities: string[];
  calibers: string[];
}

function mergeUnique(
  first: Array<string | undefined>,
  then: readonly string[],
  keyFn: (v: string) => string = normalizeKey,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of [...first, ...then]) {
    if (!v) continue;
    const k = keyFn(v);
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

/**
 * Valores conocidos para canonizar al guardar. PRECEDENCIA: la ortografía que ya existe en el catálogo gana sobre
 * el preset (así "Limón con semilla" y "Con semilla" no se parten en dos). Las variedades se comparan con varietyKey.
 */
export function knownValues(products: ClassFields[]): KnownValues {
  return {
    varieties: mergeUnique(products.map((p) => p.name), VARIETY_PRESETS, varietyKey),
    origins: mergeUnique(products.map((p) => p.origin), ORIGIN_PRESETS),
    qualities: mergeUnique(products.map((p) => p.quality), QUALITY_PRESETS),
    calibers: mergeUnique(products.map((p) => p.caliber), CALIBER_PRESETS, caliberKey),
  };
}

export interface ClassInput {
  name: string;
  origin?: string;
  quality?: string;
  caliber?: string;
}

/**
 * Cómo QUEDARÁ guardada una clasificación escrita por la persona: alias («oaxaqueño» → Oaxaca), «no especificado» → ausente
 * y ortografía de los atajos / de lo ya usado («3 x», «1×», «Calibre 300» → «3X», «1X», «300»). La usan el guardado
 * (`saveProduct`) y la vista previa del formulario, para que la vista previa diga exactamente lo que se va a guardar.
 * Con `existing` (edición), un campo que la persona no tocó conserva tal cual su valor guardado.
 */
export function canonicalizeClass(
  all: ClassFields[],
  input: ClassInput,
  existing?: ClassFields,
): { name: string; origin?: string; quality?: string; caliber?: string } {
  const known = knownValues(all);
  const same = (f: 'name' | 'origin' | 'quality' | 'caliber', raw: string | undefined) =>
    !!existing && cleanClassValue(raw) === (existing[f] ?? '');
  return {
    name: same('name', input.name) ? existing!.name : resolveVariety(input.name, known.varieties),
    origin: same('origin', input.origin) ? existing!.origin : resolveClassValue(input.origin, known.origins, ORIGIN_ALIASES),
    quality: same('quality', input.quality) ? existing!.quality : resolveClassValue(input.quality, known.qualities),
    caliber: same('caliber', input.caliber) ? existing!.caliber : resolveClassValue(input.caliber, known.calibers, {}, caliberKey),
  };
}

/** Valores usados que NO son presets (sugerencias personalizadas, ej. "Torreones"). */
export function customValues(
  all: string[],
  presets: readonly string[],
  keyFn: (v: string) => string = normalizeKey,
): string[] {
  const p = new Set(presets.map(keyFn));
  return all.filter((v) => !p.has(keyFn(v)));
}

/** Clave de una referencia o proveedor para comparar: solo letras y números ("ABC-123" ≡ "abc 123"). */
export function referenceKey(s: string | undefined | null): string {
  return normalizeKey(s).replace(/[^a-z0-9]/g, '');
}
