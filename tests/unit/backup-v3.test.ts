import { describe, expect, it } from 'vitest';
import { validateBackup } from '../../src/db/backup';
import { MAX_FREIGHT_NET_MILLI } from '../../src/domain/freight';

/**
 * Respaldo formato 3 (con fletes): forma estricta, formatos mezclados y entradas hostiles. Solo se valida la FORMA; las
 * cuentas (neto = bruto − tara, anulado con motivo...) las revisa la auditoría (freight-repo.test.ts).
 */

type Rec = Record<string, unknown>;
const kg = (n: number) => Math.round(n * 1000);

const freight = (over: Rec = {}): Rec => ({
  id: 'fl-1',
  folio: 'F-1',
  folioKey: 'F-1',
  status: 'activo',
  createdAt: '2026-10-14T18:00:00.000Z',
  updatedAt: '2026-10-14T18:00:00.000Z',
  date: '2026-10-14T18:00:00.000Z',
  day: '2026-10-14',
  origin: 'Apatzingán',
  destination: 'CDMX',
  notes: 'sin novedad',
  initial: { mode: 'bruto_tara', grossMilli: kg(22_000), tareMilli: kg(7_000), netMilli: kg(15_000), ticket: 'B-1', scale: 'Norte' },
  final: { mode: 'directo', netMilli: kg(14_800) },
  revisions: [{ id: 'r1', at: '2026-10-14T19:00:00.000Z', reason: 'typo', changes: [{ field: 'origin', before: 'Apatzinga', after: 'Apatzingán' }] }],
  ...over,
});

const base = (over: Rec = {}): Rec => ({
  app: 'sistema-venta-limones',
  version: 3,
  exportedAt: '2026-10-14T18:00:00.000Z',
  products: [],
  sales: [],
  shifts: [],
  cashMovements: [],
  stockMoves: [],
  receptions: [],
  freights: [freight()],
  nextFolio: 1,
  nextValeFolio: 1,
  nextReceptionFolio: 1,
  ...over,
});

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('formato 3: un respaldo válido', () => {
  it('conserva todos los datos de los fletes, tal cual, y sale como versión 3', () => {
    const input = base({ freightSettings: { refMinMilli: kg(150), refMaxMilli: kg(250), validated: true } });
    const copy = clone(input);
    const out = validateBackup(input);
    expect(out.version).toBe(3);
    expect(out.freights).toEqual(clone(input.freights));
    expect(out.freightSettings).toEqual({ refMinMilli: kg(150), refMaxMilli: kg(250), validated: true });
    expect(input, 'no modifica lo que recibe').toEqual(copy);
  });

  it('es estable: validar lo ya validado no cambia nada', () => {
    const once = validateBackup(base());
    expect(validateBackup(clone(once))).toEqual(once);
  });

  it('los datos derivados (diferencia, porcentaje) NO forman parte del respaldo: se calculan al leer', () => {
    const out = validateBackup(base({ freights: [freight({ diffMilli: 5, percentBp: 5, difference: 5 })] }));
    expect(Object.keys(out.freights[0]).sort()).toEqual(
      ['createdAt', 'date', 'day', 'destination', 'final', 'folio', 'folioKey', 'id', 'initial', 'notes', 'origin', 'revisions', 'status', 'updatedAt'].sort(),
    );
  });

  it('un flete anulado, uno incompleto (solo destino) y la configuración sin rango son válidos', () => {
    const out = validateBackup(
      base({
        freights: [
          freight({ id: 'a', folioKey: 'A', folio: 'A', status: 'anulado', voidedAt: '2026-10-14T20:00:00.000Z', voidReason: 'duplicado' }),
          freight({ id: 'b', folioKey: 'B', folio: 'B', initial: undefined }),
        ],
        freightSettings: { validated: false },
      }),
    );
    expect(out.freights).toHaveLength(2);
    expect(out.freights[1].initial).toBeUndefined();
    expect(out.freightSettings).toEqual({ validated: false });
  });
});

describe('formatos 1, 2 y 3: nada se adivina', () => {
  it('un respaldo 3 sin la lista de fletes está incompleto', () => {
    const b = base();
    delete b.freights;
    expect(() => validateBackup(b)).toThrow(/Respaldo incompleto: falta freights/);
    expect(() => validateBackup(base({ freights: 'no' }))).toThrow(/falta freights/);
    expect(() => validateBackup(base({ freights: null }))).toThrow(/falta freights/);
  });

  it('un 3 sigue exigiendo todo lo del 2 (recepciones y folios)', () => {
    const noRec = base();
    delete noRec.receptions;
    expect(() => validateBackup(noRec)).toThrow(/falta receptions/);
    const noVale = base();
    delete noVale.nextValeFolio;
    expect(() => validateBackup(noVale)).toThrow(/falta nextValeFolio/);
  });

  it('un archivo que dice ser 1 o 2 pero trae fletes o su configuración es mezclado y se rechaza', () => {
    for (const version of [1, 2]) {
      const withFreights = base({ version });
      if (version === 1) {
        delete withFreights.receptions;
        delete withFreights.nextReceptionFolio;
      }
      expect(() => validateBackup(withFreights), `v${version} con fletes`).toThrow(/formato mezclado.*trae fletes/);
      const withSettings = clone(withFreights);
      delete withSettings.freights;
      withSettings.freightSettings = { validated: true };
      expect(() => validateBackup(withSettings), `v${version} con configuración`).toThrow(/formato mezclado/);
    }
  });

  it('los formatos 1 y 2 de verdad (sin fletes) se aceptan y salen como 3 con la lista vacía', () => {
    const v2 = base({ version: 2 });
    delete v2.freights;
    expect(validateBackup(v2)).toMatchObject({ version: 3, freights: [] });
    const v1 = base({ version: 1 });
    delete v1.freights;
    delete v1.receptions;
    delete v1.nextReceptionFolio;
    expect(validateBackup(v1)).toMatchObject({ version: 3, freights: [], receptions: [] });
  });

  it('una versión futura (4) se rechaza', () => {
    expect(() => validateBackup(base({ version: 4 }))).toThrow(/no es un respaldo válido/);
  });
});

describe('formato 3: entradas dañadas u hostiles se rechazan', () => {
  const bad = (label: string, mutate: (f: Rec) => void, message: RegExp) => {
    it(label, () => {
      const f = freight();
      mutate(f);
      expect(() => validateBackup(base({ freights: [f] }))).toThrow(message);
    });
  };

  bad('folio que no es texto', (f) => (f.folio = 5), /flete nº 1 \(folio: texto inválido\)/);
  bad('folio vacío', (f) => (f.folio = ''), /folio: texto inválido/);
  bad('folioKey ausente', (f) => delete f.folioKey, /folioKey: falta/);
  bad('estado desconocido', (f) => (f.status = 'borrado'), /status: valor no permitido/);
  bad('fecha sin formato ISO', (f) => (f.date = '14/10/2026'), /date: fecha inválida/);
  bad('día inválido', (f) => (f.day = '2026-10'), /day: día inválido/);
  bad('origen que no es texto', (f) => (f.origin = { toString: 'x' }), /origin: texto inválido/);
  bad('texto de más de 2,000 caracteres', (f) => (f.notes = 'n'.repeat(2001)), /notes: texto inválido/);
  bad('modo de pesada desconocido', (f) => ((f.initial as Rec).mode = 'a_ojo'), /initial\.mode: valor no permitido/);
  bad('neto con decimales', (f) => ((f.initial as Rec).netMilli = 1.5), /initial\.netMilli: número entero inválido/);
  bad('neto cero', (f) => ((f.final as Rec).netMilli = 0), /final\.netMilli: número entero inválido/);
  bad('neto negativo', (f) => ((f.final as Rec).netMilli = -5), /final\.netMilli: número entero inválido/);
  bad('neto de texto', (f) => ((f.final as Rec).netMilli = '14800'), /final\.netMilli: número entero inválido/);
  bad('neto por encima del máximo', (f) => ((f.final as Rec).netMilli = MAX_FREIGHT_NET_MILLI + 1), /final\.netMilli: número entero inválido o fuera de rango/);
  bad('bruto absurdo', (f) => ((f.initial as Rec).grossMilli = 2 ** 60), /initial\.grossMilli/);
  bad('tara negativa', (f) => ((f.initial as Rec).tareMilli = -1), /initial\.tareMilli/);
  bad('pesada que no es un objeto', (f) => (f.initial = 'mucho'), /initial: no es un objeto/);
  bad('pesada nula', (f) => (f.final = null), /final: no es un objeto/);
  bad('falta la bitácora', (f) => delete f.revisions, /revisions: falta/);
  bad('bitácora que no es lista', (f) => (f.revisions = {}), /revisions: debe ser una lista/);
  bad('corrección sin motivo (campo ausente)', (f) => delete (f.revisions as Rec[])[0].reason, /reason: falta/);
  bad('cambio con campo ausente', (f) => delete ((f.revisions as Rec[])[0].changes as Rec[])[0].field, /field: falta/);
  bad('cambio con valor que no es texto ni número', (f) => (((f.revisions as Rec[])[0].changes as Rec[])[0].after = { x: 1 }), /after: valor inválido/);

  it('la lista de fletes con un elemento que no es un objeto', () => {
    expect(() => validateBackup(base({ freights: [null] }))).toThrow(/flete nº 1 \(registro: no es un objeto\)/);
    expect(() => validateBackup(base({ freights: [[]] }))).toThrow(/no es un objeto/);
    expect(() => validateBackup(base({ freights: [5] }))).toThrow(/no es un objeto/);
  });

  it('dos fletes con el mismo id o con el mismo folio normalizado', () => {
    expect(() => validateBackup(base({ freights: [freight(), freight({ folio: 'otro', folioKey: 'OTRO' })] }))).toThrow(/fletes con id repetido/);
    expect(() => validateBackup(base({ freights: [freight(), freight({ id: 'fl-2' })] }))).toThrow(/fletes con folio repetido/);
  });

  it('campos desconocidos y «__proto__» se descartan: nunca llegan a la base', () => {
    // JSON.parse crea «__proto__» como clave PROPIA (no como prototipo): es la forma real de un archivo hostil.
    const raw = JSON.stringify(base()).replace('"freights":[{', '"freights":[{"__proto__":{"polluted":true},"extra":1,');
    const input = JSON.parse(raw) as { freights: Rec[] };
    expect(Object.keys(input.freights[0]), 'el archivo de prueba sí trae esas claves').toEqual(expect.arrayContaining(['__proto__', 'extra']));
    const out = validateBackup(input);
    expect(Object.keys(out.freights[0])).not.toContain('extra');
    expect(Object.keys(out.freights[0])).not.toContain('__proto__');
    expect(Object.getPrototypeOf(out.freights[0])).toBe(Object.prototype);
    expect(({} as Rec).polluted, 'el prototipo global no se contaminó').toBeUndefined();
  });

  it('configuración: rango invertido, valores no enteros o tipo equivocado', () => {
    expect(() => validateBackup(base({ freightSettings: { refMinMilli: kg(300), refMaxMilli: kg(200), validated: true } }))).toThrow(/configuración de fletes inválida/);
    expect(() => validateBackup(base({ freightSettings: { refMinMilli: kg(100), validated: true } }))).toThrow(/configuración de fletes inválida/);
    expect(() => validateBackup(base({ freightSettings: { refMinMilli: 1.5, refMaxMilli: 5, validated: true } }))).toThrow(/configuración de fletes/);
    expect(() => validateBackup(base({ freightSettings: { validated: 'sí' } }))).toThrow(/configuración de fletes/);
    expect(() => validateBackup(base({ freightSettings: [] }))).toThrow(/configuración de fletes/);
    expect(() => validateBackup(base({ freightSettings: null }))).toThrow(/configuración de fletes/);
  });
});
