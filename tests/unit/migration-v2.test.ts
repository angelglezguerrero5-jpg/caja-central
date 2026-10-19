import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { auditDatabase } from '../../src/db/audit';
import { confirmReception, correctReception, listReceptions } from '../../src/db/receptions';
import {
  DB_VERSION,
  createSale,
  deliverVale,
  exportBackup,
  getCurrentShift,
  getProduct,
  listPendingVales,
  listProducts,
  listSalesByDay,
  newId,
  openDatabase,
} from '../../src/db/repo';
import { addLine } from '../../src/domain/cart';
import { buildMerchandiseReport } from '../../src/domain/mercancia';
import type { Backup } from '../../src/domain/types';

const kg = (n: number) => Math.round(n * 1000);
const fixture = (): Backup & Record<string, unknown> => JSON.parse(readFileSync('tests/fixtures/backup-v1.json', 'utf8'));
const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));

/**
 * Construye una base con el esquema REAL de la versión 1 y la llena con los registros de la fixture
 * (generada por el código v1), escribiendo directo en los stores como lo hacía esa versión.
 */
async function legacyV1(name: string) {
  const v1 = await openDatabase(name, { version: 1 });
  expect(v1.version).toBe(1);
  expect([...v1.objectStoreNames].sort()).toEqual(['cashMovements', 'meta', 'products', 'sales', 'shifts', 'stockMoves']);
  const f = fixture();
  const tx = v1.transaction([...v1.objectStoreNames], 'readwrite');
  for (const p of f.products) await tx.objectStore('products').put(p);
  for (const s of f.sales) await tx.objectStore('sales').put(s);
  for (const s of f.shifts) await tx.objectStore('shifts').put(s);
  for (const m of f.cashMovements) await tx.objectStore('cashMovements').put(m);
  for (const m of f.stockMoves) await tx.objectStore('stockMoves').put(m);
  await tx.objectStore('meta').put({ key: 'nextFolio', value: f.nextFolio });
  await tx.objectStore('meta').put({ key: 'nextValeFolio', value: f.nextValeFolio });
  const open = f.shifts.find((s) => !s.closedAt);
  if (open) await tx.objectStore('meta').put({ key: 'currentShiftId', value: open.id });
  await tx.done;
  v1.close();
  return f;
}

describe('migración v1 → v2 con datos previos (caso 24)', () => {
  it('la versión actual del esquema es 3 (la 2 añadió las recepciones y la 3 los fletes)', () => {
    expect(DB_VERSION).toBe(3);
  });

  it('conserva cada registro de ventas, vales, precios, inventario y cortes, idéntico', async () => {
    const name = `mig-${newId()}`;
    const f = await legacyV1(name);

    const db = await openDatabase(name); // sube de la v1 a la actual (corren la migración 2 y la 3) sin tocar los datos
    expect(db.version).toBe(3);
    expect(db.objectStoreNames.contains('receptions')).toBe(true);
    expect(db.objectStoreNames.contains('freights')).toBe(true);
    expect([...db.transaction('stockMoves').store.indexNames]).toContain('byReception');

    const now = await exportBackup(db);
    for (const k of ['products', 'sales', 'shifts', 'cashMovements', 'stockMoves'] as const) {
      expect(byId(now[k] as Array<{ id: string }>), `colección ${k}`).toEqual(byId(f[k] as Array<{ id: string }>));
    }
    expect(now.nextFolio).toBe(f.nextFolio);
    expect(now.nextValeFolio).toBe(f.nextValeFolio);
    expect(now.receptions).toEqual([]);
    expect(now.nextReceptionFolio).toBe(1);
    expect((await getCurrentShift(db))?.id).toBe(f.shifts.find((s) => !s.closedAt)?.id);
    expect((await auditDatabase(db)).issues).toEqual([]);
    db.close();
  });

  it('es idempotente: abrir otra vez no cambia nada', async () => {
    const name = `mig-${newId()}`;
    await legacyV1(name);
    let db = await openDatabase(name);
    const first = { ...(await exportBackup(db)), exportedAt: '' };
    db.close();
    db = await openDatabase(name);
    expect({ ...(await exportBackup(db)), exportedAt: '' }).toEqual(first);
    db.close();
  });

  it('la app sigue operando sobre lo migrado: venta, vale, recepción y corrección', async () => {
    const name = `mig-${newId()}`;
    const f = await legacyV1(name);
    const db = await openDatabase(name);

    // Los vales de la fixture conservan su estado y reserva
    const pend = await listPendingVales(db);
    expect(pend.map((v) => v.valeFolio)).toEqual(f.sales.filter((s) => s.delivery === 'pendiente').map((s) => s.valeFolio));
    const products = await listProducts(db);
    const kgProduct = products.find((p) => p.unit === 'kg' && p.reservedMilli > 0)!;
    expect(kgProduct.reservedMilli).toBeGreaterThan(0);

    // Una recepción sobre un producto anterior (sin procedencia ni calibre)
    const before = (await getProduct(db, kgProduct.id))!;
    const r = await confirmReception(db, { id: newId(), productId: kgProduct.id, packaging: 'arpilla', containers: 10, weightMode: 'por_envase', unitNetMilli: kg(15) });
    expect(r.folio).toBe(1);
    expect(r.productLabel).toBe([kgProduct.name, kgProduct.quality].filter(Boolean).join(' · '));
    const mid = (await getProduct(db, kgProduct.id))!;
    expect(mid.physicalMilli).toBe(before.physicalMilli + kg(150));
    expect(mid.reservedMilli).toBe(before.reservedMilli); // la reserva de los vales no se toca

    // Venta nueva (con foto de clasificación) y entrega del vale: sin doble descuento
    const sale = await createSale(db, { cart: addLine([], mid, kg(20)), paymentMethod: 'efectivo', receivedCents: 100_000 });
    expect(sale.folio).toBe(f.nextFolio);
    expect(sale.items[0].cls?.variety).toBe(kgProduct.name);
    const vale = pend.find((v) => v.items.some((i) => i.productId === kgProduct.id))!;
    await deliverVale(db, vale.id);
    const after = (await getProduct(db, kgProduct.id))!;
    const valeQty = vale.items.filter((i) => i.productId === kgProduct.id).reduce((s, i) => s + i.qtyMilli, 0);
    expect(after.physicalMilli).toBe(mid.physicalMilli - kg(20) - valeQty);
    expect(after.reservedMilli).toBe(mid.reservedMilli - valeQty);

    await correctReception(db, r.id, kg(140), 'báscula');
    expect((await getProduct(db, kgProduct.id))!.physicalMilli).toBe(after.physicalMilli - kg(10));
    expect((await auditDatabase(db)).issues).toEqual([]);
    expect(await listSalesByDay(db, sale.day)).toContainEqual(expect.objectContaining({ id: sale.id }));
    db.close();
  });

  it('el reporte de mercancía lee las ventas anteriores (sin foto de clasificación)', async () => {
    const name = `mig-${newId()}`;
    const f = await legacyV1(name);
    const db = await openDatabase(name);
    const days = [...new Set(f.sales.map((s) => s.day))].sort();
    const report = buildMerchandiseReport({
      from: days[0], to: days[days.length - 1], receptions: await listReceptions(db), sales: f.sales,
      stockMoves: f.stockMoves, products: await listProducts(db),
    });
    const manual = f.sales
      .filter((s) => s.status === 'completada' && s.delivery !== 'cancelado')
      .flatMap((s) => s.items)
      .filter((i) => i.unit === 'kg')
      .reduce((a, i) => a + i.qtyMilli, 0);
    expect(report.soldMilli).toBe(manual);
    expect(report.receivedMilli).toBe(0);
    expect(report.byVariety.reduce((a, b) => a + b.soldMilli, 0)).toBe(manual);
    db.close();
  });

  it('si la migración 2 falla: se revierte, la base queda en v1 con todos sus datos y luego sube bien', async () => {
    const name = `mig-${newId()}`;
    const f = await legacyV1(name);
    await expect(
      openDatabase(name, {
        migrations: {
          2: (d) => {
            d.createObjectStore('receptions', { keyPath: 'id' });
            throw new Error('falla simulada a mitad de la migración');
          },
        },
      }),
    ).rejects.toThrow();

    const raw = await openDB(name);
    expect(raw.version).toBe(1);
    expect(raw.objectStoreNames.contains('receptions')).toBe(false);
    expect(await raw.count('products')).toBe(f.products.length);
    expect(await raw.count('sales')).toBe(f.sales.length);
    expect(await raw.count('stockMoves')).toBe(f.stockMoves.length);
    raw.close();

    const db = await openDatabase(name);
    expect(db.version).toBe(3);
    expect((await exportBackup(db)).sales).toHaveLength(f.sales.length);
    expect((await auditDatabase(db)).issues).toEqual([]);
    db.close();
  });

  it('exportar lo migrado → importar en una base nueva → todo igual', async () => {
    const name = `mig-${newId()}`;
    await legacyV1(name);
    const db = await openDatabase(name);
    const exported = JSON.parse(JSON.stringify(await exportBackup(db)));
    const fresh = await openDatabase(`mig-fresh-${newId()}`);
    const { importBackup } = await import('../../src/db/repo');
    await importBackup(fresh, exported);
    expect({ ...(await exportBackup(fresh)), exportedAt: '' }).toEqual({ ...exported, exportedAt: '' });
    db.close();
    fresh.close();
  });
});

describe('avisos de la apertura: actualización y bloqueo', () => {
  it('onUpgrade se llama al actualizar una base existente (1 → 2) y NO en una instalación nueva ni al reabrir', async () => {
    const calls: Array<[number, number]> = [];
    const spy = (a: number, b: number) => void calls.push([a, b]);

    const fresh = await openDatabase(`up-new-${newId()}`, { onUpgrade: spy });
    fresh.close();
    expect(calls).toEqual([]); // instalación nueva: no es una "actualización"

    const name = `up-${newId()}`;
    await legacyV1(name);
    const migrated = await openDatabase(name, { onUpgrade: spy });
    expect(calls).toEqual([[1, 3]]);
    migrated.close();
    const again = await openDatabase(name, { onUpgrade: spy });
    expect(calls).toEqual([[1, 3]]); // reabrir no vuelve a avisar
    again.close();
  });

  it('una actualización que FALLA no avisa, deja la base en v1 con sus datos y la copia de emergencia los puede sacar', async () => {
    const name = `up-fail-${newId()}`;
    await legacyV1(name);
    const calls: number[] = [];
    // IndexedDB aborta la actualización y rechaza la apertura (el mensaje original no llega: es un AbortError)
    await expect(
      openDatabase(name, {
        onUpgrade: (a) => void calls.push(a),
        migrations: { 2: () => { throw new Error('migración rota'); } },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual([]);
    const v1 = await openDatabase(name, { version: 1 });
    expect(v1.version).toBe(1);
    expect(await v1.count('sales')).toBe(fixture().sales.length);
    v1.close();
  });

  it('onBlocked avisa en la pestaña nueva mientras otra pestaña vieja sigue abierta, y la apertura continúa al cerrarla', async () => {
    const name = `up-blk-${newId()}`;
    await legacyV1(name);
    // una conexión "vieja" que no se cierra sola (sin manejar versionchange)
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    let blocked = 0;
    const opening = openDatabase(name, { onBlocked: () => void blocked++ });
    await new Promise((r) => setTimeout(r, 50));
    expect(blocked).toBeGreaterThan(0);
    old.close();
    const db = await opening;
    expect(db.version).toBe(3);
    db.close();
  });
});
