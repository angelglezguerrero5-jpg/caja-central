import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addLine } from '../../src/domain/cart';
import {
  addCashOut,
  addStockMove,
  availableMilli,
  closeShift,
  createSale,
  deliverVale,
  DuplicateSaleError,
  exportBackup,
  getCurrentShift,
  getProduct,
  importBackup,
  listPendingVales,
  listProducts,
  listSalesByDay,
  listSalesByShift,
  listStockMoves,
  loadCartDraft,
  newId,
  openDatabase,
  openShift,
  saveCartDraft,
  saveProduct,
  seedIfEmpty,
  setPrice,
  voidSale,
  type DB,
} from '../../src/db/repo';
import { buildShiftReport, localDay } from '../../src/domain/report';

let db: DB;
let name: string;

beforeEach(async () => {
  name = `test-${newId()}`;
  db = await openDatabase(name);
});
afterEach(() => db.close());

async function firstProduct() {
  await seedIfEmpty(db);
  return (await listProducts(db))[0];
}

const kg = (n: number) => Math.round(n * 1000);

describe('variedades', () => {
  it('siembra variedades solo una vez', async () => {
    expect(await seedIfEmpty(db)).toBe(true);
    expect(await seedIfEmpty(db)).toBe(false);
    expect((await listProducts(db)).length).toBe(3);
  });

  it('valida variedades', async () => {
    await expect(saveProduct(db, { name: ' ', unit: 'kg', priceCents: 100, active: true })).rejects.toThrow();
    await expect(saveProduct(db, { name: 'X', unit: 'kg', priceCents: 0, active: true })).rejects.toThrow();
  });

  it('precio editable desde caja persiste y no altera ventas anteriores', async () => {
    const p = await firstProduct();
    await createSale(db, { cart: addLine([], p, kg(1)), paymentMethod: 'tarjeta', receivedCents: 0 });
    await setPrice(db, p.id, 3800);
    expect((await getProduct(db, p.id))?.priceCents).toBe(3800);
    const [stored] = await listSalesByDay(db, localDay());
    expect(stored.items[0].unitPriceCents).toBe(3000);
    await expect(setPrice(db, p.id, 0)).rejects.toThrow();
  });

  it('editar la variedad conserva su inventario', async () => {
    const p = await firstProduct();
    await addStockMove(db, p.id, 'entrada', kg(50));
    await saveProduct(db, { id: p.id, name: 'Persa extra', unit: 'kg', priceCents: 4000, active: true });
    expect((await getProduct(db, p.id))?.physicalMilli).toBe(kg(50));
  });
});

describe('ventas', () => {
  it('folio consecutivo, turno automático, cambio y limpieza de borrador', async () => {
    const p = await firstProduct();
    const cart = addLine([], p, kg(1.5));
    await saveCartDraft(db, cart);
    expect(await loadCartDraft(db)).toHaveLength(1);

    const s1 = await createSale(db, { cart, paymentMethod: 'efectivo', receivedCents: 5000 });
    const s2 = await createSale(db, { cart, paymentMethod: 'transferencia', receivedCents: 0 });
    expect([s1.folio, s2.folio]).toEqual([1, 2]);
    expect(s1.totalCents).toBe(4500);
    expect(s1.changeCents).toBe(500);
    expect(s2.receivedCents).toBe(4500);
    expect(s1.shiftId).toBe(s2.shiftId);
    expect(s1.delivery).toBe('inmediata');
    expect(await loadCartDraft(db)).toEqual([]);
    expect((await getCurrentShift(db))?.id).toBe(s1.shiftId);
    expect(await listSalesByDay(db, localDay())).toHaveLength(2);
  });

  it('folios únicos con ventas concurrentes', async () => {
    const p = await firstProduct();
    const cart = addLine([], p, kg(1));
    const sales = await Promise.all(
      Array.from({ length: 10 }, () => createSale(db, { cart, paymentMethod: 'tarjeta', receivedCents: 0 })),
    );
    expect(new Set(sales.map((s) => s.folio)).size).toBe(10);
  });

  it('pago insuficiente no guarda nada ni consume folio', async () => {
    const p = await firstProduct();
    const cart = addLine([], p, kg(1));
    await expect(createSale(db, { cart, paymentMethod: 'efectivo', receivedCents: 100 })).rejects.toThrow();
    const s = await createSale(db, { cart, paymentMethod: 'efectivo', receivedCents: 3000 });
    expect(s.folio).toBe(1);
  });

  it('mismo id (doble toque / reintento) no duplica la venta ni el inventario', async () => {
    const p = await firstProduct();
    const cart = addLine([], p, kg(2));
    const id = newId();
    const first = await createSale(db, { id, cart, paymentMethod: 'tarjeta', receivedCents: 0 });
    const again = createSale(db, { id, cart, paymentMethod: 'tarjeta', receivedCents: 0 });
    await expect(again).rejects.toBeInstanceOf(DuplicateSaleError);
    await again.catch((e: DuplicateSaleError) => expect(e.sale.folio).toBe(first.folio));
    expect(await listSalesByDay(db, localDay())).toHaveLength(1);
    expect((await getProduct(db, p.id))?.physicalMilli).toBe(-kg(2));
    const next = await createSale(db, { cart, paymentMethod: 'tarjeta', receivedCents: 0 });
    expect(next.folio).toBe(2);
  });

  it('venta normal descuenta inventario físico; anularla lo regresa', async () => {
    const p = await firstProduct();
    await addStockMove(db, p.id, 'entrada', kg(100));
    const s = await createSale(db, { cart: addLine([], p, kg(3.5)), paymentMethod: 'tarjeta', receivedCents: 0 });
    let cur = (await getProduct(db, p.id))!;
    expect(cur.physicalMilli).toBe(kg(96.5));
    expect(availableMilli(cur)).toBe(kg(96.5));
    await voidSale(db, s.id, 'error');
    cur = (await getProduct(db, p.id))!;
    expect(cur.physicalMilli).toBe(kg(100));
  });
});

describe('vales (pagados, pendientes de entrega)', () => {
  it('reservan mercancía, se cobran una sola vez y al entregarse salen de bodega', async () => {
    const p = await firstProduct();
    await openShift(db, 10000);
    await addStockMove(db, p.id, 'entrada', kg(100));

    const vale = await createSale(db, {
      cart: addLine([], p, kg(20)),
      paymentMethod: 'efectivo',
      receivedCents: 60000,
      isVale: true,
      customerName: 'Doña Mary',
    });
    expect(vale.delivery).toBe('pendiente');
    expect(vale.customerName).toBe('Doña Mary');
    let cur = (await getProduct(db, p.id))!;
    expect(cur.physicalMilli).toBe(kg(100));
    expect(cur.reservedMilli).toBe(kg(20));
    expect(availableMilli(cur)).toBe(kg(80));
    expect((await listPendingVales(db)).map((v) => v.folio)).toEqual([vale.folio]);

    const shiftId = vale.shiftId;
    const before = buildShiftReport({ openingCashCents: 10000 }, await listSalesByShift(db, shiftId));
    await deliverVale(db, vale.id);
    const after = buildShiftReport({ openingCashCents: 10000 }, await listSalesByShift(db, shiftId));
    // Entregar NO suma dinero: el cobro ya estaba contado.
    expect(after.expectedCashCents).toBe(before.expectedCashCents);
    expect(after.expectedCashCents).toBe(10000 + 60000);

    cur = (await getProduct(db, p.id))!;
    expect(cur.physicalMilli).toBe(kg(80));
    expect(cur.reservedMilli).toBe(0);
    expect(await listPendingVales(db)).toHaveLength(0);
    await expect(deliverVale(db, vale.id)).rejects.toThrow('ya fue entregado');

    const types = (await listStockMoves(db, p.id)).map((m) => m.type).sort();
    expect(types).toEqual(['entrada', 'entrega_vale', 'reserva']);
  });

  it('vale entregado en otro turno no cuenta dinero en el turno nuevo', async () => {
    const p = await firstProduct();
    await openShift(db, 0);
    const vale = await createSale(db, {
      cart: addLine([], p, kg(5)), paymentMethod: 'efectivo', receivedCents: 15000, isVale: true,
    });
    const closed = await closeShift(db, 15000);
    expect(closed.differenceCents).toBe(0);
    const s2 = await openShift(db, 0);
    await deliverVale(db, vale.id);
    const r = buildShiftReport(s2, await listSalesByShift(db, s2.id));
    expect(r.totalCents).toBe(0);
    expect(r.expectedCashCents).toBe(0);
  });

  it('anular un vale pendiente libera la reserva sin mover físico', async () => {
    const p = await firstProduct();
    await addStockMove(db, p.id, 'entrada', kg(10));
    const vale = await createSale(db, {
      cart: addLine([], p, kg(4)), paymentMethod: 'tarjeta', receivedCents: 0, isVale: true,
    });
    await voidSale(db, vale.id, 'cliente canceló');
    const cur = (await getProduct(db, p.id))!;
    expect(cur.physicalMilli).toBe(kg(10));
    expect(cur.reservedMilli).toBe(0);
    expect(await listPendingVales(db)).toHaveLength(0);
    await expect(deliverVale(db, vale.id)).rejects.toThrow('anulado');
  });
});

describe('inventario', () => {
  it('entrada, merma y ajuste por conteo físico', async () => {
    const p = await firstProduct();
    await addStockMove(db, p.id, 'entrada', kg(50), 'camión');
    await addStockMove(db, p.id, 'merma', kg(2), 'podrido');
    let cur = (await getProduct(db, p.id))!;
    expect(cur.physicalMilli).toBe(kg(48));
    cur = await addStockMove(db, p.id, 'ajuste', kg(45));
    expect(cur.physicalMilli).toBe(kg(45));
    const ajuste = (await listStockMoves(db, p.id)).find((m) => m.type === 'ajuste')!;
    expect(ajuste.deltaMilli).toBe(-kg(3));
    await expect(addStockMove(db, p.id, 'entrada', 0)).rejects.toThrow();
    await expect(addStockMove(db, 'nope', 'entrada', 1)).rejects.toThrow('no encontrada');
  });
});

describe('turnos y corte', () => {
  it('anula con motivo y cierra turno con efectivo esperado (fondo + efectivo − salidas)', async () => {
    const p = await firstProduct();
    const shift = await openShift(db, 20000);
    await expect(openShift(db, 0)).rejects.toThrow('Ya hay un turno abierto');
    const cart = addLine([], p, kg(1));
    const a = await createSale(db, { cart, paymentMethod: 'efectivo', receivedCents: 5000 });
    const b = await createSale(db, { cart, paymentMethod: 'efectivo', receivedCents: 3000 });
    await createSale(db, { cart, paymentMethod: 'transferencia', receivedCents: 0 });
    await addCashOut(db, 500, 'bolsas');
    await expect(addCashOut(db, 500, ' ')).rejects.toThrow();
    await expect(voidSale(db, b.id, '  ')).rejects.toThrow();
    await voidSale(db, b.id, 'error de captura');
    await expect(voidSale(db, b.id, 'otra vez')).rejects.toThrow('ya estaba anulada');
    expect(a.shiftId).toBe(shift.id);

    const closed = await closeShift(db, 22000);
    expect(closed.expectedCashCents).toBe(20000 + 3000 - 500);
    expect(closed.differenceCents).toBe(-500);
    expect(await getCurrentShift(db)).toBeUndefined();
    await expect(voidSale(db, a.id, 'tarde')).rejects.toThrow('ya fue cerrado');
    expect(await listSalesByShift(db, shift.id)).toHaveLength(3);

    const c = await createSale(db, { cart, paymentMethod: 'tarjeta', receivedCents: 0 });
    expect(c.shiftId).not.toBe(shift.id);
    expect(c.folio).toBe(4);
  });
});

describe('respaldo', () => {
  it('exportar → importar en otra base conserva todo (vales, inventario, folio)', async () => {
    const p = await firstProduct();
    await openShift(db, 10000);
    await addStockMove(db, p.id, 'entrada', kg(30));
    await createSale(db, { cart: addLine([], p, kg(2)), paymentMethod: 'efectivo', receivedCents: 6000 });
    await createSale(db, {
      cart: addLine([], p, kg(5)), paymentMethod: 'efectivo', receivedCents: 15000, isVale: true, customerName: 'Juan',
    });
    await addCashOut(db, 1000, 'comida');
    const backup = JSON.parse(JSON.stringify(await exportBackup(db)));

    const other = await openDatabase(`${name}-b`);
    await importBackup(other, backup);
    expect(await listProducts(other)).toHaveLength(3);
    expect(await listSalesByDay(other, localDay())).toHaveLength(2);
    expect(await listPendingVales(other)).toHaveLength(1);
    const op = (await getProduct(other, p.id))!;
    expect([op.physicalMilli, op.reservedMilli]).toEqual([kg(28), kg(5)]);
    expect((await getCurrentShift(other))?.openingCashCents).toBe(10000);
    const next = await createSale(other, { cart: addLine([], p, kg(1)), paymentMethod: 'tarjeta', receivedCents: 0 });
    expect(next.folio).toBe(3);
    other.close();
  });

  it('rechaza respaldos inválidos sin borrar datos', async () => {
    await firstProduct();
    await expect(importBackup(db, { app: 'otra' })).rejects.toThrow();
    await expect(importBackup(db, { ...(await exportBackup(db)), nextFolio: 0 })).rejects.toThrow();
    const dupSales = { ...(await exportBackup(db)), nextFolio: 9, sales: [{ id: 'x', folio: 1 }, { id: 'x', folio: 2 }] };
    await expect(importBackup(db, dupSales)).rejects.toThrow('duplicadas');
    expect(await listProducts(db)).toHaveLength(3);
  });
});
