import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listUndoSnapshots, loadUndoSnapshot, saveUndoSnapshot } from '../../src/db/undo';
import { confirmReception } from '../../src/db/receptions';
import { createSale, exportBackup, importBackup, newId, openDatabase, saveProduct } from '../../src/db/repo';
import { addLine } from '../../src/domain/cart';

const kg = (n: number) => Math.round(n * 1000);

describe('restauración: copia interna previa y folios que no bajan', () => {
  it('guarda las últimas 3 copias, la más reciente primero, y se pueden recuperar completas', async () => {
    const name = `undo-${newId()}`;
    const db = await openDatabase(`u-${newId()}`);
    const p = await saveProduct(db, { name: 'Sin semilla', unit: 'kg', priceCents: 3000, active: true });
    const snaps = [];
    for (let i = 1; i <= 4; i++) {
      await confirmReception(db, { id: newId(), productId: p.id, packaging: 'granel', weightMode: 'directo', netDirectMilli: kg(i * 10), supplier: `P${i}` });
      snaps.push(await saveUndoSnapshot(await exportBackup(db), `copia ${i}`, name));
      await new Promise((r) => setTimeout(r, 3)); // marcas de tiempo distintas
    }
    const list = await listUndoSnapshots(name);
    expect(list.map((s) => s.reason)).toEqual(['copia 4', 'copia 3', 'copia 2']); // la 1 se descartó
    expect(list[0]).toMatchObject({ receptions: 4, products: 1 });
    const full = await loadUndoSnapshot(list[1].id, name);
    expect(full?.receptions).toHaveLength(3);
    expect(await loadUndoSnapshot('no-existe', name)).toBeUndefined();
    db.close();
  });

  describe('el orden de las copias no depende del reloj del teléfono', () => {
    afterEach(() => vi.useRealTimers());

    const emptyBackup = async () => {
      const db = await openDatabase(`e-${newId()}`);
      const backup = await exportBackup(db);
      db.close();
      return backup;
    };

    it('con el reloj congelado (varias copias con la MISMA hora) la más reciente es la última guardada y se descarta la más vieja', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-10T20:00:00.000Z'));
      const name = `undo-${newId()}`;
      const backup = await emptyBackup();
      for (let i = 1; i <= 5; i++) await saveUndoSnapshot(backup, `copia ${i}`, name);
      const list = await listUndoSnapshots(name);
      expect(new Set(list.map((s) => s.at)).size, 'todas con la misma hora').toBe(1);
      expect(list.map((s) => s.reason)).toEqual(['copia 5', 'copia 4', 'copia 3']);
    });

    it('con un reloj que RETROCEDE (se corrigió la hora del teléfono) la más reciente sigue siendo la última guardada', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const name = `undo-${newId()}`;
      const backup = await emptyBackup();
      const horas = ['2026-10-10T20:00:00.000Z', '2026-10-10T19:00:00.000Z', '2026-10-09T08:00:00.000Z', '2026-10-08T08:00:00.000Z'];
      for (const [i, hora] of horas.entries()) {
        vi.setSystemTime(new Date(hora));
        await saveUndoSnapshot(backup, `copia ${i + 1}`, name);
      }
      const list = await listUndoSnapshots(name);
      expect(list.map((s) => s.reason), 'se conservan las 3 últimas GUARDADAS, aunque su fecha sea más vieja').toEqual(['copia 4', 'copia 3', 'copia 2']);
      expect(list[0].at).toBe('2026-10-08T08:00:00.000Z');
    });

    it('lo que devuelve no expone el contador interno y las copias siguen completas', async () => {
      const name = `undo-${newId()}`;
      const info = await saveUndoSnapshot(await emptyBackup(), 'una', name);
      expect(Object.keys(info).sort()).toEqual(['at', 'id', 'moves', 'products', 'reason', 'receptions', 'sales']);
      expect(Object.keys((await listUndoSnapshots(name))[0]).sort()).toEqual(Object.keys(info).sort());
      expect((await loadUndoSnapshot(info.id, name))?.app).toBe('caja-central');
    });

    it('copias guardadas por una versión anterior (sin contador) se conservan, se ordenan por fecha y quedan por debajo de las nuevas', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z')); // la nueva tiene una fecha MÁS VIEJA que las de antes
      const name = `undo-${newId()}`;
      const backup = await emptyBackup();
      const legacy = await openDB(name, 1, { upgrade: (d) => void d.createObjectStore('snapshots', { keyPath: 'id' }) });
      for (const [id, at] of [['old-1', '2026-03-01T00:00:00.000Z'], ['old-2', '2026-04-01T00:00:00.000Z'], ['old-3', '2026-05-01T00:00:00.000Z']] as const) {
        await legacy.put('snapshots', { id, at, reason: id, sales: 0, receptions: 0, products: 0, moves: 0, backup });
      }
      legacy.close();
      expect((await listUndoSnapshots(name)).map((s) => s.id)).toEqual(['old-3', 'old-2', 'old-1']); // por fecha entre sí
      await saveUndoSnapshot(backup, 'nueva', name);
      const list = await listUndoSnapshots(name);
      expect(list.map((s) => s.reason)).toEqual(['nueva', 'old-3', 'old-2']); // la nueva primero; se descartó la MÁS VIEJA (old-1)
    });
  });

  it('restaurar un respaldo VIEJO no hace bajar los folios (no se repiten tickets, vales ni recepciones)', async () => {
    const db = await openDatabase(`m-${newId()}`);
    const p = await saveProduct(db, { name: 'Sin semilla', unit: 'kg', priceCents: 3000, active: true });
    await confirmReception(db, { id: newId(), productId: p.id, packaging: 'granel', weightMode: 'directo', netDirectMilli: kg(100) });
    await createSale(db, { cart: addLine([], p, kg(5)), paymentMethod: 'tarjeta', receivedCents: 0 });
    const monday = JSON.parse(JSON.stringify(await exportBackup(db))); // folios siguientes: venta 2, vale 1, recepción 2

    // durante la semana se emiten más: ventas #2-#4, vales V-1..V-2 y recepciones R-2..R-3
    for (let i = 0; i < 3; i++) await createSale(db, { cart: addLine([], p, kg(1)), paymentMethod: 'tarjeta', receivedCents: 0, isVale: i < 2 });
    await confirmReception(db, { id: newId(), productId: p.id, packaging: 'granel', weightMode: 'directo', netDirectMilli: kg(7), supplier: 'a' });
    await confirmReception(db, { id: newId(), productId: p.id, packaging: 'granel', weightMode: 'directo', netDirectMilli: kg(8), supplier: 'b' });
    const friday = await exportBackup(db);
    expect([friday.nextFolio, friday.nextValeFolio, friday.nextReceptionFolio]).toEqual([5, 3, 4]);

    await importBackup(db, monday); // por error se elige el archivo del lunes
    const after = await exportBackup(db);
    expect(after.sales).toHaveLength(1); // los DATOS son los del lunes...
    expect(after.receptions).toHaveLength(1);
    expect([after.nextFolio, after.nextValeFolio, after.nextReceptionFolio]).toEqual([5, 3, 4]); // ...pero los folios NO bajan
    const s = await createSale(db, { cart: addLine([], p, kg(1)), paymentMethod: 'tarjeta', receivedCents: 0, allowNegativeStock: true });
    expect(s.folio).toBe(5); // el #2, #3 y #4 ya se habían entregado a clientes: no se reutilizan
    db.close();
  });

  it('en un teléfono nuevo (sin datos) los folios son exactamente los del respaldo', async () => {
    const a = await openDatabase(`n1-${newId()}`);
    const p = await saveProduct(a, { name: 'Sin semilla', unit: 'kg', priceCents: 3000, active: true });
    await createSale(a, { cart: addLine([], p, kg(1)), paymentMethod: 'tarjeta', receivedCents: 0, allowNegativeStock: true });
    const backup = JSON.parse(JSON.stringify(await exportBackup(a)));
    const b = await openDatabase(`n2-${newId()}`);
    await importBackup(b, backup);
    const out = await exportBackup(b);
    expect([out.nextFolio, out.nextValeFolio, out.nextReceptionFolio]).toEqual([2, 1, 1]);
    a.close();
    b.close();
  });
});
