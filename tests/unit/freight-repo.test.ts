import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditData, auditDatabase } from '../../src/db/audit';
import { validateBackup } from '../../src/db/backup';
import {
  DuplicateFreightError,
  FreightFolioTakenError,
  FreightValidationError,
  createFreight,
  freightFolioKeys,
  getFreight,
  getFreightSettings,
  listFreights,
  saveFreightSettings,
  updateFreight,
  voidFreight,
} from '../../src/db/freights';
import { confirmReception } from '../../src/db/receptions';
import { createSale, exportBackup, importBackup, newId, openDatabase, openShift, saveProduct, type DB } from '../../src/db/repo';
import { addLine } from '../../src/domain/cart';
import { DEFAULT_FREIGHT_SETTINGS, differenceOf, freightState, type FreightFields } from '../../src/domain/freight';
import type { Backup } from '../../src/domain/types';

// El día de un flete es el día LOCAL (Ciudad de México, UTC−6 todo el año). Vitest corre en UTC por omisión, donde «local» y UTC
// coinciden y la prueba no demostraría nada: se fija la zona del negocio y se restaura al terminar.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Mexico_City';
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const kg = (n: number) => Math.round(n * 1000);
const AT = new Date('2026-10-14T18:00:00.000Z'); // 12:00 en la Ciudad de México
let db: DB;
beforeEach(async () => {
  db = await openDatabase(`fl-${newId()}`);
});
afterEach(() => db?.close());

const fields = (over: Partial<FreightFields> = {}): FreightFields => ({
  folio: 'F-261014-01',
  origin: 'Apatzingán, Mich.',
  destination: 'Central de Abasto, CDMX',
  initial: { mode: 'bruto_tara', grossMilli: kg(22_000), tareMilli: kg(7_000), ticket: 'B-1203', scale: 'Báscula del huerto' },
  ...over,
});
const complete = (over: Partial<FreightFields> = {}) => fields({ final: { mode: 'directo', netMilli: kg(14_760), ticket: 'CDMX-88' }, ...over });

/** Foto de todo lo que NO es un flete: un flete no debe tocar ventas, inventario, caja ni folios. */
async function everythingElse(d: DB) {
  const b = await exportBackup(d);
  const { freights: _f, freightSettings: _s, exportedAt: _e, ...rest } = b;
  return rest;
}

describe('crear un flete', () => {
  it('guarda folio, fecha, origen, destino, pesadas y evidencias; los netos salen de la fórmula', async () => {
    const f = await createFreight(db, complete(), { at: AT });
    expect(f).toMatchObject({
      folio: 'F-261014-01',
      folioKey: 'F-261014-01',
      status: 'activo',
      origin: 'Apatzingán, Mich.',
      destination: 'Central de Abasto, CDMX',
      day: '2026-10-14',
      createdAt: AT.toISOString(),
      date: AT.toISOString(),
      revisions: [],
    });
    expect(f.initial).toEqual({ mode: 'bruto_tara', grossMilli: kg(22_000), tareMilli: kg(7_000), netMilli: kg(15_000), ticket: 'B-1203', scale: 'Báscula del huerto' });
    expect(f.final).toEqual({ mode: 'directo', netMilli: kg(14_760), ticket: 'CDMX-88' });
    expect(differenceOf(f)).toEqual({ diffMilli: kg(240), percentBp: 160 }); // 240 kg = 1.60 %
    expect(freightState(f)).toBe('completo');
    expect(await getFreight(db, f.id)).toEqual(f);
  });

  it('el día es el LOCAL de la fecha del flete, no el UTC (una llegada de las 21:30 sigue siendo de ese día)', async () => {
    expect(new Date('2026-10-15T03:30:00.000Z').getTimezoneOffset(), 'el entorno no respetó TZ=America/Mexico_City: esta prueba no probaría nada').toBe(360);
    const f = await createFreight(db, fields({ date: '2026-10-15T03:30:00.000Z' }), { at: new Date('2026-10-15T04:00:00.000Z') }); // 21:30 del 14 en CDMX
    expect(f.day).toBe('2026-10-14'); // en UTC ya sería el 15
  });

  it('NO toca ventas, inventario, caja ni folios', async () => {
    const p = await saveProduct(db, { name: 'Sin semilla', quality: 'Primera', unit: 'kg', priceCents: 3000, active: true });
    await confirmReception(db, { id: newId(), productId: p.id, packaging: 'granel', weightMode: 'directo', netDirectMilli: kg(100) });
    await openShift(db, 10_000);
    await createSale(db, { cart: addLine([], p, kg(10)), paymentMethod: 'efectivo', receivedCents: 30_000 });
    const before = await everythingElse(db);
    await createFreight(db, complete(), { at: AT });
    await createFreight(db, complete({ folio: 'F-2' }), { at: AT });
    expect(await everythingElse(db)).toEqual(before);
  });

  it('un flete con UNA sola pesada queda incompleto y sin diferencia', async () => {
    const f = await createFreight(db, fields(), { at: AT });
    expect(freightState(f)).toBe('falta_final');
    expect(differenceOf(f)).toBeNull();
    const g = await createFreight(db, { ...fields({ folio: 'F-2' }), initial: undefined, final: { mode: 'directo', netMilli: kg(14_000) } }, { at: AT });
    expect(freightState(g)).toBe('falta_inicial');
  });

  it('datos inválidos: se rechazan TODOS y no se guarda nada', async () => {
    const bad: Array<[string, FreightFields, RegExp]> = [
      ['sin folio', fields({ folio: '' }), /folio/],
      ['sin origen', fields({ origin: '' }), /origen/],
      ['sin destino', fields({ destination: undefined }), /destino/],
      ['sin pesadas', { folio: 'X', origin: 'a', destination: 'b' }, /al menos una pesada/],
      ['tara mayor que el bruto', fields({ initial: { mode: 'bruto_tara', grossMilli: kg(10), tareMilli: kg(20) } }), /tara debe ser menor/],
      ['negativo', fields({ initial: { mode: 'directo', netMilli: -1 } }), /mayor a cero/],
      ['cero', fields({ initial: { mode: 'directo', netMilli: 0 } }), /mayor a cero/],
      ['no numérico', fields({ initial: { mode: 'directo', netMilli: Number.NaN } }), /mayor a cero/],
      ['bruto sin tara', fields({ initial: { mode: 'bruto_tara', grossMilli: kg(10) } }), /tara/],
      ['fecha futura', fields({ date: '2027-01-01T00:00:00.000Z' }), /futura/],
      ['más de 200,000 kg', fields({ initial: { mode: 'directo', netMilli: kg(200_001) } }), /no puede pasar de/],
    ];
    for (const [why, input, message] of bad) {
      const err = await createFreight(db, input, { at: AT }).then(() => null, (e: Error) => e);
      expect(err, why).toBeInstanceOf(FreightValidationError);
      expect(err!.message, why).toMatch(message);
    }
    expect(await listFreights(db)).toEqual([]);
  });

  it('el mismo id dos veces (doble toque, reintento) NO crea otro flete', async () => {
    const id = newId();
    const first = await createFreight(db, { ...complete(), id }, { at: AT });
    const again = await createFreight(db, { ...complete(), id }, { at: AT }).then(() => null, (e: unknown) => e);
    expect(again).toBeInstanceOf(DuplicateFreightError);
    expect((again as DuplicateFreightError).freight).toEqual(first);
    expect(await listFreights(db)).toHaveLength(1);
  });

  it('dos guardados A LA VEZ con el mismo id: queda uno solo', async () => {
    const id = newId();
    const results = await Promise.allSettled([createFreight(db, { ...complete(), id }, { at: AT }), createFreight(db, { ...complete(), id }, { at: AT })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(DuplicateFreightError);
    expect(await listFreights(db)).toHaveLength(1);
  });
});

describe('folio único', () => {
  it('no se puede repetir, aunque cambien mayúsculas o espacios, y el primero queda intacto', async () => {
    const first = await createFreight(db, complete({ folio: 'FL-100' }), { at: AT });
    for (const variant of ['FL-100', 'fl-100', '  Fl-100 ', 'fl-100\n']) {
      const err = await createFreight(db, complete({ folio: variant }), { at: AT }).then(() => null, (e: unknown) => e);
      expect(err, `«${variant}»`).toBeInstanceOf(FreightFolioTakenError);
      expect((err as FreightFolioTakenError).freight.id).toBe(first.id);
    }
    expect(await listFreights(db)).toEqual([first]);
  });

  it('dos guardados A LA VEZ con el mismo folio: gana uno y el otro recibe el aviso', async () => {
    const results = await Promise.allSettled([createFreight(db, complete({ folio: 'CARRERA' }), { at: AT }), createFreight(db, complete({ folio: 'carrera' }), { at: AT })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(FreightFolioTakenError);
    expect(await listFreights(db)).toHaveLength(1);
  });

  it('el índice único de la base también lo exige (aunque el código se saltara la revisión)', async () => {
    await createFreight(db, complete({ folio: 'A-1' }), { at: AT });
    const other = await createFreight(db, complete({ folio: 'A-2' }), { at: AT });
    await expect(db.put('freights', { ...other, folio: 'A-1', folioKey: 'A-1' })).rejects.toMatchObject({ name: 'ConstraintError' });
  });

  it('los folios usados se listan normalizados', async () => {
    await createFreight(db, complete({ folio: 'f-1' }), { at: AT });
    await createFreight(db, complete({ folio: 'F-2' }), { at: AT });
    expect([...(await freightFolioKeys(db))].sort()).toEqual(['F-1', 'F-2']);
  });
});

describe('completar y corregir', () => {
  it('registrar la pesada que faltaba NO pide motivo y deja constancia', async () => {
    const f = await createFreight(db, fields(), { at: AT });
    const later = new Date('2026-10-14T23:00:00.000Z');
    const done = await updateFreight(db, f.id, { ...fields(), final: { mode: 'directo', netMilli: kg(14_700), ticket: 'CDMX-9' } }, { at: later });
    expect(freightState(done)).toBe('completo');
    expect(done.createdAt).toBe(f.createdAt);
    expect(done.updatedAt).toBe(later.toISOString());
    expect(done.revisions).toHaveLength(1);
    expect(done.revisions[0]).toMatchObject({ reason: 'Se completó el registro', at: later.toISOString() });
    expect(done.revisions[0].changes.map((c) => c.field).sort()).toEqual(['final.mode', 'final.netMilli', 'final.ticket']);
    expect(done.revisions[0].changes.every((c) => c.before === undefined)).toBe(true); // solo agregó: no pisó nada
    expect(differenceOf(done)).toEqual({ diffMilli: kg(300), percentBp: 200 });
  });

  it('cambiar un dato que YA estaba exige motivo; sin él no cambia nada', async () => {
    const f = await createFreight(db, complete(), { at: AT });
    const edit = complete({ initial: { mode: 'bruto_tara', grossMilli: kg(22_500), tareMilli: kg(7_000), ticket: 'B-1203', scale: 'Báscula del huerto' } });
    for (const reason of [undefined, '', '   ']) {
      const err = await updateFreight(db, f.id, edit, { reason }).then(() => null, (e: Error) => e);
      expect(err, `motivo «${reason}»`).toBeInstanceOf(Error);
      expect(err!.message).toMatch(/motivo/i);
    }
    expect(await getFreight(db, f.id)).toEqual(f);
  });

  it('con motivo se corrige y la bitácora guarda antes → después, la fecha y el motivo; lo anterior no se pierde', async () => {
    const f = await createFreight(db, complete(), { at: AT });
    const edit = complete({ initial: { mode: 'bruto_tara', grossMilli: kg(22_500), tareMilli: kg(7_000), ticket: 'B-1203', scale: 'Báscula del huerto' } });
    const later = new Date('2026-10-14T19:00:00.000Z');
    const saved = await updateFreight(db, f.id, edit, { reason: 'La boleta decía 22,500, no 22,000', at: later });
    expect(saved.initial).toMatchObject({ grossMilli: kg(22_500), netMilli: kg(15_500) });
    expect(saved.revisions).toHaveLength(1);
    expect(saved.revisions[0]).toMatchObject({ reason: 'La boleta decía 22,500, no 22,000', at: later.toISOString() });
    expect(saved.revisions[0].changes).toEqual(
      expect.arrayContaining([
        { field: 'initial.grossMilli', before: kg(22_000), after: kg(22_500) },
        { field: 'initial.netMilli', before: kg(15_000), after: kg(15_500) },
      ]),
    );
    // una segunda corrección se SUMA a la bitácora
    const again = await updateFreight(db, f.id, complete({ origin: 'Uruapan, Mich.', initial: edit.initial }), { reason: 'Era de Uruapan', at: later });
    expect(again.revisions).toHaveLength(2);
    expect(again.revisions[1].changes).toEqual([{ field: 'origin', before: 'Apatzingán, Mich.', after: 'Uruapan, Mich.' }]);
    expect(again.revisions[0]).toEqual(saved.revisions[0]);
  });

  it('cambiar de «bruto − tara» a «solo el neto» queda en la bitácora', async () => {
    const f = await createFreight(db, complete(), { at: AT });
    const saved = await updateFreight(db, f.id, complete({ initial: { mode: 'directo', netMilli: kg(15_000), ticket: 'B-1203', scale: 'Báscula del huerto' } }), { reason: 'La boleta solo trae el neto' });
    expect(saved.initial).toEqual({ mode: 'directo', netMilli: kg(15_000), ticket: 'B-1203', scale: 'Báscula del huerto' });
    const fieldsChanged = saved.revisions[0].changes.map((c) => c.field);
    expect(fieldsChanged).toEqual(expect.arrayContaining(['initial.mode', 'initial.grossMilli', 'initial.tareMilli']));
    expect(fieldsChanged).not.toContain('initial.netMilli'); // el neto no cambió
  });

  it('guardar sin cambiar nada no escribe ni agrega bitácora', async () => {
    const f = await createFreight(db, complete(), { at: AT });
    const same = await updateFreight(db, f.id, complete(), { at: new Date('2026-10-14T20:00:00.000Z') });
    expect(same).toEqual(f);
    expect((await getFreight(db, f.id))!.revisions).toEqual([]);
  });

  it('la corrección también se valida: lo inválido no se guarda y el flete queda como estaba', async () => {
    const f = await createFreight(db, complete(), { at: AT });
    const err = await updateFreight(db, f.id, complete({ final: { mode: 'bruto_tara', grossMilli: kg(10), tareMilli: kg(11) } }), { reason: 'x' }).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(FreightValidationError);
    expect(await getFreight(db, f.id)).toEqual(f);
  });

  it('cambiar el folio a uno ya usado se rechaza y no cambia nada; a uno libre sí', async () => {
    const a = await createFreight(db, complete({ folio: 'A-1' }), { at: AT });
    await createFreight(db, complete({ folio: 'B-1' }), { at: AT });
    const err = await updateFreight(db, a.id, complete({ folio: 'b-1' }), { reason: 'typo' }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FreightFolioTakenError);
    expect((await getFreight(db, a.id))!.folio).toBe('A-1');
    const ok = await updateFreight(db, a.id, complete({ folio: 'C-1' }), { reason: 'typo' });
    expect(ok).toMatchObject({ folio: 'C-1', folioKey: 'C-1' });
    // el folio viejo queda libre; el nuevo, ocupado
    await expect(createFreight(db, complete({ folio: 'A-1' }), { at: AT })).resolves.toMatchObject({ folio: 'A-1' });
    await expect(createFreight(db, complete({ folio: 'c-1' }), { at: AT })).rejects.toBeInstanceOf(FreightFolioTakenError);
  });

  it('un flete que ya no existe no se puede corregir', async () => {
    await expect(updateFreight(db, 'no-existe', complete(), { reason: 'x' })).rejects.toThrow(/ya no existe/);
  });
});

describe('anular', () => {
  it('exige motivo, conserva TODO, deja bitácora y el folio queda ocupado', async () => {
    const f = await createFreight(db, complete({ folio: 'ANU-1' }), { at: AT });
    for (const reason of ['', '   ']) await expect(voidFreight(db, f.id, reason)).rejects.toThrow(/motivo/i);
    expect((await getFreight(db, f.id))!.status).toBe('activo');

    const later = new Date('2026-10-14T21:00:00.000Z');
    const v = await voidFreight(db, f.id, 'Capturado en el flete equivocado', { at: later });
    expect(v).toMatchObject({ status: 'anulado', voidReason: 'Capturado en el flete equivocado', voidedAt: later.toISOString(), initial: f.initial, final: f.final });
    expect(v.revisions.at(-1)).toMatchObject({ reason: 'Capturado en el flete equivocado', changes: [{ field: 'status', before: 'activo', after: 'anulado' }] });
    expect(freightState(v)).toBe('anulado');

    // el folio no se reutiliza
    await expect(createFreight(db, complete({ folio: 'anu-1' }), { at: AT })).rejects.toBeInstanceOf(FreightFolioTakenError);
  });

  it('anular dos veces se rechaza; un anulado no se corrige', async () => {
    const f = await createFreight(db, complete(), { at: AT });
    await voidFreight(db, f.id, 'duplicado');
    await expect(voidFreight(db, f.id, 'otra vez')).rejects.toThrow(/ya está anulado/);
    await expect(updateFreight(db, f.id, complete({ origin: 'Otro' }), { reason: 'x' })).rejects.toThrow(/anulado/);
    expect((await getFreight(db, f.id))!.voidReason).toBe('duplicado');
  });

  it('anular no toca ventas, inventario ni caja', async () => {
    const f = await createFreight(db, complete(), { at: AT });
    const before = await everythingElse(db);
    await voidFreight(db, f.id, 'prueba');
    expect(await everythingElse(db)).toEqual(before);
  });
});

describe('lista', () => {
  it('del más reciente al más viejo, con desempate estable', async () => {
    await createFreight(db, complete({ folio: 'A', date: '2026-10-10T10:00:00.000Z' }), { at: AT });
    await createFreight(db, complete({ folio: 'B', date: '2026-10-13T10:00:00.000Z' }), { at: AT });
    await createFreight(db, complete({ folio: 'C', date: '2026-10-12T10:00:00.000Z' }), { at: AT });
    expect((await listFreights(db)).map((f) => f.folio)).toEqual(['B', 'C', 'A']);
  });
});

describe('rango de referencia', () => {
  it('sin configurar: 200–300 kg pendiente de validación', async () => {
    expect(await getFreightSettings(db)).toEqual(DEFAULT_FREIGHT_SETTINGS);
  });

  it('se guarda, se lee y se puede desactivar (sin rango) o volver a la referencia de fábrica', async () => {
    expect(await saveFreightSettings(db, { refMinMilli: kg(150), refMaxMilli: kg(250), validated: true })).toEqual({ refMinMilli: kg(150), refMaxMilli: kg(250), validated: true });
    expect(await getFreightSettings(db)).toEqual({ refMinMilli: kg(150), refMaxMilli: kg(250), validated: true });
    await saveFreightSettings(db, { validated: false });
    expect(await getFreightSettings(db)).toEqual({ validated: false }); // sin rango: NO vuelve al de fábrica por sí solo
    await saveFreightSettings(db, { ...DEFAULT_FREIGHT_SETTINGS });
    expect(await getFreightSettings(db)).toEqual(DEFAULT_FREIGHT_SETTINGS);
  });

  it('un rango inválido se rechaza y no pisa el anterior', async () => {
    await saveFreightSettings(db, { refMinMilli: kg(150), refMaxMilli: kg(250), validated: true });
    await expect(saveFreightSettings(db, { refMinMilli: kg(300), refMaxMilli: kg(200), validated: false })).rejects.toBeInstanceOf(FreightValidationError);
    await expect(saveFreightSettings(db, { refMinMilli: -5, refMaxMilli: kg(200), validated: false })).rejects.toBeInstanceOf(FreightValidationError);
    expect(await getFreightSettings(db)).toEqual({ refMinMilli: kg(150), refMaxMilli: kg(250), validated: true });
  });

  it('un valor dañado en la base se ignora y se usa el de fábrica', async () => {
    await db.put('meta', { key: 'freightSettings', value: { validated: 'sí', refMinMilli: 'x' } });
    expect(await getFreightSettings(db)).toEqual(DEFAULT_FREIGHT_SETTINGS);
  });
});

describe('respaldo, restauración y auditoría de fletes', () => {
  async function populated() {
    const a = await createFreight(db, complete({ folio: 'R-1' }), { at: AT });
    const b = await createFreight(db, fields({ folio: 'R-2' }), { at: AT });
    const c = await createFreight(db, complete({ folio: 'R-3' }), { at: AT });
    await updateFreight(db, a.id, complete({ folio: 'R-1', origin: 'Uruapan' }), { reason: 'Era de Uruapan' });
    await voidFreight(db, c.id, 'Duplicado');
    await saveFreightSettings(db, { refMinMilli: kg(100), refMaxMilli: kg(200), validated: true });
    return { a, b, c };
  }

  it('el respaldo trae los fletes y la configuración; restaurarlo en otra base los deja idénticos', async () => {
    await populated();
    const backup = await exportBackup(db);
    expect(backup.version).toBe(3);
    expect(backup.freights).toHaveLength(3);
    expect(backup.freightSettings).toEqual({ refMinMilli: kg(100), refMaxMilli: kg(200), validated: true });

    const other = await openDatabase(`fl-${newId()}`);
    await importBackup(other, JSON.parse(JSON.stringify(backup)));
    const restored = await exportBackup(other);
    expect({ ...restored, exportedAt: '' }).toEqual({ ...backup, exportedAt: '' });
    expect(await listFreights(other)).toEqual(await listFreights(db));
    expect((await auditDatabase(other)).issues).toEqual([]);
    other.close();
  });

  it('restaurar REEMPLAZA los fletes de hoy: un respaldo de la versión 2 (sin fletes) los deja vacíos', async () => {
    await populated();
    const v2 = JSON.parse(JSON.stringify(await exportBackup(db))) as Record<string, unknown>;
    v2.version = 2;
    delete v2.freights;
    delete v2.freightSettings;
    await importBackup(db, v2);
    expect(await listFreights(db)).toEqual([]);
    expect(await getFreightSettings(db)).toEqual(DEFAULT_FREIGHT_SETTINGS);
    expect((await auditDatabase(db)).issues).toEqual([]);
  });

  it('un folio que se anuló sigue ocupado después de restaurar', async () => {
    await populated();
    const backup = await exportBackup(db);
    const other = await openDatabase(`fl-${newId()}`);
    await importBackup(other, JSON.parse(JSON.stringify(backup)));
    await expect(createFreight(other, complete({ folio: 'r-3' }), { at: AT })).rejects.toBeInstanceOf(FreightFolioTakenError);
    other.close();
  });

  it('la auditoría cuenta los fletes y avisa (sin marcar error) si el peso final es mayor que el inicial', async () => {
    await createFreight(db, complete({ folio: 'AVISO', final: { mode: 'directo', netMilli: kg(15_200) } }), { at: AT });
    const r = await auditDatabase(db);
    expect(r.ok).toBe(true);
    expect(r.stats.freights).toBe(1);
    expect(r.warnings.join('|')).toMatch(/AVISO: el peso final es MAYOR que el inicial/);
  });

  let snapshot: Backup;
  /** Problemas que reporta la auditoría sobre una COPIA del respaldo alterada con `mut`. */
  const tamper = (mut: (b: Backup) => void): string[] => {
    const b = JSON.parse(JSON.stringify(snapshot)) as Backup;
    mut(b);
    return auditData(b).issues;
  };

  it('la auditoría detecta datos alterados: neto que no cuadra, folio normalizado falso, anulado sin motivo, corrección sin motivo, sin pesadas', async () => {
    await populated();
    snapshot = await exportBackup(db);
    expect(auditData(snapshot).issues).toEqual([]);
    const idx = snapshot.freights.findIndex((f) => f.folio === 'R-1');
    expect(tamper((b) => (b.freights[idx].initial!.netMilli += 1)).join('|')).toMatch(/R-1: peso inicial: neto guardado .* ≠ recalculado/);
    expect(tamper((b) => (b.freights[idx].folioKey = 'OTRO')).join('|')).toMatch(/folio normalizado/);
    const voided = snapshot.freights.findIndex((f) => f.status === 'anulado');
    expect(tamper((b) => (b.freights[voided].voidReason = '')).join('|')).toMatch(/anulado sin fecha o motivo/);
    expect(tamper((b) => (b.freights[voided].revisions = [])).join('|')).toMatch(/anulado sin su registro en la bitácora/);
    expect(tamper((b) => (b.freights[idx].revisions[0].reason = '  ')).join('|')).toMatch(/una corrección sin motivo/);
    expect(tamper((b) => (b.freights[idx].revisions[0].changes = [])).join('|')).toMatch(/una corrección sin cambios/);
    expect(tamper((b) => {
      delete b.freights[idx].initial;
      delete b.freights[idx].final;
    }).join('|')).toMatch(/no tiene ninguna pesada/);
    expect(tamper((b) => {
      b.freights[idx].voidReason = 'x';
    }).join('|')).toMatch(/vigente pero con datos de anulación/);
    expect(tamper((b) => (b.freights[idx].initial = { mode: 'directo', netMilli: kg(1), grossMilli: kg(2) })).join('|')).toMatch(/«solo neto» pero trae bruto o tara/);
    expect(tamper((b) => (b.freights[idx].origin = ' ')).join('|')).toMatch(/sin origen o sin destino/);
  });

  it('un respaldo con dos fletes del mismo folio (normalizado) o id se rechaza ANTES de tocar la base', async () => {
    await populated();
    const backup = JSON.parse(JSON.stringify(await exportBackup(db))) as Backup;
    const before = await exportBackup(db);
    const dupKey = JSON.parse(JSON.stringify(backup)) as Backup;
    dupKey.freights[1].folioKey = dupKey.freights[0].folioKey;
    await expect(importBackup(db, dupKey)).rejects.toThrow(/fletes con folio repetido/);
    const dupId = JSON.parse(JSON.stringify(backup)) as Backup;
    dupId.freights[1].id = dupId.freights[0].id;
    await expect(importBackup(db, dupId)).rejects.toThrow(/fletes con id repetido/);
    expect({ ...(await exportBackup(db)), exportedAt: '' }).toEqual({ ...before, exportedAt: '' });
    expect(() => validateBackup(backup)).not.toThrow();
  });
});
