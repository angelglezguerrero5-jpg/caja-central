import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addStockMove,
  createSale,
  getProduct,
  listProducts,
  listSalesByDay,
  newId,
  openDatabase,
  saveProduct,
  setPrice,
  setProductActive,
  type DB,
} from '../../src/db/repo';
import { addLine, productLabel } from '../../src/domain/cart';
import { MAX_PRICE_CENTS, MAX_QTY_MILLI } from '../../src/domain/money';
import { localDay } from '../../src/domain/report';

let db: DB;
beforeEach(async () => {
  db = await openDatabase(`cat-${newId()}`);
});
afterEach(() => db.close());

const kg = (n: number) => Math.round(n * 1000);
const mk = (o: Partial<Parameters<typeof saveProduct>[1]> & { name: string }) =>
  saveProduct(db, { unit: 'kg', priceCents: 3000, active: true, ...o });

describe('catálogo clasificado (casos 1–7)', () => {
  it('1–2. registra limón sin semilla y con semilla', async () => {
    const a = await mk({ name: 'Sin semilla' });
    const b = await mk({ name: 'Con semilla' });
    expect([a.name, b.name]).toEqual(['Sin semilla', 'Con semilla']);
    expect((await listProducts(db)).map(productLabel)).toEqual(['Sin semilla', 'Con semilla']);
  });

  it('3. procedencias Oaxaca y Michoacán (solo etiquetas: no cambian calidad ni precio)', async () => {
    const oax = await mk({ name: 'Con semilla', origin: 'Oaxaca', priceCents: 2500 });
    const mich = await mk({ name: 'Con semilla', origin: 'Michoacán', priceCents: 2800 });
    expect(oax.origin).toBe('Oaxaca');
    expect(mich.origin).toBe('Michoacán');
    expect(oax.quality).toBeUndefined(); // no se deduce calidad de la procedencia
    expect(mich.quality).toBeUndefined();
    expect([oax.priceCents, mich.priceCents]).toEqual([2500, 2800]);
    expect(productLabel(oax)).toBe('Con semilla · Oaxaca');
  });

  it('4–5. calibres 1X, 2X, 3X y 200, 300, 400, 500: cada uno es un producto aparte', async () => {
    for (const c of ['1X', '2X', '3X', '200', '300', '400', '500']) await mk({ name: 'Sin semilla', caliber: c });
    const all = await listProducts(db);
    expect(all.map((p) => p.caliber)).toEqual(['1X', '2X', '3X', '200', '300', '400', '500']);
    expect(new Set(all.map((p) => p.id)).size).toBe(7);
  });

  it('6. calidades primera, segunda y tercera', async () => {
    for (const q of ['Primera', 'Segunda', 'Tercera']) await mk({ name: 'Sin semilla', quality: q });
    expect((await listProducts(db)).map((p) => p.quality)).toEqual(['Primera', 'Segunda', 'Tercera']);
  });

  it('7. valores personalizados y no especificados', async () => {
    const t = await mk({ name: 'Sin semilla', quality: 'Torreones' }); // término del negocio: configurable, sin preset
    expect(t.quality).toBe('Torreones');
    const c = await mk({ name: 'Sin semilla', caliber: 'Mini', origin: 'Veracruz' });
    expect(c).toMatchObject({ caliber: 'Mini', origin: 'Veracruz' });
    const o = await mk({ name: 'Otra variedad rara' });
    expect(o.name).toBe('Otra variedad rara');
    // "No especificado" en cualquiera de sus formas = campo ausente
    const n = await mk({ name: 'Con semilla', origin: 'No especificada', quality: 'Sin clasificar', caliber: 'No especificado' });
    expect(n.origin).toBeUndefined();
    expect(n.quality).toBeUndefined();
    expect(n.caliber).toBeUndefined();
    expect(Object.keys(n)).not.toContain('origin'); // ni siquiera como clave vacía
    // Torreones puede estar en un producto y no en otros: no se impone
    expect((await listProducts(db)).filter((p) => p.quality === 'Torreones')).toHaveLength(1);
  });
});

describe('sin duplicados por diferencias de escritura', () => {
  it('rechaza la misma clasificación escrita distinto', async () => {
    await mk({ name: 'Sin semilla', origin: 'Michoacán', quality: 'Primera', caliber: '2X' });
    for (const dup of [
      { name: 'sin semilla', origin: 'michoacan', quality: 'primera', caliber: '2x' },
      { name: '  SIN   semilla ', origin: 'MICHOACÁN', quality: ' Primera', caliber: '2X ' },
      { name: 'Sín semilla', origin: 'Michoacán', quality: 'Primera', caliber: '2X' },
    ]) {
      await expect(mk(dup), JSON.stringify(dup)).rejects.toThrow(/Ya existe esa clasificación/);
    }
    expect(await listProducts(db)).toHaveLength(1);
  });

  it('misma clasificación en otra unidad es otro producto; con otra dimensión también', async () => {
    await mk({ name: 'Sin semilla', quality: 'Primera' });
    await expect(mk({ name: 'Sin semilla', quality: 'Primera', unit: 'caja', priceCents: 45_000 })).resolves.toBeTruthy();
    await expect(mk({ name: 'Sin semilla', quality: 'Segunda' })).resolves.toBeTruthy();
    await expect(mk({ name: 'Sin semilla', quality: 'Primera', origin: 'Oaxaca' })).resolves.toBeTruthy();
    expect(await listProducts(db)).toHaveLength(4);
  });

  it('canoniza al guardar: usa la ortografía ya existente o la del preset', async () => {
    await mk({ name: 'Sin semilla', origin: 'Oaxaca', quality: 'Torreones', caliber: '3X' });
    const a = await mk({ name: 'Con semilla', origin: 'oaxaca', quality: 'tercera', caliber: '3x' });
    expect(a).toMatchObject({ name: 'Con semilla', origin: 'Oaxaca', quality: 'Tercera', caliber: '3X' });
    const b = await mk({ name: 'Con semilla', origin: 'Oaxaca', quality: 'torreones', caliber: '500' });
    expect(b.quality).toBe('Torreones'); // reutiliza la ortografía del valor ya usado
  });

  it('editar una clasificación no puede chocar con otra', async () => {
    const a = await mk({ name: 'Sin semilla', quality: 'Primera' });
    await mk({ name: 'Sin semilla', quality: 'Segunda' });
    await expect(mk({ id: a.id, name: 'Sin semilla', quality: 'segunda' })).rejects.toThrow(/Ya existe/);
    await expect(mk({ id: a.id, name: 'Sin semilla', quality: 'Primera', priceCents: 3500 })).resolves.toMatchObject({ priceCents: 3500 });
  });
});

describe('precio independiente por clasificación (caso 16) y precio pendiente', () => {
  it('cada clasificación conserva su propio precio y no se cambia otro automáticamente', async () => {
    const a = await mk({ name: 'Sin semilla', quality: 'Primera', priceCents: 3000 });
    const b = await mk({ name: 'Sin semilla', quality: 'Segunda', priceCents: 2000 });
    const c = await mk({ name: 'Con semilla', origin: 'Oaxaca', priceCents: 2500 });
    await setPrice(db, b.id, 2200);
    expect((await getProduct(db, a.id))!.priceCents).toBe(3000);
    expect((await getProduct(db, b.id))!.priceCents).toBe(2200);
    expect((await getProduct(db, c.id))!.priceCents).toBe(2500);
    // volver a guardar otra clasificación no altera precios existentes
    await mk({ name: 'Sin semilla', quality: 'Tercera', priceCents: 1000 });
    expect((await listProducts(db)).map((p) => p.priceCents)).toEqual([3000, 2200, 2500, 1000]);
  });

  it('un producto "sin precio todavía" exige marcarlo; no se puede vender hasta ponerle precio', async () => {
    await expect(mk({ name: 'Sin semilla', priceCents: 0 })).rejects.toThrow(/mayor a cero/);
    const p = await mk({ name: 'Sin semilla', caliber: '400', priceCents: 0, pendingPrice: true });
    expect(p.priceCents).toBe(0);
    await expect(mk({ name: 'Sin semilla', caliber: '300', priceCents: 100, pendingPrice: true })).rejects.toThrow(/precio 0/);
    await expect(createSale(db, { cart: addLine([], p, kg(1)), paymentMethod: 'tarjeta', receivedCents: 0, allowNegativeStock: true })).rejects.toThrow(/Precio inválido/);
    expect(await listSalesByDay(db, localDay())).toHaveLength(0);
    await setPrice(db, p.id, 2900);
    const updated = (await getProduct(db, p.id))!;
    const s = await createSale(db, { cart: addLine([], updated, kg(1)), paymentMethod: 'tarjeta', receivedCents: 0, allowNegativeStock: true });
    expect(s.totalCents).toBe(2900);
  });

  it('las ventas conservan clasificación y precio históricos aunque el producto cambie después', async () => {
    const p = await mk({ name: 'Con semilla', origin: 'Oaxaca', quality: 'Segunda', caliber: '300', priceCents: 2500 });
    const sale = await createSale(db, { cart: addLine([], p, kg(10)), paymentMethod: 'efectivo', receivedCents: 25_000, allowNegativeStock: true });
    expect(sale.items[0]).toMatchObject({
      name: 'Con semilla · Oaxaca · Segunda · 300', unitPriceCents: 2500, totalCents: 25_000,
      cls: { variety: 'Con semilla', origin: 'Oaxaca', quality: 'Segunda', caliber: '300' },
    });
    await setPrice(db, p.id, 4000);
    await mk({ id: p.id, name: 'Con semilla', origin: 'Michoacán', quality: 'Primera', caliber: '200', priceCents: 4000 });
    const [stored] = await listSalesByDay(db, localDay());
    expect(stored.items[0].name).toBe('Con semilla · Oaxaca · Segunda · 300');
    expect(stored.items[0].cls?.origin).toBe('Oaxaca');
    expect(stored.items[0].unitPriceCents).toBe(2500);
  });
});

describe('edición, unidad y estado', () => {
  it('editar la clasificación conserva el inventario y la posición', async () => {
    const p = await mk({ name: 'Sin semilla', quality: 'Primera' });
    await addStockMove(db, p.id, 'entrada', kg(40));
    const e = await mk({ id: p.id, name: 'Sin semilla', quality: 'Primera', caliber: '2X' });
    expect(e).toMatchObject({ id: p.id, caliber: '2X', physicalMilli: kg(40), sort: p.sort });
  });

  it('cambiar la unidad solo se permite si el producto nunca tuvo movimientos', async () => {
    const free = await mk({ name: 'Sin semilla', quality: 'Primera' });
    await expect(mk({ id: free.id, name: 'Sin semilla', quality: 'Primera', unit: 'caja', priceCents: 45_000 })).resolves.toMatchObject({ unit: 'caja' });
    const used = await mk({ name: 'Con semilla' });
    await addStockMove(db, used.id, 'entrada', kg(5));
    await expect(mk({ id: used.id, name: 'Con semilla', unit: 'arpilla' })).rejects.toThrow(/ya tiene movimientos/);
    expect((await getProduct(db, used.id))!.unit).toBe('kg');
  });

  it('ocultar / mostrar no toca precio ni clasificación', async () => {
    const p = await mk({ name: 'Sin semilla', quality: 'Primera', priceCents: 0, pendingPrice: true });
    const off = await setProductActive(db, p.id, false);
    expect(off).toMatchObject({ active: false, priceCents: 0, quality: 'Primera' });
    await expect(setProductActive(db, 'no-existe', true)).rejects.toThrow(/no encontrada/);
  });
});

describe('validaciones y límites (negativas)', () => {
  it('textos: vacío, demasiado largo, caracteres de control o invisibles', async () => {
    await expect(mk({ name: '   ' })).rejects.toThrow(/obligatorio/);
    await expect(mk({ name: 'a'.repeat(41) })).rejects.toThrow(/máximo 40/);
    await expect(mk({ name: 'ok', quality: 'q'.repeat(41) })).rejects.toThrow(/Calidad.*máximo/);
    await expect(mk({ name: `Sin${String.fromCharCode(7)}semilla` })).rejects.toThrow(/no permitidos/);
    await expect(mk({ name: 'ok', origin: `Oax${String.fromCharCode(0x200b)}aca` })).rejects.toThrow(/Procedencia.*no permitidos/);
    await expect(mk({ name: 'ok', caliber: `2${String.fromCharCode(0x202e)}X` })).rejects.toThrow(/Calibre/);
    expect(await listProducts(db)).toHaveLength(0);
  });

  it('precio: cero, negativo, no entero, NaN o excesivo; unidad desconocida', async () => {
    for (const price of [0, -1, 1.5, NaN, Infinity, MAX_PRICE_CENTS + 1]) {
      await expect(mk({ name: 'Sin semilla', priceCents: price }), String(price)).rejects.toThrow();
    }
    await expect(mk({ name: 'Sin semilla', priceCents: MAX_PRICE_CENTS })).resolves.toBeTruthy();
    await expect(mk({ name: 'Otro', unit: 'tonelada' as never })).rejects.toThrow(/Unidad/);
    const p = (await listProducts(db))[0];
    await expect(setPrice(db, p.id, MAX_PRICE_CENTS + 1)).rejects.toThrow(/demasiado alto/);
    await expect(setPrice(db, p.id, 0)).rejects.toThrow(/mayor a cero/);
  });

  it('cantidades: entradas y ventas por encima del máximo o inválidas no se registran', async () => {
    const p = await mk({ name: 'Sin semilla' });
    for (const q of [0, -5, 1.5, NaN, MAX_QTY_MILLI + 1]) {
      await expect(addStockMove(db, p.id, 'entrada', q), String(q)).rejects.toThrow();
      await expect(
        createSale(db, { cart: [{ productId: p.id, name: 'x', unit: 'kg', qtyMilli: q, unitPriceCents: 3000 }], paymentMethod: 'tarjeta', receivedCents: 0, allowNegativeStock: true }),
        String(q),
      ).rejects.toThrow();
    }
    await expect(addStockMove(db, p.id, 'entrada', MAX_QTY_MILLI)).resolves.toBeTruthy();
    expect((await getProduct(db, p.id))!.physicalMilli).toBe(MAX_QTY_MILLI);
    expect(await listSalesByDay(db, localDay())).toHaveLength(0);
  });

  it('un producto antiguo (sin procedencia ni calibre) sigue funcionando igual', async () => {
    const legacy = {
      id: newId(), name: 'Limón persa', quality: 'Primera', unit: 'kg' as const, priceCents: 3000, active: true, sort: 0,
      physicalMilli: kg(10), reservedMilli: 0, updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await db.put('products', legacy);
    expect(productLabel(legacy)).toBe('Limón persa · Primera');
    const s = await createSale(db, { cart: addLine([], legacy, kg(2)), paymentMethod: 'efectivo', receivedCents: 6000 });
    expect(s.items[0]).toMatchObject({ name: 'Limón persa · Primera', cls: { variety: 'Limón persa', quality: 'Primera' } });
    expect((await getProduct(db, legacy.id))!.physicalMilli).toBe(kg(8));
  });
});
