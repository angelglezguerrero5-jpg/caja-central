import { describe, expect, it } from 'vitest';
import {
  FUTURE_TOLERANCE_MS,
  MAX_CONTAINERS,
  MAX_NET_MILLI,
  MAX_TEXT,
  computeNet,
  currentNetMilli,
  normalizeFields,
  possibleDuplicates,
  validateFields,
  type ReceptionFields,
} from '../../src/domain/reception';
import {
  MAX_PRICE_CENTS,
  MAX_QTY_MILLI,
  lineTotalCents,
  parseMoney,
  parsePrice,
  parseQty,
} from '../../src/domain/money';
import type { Reception } from '../../src/domain/types';

const kg = (n: number) => Math.round(n * 1000);
const base = (o: Partial<ReceptionFields> = {}): ReceptionFields => ({
  packaging: 'arpilla', weightMode: 'por_envase', ...o,
});

describe('cálculo de kilos netos (casos 8–11)', () => {
  it('8. a granel con peso directo', () => {
    expect(computeNet({ packaging: 'granel', weightMode: 'directo', netDirectMilli: kg(1234.5) })).toEqual({ ok: true, netMilli: 1_234_500 });
  });

  it('9. cajas con peso configurado', () => {
    expect(computeNet(base({ packaging: 'caja', containers: 40, unitNetMilli: kg(18.25) }))).toEqual({ ok: true, netMilli: kg(730) });
  });

  it('10–11. arpillas: 10 × 15 kg = 150 kg (ejemplo del prompt) y pesos fraccionarios', () => {
    expect(computeNet(base({ containers: 10, unitNetMilli: kg(15) }))).toEqual({ ok: true, netMilli: 150_000 });
    expect(computeNet(base({ containers: 3, unitNetMilli: kg(15.333) }))).toEqual({ ok: true, netMilli: 45_999 });
    expect(computeNet(base({ containers: 7, unitNetMilli: 1 }))).toEqual({ ok: true, netMilli: 7 }); // 1 g por envase
  });

  it('bruto − tara', () => {
    expect(computeNet({ packaging: 'caja', weightMode: 'bruto_tara', grossMilli: kg(520), tareMilli: kg(20) })).toEqual({ ok: true, netMilli: kg(500) });
    expect(computeNet({ packaging: 'granel', weightMode: 'bruto_tara', grossMilli: kg(100), tareMilli: 0 })).toEqual({ ok: true, netMilli: kg(100) });
  });

  it('NO suma un peso calculado con uno capturado: solo cuenta el modo activo', () => {
    const f = base({ containers: 10, unitNetMilli: kg(15), netDirectMilli: kg(999), grossMilli: kg(5000), tareMilli: kg(1) });
    expect(computeNet(f)).toEqual({ ok: true, netMilli: 150_000 });
    const clean = normalizeFields(f);
    expect(clean.netDirectMilli).toBeUndefined();
    expect(clean.grossMilli).toBeUndefined();
    expect(clean.tareMilli).toBeUndefined();
    expect(clean.unitNetMilli).toBe(kg(15));
    expect(computeNet(clean)).toEqual({ ok: true, netMilli: 150_000 });
  });

  it('sin peso conocido NO inventa nada: falta el dato (borrador)', () => {
    const r = computeNet(base({ containers: 10 }));
    expect(r).toMatchObject({ ok: false, missing: true });
    expect((r as { error: string }).error).toMatch(/borrador/);
    expect(computeNet(base({ packaging: 'caja' }))).toMatchObject({ ok: false, missing: true });
    expect(computeNet({ packaging: 'granel', weightMode: 'directo' })).toMatchObject({ ok: false, missing: true });
    expect(computeNet({ packaging: 'granel', weightMode: 'bruto_tara', grossMilli: kg(10) })).toMatchObject({ ok: false, missing: true });
  });
});

describe('kilos y cantidades inválidas (negativas)', () => {
  const invalid = (f: ReceptionFields) => expect(computeNet(f)).toMatchObject({ ok: false, missing: false });

  it('directo: cero, negativo, decimal fraccionario de milésima, NaN, Infinity y excesivo', () => {
    for (const v of [0, -1, -kg(5), 1.5, NaN, Infinity, -Infinity, MAX_NET_MILLI + 1, Number.MAX_SAFE_INTEGER + 2]) {
      invalid({ packaging: 'granel', weightMode: 'directo', netDirectMilli: v });
    }
    expect(computeNet({ packaging: 'granel', weightMode: 'directo', netDirectMilli: MAX_NET_MILLI })).toMatchObject({ ok: true });
  });

  it('por envase: envases cero/negativos/fraccionarios/NaN, peso inválido y desbordamiento', () => {
    for (const c of [0, -3, 2.5, NaN, Infinity, MAX_CONTAINERS + 1]) invalid(base({ containers: c, unitNetMilli: kg(15) }));
    for (const u of [0, -1, 0.5, NaN, Infinity]) invalid(base({ containers: 10, unitNetMilli: u }));
    // producto mayor al máximo permitido
    invalid(base({ containers: MAX_CONTAINERS, unitNetMilli: kg(100) }));
    // producto que desborda la aritmética entera segura
    invalid(base({ containers: MAX_CONTAINERS, unitNetMilli: Number.MAX_SAFE_INTEGER }));
    // a granel no hay envases
    invalid({ packaging: 'granel', weightMode: 'por_envase', containers: 3, unitNetMilli: kg(15) });
  });

  it('bruto − tara: tara ≥ bruto, negativos y valores no enteros', () => {
    const f = (g: number, t: number): ReceptionFields => ({ packaging: 'caja', weightMode: 'bruto_tara', grossMilli: g, tareMilli: t });
    invalid(f(kg(10), kg(10)));
    invalid(f(kg(10), kg(11)));
    invalid(f(kg(10), -1));
    invalid(f(-kg(10), 0));
    invalid(f(0, 0));
    invalid(f(kg(10), 0.5));
    invalid(f(MAX_NET_MILLI + 1, 0));
    expect(computeNet(f(kg(10), kg(9.999)))).toEqual({ ok: true, netMilli: 1 });
  });

  it('el texto del teclado: vacío, negativo, notación científica, letras y demasiados decimales', () => {
    for (const t of ['', ' ', '.', '-5', '1e3', '1,2,3', 'abc', '12abc', '1.2345', '--1', '+5']) {
      expect(parseQty(t), `parseQty(${JSON.stringify(t)})`).toBeNull();
    }
    expect(parseQty('15,5')).toBe(15_500);
    expect(parseQty('.5')).toBe(500);
    expect(parseQty('0.001')).toBe(1);
    expect(parseQty('200000')).toBe(MAX_QTY_MILLI);
    expect(parseQty('200000.001')).toBeNull(); // excede el máximo
    expect(parseQty('99999999999999999999')).toBeNull();
  });

  it('límites de dinero y precio; el importe nunca desborda', () => {
    expect(parsePrice('100000')).toBe(MAX_PRICE_CENTS);
    expect(parsePrice('100000.01')).toBeNull();
    expect(parseMoney('0.1')).toBe(10);
    expect(parseMoney('-1')).toBeNull();
    expect(parseMoney('1e5')).toBeNull();
    expect(parseMoney('99999999999999999')).toBeNull();
    expect(lineTotalCents(MAX_PRICE_CENTS, MAX_QTY_MILLI)).toBe(2e12); // $20 000 000 000, exacto
    expect(() => lineTotalCents(Number.MAX_SAFE_INTEGER, 1000)).toThrow(RangeError);
  });
});

describe('normalización y validación', () => {
  const now = new Date('2026-10-10T12:00:00.000Z');
  const okProduct = { unit: 'kg' as const, active: true };

  it('recorta textos, descarta campos de otros modos y quita envases a granel', () => {
    const n = normalizeFields({
      packaging: 'granel', weightMode: 'directo', supplier: '  Rancho   El  Sol ', reference: ' ', notes: undefined,
      containers: 5, netDirectMilli: kg(10), unitNetMilli: kg(15), grossMilli: kg(1), tareMilli: 0,
    });
    expect(n).toEqual({ packaging: 'granel', weightMode: 'directo', supplier: 'Rancho El Sol', netDirectMilli: kg(10) });
  });

  it('un borrador puede estar incompleto pero no vacío ni con datos inválidos', () => {
    const draft = (f: ReceptionFields) => validateFields(normalizeFields(f), { forConfirm: false, now });
    expect(draft(base({ supplier: 'Rancho El Sol' }))).toEqual([]);
    expect(draft(base({ containers: 10 }))).toEqual([]); // sin peso: borrador válido
    expect(draft(base())).toEqual(['El borrador está vacío: captura al menos un dato']);
    expect(draft(base({ containers: 10, unitNetMilli: -5 }))).toHaveLength(1);
    expect(draft({ packaging: 'granel', weightMode: 'directo', netDirectMilli: MAX_NET_MILLI + 1 })).toHaveLength(1);
  });

  it('para confirmar exige producto activo en kg y peso completo', () => {
    const full = base({ productId: 'p', containers: 10, unitNetMilli: kg(15) });
    const v = (f: ReceptionFields, product: Parameters<typeof validateFields>[1]['product']) =>
      validateFields(normalizeFields(f), { forConfirm: true, now, product });
    expect(v(full, okProduct)).toEqual([]);
    expect(v({ ...full, productId: undefined }, okProduct)[0]).toMatch(/Elige qué producto llegó/);
    expect(v(full, null)[0]).toMatch(/ya no existe/);
    expect(v(full, { unit: 'kg', active: false })[0]).toMatch(/oculto/);
    expect(v(full, { unit: 'caja', active: true })[0]).toMatch(/por kg/);
    expect(v({ ...full, unitNetMilli: undefined }, okProduct)[0]).toMatch(/peso neto/);
  });

  it('fecha: válida, no futura (con tolerancia) y no absurda', () => {
    const check = (receivedAt: string) => validateFields(normalizeFields(base({ supplier: 'x', receivedAt })), { forConfirm: false, now });
    expect(check('2026-10-10T07:30:00.000Z')).toEqual([]);
    expect(check(new Date(now.getTime() + FUTURE_TOLERANCE_MS).toISOString())).toEqual([]);
    expect(check(new Date(now.getTime() + FUTURE_TOLERANCE_MS + 1000).toISOString())).toEqual(['La fecha de recepción no puede ser futura']);
    expect(check('no es fecha')).toEqual(['La fecha y hora de recepción no es válida']);
    expect(check('1999-12-31T00:00:00.000Z')).toEqual(['La fecha de recepción es demasiado antigua']);
  });

  it('textos: longitud máxima y caracteres de control/invisibles', () => {
    const bell = String.fromCharCode(7);
    const zw = String.fromCharCode(0x200b);
    const v = (f: Partial<ReceptionFields>) => validateFields(base({ supplier: 's', ...f }), { forConfirm: false, now });
    expect(v({ supplier: 'a'.repeat(MAX_TEXT.supplier) })).toEqual([]);
    expect(v({ supplier: 'a'.repeat(MAX_TEXT.supplier + 1) })[0]).toMatch(/máximo/);
    expect(v({ reference: 'a'.repeat(MAX_TEXT.reference + 1) })[0]).toMatch(/máximo/);
    expect(v({ notes: 'a'.repeat(MAX_TEXT.notes + 1) })[0]).toMatch(/máximo/);
    expect(v({ notes: `uno${bell}dos` })[0]).toMatch(/no permitidos/);
    expect(v({ supplier: `ran${zw}cho` })[0]).toMatch(/no permitidos/);
  });

  it('presentación y modo desconocidos, y envases a granel', () => {
    const v = (f: unknown) => validateFields(f as ReceptionFields, { forConfirm: false, now });
    expect(v({ packaging: 'tonel', weightMode: 'directo', supplier: 'x' })).toEqual(['Presentación inválida']);
    expect(v({ packaging: 'granel', weightMode: 'magia', supplier: 'x' })).toEqual(['Modo de peso inválido']);
    expect(v({ packaging: 'granel', weightMode: 'directo', containers: 3, supplier: 'x' })).toEqual(['A granel no se cuentan cajas ni arpillas']);
  });
});

describe('posibles duplicados y kilos vigentes', () => {
  const T0 = Date.parse('2026-10-10T15:00:00.000Z');
  const HOUR = 3600 * 1000;
  const rec = (o: Partial<Reception>): Reception => ({
    id: 'r1', status: 'confirmada', createdAt: '', updatedAt: '',
    receivedAt: new Date(T0 - 30 * HOUR).toISOString(), confirmedAt: new Date(T0 - 30 * HOUR).toISOString(),
    day: '2026-10-09', packaging: 'arpilla', weightMode: 'directo', corrections: [], productId: 'p1',
    confirmedNetMilli: kg(150), netMilli: kg(150), ...o,
  });
  const cand = {
    id: 'nuevo', productId: 'p1', reference: ' camión 12 ', supplier: 'Rancho', netMilli: kg(150),
    day: '2026-10-10', receivedAtMs: T0, atMs: T0,
  };

  it('regla 1: misma referencia y producto con llegada a menos de 48 h', () => {
    const c = { ...cand, supplier: undefined };
    expect(possibleDuplicates(c, [rec({ reference: 'CAMIÓN 12' })])).toHaveLength(1);
    // la comparación ignora mayúsculas, acentos y espacios de más
    expect(possibleDuplicates({ ...c, reference: 'camion   12' }, [rec({ reference: 'Camión 12' })])).toHaveLength(1);
    // una placa o referencia que se repite cada semana NO avisa
    expect(
      possibleDuplicates(c, [rec({ reference: 'camión 12', receivedAt: new Date(T0 - 10 * 24 * HOUR).toISOString() })]),
    ).toHaveLength(0);
    // distinto producto / estado / mismo id → no es duplicado
    expect(possibleDuplicates(c, [rec({ reference: 'camión 12', productId: 'p2' })])).toHaveLength(0);
    expect(possibleDuplicates(c, [rec({ reference: 'camión 12', status: 'anulada' }), rec({ reference: 'camión 12', status: 'borrador' })])).toHaveLength(0);
    expect(possibleDuplicates({ ...c, id: 'r1' }, [rec({ reference: 'camión 12' })])).toHaveLength(0);
  });

  it('regla 2: mismo proveedor + producto + kilos vigentes + día de llegada', () => {
    const c = { ...cand, reference: undefined };
    expect(possibleDuplicates(c, [rec({ supplier: 'rancho', day: '2026-10-10' })])).toHaveLength(1);
    expect(possibleDuplicates(c, [rec({ supplier: 'Rancho', day: '2026-10-10', confirmedNetMilli: kg(151), netMilli: kg(151) })])).toHaveLength(0);
    expect(possibleDuplicates(c, [rec({ supplier: 'Rancho', day: '2026-10-09' })])).toHaveLength(0);
    expect(possibleDuplicates(c, [rec({ supplier: 'Otro', day: '2026-10-10' })])).toHaveLength(0);
    // usa los kilos VIGENTES (con correcciones), no los originales
    const corrected = rec({
      supplier: 'Rancho', day: '2026-10-10', confirmedNetMilli: kg(160), netMilli: kg(150),
      corrections: [{ id: 'c', at: '', reason: 'x', previousNetMilli: kg(160), newNetMilli: kg(150), deltaMilli: -kg(10), stockMoveId: 'm' }],
    });
    expect(possibleDuplicates(c, [corrected])).toHaveLength(1);
  });

  it('regla 3: mismo producto y mismos kilos confirmados hace menos de 10 minutos (reintento tras recargar)', () => {
    const c = { ...cand, reference: undefined, supplier: undefined };
    const justNow = rec({ confirmedAt: new Date(T0 - 4 * 60 * 1000).toISOString() });
    expect(possibleDuplicates(c, [justNow])).toHaveLength(1);
    expect(possibleDuplicates(c, [rec({ confirmedAt: new Date(T0 - 11 * 60 * 1000).toISOString() })])).toHaveLength(0);
    expect(possibleDuplicates(c, [{ ...justNow, productId: 'p2' }])).toHaveLength(0);
    expect(possibleDuplicates(c, [{ ...justNow, confirmedNetMilli: kg(151), netMilli: kg(151) }])).toHaveLength(0);
  });

  it('sin referencia ni proveedor y sin confirmación reciente nunca se marca', () => {
    expect(possibleDuplicates({ ...cand, reference: undefined, supplier: undefined }, [rec({})])).toHaveLength(0);
    expect(possibleDuplicates({ ...cand, reference: '   ', supplier: ' ' }, [rec({ reference: ' ', supplier: '  ' })])).toHaveLength(0);
  });

  it('kilos vigentes = originales + correcciones; 0 si no está confirmada', () => {
    const c = (d: number) => ({ id: 'c', at: '', reason: 'x', previousNetMilli: 0, newNetMilli: 0, deltaMilli: d, stockMoveId: 'm' });
    expect(currentNetMilli({ status: 'confirmada', confirmedNetMilli: kg(150), corrections: [c(-kg(10)), c(kg(2))] })).toBe(kg(142));
    expect(currentNetMilli({ status: 'anulada', confirmedNetMilli: kg(150), corrections: [] })).toBe(0);
    expect(currentNetMilli({ status: 'borrador', corrections: [] })).toBe(0);
  });
});
