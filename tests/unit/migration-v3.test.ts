import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { auditDatabase } from '../../src/db/audit';
import { createFreight, listFreights } from '../../src/db/freights';
import { confirmReception } from '../../src/db/receptions';
import { DB_VERSION, createSale, exportBackup, importBackup, newId, openDatabase, openShift, saveProduct, type DB } from '../../src/db/repo';
import { addLine } from '../../src/domain/cart';

/**
 * Migración 2 → 3 (control de pesaje por flete): solo AÑADE el almacén `freights`; no toca nada de lo anterior.
 * La base v2 se crea con el código REAL de la versión 2 (`openDatabase(name, { version: 2 })` corre solo las migraciones 1 y 2)
 * y se llena con operaciones reales: variedades, recepciones, ventas, un vale y un turno.
 */

const kg = (n: number) => Math.round(n * 1000);
const STORES_V2 = ['products', 'sales', 'shifts', 'cashMovements', 'stockMoves', 'receptions', 'meta'] as const;

async function realV2(name: string): Promise<DB> {
  const db = await openDatabase(name, { version: 2 });
  expect(db.version).toBe(2);
  expect([...db.objectStoreNames].sort()).toEqual([...STORES_V2].sort());
  const p = await saveProduct(db, { name: 'Sin semilla', quality: 'Primera', unit: 'kg', priceCents: 3000, active: true });
  const q = await saveProduct(db, { name: 'Con semilla', unit: 'kg', priceCents: 2500, active: true });
  await confirmReception(db, { id: newId(), productId: p.id, packaging: 'caja', weightMode: 'por_envase', containers: 20, unitNetMilli: kg(15) });
  await confirmReception(db, { id: newId(), productId: q.id, packaging: 'granel', weightMode: 'directo', netDirectMilli: kg(500) });
  await openShift(db, 20_000);
  await createSale(db, { cart: addLine([], p, kg(12)), paymentMethod: 'efectivo', receivedCents: 40_000 });
  await createSale(db, { cart: addLine([], q, kg(30)), paymentMethod: 'tarjeta', receivedCents: 0, isVale: true });
  return db;
}

/** Todo lo que hay en cada almacén, leído CRUDO (sin pasar por el código de la app), ordenado para comparar. */
async function raw(name: string) {
  const d = await openDB(name);
  const out: Record<string, unknown[]> = {};
  const meta = { version: d.version, stores: [...d.objectStoreNames].sort() };
  for (const s of d.objectStoreNames) out[s] = (await d.getAll(s)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  d.close();
  return { ...meta, data: out };
}

describe('migración 2 → 3 con datos reales', () => {
  it('la versión actual del esquema es 3', () => {
    expect(DB_VERSION).toBe(3);
  });

  it('conserva cada registro idéntico, añade el almacén de fletes (folio único) y la auditoría sigue limpia', async () => {
    const name = `m3-${newId()}`;
    (await realV2(name)).close();
    const before = await raw(name);
    expect(before.version).toBe(2);
    expect(before.data.sales).toHaveLength(2);
    expect(before.data.receptions).toHaveLength(2);

    const upgrades: Array<[number, number]> = [];
    const db = await openDatabase(name, { onUpgrade: (a, b) => upgrades.push([a, b]) });
    expect(db.version).toBe(3);
    expect(upgrades).toEqual([[2, 3]]);
    expect([...db.objectStoreNames].sort()).toEqual([...STORES_V2, 'freights'].sort());
    const tx = db.transaction('freights');
    expect([...tx.store.indexNames].sort()).toEqual(['byDay', 'byFolioKey', 'byStatus']);
    expect(tx.store.index('byFolioKey').unique).toBe(true);
    expect(tx.store.keyPath).toBe('id');
    await tx.done;
    db.close();

    const after = await raw(name);
    expect(after.version).toBe(3);
    for (const s of STORES_V2) expect(after.data[s], `«${s}» quedó idéntica`).toEqual(before.data[s]);
    expect(after.data.freights).toEqual([]);

    const again = await openDatabase(name);
    expect((await auditDatabase(again)).issues).toEqual([]);
    // y ya se puede usar: un flete se guarda y entra al respaldo
    await createFreight(again, { folio: 'F-1', origin: 'Zamora', destination: 'CDMX', initial: { mode: 'directo', netMilli: kg(1_000) } });
    expect((await exportBackup(again)).freights).toHaveLength(1);
    again.close();
  });

  it('si la migración 3 FALLA se revierte entera: la base queda en v2 con todos sus datos y luego sube bien', async () => {
    const name = `m3-${newId()}`;
    (await realV2(name)).close();
    const before = await raw(name);

    await expect(
      openDatabase(name, {
        migrations: {
          3: (d) => {
            d.createObjectStore('freights', { keyPath: 'id' });
            throw new Error('migración rota');
          },
        },
      }),
    ).rejects.toThrow();
    const stuck = await raw(name);
    expect(stuck.version).toBe(2);
    expect(stuck.stores).not.toContain('freights');
    expect(stuck.data).toEqual(before.data);

    const db = await openDatabase(name);
    expect(db.version).toBe(3);
    expect((await exportBackup(db)).sales).toHaveLength(2);
    expect((await auditDatabase(db)).issues).toEqual([]);
    db.close();
  });

  it('reabrir no repite la migración ni avisa de otra actualización; una instalación nueva nace ya en la 3', async () => {
    const name = `m3-${newId()}`;
    (await realV2(name)).close();
    const calls: Array<[number, number]> = [];
    (await openDatabase(name, { onUpgrade: (a, b) => calls.push([a, b]) })).close();
    (await openDatabase(name, { onUpgrade: (a, b) => calls.push([a, b]) })).close();
    expect(calls).toEqual([[2, 3]]);

    const fresh = await openDatabase(`m3-new-${newId()}`, { onUpgrade: (a, b) => calls.push([a, b]) });
    expect(fresh.version).toBe(3);
    expect(fresh.objectStoreNames.contains('freights')).toBe(true);
    expect(calls).toEqual([[2, 3]]); // una instalación nueva no es una «actualización»
    fresh.close();
  });

  it('una base de una versión MÁS NUEVA (4) no la abre esta app y no se toca nada', async () => {
    const name = `m3-${newId()}`;
    (await realV2(name)).close();
    (await openDatabase(name)).close(); // ya en la 3
    const future = await openDatabase(name, { version: 4, migrations: { 4: (d) => void d.createObjectStore('futuro', { keyPath: 'id' }) } });
    future.close();
    const before = await raw(name);
    await expect(openDatabase(name)).rejects.toMatchObject({ name: 'VersionError' });
    expect(await raw(name)).toEqual(before);
  });

  it('un respaldo de la v2 (sin fletes) se restaura en la base v3 y deja los fletes vacíos', async () => {
    const name = `m3-${newId()}`;
    (await realV2(name)).close();
    const upgraded = await openDatabase(name); // la v2 ya migrada: solo así la app actual puede exportarla
    const v2Backup = JSON.parse(JSON.stringify(await exportBackup(upgraded))) as Record<string, unknown>;
    upgraded.close();
    // lo que exportaba la app v2: formato 2, sin fletes
    v2Backup.version = 2;
    delete v2Backup.freights;
    delete v2Backup.freightSettings;

    const target = await openDatabase(`m3-t-${newId()}`);
    await createFreight(target, { folio: 'QUEDA-FUERA', origin: 'a', destination: 'b', initial: { mode: 'directo', netMilli: kg(10) } });
    await importBackup(target, v2Backup);
    expect(await listFreights(target)).toEqual([]);
    expect((await exportBackup(target)).sales).toHaveLength(2);
    expect((await auditDatabase(target)).issues).toEqual([]);
    target.close();
  });
});
