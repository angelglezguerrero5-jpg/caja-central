import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FREIGHT_SETTINGS,
  MAX_FREIGHT_NET_MILLI,
  classifyDifference,
  computeDifference,
  computeSideNet,
  differenceOf,
  folioKeyOf,
  formatDiff,
  formatPercentBp,
  freightState,
  normalizeFreightFields,
  referenceLabel,
  referenceOf,
  sideIsBlank,
  suggestFolio,
  totalsOf,
  validateFreightFields,
  validateFreightSettings,
  type FreightFields,
  type FreightSideFields,
} from '../../src/domain/freight';
import type { Freight, FreightSide } from '../../src/domain/types';

/**
 * Fórmulas y validaciones del control de pesaje por flete.
 *   peso neto  = peso bruto − tara
 *   diferencia = peso neto inicial − peso neto final
 *   porcentaje = diferencia ÷ peso neto inicial × 100
 * Las cifras esperadas están hechas a mano (kg × 1000 = milésimas) o con un cálculo INDEPENDIENTE en BigInt.
 */

const kg = (n: number) => Math.round(n * 1000);
const NOW = new Date('2026-10-14T20:00:00.000Z');

describe('peso neto de una pesada (bruto − tara)', () => {
  it('camión de 12,450 kg brutos con 4,100 kg de tara → 8,350 kg netos', () => {
    expect(computeSideNet({ mode: 'bruto_tara', grossMilli: kg(12_450), tareMilli: kg(4_100) })).toEqual({ ok: true, netMilli: kg(8_350) });
  });

  it('sin tara (0) el neto es el bruto', () => {
    expect(computeSideNet({ mode: 'bruto_tara', grossMilli: kg(500), tareMilli: 0 })).toEqual({ ok: true, netMilli: kg(500) });
  });

  it('gramos: 12.345 kg − 0.345 kg = 12 kg exactos', () => {
    expect(computeSideNet({ mode: 'bruto_tara', grossMilli: 12_345, tareMilli: 345 })).toEqual({ ok: true, netMilli: 12_000 });
  });

  it('modo «solo el neto»: el neto capturado es el neto', () => {
    expect(computeSideNet({ mode: 'directo', netMilli: kg(8_350) })).toEqual({ ok: true, netMilli: kg(8_350) });
  });

  it('tara MAYOR que el bruto se rechaza; tara IGUAL al bruto (neto cero) también', () => {
    const mayor = computeSideNet({ mode: 'bruto_tara', grossMilli: kg(100), tareMilli: kg(101) });
    expect(mayor).toMatchObject({ ok: false, missing: false, error: 'La tara debe ser menor al peso bruto' });
    expect(computeSideNet({ mode: 'bruto_tara', grossMilli: kg(100), tareMilli: kg(100) })).toMatchObject({ ok: false, missing: false });
  });

  it('valores negativos se rechazan', () => {
    expect(computeSideNet({ mode: 'bruto_tara', grossMilli: -1, tareMilli: 0 })).toMatchObject({ ok: false, missing: false });
    expect(computeSideNet({ mode: 'bruto_tara', grossMilli: kg(10), tareMilli: -1 })).toMatchObject({ ok: false, missing: false, error: 'La tara no puede ser negativa' });
    expect(computeSideNet({ mode: 'directo', netMilli: -kg(5) })).toMatchObject({ ok: false, missing: false });
  });

  it('cero kilos de peso (bruto o neto) se rechaza', () => {
    expect(computeSideNet({ mode: 'bruto_tara', grossMilli: 0, tareMilli: 0 })).toMatchObject({ ok: false, missing: false });
    expect(computeSideNet({ mode: 'directo', netMilli: 0 })).toMatchObject({ ok: false, missing: false, error: 'El peso neto debe ser mayor a cero' });
  });

  it('valores no numéricos o no enteros (NaN, Infinity, decimales) se rechazan', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 60]) {
      expect(computeSideNet({ mode: 'directo', netMilli: bad }), `neto ${bad}`).toMatchObject({ ok: false, missing: false });
      expect(computeSideNet({ mode: 'bruto_tara', grossMilli: bad, tareMilli: 0 }), `bruto ${bad}`).toMatchObject({ ok: false, missing: false });
      expect(computeSideNet({ mode: 'bruto_tara', grossMilli: kg(10), tareMilli: bad }), `tara ${bad}`).toMatchObject({ ok: false, missing: false });
    }
  });

  it('el tope: 200,000 kg pasa; un gramo más no', () => {
    expect(computeSideNet({ mode: 'directo', netMilli: MAX_FREIGHT_NET_MILLI })).toEqual({ ok: true, netMilli: MAX_FREIGHT_NET_MILLI });
    expect(computeSideNet({ mode: 'directo', netMilli: MAX_FREIGHT_NET_MILLI + 1 })).toMatchObject({ ok: false, missing: false });
    expect(computeSideNet({ mode: 'bruto_tara', grossMilli: MAX_FREIGHT_NET_MILLI + 1, tareMilli: 0 })).toMatchObject({ ok: false, missing: false });
  });

  it('un dato que FALTA es «missing» (incompleto), no «inválido»', () => {
    expect(computeSideNet({ mode: 'bruto_tara' })).toMatchObject({ ok: false, missing: true, error: 'Escribe el peso bruto' });
    expect(computeSideNet({ mode: 'bruto_tara', grossMilli: kg(10) })).toMatchObject({ ok: false, missing: true, error: 'Escribe la tara (0 si no hay)' });
    expect(computeSideNet({ mode: 'directo' })).toMatchObject({ ok: false, missing: true });
  });

  it('un modo desconocido se rechaza (no se adivina)', () => {
    expect(computeSideNet({ mode: 'otro' as never })).toMatchObject({ ok: false, error: 'Modo de peso desconocido' });
  });

  it('en modo «solo el neto» el bruto y la tara escritos NO se mezclan con el neto', () => {
    expect(computeSideNet({ mode: 'directo', netMilli: kg(100), grossMilli: kg(999), tareMilli: kg(1) })).toEqual({ ok: true, netMilli: kg(100) });
    expect(normalizeFreightFields({ initial: { mode: 'directo', netMilli: kg(100), grossMilli: kg(999), tareMilli: kg(1) } }).initial).toEqual({ mode: 'directo', netMilli: kg(100) });
    expect(normalizeFreightFields({ initial: { mode: 'bruto_tara', grossMilli: kg(100), tareMilli: kg(10), netMilli: kg(1) } }).initial).toEqual({ mode: 'bruto_tara', grossMilli: kg(100), tareMilli: kg(10) });
  });
});

describe('diferencia y porcentaje', () => {
  it('sale con 10,000 kg y llega con 9,750 kg → 250 kg de diferencia = 2.50 %', () => {
    expect(computeDifference(kg(10_000), kg(9_750))).toEqual({ diffMilli: kg(250), percentBp: 250 });
  });

  it('llega MÁS de lo que salió: diferencia y porcentaje negativos', () => {
    expect(computeDifference(kg(10_000), kg(10_100))).toEqual({ diffMilli: -kg(100), percentBp: -100 });
  });

  it('llega igual: 0 y 0.00 %', () => {
    expect(computeDifference(kg(8_000), kg(8_000))).toEqual({ diffMilli: 0, percentBp: 0 });
  });

  it('el peso inicial en cero NO se divide: no hay porcentaje', () => {
    expect(computeDifference(0, kg(100))).toBeNull();
    expect(computeDifference(-kg(5), kg(100))).toBeNull();
  });

  it('si falta una pesada no hay diferencia (registro incompleto)', () => {
    expect(computeDifference(undefined, kg(100))).toBeNull();
    expect(computeDifference(kg(100), undefined)).toBeNull();
    expect(computeDifference(Number.NaN, kg(100))).toBeNull();
  });

  it('redondeo al centésimo de punto, mitades alejándose de cero y con el mismo signo para negativos', () => {
    expect(computeDifference(3, 2)!.percentBp).toBe(3333); // 33.333… %
    expect(computeDifference(7, 5)!.percentBp).toBe(2857); // 28.5714… %
    expect(computeDifference(3, 4)!.percentBp).toBe(-3333);
    expect(computeDifference(32, 31)!.percentBp).toBe(313); // 312.5 → 313
    expect(computeDifference(32, 33)!.percentBp).toBe(-313); // −312.5 → −313
  });

  it('con pesos enormes (200 toneladas) no pierde exactitud', () => {
    expect(computeDifference(MAX_FREIGHT_NET_MILLI, MAX_FREIGHT_NET_MILLI - 1)).toEqual({ diffMilli: 1, percentBp: 0 });
    // 199,999,999 ÷ 200,000,000 = 99.9999995 % → 10000 centésimos de punto (100.00 %)
    expect(computeDifference(MAX_FREIGHT_NET_MILLI, 1)).toEqual({ diffMilli: MAX_FREIGHT_NET_MILLI - 1, percentBp: 10_000 });
  });

  it('coincide con un cálculo INDEPENDIENTE en BigInt para 2,000 pares al azar (semilla fija)', () => {
    let seed = 20261014;
    const rnd = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return 1 + (seed % max);
    };
    for (let i = 0; i < 2000; i++) {
      const initial = rnd(i % 2 ? MAX_FREIGHT_NET_MILLI : 50_000);
      const final = rnd(i % 3 ? MAX_FREIGHT_NET_MILLI : 50_000);
      const diff = BigInt(initial - final);
      const num = diff * 10000n;
      const den = BigInt(initial);
      const abs = num < 0n ? -num : num;
      const q = (2n * abs + den) / (2n * den); // entero más cercano, mitades hacia afuera
      const expected = Number(num < 0n ? -q : q);
      expect(computeDifference(initial, final), `inicial ${initial} final ${final}`).toEqual({ diffMilli: initial - final, percentBp: expected });
    }
  });

  it('differenceOf toma los netos del flete', () => {
    expect(differenceOf({ initial: side(kg(1_000)), final: side(kg(990)) })).toEqual({ diffMilli: kg(10), percentBp: 100 });
    expect(differenceOf({ initial: side(kg(1_000)) })).toBeNull();
  });

  it('formatos: porcentaje con dos decimales y diferencia en kg o en gramos', () => {
    expect(formatPercentBp(250)).toBe('2.50 %');
    expect(formatPercentBp(-100)).toBe('−1.00 %');
    expect(formatPercentBp(0)).toBe('0.00 %');
    expect(formatDiff(kg(250))).toBe('250 kg');
    expect(formatDiff(-kg(100))).toBe('−100 kg');
    expect(formatDiff(800)).toBe('800 g');
    expect(formatDiff(kg(1_234.5))).toBe('1,234.5 kg');
  });
});

const side = (netMilli: number): FreightSide => ({ mode: 'directo', netMilli });

describe('comparación con el rango de referencia (no se atribuye ninguna causa)', () => {
  const ref = { minMilli: kg(200), maxMilli: kg(300) };
  const d = (kgs: number) => computeDifference(kg(10_000), kg(10_000) - kg(kgs));

  it('200 y 300 kg exactos están DENTRO; 199.999 está debajo y 300.001 encima', () => {
    expect(classifyDifference(d(250), ref)).toBe('dentro');
    expect(classifyDifference(d(200), ref)).toBe('dentro');
    expect(classifyDifference(d(300), ref)).toBe('dentro');
    expect(classifyDifference(computeDifference(kg(10_000), kg(10_000) - 199_999), ref)).toBe('debajo');
    expect(classifyDifference(computeDifference(kg(10_000), kg(10_000) - 300_001), ref)).toBe('encima');
  });

  it('un peso final MAYOR es una alerta aparte (no «dentro» ni «debajo»), con o sin rango', () => {
    expect(classifyDifference(d(-50), ref)).toBe('final_mayor');
    expect(classifyDifference(d(-50), null)).toBe('final_mayor');
  });

  it('sin diferencia, sin rango y sin datos', () => {
    expect(classifyDifference(d(0), ref)).toBe('sin_diferencia');
    expect(classifyDifference(d(250), null)).toBe('sin_referencia');
    expect(classifyDifference(null, ref)).toBeNull();
  });

  it('ninguna clasificación llama a la diferencia merma ni deshidratación', async () => {
    const { DIFFERENCE_TEXT } = await import('../../src/domain/freight');
    for (const text of Object.values(DIFFERENCE_TEXT)) expect(text.toLowerCase()).not.toMatch(/deshidrat|merma/);
  });

  it('la referencia de fábrica es 200–300 kg y está PENDIENTE de validación', () => {
    expect(DEFAULT_FREIGHT_SETTINGS).toEqual({ refMinMilli: 200_000, refMaxMilli: 300_000, validated: false });
    expect(referenceLabel(DEFAULT_FREIGHT_SETTINGS)).toBe('200–300 kg · pendiente de validación');
    expect(referenceLabel({ ...DEFAULT_FREIGHT_SETTINGS, validated: true })).toBe('200–300 kg');
    expect(referenceLabel({ validated: false })).toBe('Sin rango de referencia');
    expect(referenceOf({ validated: true })).toBeNull();
  });

  it('configuración del rango: válida o con un motivo claro', () => {
    expect(validateFreightSettings({ refMinMilli: kg(150), refMaxMilli: kg(250), validated: true })).toEqual([]);
    expect(validateFreightSettings({ validated: false })).toEqual([]); // sin rango = no usar rango
    expect(validateFreightSettings({ refMinMilli: kg(300), refMaxMilli: kg(200), validated: false })).toEqual(['El mínimo del rango no puede ser mayor que el máximo']);
    expect(validateFreightSettings({ refMinMilli: kg(100), validated: false })[0]).toMatch(/mínimo y el máximo/);
    expect(validateFreightSettings({ refMinMilli: -1, refMaxMilli: kg(1), validated: false })[0]).toMatch(/negativos/);
    expect(validateFreightSettings({ refMinMilli: 0, refMaxMilli: MAX_FREIGHT_NET_MILLI + 1, validated: false })[0]).toMatch(/no puede pasar de/);
    expect(validateFreightSettings({ refMinMilli: 1.5, refMaxMilli: 5, validated: false })[0]).toMatch(/negativos/);
    expect(validateFreightSettings({ validated: 'si' as never })[0]).toMatch(/validado/);
  });
});

const ok = (over: Partial<FreightFields> = {}): FreightFields => ({
  folio: 'F-261014-01',
  origin: 'Apatzingán, Mich.',
  destination: 'Central de Abasto, CDMX',
  initial: { mode: 'bruto_tara', grossMilli: kg(22_000), tareMilli: kg(7_000) },
  ...over,
});
const check = (f: FreightFields) => validateFreightFields(normalizeFreightFields(f), { now: NOW });

describe('validación de un flete (registros incompletos o inválidos)', () => {
  it('un flete completo y uno con una sola pesada son válidos', () => {
    expect(check(ok())).toEqual([]);
    expect(check(ok({ final: { mode: 'directo', netMilli: kg(14_800) } }))).toEqual([]);
    expect(check({ ...ok(), initial: undefined, final: { mode: 'directo', netMilli: kg(14_800) } })).toEqual([]); // primero el destino
  });

  it('sin folio, sin origen o sin destino no se guarda', () => {
    expect(check(ok({ folio: '' }))).toContain('Escribe el folio del flete');
    expect(check(ok({ folio: '   ' }))).toContain('Escribe el folio del flete');
    expect(check(ok({ origin: undefined }))).toContain('Escribe el origen del flete (de dónde sale)');
    expect(check(ok({ destination: '' }))).toContain('Escribe el destino del flete (a dónde llega)');
  });

  it('sin NINGUNA pesada no se guarda', () => {
    expect(check({ folio: 'X', origin: 'a', destination: 'b' })).toContain('Captura al menos una pesada: el peso inicial (origen) o el final (destino)');
    // una pesada con solo espacios en la boleta tampoco cuenta
    expect(check({ folio: 'X', origin: 'a', destination: 'b', initial: { mode: 'bruto_tara', ticket: '   ' } })).toContain('Captura al menos una pesada: el peso inicial (origen) o el final (destino)');
  });

  it('una pesada a medias (solo bruto, tara mayor, negativo...) se rechaza con el nombre de su lado', () => {
    expect(check(ok({ initial: { mode: 'bruto_tara', grossMilli: kg(100) } }))).toEqual(['Peso inicial (origen): Escribe la tara (0 si no hay)']);
    expect(check(ok({ initial: { mode: 'bruto_tara', grossMilli: kg(100), tareMilli: kg(200) } }))).toEqual(['Peso inicial (origen): La tara debe ser menor al peso bruto']);
    expect(check(ok({ final: { mode: 'directo', netMilli: -5 } }))).toEqual(['Peso final (destino): El peso neto debe ser mayor a cero']);
    expect(check(ok({ final: { mode: 'directo', netMilli: Number.NaN } }))).toEqual(['Peso final (destino): El peso neto debe ser mayor a cero']);
  });

  it('textos: largo máximo y caracteres de control', () => {
    expect(check(ok({ folio: 'F'.repeat(41) }))[0]).toMatch(/Folio: máximo 40 caracteres/);
    expect(check(ok({ origin: 'x'.repeat(121) }))[0]).toMatch(/Origen: máximo 120/);
    expect(check(ok({ notes: 'n'.repeat(501) }))[0]).toMatch(/Observaciones: máximo 500/);
    expect(check(ok({ folio: 'F\u0000-1' }))[0]).toMatch(/caracteres no permitidos/);
    expect(check(ok({ initial: { mode: 'directo', netMilli: kg(1), ticket: 'T'.repeat(61) } }))[0]).toMatch(/boleta: máximo 60/);
    expect(check(ok({ initial: { mode: 'directo', netMilli: kg(1), scale: 'B'.repeat(121) } }))[0]).toMatch(/báscula: máximo 120/);
  });

  it('fecha: no futura, no absurda, legible', () => {
    expect(check(ok({ date: '2026-10-14T20:04:00.000Z' }))).toEqual([]); // 4 min adelantado: tolerancia de reloj
    expect(check(ok({ date: '2026-10-14T21:00:00.000Z' }))).toEqual(['Fecha: la fecha no puede ser futura']);
    expect(check(ok({ date: '1999-12-31T00:00:00.000Z' }))).toEqual(['Fecha: la fecha es demasiado antigua']);
    expect(check(ok({ date: 'ayer' }))).toEqual(['Fecha: la fecha no es válida']);
  });

  it('normalizar: espacios de sobra, NFC, textos vacíos fuera y pesada en blanco fuera', () => {
    const n = normalizeFreightFields({
      folio: '  f-1   a ',
      origin: ' Zamora ',
      destination: 'Cdmx',
      notes: '   ',
      initial: { mode: 'directo', netMilli: kg(1), ticket: '  ', scale: ' B1 ' },
      final: { mode: 'bruto_tara', ticket: '' },
    });
    expect(n).toEqual({ folio: 'f-1 a', origin: 'Zamora', destination: 'Cdmx', initial: { mode: 'directo', netMilli: kg(1), scale: 'B1' } });
    expect(sideIsBlank(n.final)).toBe(true);
    expect(sideIsBlank({ mode: 'directo', ticket: 'T' })).toBe(false);
  });
});

describe('folio único', () => {
  it('mayúsculas, minúsculas y espacios de sobra son el MISMO folio', () => {
    expect(folioKeyOf('fl-001')).toBe('FL-001');
    expect(folioKeyOf('  Fl-001  ')).toBe('FL-001');
    expect(folioKeyOf('FL   001')).toBe('FL 001');
    expect(folioKeyOf('FL-001')).not.toBe(folioKeyOf('FL-002'));
  });

  it('sugiere F-AAMMDD-NN con el primer número libre del día', () => {
    expect(suggestFolio(new Set(), '2026-10-14')).toBe('F-261014-01');
    expect(suggestFolio(new Set(['F-261014-01']), '2026-10-14')).toBe('F-261014-02');
    expect(suggestFolio(new Set(['F-261014-01', 'F-261014-03']), '2026-10-14')).toBe('F-261014-02');
    expect(suggestFolio(new Set(['F-261014-01']), '2026-10-15')).toBe('F-261015-01');
  });
});

const fr = (id: string, i?: number, f?: number, status: Freight['status'] = 'activo'): Freight => ({
  id,
  folio: id,
  folioKey: id.toUpperCase(),
  status,
  createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T00:00:00.000Z',
  date: '2026-10-14T00:00:00.000Z',
  day: '2026-10-14',
  origin: 'a',
  destination: 'b',
  ...(i !== undefined ? { initial: side(i) } : {}),
  ...(f !== undefined ? { final: side(f) } : {}),
  revisions: [],
});

describe('estado y totales de varios fletes', () => {
  it('estado según las pesadas capturadas', () => {
    expect(freightState(fr('a', 10, 9))).toBe('completo');
    expect(freightState(fr('b', 10))).toBe('falta_final');
    expect(freightState(fr('c', undefined, 9))).toBe('falta_inicial');
    expect(freightState(fr('d', 10, 9, 'anulado'))).toBe('anulado');
  });

  it('los totales suman SOLO fletes completos y vigentes; el porcentaje es de la suma', () => {
    const list = [
      fr('a', kg(10_000), kg(9_750)),
      fr('b', kg(20_000), kg(19_800)),
      fr('c', kg(5_000)), // incompleto: no suma
      fr('d', kg(7_000), kg(1), 'anulado'), // anulado: no suma
    ];
    const t = totalsOf(list);
    expect(t).toMatchObject({ active: 3, complete: 2, incomplete: 1, voided: 1, initialMilli: kg(30_000), finalMilli: kg(29_550), diffMilli: kg(450) });
    expect(t.percentBp).toBe(150); // 450 ÷ 30,000 = 1.50 %
  });

  it('sin fletes completos no hay porcentaje', () => {
    expect(totalsOf([]).percentBp).toBeNull();
    expect(totalsOf([fr('a', kg(1))]).percentBp).toBeNull();
  });
});

describe('lados «solo neto» y «bruto − tara» en el mismo flete', () => {
  it('cada lado se captura a su manera y la diferencia sale de los dos netos', () => {
    const initial: FreightSideFields = { mode: 'bruto_tara', grossMilli: kg(22_000), tareMilli: kg(7_000) };
    const final: FreightSideFields = { mode: 'directo', netMilli: kg(14_800) };
    const a = computeSideNet(initial);
    const b = computeSideNet(final);
    expect(a).toEqual({ ok: true, netMilli: kg(15_000) });
    expect(b).toEqual({ ok: true, netMilli: kg(14_800) });
    expect(computeDifference(a.ok ? a.netMilli : undefined, b.ok ? b.netMilli : undefined)).toEqual({ diffMilli: kg(200), percentBp: 133 }); // 1.33 %
  });
});
