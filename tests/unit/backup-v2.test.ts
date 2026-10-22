import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditData, auditDatabase } from '../../src/db/audit';
import { validateBackup } from '../../src/db/backup';
import {
  annotateReception,
  confirmReception,
  correctReception,
  listReceptions,
  saveReceptionDraft,
  voidReception,
} from '../../src/db/receptions';
import {
  createSale,
  deliverVale,
  exportBackup,
  getCurrentShift,
  getProduct,
  importBackup,
  listPendingVales,
  listProducts,
  newId,
  openDatabase,
  saveProduct,
  type DB,
} from '../../src/db/repo';
import { addLine } from '../../src/domain/cart';
import type { Backup } from '../../src/domain/types';

const kg = (n: number) => Math.round(n * 1000);
const fixtureV1 = (): Record<string, unknown> => JSON.parse(readFileSync('tests/fixtures/backup-v1.json', 'utf8'));

let db: DB;
beforeEach(async () => {
  db = await openDatabase(`bk-${newId()}`);
});
afterEach(() => db.close());

async function populated() {
  const p = await saveProduct(db, { name: 'Sin semilla', quality: 'Primera', caliber: '2X', unit: 'kg', priceCents: 3000, active: true });
  const q = await saveProduct(db, { name: 'Con semilla', origin: 'Oaxaca', unit: 'kg', priceCents: 2500, active: true });
  const r1 = await confirmReception(db, { id: newId(), productId: p.id, packaging: 'arpilla', containers: 10, weightMode: 'por_envase', unitNetMilli: kg(15), supplier: 'Rancho Sol', reference: 'CAM-1' });
  const r2 = await confirmReception(db, { id: newId(), productId: q.id, packaging: 'granel', weightMode: 'directo', netDirectMilli: kg(300) });
  await correctReception(db, r2.id, kg(280), 'báscula');
  const r3 = await confirmReception(db, { id: newId(), productId: q.id, packaging: 'caja', containers: 5, weightMode: 'bruto_tara', grossMilli: kg(110), tareMilli: kg(10) });
  await voidReception(db, r3.id, 'producto equivocado');
  await saveReceptionDraft(db, { id: newId(), productId: p.id, packaging: 'caja', containers: 8, weightMode: 'por_envase' });
  await createSale(db, { cart: addLine([], p, kg(20)), paymentMethod: 'efectivo', receivedCents: 60_000 });
  await createSale(db, { cart: addLine([], p, kg(30)), paymentMethod: 'tarjeta', receivedCents: 0, isVale: true });
  return { p, q, r1, r2, r3 };
}

describe('respaldo v2 (caso 18)', () => {
  it('exporta recepciones, folios y la versión actual del formato (3: la 2 trajo las recepciones y la 3 los fletes)', async () => {
    await populated();
    const b = await exportBackup(db);
    expect(b.version).toBe(3);
    expect(b.freights).toEqual([]);
    expect(b.receptions).toHaveLength(4);
    expect(b.receptions.map((r) => r.status).sort()).toEqual(['anulada', 'borrador', 'confirmada', 'confirmada']);
    expect(b.nextReceptionFolio).toBe(4);
    // r1: 1 · r2: original + corrección = 2 · r3: original + reversa = 2  → 5 movimientos enlazados
    expect(b.stockMoves.filter((m) => m.receptionId)).toHaveLength(5);
    expect(auditData(b, (await getCurrentShift(db))?.id).issues).toEqual([]);
  });

  it('exportar → importar en otra base restaura TODO y el folio continúa', async () => {
    const { p } = await populated();
    const backup = JSON.parse(JSON.stringify(await exportBackup(db)));
    const other = await openDatabase(`bk-b-${newId()}`);
    await importBackup(other, backup);

    const again = await exportBackup(other);
    const strip = (b: Backup) => ({ ...b, exportedAt: '' });
    expect(strip(again)).toEqual(strip(backup)); // idéntico, registro por registro
    expect((await auditDatabase(other)).issues).toEqual([]);
    expect((await listReceptions(other, { status: 'confirmada' }))).toHaveLength(2);
    expect((await getProduct(other, p.id))!.physicalMilli).toBe(kg(150) - kg(20));
    // el siguiente folio de recepción continúa y los kilos entran una sola vez
    const next = await confirmReception(other, { id: newId(), productId: p.id, packaging: 'granel', weightMode: 'directo', netDirectMilli: kg(10) });
    expect(next.folio).toBe(4);
    expect((await getProduct(other, p.id))!.physicalMilli).toBe(kg(150) - kg(20) + kg(10));
    other.close();
  });

  it('restaurar REEMPLAZA (no mezcla) los datos existentes', async () => {
    await populated();
    const backup = JSON.parse(JSON.stringify(await exportBackup(db)));
    const other = await openDatabase(`bk-c-${newId()}`);
    const extra = await saveProduct(other, { name: 'Tercera', unit: 'kg', priceCents: 100, active: true });
    await importBackup(other, backup);
    expect(await getProduct(other, extra.id)).toBeUndefined();
    expect(await listProducts(other)).toHaveLength(2);
    other.close();
  });
});

describe('respaldo anterior v1 (caso 19)', () => {
  it('se importa tal cual (fixture auténtica de la versión anterior) y queda consistente', async () => {
    const v1 = fixtureV1();
    expect(v1.version).toBe(1);
    expect(v1.receptions).toBeUndefined();
    const checked = validateBackup(v1);
    expect(checked.version).toBe(3);
    expect(checked.receptions).toEqual([]);
    expect(checked.freights).toEqual([]);
    expect(checked.nextReceptionFolio).toBe(1);

    await importBackup(db, v1);
    const exported = await exportBackup(db);
    expect(exported.version).toBe(3);
    // Cada colección de la fixture quedó idéntica
    for (const k of ['products', 'sales', 'shifts', 'cashMovements', 'stockMoves'] as const) {
      expect(exported[k], k).toHaveLength((v1[k] as unknown[]).length);
      expect([...exported[k]].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
        [...(v1[k] as Array<{ id: string }>)].sort((a, b) => a.id.localeCompare(b.id)),
      );
    }
    expect(exported.nextFolio).toBe(v1.nextFolio);
    expect(exported.nextValeFolio).toBe(v1.nextValeFolio);
    expect((await auditDatabase(db)).issues).toEqual([]);
    // El vale pendiente de la fixture sigue reservando y se puede entregar sin doble descuento
    const [pending] = await listPendingVales(db);
    expect(pending).toBeTruthy();
    const prodBefore = (await getProduct(db, pending.items[0].productId))!;
    await deliverVale(db, pending.id);
    const prodAfter = (await getProduct(db, pending.items[0].productId))!;
    expect(prodAfter.physicalMilli).toBe(prodBefore.physicalMilli - pending.items[0].qtyMilli);
    expect(prodAfter.reservedMilli).toBe(prodBefore.reservedMilli - pending.items[0].qtyMilli);
  });

  it('sobre ese respaldo se puede recibir mercancía en un producto anterior', async () => {
    await importBackup(db, fixtureV1());
    const legacy = (await listProducts(db)).find((p) => p.unit === 'kg')!;
    const before = legacy.physicalMilli;
    const r = await confirmReception(db, { id: newId(), productId: legacy.id, packaging: 'arpilla', containers: 20, weightMode: 'por_envase', unitNetMilli: kg(15) });
    expect(r.folio).toBe(1);
    expect((await getProduct(db, legacy.id))!.physicalMilli).toBe(before + kg(300));
    expect((await auditDatabase(db)).issues).toEqual([]);
  });
});

describe('respaldo corrupto: se rechaza sin perder información (caso 20)', () => {
  const clone = () => structuredClone(JSON.parse(JSON.stringify({ ...fixtureV1() })));

  async function rejectsKeepingData(label: string, mutate: (b: Record<string, any>) => void, message?: RegExp) {
    await importBackup(db, fixtureV1());
    const before = await exportBackup(db);
    const bad = clone();
    mutate(bad);
    const err = await importBackup(db, bad).then(() => null, (e: Error) => e);
    expect(err, `${label}: debía rechazarse`).toBeInstanceOf(Error);
    if (message) expect(err!.message, label).toMatch(message);
    const after = await exportBackup(db);
    expect({ ...after, exportedAt: '' }, `${label}: los datos cambiaron`).toEqual({ ...before, exportedAt: '' });
  }

  it('estructura y tipos', async () => {
    await rejectsKeepingData('no es un respaldo', (b) => (b.app = 'otra'), /no es un respaldo válido/);
    await rejectsKeepingData('versión futura', (b) => (b.version = 4), /no es un respaldo válido/);
    await rejectsKeepingData('falta sales', (b) => delete b.sales, /incompleto/);
    await rejectsKeepingData('v2 sin recepciones', (b) => (b.version = 2), /receptions/);
    await rejectsKeepingData('folio cero', (b) => (b.nextFolio = 0), /folio/);
    await rejectsKeepingData('folio ya usado', (b) => (b.nextFolio = 1), /ya fue usado/);
    await rejectsKeepingData('precio negativo', (b) => (b.products[0].priceCents = -5), /producto nº 1/);
    await rejectsKeepingData('precio texto', (b) => (b.products[0].priceCents = '3000'), /producto nº 1/);
    await rejectsKeepingData('unidad rara', (b) => (b.products[0].unit = 'tonelada'), /producto nº 1/);
    await rejectsKeepingData('venta sin items', (b) => (b.sales[0].items = []), /venta nº 1/);
    await rejectsKeepingData('cantidad negativa', (b) => (b.sales[0].items[0].qtyMilli = -1), /venta nº 1/);
    await rejectsKeepingData('cantidad decimal', (b) => (b.sales[0].items[0].qtyMilli = 1.5), /venta nº 1/);
    await rejectsKeepingData('desbordado', (b) => (b.sales[0].totalCents = Number.MAX_SAFE_INTEGER + 10), /venta nº 1/);
    await rejectsKeepingData('estado raro', (b) => (b.sales[0].status = 'borrada'), /venta nº 1/);
    await rejectsKeepingData('día inválido', (b) => (b.sales[0].day = 'ayer'), /venta nº 1/);
    await rejectsKeepingData('fecha inválida', (b) => (b.sales[0].createdAt = 'nunca'), /venta nº 1/);
    await rejectsKeepingData('texto gigante', (b) => (b.products[0].name = 'x'.repeat(5000)), /producto nº 1/);
    await rejectsKeepingData('movimiento con tipo raro', (b) => (b.stockMoves[0].type = 'regalo'), /movimiento de inventario nº 1/);
    await rejectsKeepingData('turno sin fondo', (b) => delete b.shifts[0].openingCashCents, /turno nº 1/);
    await rejectsKeepingData('registro no objeto', (b) => (b.products[0] = 'hola'), /producto nº 1/);
  });

  it('duplicados', async () => {
    await rejectsKeepingData('id de producto repetido', (b) => b.products.push({ ...b.products[0] }), /repetido/);
    await rejectsKeepingData('venta repetida', (b) => b.sales.push({ ...b.sales[0] }), /duplicadas/);
    await rejectsKeepingData('folio de venta repetido', (b) => (b.sales[1].folio = b.sales[0].folio), /folios de venta repetidos/);
    await rejectsKeepingData('folio de vale repetido', (b) => {
      const vales = b.sales.filter((s: any) => s.valeFolio !== undefined);
      vales[1].valeFolio = vales[0].valeFolio;
    }, /folios de vale repetidos/);
  });

  it('recepciones dañadas en un respaldo v2', async () => {
    await populated();
    const good = JSON.parse(JSON.stringify(await exportBackup(db)));
    const rejects = async (label: string, mutate: (b: Record<string, any>) => void, message: RegExp) => {
      const bad = JSON.parse(JSON.stringify(good));
      mutate(bad);
      const before = await exportBackup(db);
      await expect(importBackup(db, bad), label).rejects.toThrow(message);
      expect({ ...(await exportBackup(db)), exportedAt: '' }, label).toEqual({ ...before, exportedAt: '' });
    };
    await rejects('estado desconocido', (b) => (b.receptions[0].status = 'perdida'), /recepción nº 1/);
    await rejects('sin id', (b) => delete b.receptions[0].id, /recepción nº 1/);
    await rejects('presentación rara', (b) => (b.receptions[0].packaging = 'tonel'), /recepción nº 1/);
    await rejects('modo de peso raro', (b) => (b.receptions[0].weightMode = 'magia'), /recepción nº 1/);
    await rejects('kilos como texto', (b) => (b.receptions[0].confirmedNetMilli = '150000'), /recepción nº 1/);
    await rejects('correcciones mal formadas', (b) => {
      const r = b.receptions.find((x: any) => x.corrections.length);
      r.corrections[0].deltaMilli = 'mucho';
    }, /recepción nº/);
    await rejects('ids repetidos', (b) => b.receptions.push({ ...b.receptions[0] }), /recepciones con id repetido/);
    // (el orden de exportación es por id aleatorio: se eligen dos recepciones que SÍ tienen folio)
    await rejects('folios repetidos', (b) => {
      const conFolio = b.receptions.filter((r: any) => r.folio !== undefined);
      conFolio[1].folio = conFolio[0].folio;
    }, /folios de recepción repetidos/);
    await rejects('siguiente folio ya usado', (b) => (b.nextReceptionFolio = 1), /folio de recepción siguiente/);
    await rejects('recepciones no es lista', (b) => (b.receptions = {}), /receptions/);
  });

  it('un JSON con __proto__ y campos extra: no contamina nada y los extras no se guardan', async () => {
    const text = JSON.stringify(fixtureV1()).replace(
      '"app":',
      '"__proto__": {"polluted": true}, "extra": 1, "app":',
    );
    const parsed = JSON.parse(text);
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true); // JSON.parse lo crea como propiedad propia
    parsed.products[0].evil = 'x';
    parsed.products[0].__proto__ = { polluted: true };
    parsed.sales[0].items[0].extra = { dentro: 'de items' };
    await importBackup(db, parsed);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const b = await exportBackup(db);
    expect(Object.keys(b)).not.toContain('extra');
    expect(JSON.stringify(b)).not.toMatch(/evil|polluted|dentro/);
    expect((await auditDatabase(db)).issues).toEqual([]);
  });

  it('una inconsistencia contable con forma válida se importa pero la auditoría la reporta', async () => {
    const bad = clone();
    bad.sales[0].totalCents += 100;
    const checked = validateBackup(bad); // la FORMA es válida
    const issues = auditData(checked, undefined).issues;
    expect(issues.join(' | ')).toMatch(/total no coincide/);
  });
});

describe('respaldo v2 estricto: nada se adivina', () => {
  it('v1 que trae recepciones es un archivo mezclado: se rechaza; v1 sin recepciones sigue valiendo', () => {
    const mixed = fixtureV1();
    mixed.receptions = [];
    expect(() => validateBackup(mixed)).toThrow(/formato mezclado/);
    const mixed2 = fixtureV1();
    mixed2.nextReceptionFolio = 1;
    expect(() => validateBackup(mixed2)).toThrow(/formato mezclado/);
    expect(validateBackup(fixtureV1()).version).toBe(3);
  });

  it('v2 debe traer explícitos receptions, nextValeFolio y nextReceptionFolio', async () => {
    await populated();
    const good = JSON.parse(JSON.stringify(await exportBackup(db)));
    expect(validateBackup(good).nextReceptionFolio).toBe(4);
    for (const key of ['receptions', 'nextValeFolio', 'nextReceptionFolio']) {
      const bad = JSON.parse(JSON.stringify(good));
      delete bad[key];
      expect(() => validateBackup(bad), key).toThrow(new RegExp(`falta ${key}`));
    }
  });

  it('pesadas individuales y correcciones de datos hacen ida y vuelta exactos; los valores inválidos se rechazan', async () => {
    const p = await saveProduct(db, { name: 'Sin semilla', unit: 'kg', priceCents: 3000, active: true });
    const r = await confirmReception(db, {
      id: newId(), productId: p.id, packaging: 'arpilla', containers: 7, weightMode: 'directo',
      netDirectMilli: kg(100), weighingsMilli: [kg(60), kg(40)],
    });
    expect(r.weighingsMilli).toEqual([kg(60), kg(40)]);
    await annotateReception(db, r.id, { supplier: 'Rancho Sol', containers: 8 }, 'se corrigió el proveedor y el conteo');
    const backup = JSON.parse(JSON.stringify(await exportBackup(db)));
    expect(backup.receptions[0].dataEdits).toHaveLength(1);
    expect(backup.receptions[0].dataEdits[0].changes).toEqual([
      { field: 'supplier', after: 'Rancho Sol' },
      { field: 'containers', before: 7, after: 8 },
    ]);

    const other = await openDatabase(`bk-w-${newId()}`);
    await importBackup(other, backup);
    const strip = (b: Backup) => ({ ...b, exportedAt: '' });
    expect(strip(await exportBackup(other))).toEqual(strip(backup));
    expect((await auditDatabase(other)).issues).toEqual([]);
    other.close();

    const bad = (mutate: (b: Record<string, any>) => void) => {
      const c = JSON.parse(JSON.stringify(backup));
      mutate(c);
      return () => validateBackup(c);
    };
    expect(bad((b) => (b.receptions[0].weighingsMilli = [0, 100]))).toThrow(/recepción nº 1/);
    expect(bad((b) => (b.receptions[0].weighingsMilli = [1.5, 2]))).toThrow(/recepción nº 1/);
    expect(bad((b) => (b.receptions[0].weighingsMilli = Array(101).fill(1)))).toThrow(/recepción nº 1/);
    expect(bad((b) => (b.receptions[0].weighingsMilli = 'mucho'))).toThrow(/recepción nº 1/);
    expect(bad((b) => (b.receptions[0].dataEdits[0].changes[0].field = 'netMilli'))).toThrow(/recepción nº 1/);
    expect(bad((b) => (b.receptions[0].dataEdits[0].changes[0].after = { x: 1 }))).toThrow(/recepción nº 1/);
    expect(bad((b) => (b.receptions[0].dataEdits[0].reason = 5))).toThrow(/recepción nº 1/);
    expect(bad((b) => (b.receptions[0].dataEdits = {}))).toThrow(/recepción nº 1/);
    // campos extra dentro de dataEdits no se guardan
    const extra = JSON.parse(JSON.stringify(backup));
    extra.receptions[0].dataEdits[0].evil = 'x';
    extra.receptions[0].dataEdits[0].changes[0].evil = 'x';
    expect(JSON.stringify(validateBackup(extra))).not.toMatch(/evil/);
  });
});
