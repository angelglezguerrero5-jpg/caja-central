import { describe, expect, it } from 'vitest';
import * as classification from '../../src/domain/classification';
import {
  CALIBER_NUMBER_PRESETS,
  CALIBER_PRESETS,
  MAX_CLASS_LEN,
  ORIGIN_ALIASES,
  ORIGIN_PRESETS,
  QUALITY_PRESETS,
  SIZE_PRESETS,
  UNSPECIFIED,
  VARIETY_PRESETS,
  classLabel,
  classValueError,
  classificationKey,
  classificationOf,
  caliberKey,
  cleanClassValue,
  customValues,
  isUnspecified,
  knownValues,
  normalizeKey,
  productLabel,
  referenceKey,
  resolveClassValue,
  resolveVariety,
  sameClassification,
  varietyKey,
} from '../../src/domain/classification';
import { addLine } from '../../src/domain/cart';
import type { Product, Unit } from '../../src/domain/types';

type P = { name: string; origin?: string; quality?: string; caliber?: string; unit: Unit };
const p = (o: Partial<P> & { name: string }): P => ({ unit: 'kg', ...o });

describe('presets del catálogo (casos 1–7 del prompt)', () => {
  it('1–2. variedades sin semilla y con semilla', () => {
    expect([...VARIETY_PRESETS]).toEqual(['Sin semilla', 'Con semilla']);
    expect(classificationKey(p({ name: 'Sin semilla' }))).not.toBe(classificationKey(p({ name: 'Con semilla' })));
  });

  it('3. procedencias Oaxaca y Michoacán, distintas entre sí', () => {
    expect([...ORIGIN_PRESETS]).toEqual(['Oaxaca', 'Michoacán']);
    const a = p({ name: 'Con semilla', origin: 'Oaxaca' });
    const b = p({ name: 'Con semilla', origin: 'Michoacán' });
    expect(sameClassification(a, b)).toBe(false);
    expect(productLabel(a)).toBe('Con semilla · Oaxaca');
    expect(productLabel(b)).toBe('Con semilla · Michoacán');
  });

  it('4. tamaños 1X, 2X y 3X', () => {
    expect([...SIZE_PRESETS]).toEqual(['1X', '2X', '3X']);
    const keys = SIZE_PRESETS.map((c) => classificationKey(p({ name: 'Sin semilla', caliber: c })));
    expect(new Set(keys).size).toBe(3);
  });

  it('5. calibres 200, 300, 400 y 500', () => {
    expect([...CALIBER_NUMBER_PRESETS]).toEqual(['200', '300', '400', '500']);
    const keys = CALIBER_NUMBER_PRESETS.map((c) => classificationKey(p({ name: 'Sin semilla', caliber: c })));
    expect(new Set(keys).size).toBe(4);
    expect([...CALIBER_PRESETS]).toHaveLength(7);
  });

  it('NO existe equivalencia entre 1X/2X/3X y 200–500 (son valores distintos)', () => {
    for (const size of SIZE_PRESETS) {
      for (const num of CALIBER_NUMBER_PRESETS) {
        expect(sameClassification(p({ name: 'Sin semilla', caliber: size }), p({ name: 'Sin semilla', caliber: num }))).toBe(false);
      }
    }
    // El módulo no ofrece ninguna conversión ni equivalencia.
    const names = Object.keys(classification).join(' ');
    expect(names).not.toMatch(/equiv|convert|tabla|map(ear|a)?De/i);
  });

  it('6. calidades primera, segunda y tercera', () => {
    expect([...QUALITY_PRESETS]).toEqual(['Primera', 'Segunda', 'Tercera']);
    expect(productLabel(p({ name: 'Sin semilla', quality: 'Tercera' }))).toBe('Sin semilla · Tercera');
  });

  it('7. valores personalizados y no especificados', () => {
    // No especificado = ausente, en cualquiera de sus escrituras
    for (const raw of ['', '   ', UNSPECIFIED.origin, UNSPECIFIED.quality, UNSPECIFIED.caliber, 'no especificada', 'SIN CLASIFICAR']) {
      expect(resolveClassValue(raw, QUALITY_PRESETS)).toBeUndefined();
      expect(isUnspecified(raw)).toBe(true);
    }
    expect(resolveClassValue(undefined, [])).toBeUndefined();
    // Personalizado se conserva tal cual (sin imponer nada)
    expect(resolveClassValue('  Torreones  ', QUALITY_PRESETS)).toBe('Torreones');
    expect(resolveClassValue('Calibre   especial', CALIBER_PRESETS)).toBe('Calibre especial');
    // 'Torreones' NO es un preset de ninguna lista
    for (const list of [VARIETY_PRESETS, ORIGIN_PRESETS, QUALITY_PRESETS, CALIBER_PRESETS]) {
      expect(list.map(normalizeKey)).not.toContain('torreones');
    }
  });
});

describe('identidad y duplicados por diferencias de escritura', () => {
  it('ignora mayúsculas, acentos, espacios y un "limón" inicial', () => {
    const base = classificationKey(p({ name: 'Sin semilla', origin: 'Michoacán', quality: 'Primera', caliber: '2X' }));
    expect(classificationKey(p({ name: '  LIMÓN   sin  semilla ', origin: 'michoacan', quality: 'primera ', caliber: '2x' }))).toBe(base);
    expect(varietyKey('Limon Con Semilla')).toBe(varietyKey('con semilla'));
  });

  it('distingue unidad y cada dimensión', () => {
    const a = p({ name: 'Sin semilla', quality: 'Primera' });
    expect(sameClassification(a, { ...a, unit: 'caja' })).toBe(false);
    expect(sameClassification(a, { ...a, quality: 'Segunda' })).toBe(false);
    expect(sameClassification(a, { ...a, origin: 'Oaxaca' })).toBe(false);
    expect(sameClassification(a, { ...a, caliber: '500' })).toBe(false);
  });

  it('canoniza contra valores conocidos para no crear duplicados', () => {
    expect(resolveClassValue('primera', QUALITY_PRESETS)).toBe('Primera');
    expect(resolveClassValue('MICHOACAN', ORIGIN_PRESETS)).toBe('Michoacán');
    expect(resolveClassValue('3x', CALIBER_PRESETS)).toBe('3X');
    expect(resolveClassValue('torreones', ['Torreones'])).toBe('Torreones');
    expect(resolveVariety('Limón sin semilla', VARIETY_PRESETS)).toBe('Sin semilla');
    expect(resolveVariety('  con   semilla', VARIETY_PRESETS)).toBe('Con semilla');
    expect(resolveVariety('Persa', VARIETY_PRESETS)).toBe('Persa');
    expect(resolveVariety('   ', VARIETY_PRESETS)).toBe('');
  });

  it('no confunde un valor parecido pero distinto', () => {
    expect(resolveClassValue('Primera A', QUALITY_PRESETS)).toBe('Primera A');
    expect(resolveClassValue('2XL', CALIBER_PRESETS)).toBe('2XL');
  });
});

describe('etiquetas', () => {
  it('conserva el formato anterior (nombre · calidad)', () => {
    expect(productLabel({ name: 'Limón persa', quality: 'Primera' })).toBe('Limón persa · Primera');
    expect(productLabel({ name: 'Limón con semilla' })).toBe('Limón con semilla');
  });

  it('arma variedad · procedencia · calidad · calibre y omite lo ausente', () => {
    expect(productLabel({ name: 'Con semilla', origin: 'Oaxaca', quality: 'Segunda', caliber: '300' })).toBe('Con semilla · Oaxaca · Segunda · 300');
    expect(classLabel({ origin: 'Oaxaca', caliber: '300' })).toBe('Oaxaca · 300');
    expect(classLabel({})).toBe('');
    expect(classificationOf({ name: 'Sin semilla', quality: 'Primera' })).toEqual({ variety: 'Sin semilla', quality: 'Primera' });
  });

  it('la línea de carrito guarda una foto de la clasificación', () => {
    const product = {
      id: 'x', name: 'Con semilla', origin: 'Oaxaca', caliber: '2X', unit: 'kg', priceCents: 3000, active: true,
      sort: 0, physicalMilli: 0, reservedMilli: 0, updatedAt: '',
    } as Product;
    const [line] = addLine([], product, 1000);
    expect(line.name).toBe('Con semilla · Oaxaca · 2X');
    expect(line.cls).toEqual({ variety: 'Con semilla', origin: 'Oaxaca', caliber: '2X' });
  });
});

describe('validación de texto de clasificación (negativas)', () => {
  const zeroWidth = String.fromCharCode(0x200b);
  const rtlOverride = String.fromCharCode(0x202e);
  const bell = String.fromCharCode(7);
  const lineSep = String.fromCharCode(0x2028);

  it('rechaza demasiado largo y caracteres de control o invisibles', () => {
    expect(classValueError('a'.repeat(MAX_CLASS_LEN), 'Calidad')).toBeNull();
    expect(classValueError('a'.repeat(MAX_CLASS_LEN + 1), 'Calidad')).toMatch(/máximo/);
    for (const bad of [`Pri${bell}mera`, `Pri${zeroWidth}mera`, `Pri${rtlOverride}mera`, `Pri${lineSep}mera`]) {
      expect(classValueError(bad, 'Calidad')).toMatch(/no permitidos/);
    }
    expect(classValueError('', 'Calidad')).toBeNull();
    expect(classValueError(undefined, 'Calidad')).toBeNull();
  });

  it('acepta acentos, ñ y símbolos comunes', () => {
    expect(classValueError('Calibre 2½ (extra) – ñandú', 'Calibre')).toBeNull();
    expect(cleanClassValue('  a \t  b \n c ')).toBe('a b c');
  });
});

describe('valores conocidos y sugerencias', () => {
  it('la ortografía ya usada en el catálogo gana sobre el preset, sin repetir por clave', () => {
    const k = knownValues([
      { name: 'Sin semilla', quality: 'primera', caliber: 'Torreones' },
      { name: 'Persa', origin: 'Oaxaca', quality: 'Torreones' },
    ]);
    expect(k.varieties).toEqual(['Sin semilla', 'Persa', 'Con semilla']);
    expect(k.qualities).toEqual(['primera', 'Torreones', 'Segunda', 'Tercera']); // 'primera' (usada) gana a 'Primera'
    expect(k.origins).toEqual(['Oaxaca', 'Michoacán']);
    expect(k.calibers.slice(0, 1)).toEqual(['Torreones']);
    expect(customValues(k.qualities, QUALITY_PRESETS)).toEqual(['Torreones']);
  });

  it('una variedad antigua "Limón con semilla" y el preset "Con semilla" son UNA sola variedad', () => {
    const k = knownValues([{ name: 'Limón con semilla' }]);
    expect(k.varieties).toEqual(['Limón con semilla', 'Sin semilla']); // el preset equivalente no se duplica
    expect(resolveVariety('Con semilla', k.varieties)).toBe('Limón con semilla');
    expect(customValues(k.varieties, VARIETY_PRESETS, varietyKey)).toEqual([]);
  });
});

describe('claves de identidad: casos límite (revisión)', () => {
  const key = (o: Partial<P> & { name: string }) => classificationKey(p(o));

  it('un separador dentro del texto no provoca colisiones', () => {
    expect(key({ name: 'x|y', origin: 'z' })).not.toBe(key({ name: 'x', origin: 'y|z' }));
    expect(key({ name: 'a', quality: 'b|c' })).not.toBe(key({ name: 'a|b', quality: 'c' }));
  });

  it('el calibre ignora espacios, prefijo "calibre"/"cal."/"#" y × — pero NUNCA mezcla tamaños con números', () => {
    for (const same of ['3 X', '3x', '3×', 'Calibre 3X', 'cal. 3X', '#3x']) {
      expect(key({ name: 'Sin semilla', caliber: same }), same).toBe(key({ name: 'Sin semilla', caliber: '3X' }));
    }
    for (const same of ['Calibre 300', 'calibre300', '#300', ' 300 ']) {
      expect(key({ name: 'Sin semilla', caliber: same }), same).toBe(key({ name: 'Sin semilla', caliber: '300' }));
    }
    expect(caliberKey('3X')).not.toBe(caliberKey('300'));
    expect(key({ name: 'Sin semilla', caliber: '1X' })).not.toBe(key({ name: 'Sin semilla', caliber: '200' }));
  });

  it('"No especificado" escrito literalmente equivale a ausente (una sola representación de desconocido)', () => {
    expect(key({ name: 'Sin semilla', quality: 'Sin clasificar' })).toBe(key({ name: 'Sin semilla' }));
    expect(key({ name: 'Sin semilla', origin: 'No especificada' })).toBe(key({ name: 'Sin semilla' }));
    expect(key({ name: 'Sin semilla', caliber: 'No especificado' })).toBe(key({ name: 'Sin semilla' }));
  });

  it('"Limón" inicial, plural y guion se ignoran; "Limón" solo queda como variedad', () => {
    for (const v of ['Limón sin semilla', 'limones sin semilla', 'Limón-sin semilla', 'LIMON   SIN SEMILLA']) {
      expect(varietyKey(v), v).toBe('sin semilla');
    }
    expect(varietyKey('Limón')).toBe('limon');
    expect(varietyKey('')).toBe('');
  });

  it('referencias y proveedores se comparan solo por letras y números', () => {
    expect(referenceKey('ABC-123')).toBe(referenceKey('abc 123'));
    expect(referenceKey(' Camión #12 ')).toBe(referenceKey('CAMION12'));
    expect(referenceKey('---')).toBe('');
    expect(referenceKey(undefined)).toBe('');
  });

  it('"oaxaqueño" y "michoacano" se escriben como Oaxaca y Michoacán (sin deducir calidad ni precio)', () => {
    expect(resolveClassValue('Oaxaqueño', ORIGIN_PRESETS, ORIGIN_ALIASES)).toBe('Oaxaca');
    expect(resolveClassValue('MICHOACANA', ORIGIN_PRESETS, ORIGIN_ALIASES)).toBe('Michoacán');
    expect(resolveClassValue('Veracruz', ORIGIN_PRESETS, ORIGIN_ALIASES)).toBe('Veracruz');
    expect(resolveClassValue('oaxaqueño', ORIGIN_PRESETS)).toBe('oaxaqueño'); // sin alias solicitado no cambia nada
  });
});

describe('canonicalizeClass: la vista previa del formulario dice lo mismo que se guarda', () => {
  const canon = (input: Parameters<typeof classification.canonicalizeClass>[1], all: P[] = [], existing?: P) =>
    classification.canonicalizeClass(all, input, existing);

  it('alias de procedencia, "no especificado" como ausente y ortografía de los atajos', () => {
    expect(canon({ name: 'limón con semilla', origin: 'oaxaqueño', quality: 'primera' })).toEqual({
      name: 'Con semilla', origin: 'Oaxaca', quality: 'Primera', caliber: undefined,
    });
    expect(canon({ name: 'Sin semilla', origin: 'No especificada', quality: 'sin clasificar', caliber: 'N/A' })).toEqual({
      name: 'Sin semilla', origin: undefined, quality: undefined, caliber: undefined,
    });
    expect(canon({ name: 'x', origin: 'MICHOACANA' }).origin).toBe('Michoacán');
  });

  it('los calibres con espacio, × o prefijo se guardan con la escritura de los atajos (sin mezclar tamaños con números)', () => {
    const c = (caliber: string) => canon({ name: 'Persa', caliber }).caliber;
    expect(c('3 x')).toBe('3X');
    expect(c('2 X')).toBe('2X');
    expect(c('1×')).toBe('1X');
    expect(c('3x')).toBe('3X');
    expect(c('Calibre 300')).toBe('300');
    expect(c('cal. 400')).toBe('400');
    expect(c('350')).toBe('350'); // un calibre propio se respeta
    expect(c('2X')).not.toBe('200');
  });

  it('una ortografía que ya existe en el catálogo gana sobre el preset; un campo que no se tocó en una edición se conserva', () => {
    const all = [p({ name: 'Persa', caliber: '3 x' })];
    expect(canon({ name: 'Persa', caliber: '3x' }, all).caliber).toBe('3 x');
    const existing = all[0];
    expect(canon({ name: 'Persa', caliber: '3 x', quality: 'primera' }, all, existing)).toMatchObject({ caliber: '3 x', quality: 'Primera' });
  });

  it('el caso del formulario: el duplicado se reconoce con alias ANTES de guardar', () => {
    const all = [p({ name: 'Con semilla', origin: 'Oaxaca' })];
    const c = canon({ name: 'con semilla', origin: 'oaxaqueño' }, all);
    expect(classificationKey({ ...c, unit: 'kg' })).toBe(classificationKey(all[0]));
  });
});
