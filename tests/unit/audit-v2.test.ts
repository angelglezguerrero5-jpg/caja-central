import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditData, auditDatabase } from '../../src/db/audit';
import { annotateReception, confirmReception, correctReception, voidReception } from '../../src/db/receptions';
import {
  addStockMove,
  cancelVale,
  createSale,
  deliverVale,
  exportBackup,
  getCurrentShift,
  importBackup,
  newId,
  openDatabase,
  openShift,
  saveProduct,
  voidSale,
  type DB,
} from '../../src/db/repo';
import { addLine } from '../../src/domain/cart';
import type { Backup, Product } from '../../src/domain/types';

const kg = (n: number) => Math.round(n * 1000);
let db: DB;
let p: Product;
let q: Product;

beforeEach(async () => {
  db = await openDatabase(`aud-${newId()}`);
  p = await saveProduct(db, { name: 'Sin semilla', quality: 'Primera', caliber: '2X', unit: 'kg', priceCents: 3000, active: true });
  q = await saveProduct(db, { name: 'Con semilla', origin: 'Oaxaca', unit: 'kg', priceCents: 2500, active: true });
});
afterEach(() => db.close());

/** Una base con TODOS los tipos de movimiento y todos los estados de venta/vale/recepción. */
async function busyBackup(): Promise<{ backup: Backup; shiftId: string | undefined }> {
  await openShift(db, 10_000);
  const r = await confirmReception(db, { id: newId(), productId: p.id, packaging: 'granel', weightMode: 'directo', netDirectMilli: kg(500), supplier: 'Rancho' });
  await correctReception(db, r.id, kg(495), 'báscula');
  await annotateReception(db, r.id, { notes: 'llegó fría' }, 'observación olvidada');
  const r2 = await confirmReception(db, { id: newId(), productId: q.id, packaging: 'caja', containers: 4, weightMode: 'por_envase', unitNetMilli: kg(20) });
  await voidReception(db, r2.id, 'error de captura');
  await addStockMove(db, p.id, 'entrada', kg(30), '', false, true); // el aviso de «recepción reciente» se reconoce
  await addStockMove(db, p.id, 'merma', kg(2), 'podrido');
  await addStockMove(db, p.id, 'ajuste', kg(500), 'conteo');
  await createSale(db, { cart: addLine([], p, kg(10)), paymentMethod: 'efectivo', receivedCents: 100_000 });
  const toVoid = await createSale(db, { cart: addLine([], p, kg(5)), paymentMethod: 'tarjeta', receivedCents: 0 });
  await voidSale(db, toVoid.id, 'cliente se arrepintió');
  await createSale(db, { cart: addLine([], p, kg(20)), paymentMethod: 'tarjeta', receivedCents: 0, isVale: true });
  const delivered = await createSale(db, { cart: addLine([], p, kg(8)), paymentMethod: 'tarjeta', receivedCents: 0, isVale: true });
  await deliverVale(db, delivered.id);
  const cancelled = await createSale(db, { cart: addLine([], p, kg(6)), paymentMethod: 'tarjeta', receivedCents: 0, isVale: true });
  await cancelVale(db, cancelled.id, 'no vino', 'ninguna');
  return { backup: await exportBackup(db), shiftId: (await getCurrentShift(db))?.id };
}

describe('auditoría de movimientos de inventario', () => {
  it('una base con todos los tipos de operación audita limpia y sin advertencias', async () => {
    const { backup, shiftId } = await busyBackup();
    const a = auditData(backup, shiftId);
    expect(a.issues).toEqual([]);
    expect(a.warnings).toEqual([]);
    expect(a.ok).toBe(true);
    const types = new Set(backup.stockMoves.map((m) => m.type));
    for (const t of ['recepcion', 'correccion_recepcion', 'reversa_recepcion', 'entrada', 'merma', 'ajuste', 'venta', 'reserva', 'entrega_vale', 'anulacion']) {
      expect(types.has(t as never), `falta el tipo ${t}`).toBe(true);
    }
    expect((await auditDatabase(db)).issues).toEqual([]);
  });

  it('el respaldo auténtico de la versión anterior también audita limpio (cruce venta ↔ movimientos incluido)', async () => {
    await importBackup(db, JSON.parse(readFileSync('tests/fixtures/backup-v1.json', 'utf8')));
    const a = await auditDatabase(db);
    expect(a.issues).toEqual([]);
  });

  it('detecta signos incoherentes con el tipo del movimiento', async () => {
    const { backup, shiftId } = await busyBackup();
    const issues = (mut: (b: Backup) => void) => {
      const c = structuredClone(backup);
      mut(c);
      return auditData(c, shiftId).issues.join(' | ');
    };
    const mv = (c: Backup, type: string) => c.stockMoves.find((m) => m.type === type)!;
    expect(issues((c) => (mv(c, 'venta').deltaMilli = 5))).toMatch(/una venta debe restar kilos/);
    expect(issues((c) => (mv(c, 'recepcion').deltaMilli = -5))).toMatch(/una recepción debe sumar kilos/);
    expect(issues((c) => (mv(c, 'entrada').reservedDeltaMilli = 1))).toMatch(/una entrada debe sumar kilos/);
    expect(issues((c) => (mv(c, 'merma').deltaMilli = 5))).toMatch(/una merma debe restar kilos/);
    expect(issues((c) => (mv(c, 'merma').note = ' '))).toMatch(/merma sin motivo/);
    expect(issues((c) => (mv(c, 'ajuste').note = ''))).toMatch(/conteo físico sin motivo/);
    expect(issues((c) => (mv(c, 'reserva').deltaMilli = -1))).toMatch(/una reserva no mueve kilos físicos/);
    expect(issues((c) => (mv(c, 'entrega_vale').reservedDeltaMilli = 0))).toMatch(/una entrega debe restar los mismos kilos/);
    expect(issues((c) => (mv(c, 'anulacion').deltaMilli = 0, mv(c, 'anulacion').reservedDeltaMilli = 0))).toMatch(/una anulación devuelve kilos/);
    expect(issues((c) => (mv(c, 'reversa_recepcion').deltaMilli = 5))).toMatch(/una anulación de recepción debe restar/);
    expect(issues((c) => (mv(c, 'correccion_recepcion').deltaMilli = 0))).toMatch(/una corrección debe cambiar los kilos/);
    expect(issues((c) => ((mv(c, 'venta') as { type: string }).type = 'regalo'))).toMatch(/tipo de movimiento desconocido/);
  });

  it('detecta enlaces rotos entre ventas y movimientos', async () => {
    const { backup, shiftId } = await busyBackup();
    const issues = (mut: (b: Backup) => void) => {
      const c = structuredClone(backup);
      mut(c);
      return auditData(c, shiftId).issues.join(' | ');
    };
    const mv = (c: Backup, type: string) => c.stockMoves.find((m) => m.type === type)!;
    // un movimiento de venta apunta a una venta inexistente / a ninguna
    expect(issues((c) => (mv(c, 'venta').saleId = 'fantasma'))).toMatch(/venta que no existe/);
    expect(issues((c) => delete mv(c, 'reserva').saleId)).toMatch(/no apunta a ninguna venta/);
    // un movimiento manual no debe llevar saleId
    expect(issues((c) => (mv(c, 'entrada').saleId = c.sales[0].id))).toMatch(/no debería estar enlazado a una venta/);
    // una venta sin su movimiento, o con otra cantidad, no cuadra con sus renglones
    expect(issues((c) => c.stockMoves.splice(c.stockMoves.findIndex((m) => m.type === 'venta'), 1))).toMatch(/Venta #\d+: sus movimientos de inventario no coinciden con sus renglones \(faltan 1/);
    expect(issues((c) => (mv(c, 'entrega_vale').deltaMilli -= 1000, mv(c, 'entrega_vale').reservedDeltaMilli -= 1000))).toMatch(/no coinciden con sus renglones/);
    // un vale entregado al que le quitan la entrega queda como reserva viva
    expect(issues((c) => c.stockMoves.splice(c.stockMoves.findIndex((m) => m.type === 'entrega_vale'), 1))).toMatch(/no coinciden con sus renglones/);
    // el estado de la venta debe corresponder a sus movimientos
    expect(issues((c) => (c.sales.find((s) => s.delivery === 'cancelado')!.delivery = 'pendiente'))).toMatch(/no coinciden con sus renglones/);
    // movimiento duplicado (mismo id)
    expect(issues((c) => c.stockMoves.push({ ...c.stockMoves[0] }))).toMatch(/identificador repetido/);
    // movimiento de una variedad inexistente
    expect(issues((c) => (mv(c, 'entrada').productId = 'fantasma'))).toMatch(/variedad que no existe/);
  });

  it('un renglón con importe fuera de rango se reporta como inconsistencia, sin lanzar', async () => {
    const { backup, shiftId } = await busyBackup();
    const c = structuredClone(backup);
    c.sales[0].items[0].unitPriceCents = 10_000_000;
    c.sales[0].items[0].qtyMilli = 90_000_000_000;
    let out = '';
    expect(() => (out = auditData(c, shiftId).issues.join(' | '))).not.toThrow();
    expect(out).toMatch(/importe fuera de rango/);
  });

  it('las correcciones de datos de una recepción son solo bitácora', async () => {
    const { backup, shiftId } = await busyBackup();
    const withEdits = backup.receptions.find((r) => r.dataEdits?.length)!;
    expect(withEdits.dataEdits![0].changes).toEqual([{ field: 'notes', after: 'llegó fría' }]);
    const issues = (mut: (r: typeof withEdits) => void) => {
      const c = structuredClone(backup);
      mut(c.receptions.find((r) => r.id === withEdits.id)!);
      return auditData(c, shiftId).issues.join(' | ');
    };
    expect(issues((r) => (r.dataEdits![0].reason = ' '))).toMatch(/corrección de datos sin motivo/);
    expect(issues((r) => (r.dataEdits![0].changes = []))).toMatch(/sin cambios/);
    expect(issues((r) => (r.dataEdits![0].changes[0].field = 'netMilli' as never))).toMatch(/campo no editable \(netMilli\)/);
  });
});

describe('advertencias de catálogo heredado (no son errores)', () => {
  it('productos con la misma clasificación, valores largos o «Sin clasificar» escrito se avisan sin romper la auditoría', async () => {
    const { backup, shiftId } = await busyBackup();
    const c = structuredClone(backup);
    const base = c.products[0];
    c.products.push({ ...base, id: 'dup', physicalMilli: 0, reservedMilli: 0, name: base.name.toLowerCase() });
    c.products.push({ ...base, id: 'largo', physicalMilli: 0, reservedMilli: 0, name: 'Limón persa', quality: 'x'.repeat(41), caliber: undefined, origin: undefined });
    c.products.push({ ...base, id: 'literal', physicalMilli: 0, reservedMilli: 0, name: 'Limón raro', quality: 'Sin clasificar', caliber: undefined, origin: undefined });
    const a = auditData(c, shiftId);
    expect(a.issues).toEqual([]);
    expect(a.ok).toBe(true);
    const w = a.warnings.join(' | ');
    expect(w).toMatch(/2 productos con la misma clasificación/);
    expect(w).toMatch(/más de 40 caracteres/);
    expect(w).toMatch(/dice «Sin clasificar» en vez de quedar vacía/);
  });
});

describe('el consejo «ocultar uno de los duplicados» se puede cumplir', () => {
  it('un duplicado OCULTO y sin existencias deja de avisarse; si conserva existencias, sigue avisándose', async () => {
    const { backup, shiftId } = await busyBackup();
    const c = structuredClone(backup);
    const base = c.products[0];
    c.products.push({ ...base, id: 'dup', physicalMilli: 0, reservedMilli: 0, name: base.name.toLowerCase(), active: true });
    expect(auditData(c, shiftId).warnings.join(' | ')).toMatch(/2 productos con la misma clasificación/);
    c.products.find((x) => x.id === 'dup')!.active = false; // la persona sigue el consejo
    expect(auditData(c, shiftId).warnings.join(' | ')).not.toMatch(/misma clasificación/);
    // Oculto pero con existencia: su inventario sigue repartido, así que el aviso se queda.
    c.products.find((x) => x.id === 'dup')!.physicalMilli = 5000;
    expect(auditData(c, shiftId).warnings.join(' | ')).toMatch(/2 productos con la misma clasificación/);
  });

  it('datos de la versión 1 por encima de los topes de captura se conservan pero se avisan', async () => {
    const { backup, shiftId } = await busyBackup();
    const c = structuredClone(backup);
    c.sales[0].items[0].qtyMilli = 1_000_000_000; // 1 000 000 kg tecleados por error
    c.shifts[0].openingCashCents = 200_000_000_000; // $2 000 millones de fondo (el tope de captura es $1 000 millones)
    const w = auditData(c, shiftId).warnings.join(' | ');
    expect(w).toMatch(/1 venta con cantidades o importes por encima de lo que hoy se permite capturar/);
    expect(w).toMatch(/1 registro de caja/);
  });
});

describe('negativos autorizados y existencia negativa', () => {
  it('un movimiento marcado como «negativo autorizado» debe restar kilos y dejar el disponible negativo', async () => {
    const { backup, shiftId } = await busyBackup();
    const move = backup.stockMoves.find((m) => m.type === 'merma')!;
    const c = structuredClone(backup);
    c.stockMoves.find((m) => m.id === move.id)!.authorizedNegativeAfterMilli = 5; // positivo: incoherente
    expect(auditData(c, shiftId).issues.join(' | ')).toMatch(/negativo autorizado/);
    const c2 = structuredClone(backup);
    c2.stockMoves.find((m) => m.type === 'recepcion')!.authorizedNegativeAfterMilli = -1000; // una recepción no resta
    expect(auditData(c2, shiftId).issues.join(' | ')).toMatch(/negativo autorizado/);
    const c3 = structuredClone(backup);
    c3.stockMoves.find((m) => m.id === move.id)!.authorizedNegativeAfterMilli = -1000; // merma que resta y queda negativo: coherente
    expect(auditData(c3, shiftId).issues).toEqual([]);
  });

  it('la existencia disponible negativa se avisa, distinguiendo si hay autorización registrada o no', async () => {
    const { backup, shiftId } = await busyBackup();
    // sin autorización registrada: se fuerza a mano un producto en negativo (compensando movimientos para no crear errores)
    const c = structuredClone(backup);
    const prod = c.products.find((pp) => pp.name === 'Con semilla')!;
    prod.physicalMilli = -kg(5);
    c.stockMoves.push({ id: 'ajuste-manual', productId: prod.id, createdAt: new Date().toISOString(), type: 'ajuste', deltaMilli: -kg(5) - 0, reservedDeltaMilli: 0, note: 'conteo' });
    const w = auditData(c, shiftId);
    expect(w.issues).toEqual([]);
    expect(w.warnings.join(' | ')).toMatch(/Con semilla.*negativa.*SIN ninguna autorización/);
    // con una venta autorizada de ese producto, el aviso cambia
    const c2 = structuredClone(c);
    c2.sales[0].stockOverride = true;
    c2.sales[0].items[0].productId = prod.id;
    const w2 = auditData(c2, shiftId);
    expect(w2.warnings.join(' | ')).not.toMatch(/SIN ninguna autorización/);
  });
});
