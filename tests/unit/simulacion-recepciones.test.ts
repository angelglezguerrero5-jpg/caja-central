import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditDatabase } from '../../src/db/audit';
import { validateBackup } from '../../src/db/backup';
import {
  DuplicateReceptionError,
  ReceptionIdConflictError,
  annotateReception,
  cancelReceptionDraft,
  confirmReception,
  confirmReceptionDraft,
  correctReception,
  listReceptions,
  saveReceptionDraft,
  voidReception,
} from '../../src/db/receptions';
import {
  addStockMove,
  cancelVale,
  createSale,
  deliverVale,
  exportBackup,
  getProduct,
  importBackup,
  newId,
  openDatabase,
  openShift,
  saveProduct,
  type DB,
} from '../../src/db/repo';
import { addLine } from '../../src/domain/cart';
import { currentNetMilli } from '../../src/domain/reception';
import type { Product } from '../../src/domain/types';

/**
 * Simulación aleatoria DETERMINISTA con ORÁCULO INDEPENDIENTE para las recepciones.
 *
 * Se mezclan, con una semilla fija, recepciones (confirmar, borradores, descartar, corregir, anular, corregir datos), ventas,
 * vales (vender, entregar, cancelar), entradas/mermas/conteos y viajes de ida y vuelta de respaldo. Un modelo en memoria,
 * escrito aparte y sin leer la base, lleva las existencias y los folios que DEBEN resultar; después de cada operación se
 * compara contra la base de datos (físico, reservado, estado y kilos vigentes de cada recepción, contador de folios) y cada
 * 25 operaciones se corre la auditoría de integridad. También se intentan operaciones que deben ser rechazadas (repetir una
 * recepción ya confirmada, anular dos veces, confirmar un borrador sin peso) y se comprueba que NO cambian nada.
 */

const kg = (n: number) => Math.round(n * 1000);
let db: DB;
let products: Product[];

beforeEach(async () => {
  db = await openDatabase(`sim-rec-${newId()}`);
  products = [
    await saveProduct(db, { name: 'Sin semilla', quality: 'Primera', caliber: '2X', unit: 'kg', priceCents: 3000, active: true }),
    await saveProduct(db, { name: 'Sin semilla', quality: 'Segunda', caliber: '3X', unit: 'kg', priceCents: 2200, active: true }),
    await saveProduct(db, { name: 'Con semilla', origin: 'Oaxaca', quality: 'Segunda', caliber: '300', unit: 'kg', priceCents: 2500, active: true }),
  ];
  await openShift(db, 100_000);
});
afterEach(() => db.close());

interface OracleRec {
  status: 'borrador' | 'confirmada' | 'cancelada' | 'anulada';
  productId: string;
  net?: number; // kilos vigentes (confirmada) o capturados (borrador)
  orig?: number; // kilos con los que se CONFIRMÓ (las correcciones no lo cambian)
  folio?: number;
}

function run(seed0: number, ops: number) {
  return async () => {
    let seed = seed0;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const milli = (lo: number, hi: number) => 250 * (lo * 4 + Math.floor(rnd() * ((hi - lo) * 4 + 1)));

    // ---- Oráculo: existencias por producto, recepciones y contador de folios
    const stock = new Map(products.map((p) => [p.id, { phys: 0, res: 0 }]));
    const recs = new Map<string, OracleRec>();
    const vales: Array<{ id: string; productId: string; qty: number }> = [];
    let nextFolio = 1;
    const counts = { confirm: 0, draft: 0, confirmDraft: 0, cancel: 0, correct: 0, void: 0, annotate: 0, sale: 0, vale: 0, deliver: 0, cancelVale: 0, manual: 0, roundtrip: 0, probe: 0 };

    const ofStatus = (s: OracleRec['status']) => [...recs.entries()].filter(([, r]) => r.status === s);

    async function compare(step: string) {
      for (const p of products) {
        const real = (await getProduct(db, p.id))!;
        const o = stock.get(p.id)!;
        expect({ phys: real.physicalMilli, res: real.reservedMilli }, `${step}: existencias de ${p.name} ${p.quality}`).toEqual(o);
      }
      const real = await listReceptions(db);
      expect(real.length, `${step}: cantidad de recepciones`).toBe(recs.size);
      for (const r of real) {
        const o = recs.get(r.id);
        expect(o, `${step}: recepción inesperada ${r.id}`).toBeDefined();
        expect(r.status, `${step}: estado de ${r.id}`).toBe(o!.status);
        if (o!.status === 'confirmada') {
          expect(currentNetMilli(r), `${step}: kilos vigentes de R-${r.folio}`).toBe(o!.net);
          expect(r.folio, `${step}: folio de ${r.id}`).toBe(o!.folio);
        }
        if (o!.status === 'anulada') expect(currentNetMilli(r)).toBe(0);
        if (o!.status === 'borrador' || o!.status === 'cancelada') expect(r.folio, 'sin folio hasta confirmar').toBeUndefined();
      }
      expect((await exportBackup(db)).nextReceptionFolio, `${step}: contador de folios de recepción`).toBe(nextFolio);
    }

    for (let i = 0; i < ops; i++) {
      const p = pick(products);
      const op = rnd();
      const step = `op ${i + 1} (semilla ${seed0})`;
      if (op < 0.2) {
        // confirmar una recepción nueva
        const id = newId();
        const net = milli(1, 500);
        await confirmReception(db, { id, productId: p.id, packaging: 'granel', weightMode: 'directo', netDirectMilli: net }, { acknowledgeDuplicate: true });
        stock.get(p.id)!.phys += net;
        recs.set(id, { status: 'confirmada', productId: p.id, net, orig: net, folio: nextFolio++ });
        counts.confirm++;
      } else if (op < 0.3) {
        // guardar un borrador (a veces sin peso)
        const id = newId();
        const net = rnd() < 0.7 ? milli(1, 300) : undefined;
        await saveReceptionDraft(db, { id, productId: p.id, packaging: 'granel', weightMode: 'directo', ...(net ? { netDirectMilli: net } : {}) });
        recs.set(id, { status: 'borrador', productId: p.id, ...(net ? { net } : {}) });
        counts.draft++;
      } else if (op < 0.38) {
        // confirmar un borrador: con peso suma; sin peso se rechaza y no cambia nada
        const d = ofStatus('borrador');
        if (!d.length) continue;
        const [id, r] = pick(d);
        if (r.net === undefined) {
          await expect(confirmReceptionDraft(db, id, { acknowledgeDuplicate: true }), `${step}: confirmar un borrador sin peso`).rejects.toThrow();
        } else {
          await confirmReceptionDraft(db, id, { acknowledgeDuplicate: true });
          stock.get(r.productId)!.phys += r.net;
          recs.set(id, { status: 'confirmada', productId: r.productId, net: r.net, orig: r.net, folio: nextFolio++ });
          counts.confirmDraft++;
        }
      } else if (op < 0.43) {
        const d = ofStatus('borrador');
        if (!d.length) continue;
        const [id, r] = pick(d);
        await cancelReceptionDraft(db, id, 'descartado');
        recs.set(id, { status: 'cancelada', productId: r.productId });
        counts.cancel++;
      } else if (op < 0.52) {
        const c = ofStatus('confirmada');
        if (!c.length) continue;
        const [id, r] = pick(c);
        let net = milli(1, 500);
        if (net === r.net) net += 250;
        await correctReception(db, id, net, 'corrección de la simulación', true, true);
        stock.get(r.productId)!.phys += net - r.net!;
        recs.set(id, { ...r, net });
        counts.correct++;
      } else if (op < 0.58) {
        const c = ofStatus('confirmada');
        if (!c.length) continue;
        const [id, r] = pick(c);
        await voidReception(db, id, 'anulada por la simulación', true, true);
        stock.get(r.productId)!.phys -= r.net!;
        recs.set(id, { status: 'anulada', productId: r.productId, folio: r.folio, orig: r.orig });
        counts.void++;
      } else if (op < 0.62) {
        const c = ofStatus('confirmada');
        if (!c.length) continue;
        const [id] = pick(c);
        await annotateReception(db, id, { supplier: `Proveedor ${i}` }, 'dato corregido'); // sin efecto en existencias
        counts.annotate++;
      } else if (op < 0.72) {
        const qty = milli(1, 40);
        await createSale(db, { cart: addLine([], p, qty), paymentMethod: 'transferencia', receivedCents: 0, allowNegativeStock: true });
        stock.get(p.id)!.phys -= qty;
        counts.sale++;
      } else if (op < 0.78) {
        const qty = milli(1, 30);
        const s = await createSale(db, { cart: addLine([], p, qty), paymentMethod: 'transferencia', receivedCents: 0, isVale: true, allowNegativeStock: true });
        stock.get(p.id)!.res += qty; // el vale RESERVA: el físico no se mueve
        vales.push({ id: s.id, productId: p.id, qty });
        counts.vale++;
      } else if (op < 0.83) {
        if (!vales.length) continue;
        const v = vales.splice(Math.floor(rnd() * vales.length), 1)[0];
        await deliverVale(db, v.id);
        const o = stock.get(v.productId)!;
        o.phys -= v.qty;
        o.res -= v.qty;
        counts.deliver++;
      } else if (op < 0.87) {
        if (!vales.length) continue;
        const v = vales.splice(Math.floor(rnd() * vales.length), 1)[0];
        await cancelVale(db, v.id, 'no vino', 'ninguna');
        stock.get(v.productId)!.res -= v.qty;
        counts.cancelVale++;
      } else if (op < 0.93) {
        const kind = pick(['entrada', 'merma', 'ajuste'] as const);
        const q = milli(1, 60);
        const o = stock.get(p.id)!;
        if (kind === 'entrada') {
          await addStockMove(db, p.id, 'entrada', q, 'inventario inicial', false, true);
          o.phys += q;
        } else if (kind === 'merma') {
          await addStockMove(db, p.id, 'merma', q, 'se echó a perder', true, true);
          o.phys -= q;
        } else {
          await addStockMove(db, p.id, 'ajuste', q, 'conteo físico', true, true);
          o.phys = q; // «existencia real contada»
        }
        counts.manual++;
      } else if (op < 0.96) {
        // ida y vuelta del respaldo sobre la misma base: nada debe cambiar (ni existencias ni folios)
        const b = await exportBackup(db);
        await importBackup(db, validateBackup(JSON.parse(JSON.stringify(b))));
        counts.roundtrip++;
      } else {
        // intentos que DEBEN ser rechazados sin cambiar nada
        const c = ofStatus('confirmada');
        const v = ofStatus('anulada');
        if (c.length) {
          const [id, r] = pick(c);
          // El MISMO intento con el MISMO contenido (los kilos con que se confirmó) es un reintento: se reconoce, no suma.
          await expect(
            confirmReception(db, { id, productId: r.productId, packaging: 'granel', weightMode: 'directo', netDirectMilli: r.orig! }, { acknowledgeDuplicate: true }),
            `${step}: repetir una recepción ya confirmada`,
          ).rejects.toBeInstanceOf(DuplicateReceptionError);
          // El mismo intento con OTRO contenido es un conflicto: nunca se da por bueno ni suma.
          await expect(
            confirmReception(db, { id, productId: r.productId, packaging: 'granel', weightMode: 'directo', netDirectMilli: r.orig! + 250 }, { acknowledgeDuplicate: true }),
            `${step}: mismo intento con otros kilos`,
          ).rejects.toBeInstanceOf(ReceptionIdConflictError);
        }
        if (v.length) {
          const [id] = pick(v);
          await expect(voidReception(db, id, 'otra vez', true, true), `${step}: anular dos veces`).rejects.toThrow();
          await expect(correctReception(db, id, kg(10), 'corregir una anulada', true, true), `${step}: corregir una anulada`).rejects.toThrow();
        }
        counts.probe++;
      }
      await compare(step);
      if (i % 25 === 24) {
        const r = await auditDatabase(db);
        expect(r.issues, `auditoría tras ${i + 1} operaciones`).toEqual([]);
      }
    }

    const final = await auditDatabase(db);
    expect(final.issues).toEqual([]);
    // La simulación sí ejerció cada tipo de operación (si no, no probaría nada).
    for (const [k, n] of Object.entries(counts)) expect(n, `la simulación nunca hizo «${k}»`).toBeGreaterThan(0);
    // Los folios de las recepciones confirmadas o anuladas son consecutivos y sin huecos.
    const folios = [...recs.values()].filter((r) => r.folio !== undefined).map((r) => r.folio as number).sort((a, b) => a - b);
    expect(folios).toEqual(Array.from({ length: folios.length }, (_, k) => k + 1));
  };
}

describe('simulación aleatoria con oráculo: recepciones, ventas, vales, conteos y respaldo', () => {
  for (const seed of [20261010, 7, 424242]) {
    it(`semilla ${seed}: 320 operaciones mantienen existencias, folios, estados y auditoría`, run(seed, 320), 120_000);
  }
});
