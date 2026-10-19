import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditData, auditDatabase } from '../../src/db/audit';
import {
  addCashOut,
  addStockMove,
  cancelVale,
  closeShift,
  createSale,
  deliverVale,
  exportBackup,
  getCurrentShift,
  InsufficientStockError,
  listPendingVales,
  listProducts,
  listSalesByDay,
  listSalesByShift,
  newId,
  openDatabase,
  openShift,
  seedIfEmpty,
  setPrice,
  voidSale,
  type DB,
} from '../../src/db/repo';
import { addLine } from '../../src/domain/cart';
import { localDay } from '../../src/domain/report';

let db: DB;
let name: string;
beforeEach(async () => {
  name = `int-${newId()}`;
  db = await openDatabase(name);
});
afterEach(() => db.close());

describe('migraciones versionadas', () => {
  it('abrir una base existente con la misma versión conserva todos los datos', async () => {
    await seedIfEmpty(db);
    const p = (await listProducts(db))[0];
    await createSale(db, { cart: addLine([], p, 1000), paymentMethod: 'tarjeta', receivedCents: 0, allowNegativeStock: true });
    db.close();
    db = await openDatabase(name);
    expect(await listProducts(db)).toHaveLength(3);
    expect(await listSalesByDay(db, localDay())).toHaveLength(1);
  });

  it('subir de versión ejecuta solo las migraciones nuevas (las reales 2 y 3 incluidas) y NO borra datos', async () => {
    // Base REAL v1: se abre explícitamente con el esquema de la versión 1.
    const n = `mig-${newId()}`;
    let d = await openDatabase(n, { version: 1 });
    expect(d.version).toBe(1);
    expect(d.objectStoreNames.contains('receptions' as never)).toBe(false);
    expect(d.objectStoreNames.contains('freights' as never)).toBe(false);
    await seedIfEmpty(d);
    const p = (await listProducts(d))[0];
    await createSale(d, { cart: addLine([], p, 1000), paymentMethod: 'tarjeta', receivedCents: 0, allowNegativeStock: true });
    d.close();

    const ran: number[] = [];
    d = await openDatabase(n, {
      version: 5,
      migrations: {
        4: (_d, tx) => {
          ran.push(4);
          tx.objectStore('products').createIndex('byName', 'name');
        },
        5: (dd) => {
          ran.push(5);
          if (!dd.objectStoreNames.contains('extra')) dd.createObjectStore('extra', { keyPath: 'id' });
        },
      },
    });
    expect(ran).toEqual([4, 5]); // 1 ya estaba aplicada; la 2 y la 3 reales corrieron sin tocar los datos
    expect(d.objectStoreNames.contains('receptions' as never)).toBe(true); // creada por la migración 2 real
    expect(d.objectStoreNames.contains('freights' as never)).toBe(true); // creada por la migración 3 real
    expect(d.objectStoreNames.contains('extra' as never)).toBe(true);
    expect(await listProducts(d)).toHaveLength(3);
    expect(await listSalesByDay(d, localDay())).toHaveLength(1);
    expect((await auditDatabase(d)).ok).toBe(true);
    d.close();
  });

  it('si una migración falla se revierte entera y los datos quedan intactos en la versión anterior', async () => {
    const n = `mig-${newId()}`;
    let d = await openDatabase(n, { version: 1 });
    await seedIfEmpty(d);
    d.close();
    await expect(
      openDatabase(n, {
        version: 2,
        migrations: {
          2: (dd) => {
            dd.createObjectStore('nuevo', { keyPath: 'id' });
            throw new Error('migración rota');
          },
        },
      }),
    ).rejects.toThrow();
    const raw = await openDB(n); // sin versión: abre la que haya
    expect(raw.version).toBe(1);
    expect(raw.objectStoreNames.contains('nuevo')).toBe(false);
    expect(raw.objectStoreNames.contains('receptions')).toBe(false);
    expect(raw.objectStoreNames.contains('freights')).toBe(false);
    expect((await raw.getAll('products')).length).toBe(3);
    raw.close();
    // Y con las migraciones reales la base sube sin problema, con los mismos datos.
    d = await openDatabase(n);
    expect(d.version).toBe(3);
    expect(d.objectStoreNames.contains('freights' as never)).toBe(true);
    expect(await listProducts(d)).toHaveLength(3);
    d.close();
  });
});

describe('auditoría de integridad', () => {
  it('una base nueva y un escenario completo pasan la auditoría', async () => {
    await seedIfEmpty(db);
    expect((await auditDatabase(db)).ok).toBe(true);
    const [a, b] = await listProducts(db);
    await openShift(db, 20000);
    await addStockMove(db, a.id, 'entrada', 100_000);
    await createSale(db, { cart: addLine([], a, 2500), paymentMethod: 'efectivo', receivedCents: 10000 });
    const v1 = await createSale(db, { cart: addLine([], a, 10_000), paymentMethod: 'efectivo', receivedCents: 30000, isVale: true, customerName: 'Ana' });
    const v2 = await createSale(db, { cart: addLine([], b, 5_000), paymentMethod: 'transferencia', receivedCents: 0, isVale: true, allowNegativeStock: true });
    await deliverVale(db, v1.id);
    await cancelVale(db, v2.id, 'no vino', 'efectivo');
    await addCashOut(db, 500, 'bolsas');
    await closeShift(db, 21000);
    const r = await auditDatabase(db);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.stats.vales).toBe(2);
  });

  it('detecta datos corruptos', async () => {
    await seedIfEmpty(db);
    const [a] = await listProducts(db);
    await addStockMove(db, a.id, 'entrada', 10_000);
    const vale = await createSale(db, { cart: addLine([], a, 4_000), paymentMethod: 'tarjeta', receivedCents: 0, isVale: true });
    const clean = await exportBackup(db);
    const shiftId = (await getCurrentShift(db))!.id;

    const clone = () => structuredClone(clean);
    let c = clone();
    c.products[0].physicalMilli += 1;
    expect(auditData(c, shiftId).issues.join()).toContain('físico');

    c = clone();
    c.products.find((p) => p.id === a.id)!.reservedMilli = 0; // el producto del vale pendiente
    expect(auditData(c, shiftId).issues.join()).toContain('Reservado');

    c = clone();
    c.sales[0].totalCents += 1;
    expect(auditData(c, shiftId).issues.join()).toContain('total no coincide');

    c = clone();
    c.sales.push({ ...c.sales[0], id: 'otra' });
    expect(auditData(c, shiftId).issues.join()).toContain('Folio de venta repetido');

    c = clone();
    c.sales[0].delivery = 'cancelado'; // cancelado sin motivo ni decisión
    expect(auditData(c, shiftId).issues.join()).toContain('sin motivo');

    expect(auditData(clean, shiftId).ok).toBe(true);
    expect(vale.valeFolio).toBe(1);
  });

  it('simulación aleatoria determinista: 400 operaciones mantienen todas las invariantes', async () => {
    await seedIfEmpty(db);
    let seed = 20261010;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const products = await listProducts(db);
    let sales = 0;
    let rejected = 0;

    for (let i = 0; i < 400; i++) {
      const op = rnd();
      const p = pick(products);
      const qty = 250 + Math.floor(rnd() * 20) * 250;
      try {
        if (op < 0.25) {
          await createSale(db, {
            cart: addLine([], p, qty),
            paymentMethod: pick(['efectivo', 'transferencia', 'tarjeta'] as const),
            receivedCents: 1_000_000,
            isVale: rnd() < 0.4,
            allowNegativeStock: rnd() < 0.5,
          });
          sales++;
        } else if (op < 0.4) {
          const pend = await listPendingVales(db);
          if (pend.length) await deliverVale(db, pick(pend).id);
        } else if (op < 0.5) {
          const pend = await listPendingVales(db);
          if (pend.length) await cancelVale(db, pick(pend).id, 'x', pick(['efectivo', 'transferencia', 'ninguna'] as const));
        } else if (op < 0.6) {
          const cur = await getCurrentShift(db);
          const cand = cur
            ? (await listSalesByShift(db, cur.id)).filter((s) => s.status === 'completada' && s.delivery === 'inmediata')
            : [];
          if (cand.length) await voidSale(db, pick(cand).id, 'error');
        } else if (op < 0.75) {
          await addStockMove(db, p.id, 'entrada', qty * 4);
        } else if (op < 0.8) {
          await addStockMove(db, p.id, rnd() < 0.5 ? 'merma' : 'ajuste', qty, 'motivo', true);
        } else if (op < 0.85) {
          await setPrice(db, p.id, 1000 + Math.floor(rnd() * 5000));
        } else if (op < 0.92) {
          await addCashOut(db, 100 + Math.floor(rnd() * 900), 'gasto');
        } else if (op < 0.96) {
          if (await getCurrentShift(db)) await closeShift(db, Math.floor(rnd() * 100000));
        } else if (!(await getCurrentShift(db))) {
          await openShift(db, Math.floor(rnd() * 50000));
        }
      } catch (e) {
        if (e instanceof InsufficientStockError) rejected++;
        else throw e; // cualquier otro error inesperado debe hacer fallar la simulación
      }
      if (i % 50 === 49) {
        const r = await auditDatabase(db);
        expect(r.issues, `auditoría tras ${i + 1} operaciones`).toEqual([]);
      }
    }
    const final = await auditDatabase(db);
    expect(final.issues).toEqual([]);
    expect(final.stats.sales).toBe(sales);
    expect(sales).toBeGreaterThan(30);
    expect(rejected).toBeGreaterThan(0); // la simulación sí ejerció el rechazo por existencias
  }, 60_000);
});
