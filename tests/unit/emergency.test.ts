import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoDatabaseError, dumpRawDatabase } from '../../src/db/emergency';
import { confirmReception } from '../../src/db/receptions';
import { createSale, newId, openDatabase, saveProduct, type DB } from '../../src/db/repo';
import { addLine } from '../../src/domain/cart';

const kg = (n: number) => Math.round(n * 1000);
let db: DB;
let name: string;
beforeEach(async () => {
  name = `em-${newId()}`;
});
afterEach(() => db?.close());

describe('copia de emergencia (lectura cruda)', () => {
  it('saca TODOS los datos sin importar la versión y sin tocar nada', async () => {
    db = await openDatabase(name);
    const p = await saveProduct(db, { name: 'Sin semilla', quality: 'Primera', unit: 'kg', priceCents: 3000, active: true });
    await confirmReception(db, { id: newId(), productId: p.id, packaging: 'granel', weightMode: 'directo', netDirectMilli: kg(100) });
    await createSale(db, { cart: addLine([], p, kg(10)), paymentMethod: 'tarjeta', receivedCents: 0 });
    db.close();

    const dump = await dumpRawDatabase(name);
    expect(dump).toMatchObject({ app: 'caja-central', kind: 'emergency-raw-dump', database: name, version: 3 });
    expect(dump.stores.products).toHaveLength(1);
    expect(dump.stores.sales).toHaveLength(1);
    expect(dump.stores.receptions).toHaveLength(1);
    expect(dump.stores.stockMoves).toHaveLength(2);
    expect(Object.keys(dump.stores).sort()).toEqual(['cashMovements', 'freights', 'meta', 'products', 'receptions', 'sales', 'shifts', 'stockMoves']);

    // no cambió la versión ni los datos
    db = await openDatabase(name);
    expect(db.version).toBe(3);
    expect(await db.count('sales')).toBe(1);
  });

  it('funciona aunque la app NO pueda abrir la base: datos de una versión más nueva del esquema', async () => {
    const future = await openDatabase(name, { version: 4, migrations: { 4: (d) => void d.createObjectStore('futuro', { keyPath: 'id' }) } });
    await future.put('products', { id: 'p', name: 'x', unit: 'kg', priceCents: 1, active: true, sort: 0, physicalMilli: 0, reservedMilli: 0, updatedAt: '' });
    future.close();
    // la app (versión 3) no puede abrirla...
    await expect(openDatabase(name)).rejects.toMatchObject({ name: 'VersionError' });
    // ...pero la copia de emergencia sí lee todo, incluido el store que esta versión no conoce
    const dump = await dumpRawDatabase(name);
    expect(dump.version).toBe(4);
    expect(dump.stores.products).toHaveLength(1);
    expect(dump.stores.futuro).toEqual([]);
  });

  it('si no hay base NO crea una vacía', async () => {
    await expect(dumpRawDatabase(name)).rejects.toBeInstanceOf(NoDatabaseError);
    const dbs = (await indexedDB.databases?.()) ?? [];
    expect(dbs.map((d) => d.name)).not.toContain(name);
  });
});
