import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditData, auditDatabase } from '../../src/db/audit';
import {
  DuplicateReceptionError,
  PossibleDuplicateReceptionError,
  ReceptionValidationError,
  annotateReception,
  cancelReceptionDraft,
  confirmReception,
  confirmReceptionDraft,
  correctReception,
  getReception,
  lastUnitNet,
  listMovesForReception,
  listReceptions,
  receptionToFields,
  saveReceptionDraft,
  voidAndCopyToDraft,
  voidReception,
} from '../../src/db/receptions';
import {
  addStockMove,
  availableMilli,
  cancelVale,
  closeShift,
  createSale,
  deliverVale,
  exportBackup,
  getCurrentShift,
  getProduct,
  InsufficientStockError,
  NegativeStockError,
  listSalesByShift,
  listStockMoves,
  newId,
  openDatabase,
  openShift,
  saveProduct,
  setProductActive,
  type DB,
} from '../../src/db/repo';
import { addLine } from '../../src/domain/cart';
import { movementTotals } from '../../src/domain/mercancia';
import { buildShiftReport, localDay } from '../../src/domain/report';
import type { Product } from '../../src/domain/types';

const kg = (n: number) => Math.round(n * 1000);
let db: DB;
let p: Product; // Sin semilla · Primera · 2X
let q: Product; // Con semilla · Oaxaca · Segunda · 300

beforeEach(async () => {
  db = await openDatabase(`rec-${newId()}`);
  p = await saveProduct(db, { name: 'Sin semilla', quality: 'Primera', caliber: '2X', unit: 'kg', priceCents: 3000, active: true });
  q = await saveProduct(db, { name: 'Con semilla', origin: 'Oaxaca', quality: 'Segunda', caliber: '300', unit: 'kg', priceCents: 2500, active: true });
});
afterEach(() => db.close());

const phys = async (prod = p) => (await getProduct(db, prod.id))!.physicalMilli;
const direct = (n: number, extra: Record<string, unknown> = {}) => ({
  id: newId(), productId: p.id, packaging: 'granel' as const, weightMode: 'directo' as const, netDirectMilli: kg(n), ...extra,
});

describe('recepción confirmada: los kilos entran una sola vez (casos 8–11)', () => {
  it('8. a granel: suma exacta, folio R-1, dato original y movimiento enlazado', async () => {
    const input = direct(1234.5, { supplier: '  Rancho   El Sol ', reference: 'CAM-77', notes: 'llegó fría' });
    const r = await confirmReception(db, input);
    expect(r).toMatchObject({
      status: 'confirmada', folio: 1, productId: p.id, productLabel: 'Sin semilla · Primera · 2X',
      supplier: 'Rancho El Sol', reference: 'CAM-77', notes: 'llegó fría', packaging: 'granel', weightMode: 'directo',
      netDirectMilli: 1_234_500, netMilli: 1_234_500, confirmedNetMilli: 1_234_500, corrections: [],
    });
    expect(r.cls).toEqual({ variety: 'Sin semilla', quality: 'Primera', caliber: '2X' });
    expect(await phys()).toBe(1_234_500);
    const moves = await listStockMoves(db, p.id);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ type: 'recepcion', deltaMilli: 1_234_500, reservedDeltaMilli: 0, receptionId: r.id, id: r.stockMoveId });
    expect(await listMovesForReception(db, r.id)).toHaveLength(1);
    expect((await getReception(db, r.id))?.confirmedAt).toBeTruthy();
  });

  it('9. cajas con peso configurado: 40 × 18.25 kg = 730 kg (el neto por caja es dato capturado)', async () => {
    const r = await confirmReception(db, {
      id: newId(), productId: p.id, packaging: 'caja', containers: 40, weightMode: 'por_envase', unitNetMilli: kg(18.25),
    });
    expect(r).toMatchObject({ packaging: 'caja', containers: 40, unitNetMilli: 18_250, netMilli: 730_000 });
    expect(await phys()).toBe(730_000);
  });

  it('10–11. arpillas: 10 × 15 kg = 150 kg; también con peso fraccionario', async () => {
    await confirmReception(db, { id: newId(), productId: p.id, packaging: 'arpilla', containers: 10, weightMode: 'por_envase', unitNetMilli: kg(15) });
    expect(await phys()).toBe(150_000);
    await confirmReception(db, { id: newId(), productId: p.id, packaging: 'arpilla', containers: 3, weightMode: 'por_envase', unitNetMilli: kg(14.333) });
    expect(await phys()).toBe(150_000 + 42_999);
  });

  it('bruto − tara y NO se suman modos: solo cuenta el activo, y se guarda solo lo del modo activo', async () => {
    const r = await confirmReception(db, {
      id: newId(), productId: p.id, packaging: 'caja', weightMode: 'bruto_tara', grossMilli: kg(520), tareMilli: kg(20),
      containers: 25, netDirectMilli: kg(999), unitNetMilli: kg(77),
    });
    expect(r.netMilli).toBe(kg(500));
    expect(r.netDirectMilli).toBeUndefined();
    expect(r.unitNetMilli).toBeUndefined();
    expect(r).toMatchObject({ grossMilli: kg(520), tareMilli: kg(20), containers: 25 }); // envases = informativo
    expect(await phys()).toBe(kg(500));
  });

  it('a granel descarta los envases y no permite envases × peso', async () => {
    const r = await confirmReception(db, { ...direct(10), containers: 5 });
    expect(r.containers).toBeUndefined();
    await expect(
      confirmReception(db, { id: newId(), productId: p.id, packaging: 'granel', containers: 3, weightMode: 'por_envase', unitNetMilli: kg(15) }),
    ).rejects.toBeInstanceOf(ReceptionValidationError);
    expect(await phys()).toBe(kg(10));
  });

  it('folios consecutivos R-1, R-2… y la fecha editable define el día', async () => {
    const a = await confirmReception(db, direct(10));
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    const b = await confirmReception(db, direct(20, { receivedAt: yesterday.toISOString() }));
    expect([a.folio, b.folio]).toEqual([1, 2]);
    expect(b.day).toBe(localDay(yesterday));
    expect(a.day).toBe(localDay());
  });
});

describe('prevención de duplicados (caso 12)', () => {
  it('confirmar dos veces el MISMO id no vuelve a sumar (doble toque / reintento)', async () => {
    const input = direct(100);
    const first = await confirmReception(db, input);
    const again = confirmReception(db, input);
    await expect(again).rejects.toBeInstanceOf(DuplicateReceptionError);
    await again.catch((e: DuplicateReceptionError) => expect(e.reception.folio).toBe(first.folio));
    expect(await phys()).toBe(kg(100));
    expect(await listStockMoves(db, p.id)).toHaveLength(1);
    expect(await listReceptions(db)).toHaveLength(1);
    // el folio no se gastó con el intento repetido
    expect((await confirmReception(db, direct(1))).folio).toBe(2);
  });

  it('10 confirmaciones simultáneas del mismo id: exactamente una entra', async () => {
    const input = direct(50);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => confirmReception(db, input)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(9);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(DuplicateReceptionError);
    expect(await phys()).toBe(kg(50));
    expect((await auditDatabase(db)).issues).toEqual([]);
  });

  it('otra captura de la misma entrega (misma referencia) exige reconocimiento explícito', async () => {
    await confirmReception(db, direct(100, { reference: 'CAM-5' }));
    const second = direct(100, { reference: ' cam-5 ' });
    const err = await confirmReception(db, second).catch((e) => e);
    expect(err).toBeInstanceOf(PossibleDuplicateReceptionError);
    expect(err.matches).toHaveLength(1);
    expect(await phys()).toBe(kg(100)); // nada se sumó
    const ok = await confirmReception(db, second, { acknowledgeDuplicate: true });
    expect(ok.folio).toBe(2);
    expect(await phys()).toBe(kg(200));
  });

  it('mismo proveedor + producto + kilos + día también se marca; otro producto o kilos no', async () => {
    await confirmReception(db, direct(100, { supplier: 'Rancho Sol' }));
    await expect(confirmReception(db, direct(100, { supplier: 'rancho sol' }))).rejects.toBeInstanceOf(PossibleDuplicateReceptionError);
    await expect(confirmReception(db, direct(101, { supplier: 'Rancho Sol' }))).resolves.toBeTruthy();
    await expect(confirmReception(db, { ...direct(100, { supplier: 'Rancho Sol' }), productId: q.id })).resolves.toBeTruthy();
  });
});

describe('borradores y cancelación (caso 13)', () => {
  it('un borrador no toca el inventario, es idempotente y puede estar incompleto', async () => {
    const id = newId();
    const d1 = await saveReceptionDraft(db, { id, packaging: 'caja', weightMode: 'por_envase', containers: 30, supplier: 'Rancho Sol', productId: p.id });
    expect(d1).toMatchObject({ status: 'borrador', containers: 30 });
    expect(d1.netMilli).toBeUndefined(); // no se inventa el peso
    expect(d1.folio).toBeUndefined();
    const d2 = await saveReceptionDraft(db, { id, packaging: 'caja', weightMode: 'por_envase', containers: 31, supplier: 'Rancho Sol', productId: p.id });
    expect(d2.containers).toBe(31);
    expect(d2.createdAt).toBe(d1.createdAt);
    expect(await listReceptions(db, { status: 'borrador' })).toHaveLength(1);
    expect(await phys()).toBe(0);
    expect(await listStockMoves(db, p.id)).toHaveLength(0);
  });

  it('un borrador sin peso NO se puede confirmar (sin inventar el peso) y nada cambia', async () => {
    const d = await saveReceptionDraft(db, { id: newId(), packaging: 'caja', weightMode: 'por_envase', containers: 30, productId: p.id });
    const err = await confirmReceptionDraft(db, d.id).catch((e) => e);
    expect(err).toBeInstanceOf(ReceptionValidationError);
    expect(err.message).toMatch(/peso neto/);
    expect(await phys()).toBe(0);
    expect((await getReception(db, d.id))?.status).toBe('borrador');
    expect((await confirmReception(db, direct(1))).folio).toBe(1); // folio no consumido
  });

  it('completar el borrador y confirmarlo suma una vez (reabrir con receptionToFields)', async () => {
    const d = await saveReceptionDraft(db, { id: newId(), packaging: 'arpilla', weightMode: 'por_envase', containers: 10, productId: p.id });
    const fields = { ...receptionToFields(d), unitNetMilli: kg(15) };
    const r = await confirmReception(db, fields);
    expect(r).toMatchObject({ id: d.id, status: 'confirmada', netMilli: kg(150), createdAt: d.createdAt });
    expect(await phys()).toBe(kg(150));
    expect(await listReceptions(db, { status: 'borrador' })).toHaveLength(0);
    await expect(confirmReceptionDraft(db, d.id)).rejects.toBeInstanceOf(DuplicateReceptionError);
    expect(await phys()).toBe(kg(150));
  });

  it('13. cancelar un borrador conserva el registro y NO modifica existencias; no se puede confirmar después', async () => {
    await addStockMove(db, p.id, 'entrada', kg(40));
    const d = await saveReceptionDraft(db, { ...direct(500), id: newId() });
    const c = await cancelReceptionDraft(db, d.id, 'se rechazó el camión');
    expect(c).toMatchObject({ status: 'cancelada', cancelReason: 'se rechazó el camión' });
    expect(c.cancelledAt).toBeTruthy();
    expect(await phys()).toBe(kg(40));
    expect(await listStockMoves(db, p.id)).toHaveLength(1); // solo la entrada manual
    await expect(confirmReceptionDraft(db, d.id)).rejects.toThrow(/cancelada/);
    await expect(confirmReception(db, receptionToFields(c))).rejects.toThrow(/cancelada/);
    await expect(cancelReceptionDraft(db, d.id)).rejects.toThrow(/borradores/);
    await expect(saveReceptionDraft(db, receptionToFields(c))).rejects.toThrow(/cancelada/);
    expect(await phys()).toBe(kg(40));
  });

  it('13b. al descartar un borrador queda escrito QUÉ limón era (el historial lo muestra); sin producto no inventa nada', async () => {
    const d = await saveReceptionDraft(db, { ...direct(75), id: newId() });
    const c = await cancelReceptionDraft(db, d.id);
    expect(c.productLabel).toBe('Sin semilla · Primera · 2X');
    expect((await getReception(db, d.id))!.productLabel).toBe('Sin semilla · Primera · 2X');
    const sinProducto = await saveReceptionDraft(db, { id: newId(), packaging: 'granel', weightMode: 'directo', netDirectMilli: kg(5) });
    expect((await cancelReceptionDraft(db, sinProducto.id)).productLabel).toBeUndefined();
    // Si luego se renombra el producto, la etiqueta del descarte conserva el nombre de ese momento (foto, no referencia).
    await saveProduct(db, { id: p.id, name: 'Sin semilla', quality: 'Segunda', caliber: '2X', unit: 'kg', priceCents: 3000, active: true });
    expect((await getReception(db, d.id))!.productLabel).toBe('Sin semilla · Primera · 2X');
    expect(await phys()).toBe(0);
  });

  it('el historial ordena con desempate estable: dos llegadas a la misma hora salen por folio descendente', async () => {
    const at = new Date('2026-10-10T18:00:00.000Z');
    const a = await confirmReception(db, direct(10), { at });
    const b = await confirmReception(db, direct(20, { reference: 'otra' }), { at, acknowledgeDuplicate: true });
    const c = await confirmReception(db, direct(30, { reference: 'otra más' }), { at, acknowledgeDuplicate: true });
    expect([a.folio, b.folio, c.folio]).toEqual([1, 2, 3]);
    for (let i = 0; i < 5; i++) {
      expect((await listReceptions(db, { status: 'confirmada' })).map((r) => r.folio)).toEqual([3, 2, 1]);
    }
  });

  it('una recepción confirmada no se "cancela": se anula', async () => {
    const r = await confirmReception(db, direct(10));
    await expect(cancelReceptionDraft(db, r.id)).rejects.toThrow(/borradores/);
    expect(await phys()).toBe(kg(10));
  });

  it('un borrador vacío o con datos inválidos se rechaza', async () => {
    await expect(saveReceptionDraft(db, { packaging: 'granel', weightMode: 'directo' })).rejects.toBeInstanceOf(ReceptionValidationError);
    await expect(saveReceptionDraft(db, direct(-5))).rejects.toBeInstanceOf(ReceptionValidationError);
  });
});

describe('correcciones y anulaciones auditadas', () => {
  it('corregir kilos agrega un movimiento ± y conserva el original', async () => {
    const r = await confirmReception(db, direct(150));
    const c = await correctReception(db, r.id, kg(140), 'la báscula marcó mal');
    expect(c.netMilli).toBe(kg(140));
    expect(c.confirmedNetMilli).toBe(kg(150)); // dato original intacto
    expect(c.corrections).toHaveLength(1);
    expect(c.corrections[0]).toMatchObject({ previousNetMilli: kg(150), newNetMilli: kg(140), deltaMilli: -kg(10), reason: 'la báscula marcó mal' });
    expect(await phys()).toBe(kg(140));
    const moves = await listMovesForReception(db, r.id);
    expect(moves.map((m) => [m.type, m.deltaMilli])).toEqual([['recepcion', kg(150)], ['correccion_recepcion', -kg(10)]]);
    // segunda corrección al alza encadena
    const c2 = await correctReception(db, r.id, kg(145), 'se encontró una arpilla');
    expect(c2.corrections[1]).toMatchObject({ previousNetMilli: kg(140), newNetMilli: kg(145), deltaMilli: kg(5) });
    expect(await phys()).toBe(kg(145));
    expect((await auditDatabase(db)).issues).toEqual([]);
  });

  it('corregir exige motivo, kilos válidos y un cambio real', async () => {
    const r = await confirmReception(db, direct(150));
    await expect(correctReception(db, r.id, kg(140), '  ')).rejects.toThrow(/motivo/);
    for (const bad of [0, -5, 1.5, NaN, Infinity, 200_000_001]) {
      await expect(correctReception(db, r.id, bad, 'x'), `kilos ${bad}`).rejects.toThrow();
    }
    await expect(correctReception(db, r.id, kg(150), 'igual')).rejects.toThrow(/nada que corregir/);
    await expect(correctReception(db, 'no-existe', kg(1), 'x')).rejects.toThrow(/no encontrada/);
    expect(await phys()).toBe(kg(150));
  });

  it('corregir a la baja o anular con mercancía ya vendida exige autorización explícita', async () => {
    const r = await confirmReception(db, direct(100));
    await createSale(db, { cart: addLine([], p, kg(80)), paymentMethod: 'tarjeta', receivedCents: 0 });
    await expect(correctReception(db, r.id, kg(50), 'error')).rejects.toThrow(/Se requiere autorización/);
    await expect(voidReception(db, r.id, 'error')).rejects.toThrow(/Se requiere autorización/);
    expect(await phys()).toBe(kg(20));
    const c = await correctReception(db, r.id, kg(50), 'error', true);
    expect(c.netMilli).toBe(kg(50));
    expect(await phys()).toBe(-kg(30));
    expect(availableMilli((await getProduct(db, p.id))!)).toBe(-kg(30));
    // corregir al alza nunca necesita autorización
    await expect(correctReception(db, r.id, kg(300), 'más')).resolves.toBeTruthy();
  });

  it('anular revierte los kilos vigentes con una reversa; no se repite ni se corrige después', async () => {
    const r = await confirmReception(db, direct(100));
    await correctReception(db, r.id, kg(90), 'ajuste');
    const v = await voidReception(db, r.id, 'se capturó con la clasificación equivocada');
    expect(v).toMatchObject({ status: 'anulada', netMilli: 0, confirmedNetMilli: kg(100), voidReason: 'se capturó con la clasificación equivocada' });
    expect(await phys()).toBe(0);
    const moves = await listMovesForReception(db, r.id);
    expect(moves.map((m) => m.type)).toEqual(['recepcion', 'correccion_recepcion', 'reversa_recepcion']);
    expect(moves[2].deltaMilli).toBe(-kg(90));
    expect(v.voidStockMoveId).toBe(moves[2].id);
    await expect(voidReception(db, r.id, 'otra vez')).rejects.toThrow(/confirmadas/);
    await expect(correctReception(db, r.id, kg(5), 'x')).rejects.toThrow(/confirmadas/);
    await expect(voidReception(db, newId(), 'x')).rejects.toThrow(/no encontrada/);
    await expect(voidReception(db, r.id, ' ')).rejects.toThrow(/motivo/);
    expect(await phys()).toBe(0);
    expect((await auditDatabase(db)).issues).toEqual([]);
    // El producto equivocado se corrige: anular + capturar de nuevo en el correcto
    await confirmReception(db, { ...direct(100), productId: q.id });
    expect(await phys(q)).toBe(kg(100));
  });
});

describe('inventario: ventas, vales y corte con recepciones (casos 14, 15, 23)', () => {
  it('14. una venta de 20 kg descuenta exactamente 20 kg', async () => {
    await confirmReception(db, direct(150));
    await createSale(db, { cart: addLine([], p, kg(20)), paymentMethod: 'efectivo', receivedCents: 100_000 });
    const prod = (await getProduct(db, p.id))!;
    expect([prod.physicalMilli, prod.reservedMilli, availableMilli(prod)]).toEqual([kg(130), 0, kg(130)]);
  });

  it('15. un vale reserva sin descontar dos veces, y al entregarlo baja físico y reserva una sola vez', async () => {
    await confirmReception(db, direct(150));
    const vale = await createSale(db, { cart: addLine([], p, kg(50)), paymentMethod: 'efectivo', receivedCents: 150_000, isVale: true });
    let prod = (await getProduct(db, p.id))!;
    expect([prod.physicalMilli, prod.reservedMilli, availableMilli(prod)]).toEqual([kg(150), kg(50), kg(100)]);
    await deliverVale(db, vale.id);
    prod = (await getProduct(db, p.id))!;
    expect([prod.physicalMilli, prod.reservedMilli, availableMilli(prod)]).toEqual([kg(100), 0, kg(100)]);
    // no se puede disponer de lo reservado
    const v2 = await createSale(db, { cart: addLine([], p, kg(90)), paymentMethod: 'efectivo', receivedCents: 300_000, isVale: true });
    await expect(createSale(db, { cart: addLine([], p, kg(20)), paymentMethod: 'tarjeta', receivedCents: 0 })).rejects.toBeInstanceOf(InsufficientStockError);
    await cancelVale(db, v2.id, 'no vino', 'ninguna');
    expect(availableMilli((await getProduct(db, p.id))!)).toBe(kg(100));
  });

  it('la identidad contable se cumple con todos los tipos de movimiento', async () => {
    const r = await confirmReception(db, direct(500));
    await addStockMove(db, p.id, 'entrada', kg(30), '', false, true); // reconoce el aviso de recepción reciente
    await createSale(db, { cart: addLine([], p, kg(40)), paymentMethod: 'tarjeta', receivedCents: 0 });
    const vale = await createSale(db, { cart: addLine([], p, kg(25)), paymentMethod: 'tarjeta', receivedCents: 0, isVale: true });
    await deliverVale(db, vale.id);
    await addStockMove(db, p.id, 'merma', kg(5), 'podrido');
    await addStockMove(db, p.id, 'ajuste', kg(480), 'conteo');
    await correctReception(db, r.id, kg(495), 'báscula', false, true); // reconoce el aviso: hubo un conteo después
    const t = movementTotals(await listStockMoves(db, p.id, 999));
    expect(t.physicalMilli).toBe(await phys());
    expect(t.recepcionesMilli).toBe(kg(495));
    expect(t.entradasManualesMilli).toBe(kg(30));
    expect(t.ventasNetasMilli).toBe(kg(65));
    expect(t.mermasMilli).toBe(kg(5));
    expect((await auditDatabase(db)).issues).toEqual([]);
  });

  it('23. el corte de caja no cambia por recibir, corregir o anular mercancía', async () => {
    await openShift(db, 20_000);
    await confirmReception(db, direct(300));
    await createSale(db, { cart: addLine([], p, kg(10)), paymentMethod: 'efectivo', receivedCents: 30_000 });
    const shift = (await getCurrentShift(db))!;
    const report = async () => buildShiftReport(shift, await listSalesByShift(db, shift.id), []);
    const before = await report();
    expect(before.expectedCashCents).toBe(20_000 + 30_000);
    const r2 = await confirmReception(db, direct(100, { supplier: 'otro' }));
    await correctReception(db, r2.id, kg(120), 'x');
    await voidReception(db, r2.id, 'y');
    const after = await report();
    expect(after).toEqual(before);
    const closed = await closeShift(db, 50_000);
    expect(closed.expectedCashCents).toBe(50_000);
    expect(closed.differenceCents).toBe(0);
  });
});

describe('validaciones y fallos (negativas)', () => {
  const rejects = async (input: Record<string, unknown>) => {
    const before = await phys();
    await expect(confirmReception(db, { ...direct(10), ...input } as never)).rejects.toBeInstanceOf(ReceptionValidationError);
    expect(await phys()).toBe(before);
    expect(await listReceptions(db, { status: 'confirmada' })).toHaveLength(0);
  };

  it('kilos inválidos, vacíos, negativos, desbordados o excesivos no entran', async () => {
    for (const v of [0, -1, -kg(10), 0.5, NaN, Infinity, 200_000_001, Number.MAX_SAFE_INTEGER + 2]) {
      await rejects({ netDirectMilli: v });
    }
    await rejects({ netDirectMilli: undefined });
    await rejects({ packaging: 'arpilla', weightMode: 'por_envase', containers: 100_000, unitNetMilli: Number.MAX_SAFE_INTEGER, netDirectMilli: undefined });
    await rejects({ packaging: 'arpilla', weightMode: 'por_envase', containers: 100_001, unitNetMilli: 1, netDirectMilli: undefined });
    await rejects({ packaging: 'arpilla', weightMode: 'por_envase', containers: 0, unitNetMilli: kg(15), netDirectMilli: undefined });
    await rejects({ packaging: 'arpilla', weightMode: 'por_envase', containers: 10, netDirectMilli: undefined }); // sin peso: no se inventa
    await rejects({ packaging: 'caja', weightMode: 'bruto_tara', grossMilli: kg(10), tareMilli: kg(10), netDirectMilli: undefined });
    await rejects({ packaging: 'caja', weightMode: 'bruto_tara', grossMilli: kg(10), tareMilli: -1, netDirectMilli: undefined });
  });

  it('producto: sin elegir, inexistente, oculto o que no se vende por kg', async () => {
    await rejects({ productId: undefined });
    await rejects({ productId: 'no-existe' });
    await setProductActive(db, p.id, false);
    await rejects({});
    await setProductActive(db, p.id, true);
    const caja = await saveProduct(db, { name: 'Sin semilla', quality: 'Primera', caliber: '2X', unit: 'caja', priceCents: 45_000, active: true });
    await rejects({ productId: caja.id });
  });

  it('fecha futura o absurda, y textos demasiado largos o con caracteres de control', async () => {
    await rejects({ receivedAt: new Date(Date.now() + 3600_000).toISOString() });
    await rejects({ receivedAt: 'mañana' });
    await rejects({ receivedAt: '1990-01-01T00:00:00.000Z' });
    await rejects({ supplier: 'a'.repeat(121) });
    await rejects({ reference: 'a'.repeat(61) });
    await rejects({ notes: 'a'.repeat(501) });
    await rejects({ notes: `uno${String.fromCharCode(7)}dos` });
    await rejects({ supplier: `ran${String.fromCharCode(0x200b)}cho` });
    await rejects({ packaging: 'tonel' });
    await rejects({ weightMode: 'magia' });
  });

  it('un fallo a mitad de la operación revierte TODO (inventario, movimiento, folio y documento)', async () => {
    // Una recepción "fantasma" ya ocupa el folio 1 → el índice único byFolio hará fallar la escritura final,
    // DESPUÉS de haber movido el inventario dentro de la misma transacción.
    await db.put('receptions', {
      id: 'fantasma', status: 'confirmada', folio: 1, createdAt: '', updatedAt: '', receivedAt: '2026-01-01T00:00:00.000Z',
      day: '2026-01-01', packaging: 'granel', weightMode: 'directo', corrections: [],
    });
    const before = await getProduct(db, p.id);
    await expect(confirmReception(db, direct(100))).rejects.toBeTruthy();
    expect(await getProduct(db, p.id)).toEqual(before); // inventario intacto
    expect(await listStockMoves(db, p.id)).toHaveLength(0); // sin movimiento huérfano
    expect(await listReceptions(db)).toHaveLength(1); // solo la fantasma
    expect(await db.get('meta', 'nextReceptionFolio')).toBeUndefined(); // folio sin avanzar
  });
});

describe('persistencia, ayudas y auditoría', () => {
  it('17. las recepciones sobreviven a cerrar y reabrir la base', async () => {
    const name = db.name;
    const r = await confirmReception(db, direct(75, { supplier: 'Rancho' }));
    await saveReceptionDraft(db, { id: newId(), packaging: 'caja', weightMode: 'por_envase', containers: 5, productId: p.id });
    db.close();
    db = await openDatabase(name);
    expect((await getReception(db, r.id))?.netMilli).toBe(kg(75));
    expect(await listReceptions(db, { status: 'confirmada' })).toHaveLength(1);
    expect(await listReceptions(db, { status: 'borrador' })).toHaveLength(1);
    expect(await phys()).toBe(kg(75));
    expect((await confirmReception(db, direct(1, { supplier: 'x' }))).folio).toBe(2); // el folio continúa
  });

  it('lastUnitNet devuelve el último peso REAL capturado para ESA clasificación y presentación, con su folio', async () => {
    expect(await lastUnitNet(db, 'arpilla', p.id)).toBeUndefined(); // sin historial no se sugiere nada
    const a = await confirmReception(db, { id: newId(), productId: p.id, packaging: 'arpilla', containers: 4, weightMode: 'por_envase', unitNetMilli: kg(14.5) });
    expect(await lastUnitNet(db, 'arpilla', p.id)).toEqual({ unitNetMilli: kg(14.5), folio: a.folio });
    // otra clasificación o presentación: NO se arrastra el valor (las arpillas de otro tipo pesan distinto)
    expect(await lastUnitNet(db, 'arpilla', q.id)).toBeUndefined();
    expect(await lastUnitNet(db, 'caja', p.id)).toBeUndefined();
    // una recepción por kilos netos directos no cuenta como "peso por arpilla"
    await confirmReception(db, { id: newId(), productId: p.id, packaging: 'arpilla', weightMode: 'directo', netDirectMilli: kg(77) });
    expect((await lastUnitNet(db, 'arpilla', p.id))?.unitNetMilli).toBe(kg(14.5));
    // la más reciente gana
    const b = await confirmReception(db, { id: newId(), productId: p.id, packaging: 'arpilla', containers: 2, weightMode: 'por_envase', unitNetMilli: kg(15) });
    expect(await lastUnitNet(db, 'arpilla', p.id)).toEqual({ unitNetMilli: kg(15), folio: b.folio });
    // una recepción anulada ya no sirve de referencia
    await voidReception(db, b.id, 'error');
    expect((await lastUnitNet(db, 'arpilla', p.id))?.unitNetMilli).toBe(kg(14.5));
  });

  it('listReceptions filtra por estado, día y producto', async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    await confirmReception(db, direct(10));
    await confirmReception(db, direct(20, { receivedAt: yesterday.toISOString(), productId: q.id }));
    await saveReceptionDraft(db, { packaging: 'granel', weightMode: 'directo', supplier: 'x' });
    expect(await listReceptions(db)).toHaveLength(3);
    expect(await listReceptions(db, { status: 'confirmada' })).toHaveLength(2);
    expect(await listReceptions(db, { day: localDay(yesterday) })).toHaveLength(1);
    expect(await listReceptions(db, { productId: q.id })).toHaveLength(1);
    expect(await listReceptions(db, { from: localDay(yesterday), to: localDay(yesterday) })).toHaveLength(1);
  });

  it('25. la auditoría detecta recepciones alteradas', async () => {
    const r = await confirmReception(db, direct(100));
    await correctReception(db, r.id, kg(90), 'x');
    const clean = await exportBackup(db);
    const shiftId = (await getCurrentShift(db))?.id;
    expect(auditData(clean, shiftId).issues).toEqual([]);
    const issues = (mut: (b: typeof clean) => void) => {
      const c = structuredClone(clean);
      mut(c);
      return auditData(c, shiftId).issues.join(' | ');
    };
    expect(issues((c) => c.stockMoves.splice(c.stockMoves.findIndex((m) => m.type === 'recepcion'), 1))).toMatch(/exactamente 1 movimiento/);
    expect(issues((c) => (c.stockMoves.find((m) => m.type === 'recepcion')!.deltaMilli += 1))).toMatch(/sumó/);
    expect(issues((c) => (c.receptions[0].netMilli = 1))).toMatch(/vigentes/);
    expect(issues((c) => (c.receptions[0].confirmedNetMilli = 5))).toMatch(/recalculados|sumó/);
    expect(issues((c) => c.stockMoves.splice(c.stockMoves.findIndex((m) => m.type === 'correccion_recepcion'), 1))).toMatch(/correcci/);
    expect(issues((c) => (c.receptions[0].netDirectMilli = 1, c.receptions[0].unitNetMilli = 5))).toMatch(/otro modo/);
    expect(issues((c) => (c.stockMoves.find((m) => m.type === 'recepcion')!.receptionId = 'fantasma'))).toMatch(/no existe/);
    expect(issues((c) => c.receptions.push({ ...c.receptions[0], id: 'dup' }))).toMatch(/Folio de recepción repetido/);
    expect(issues((c) => (c.receptions[0].folio = 99))).toMatch(/siguiente folio/);
    expect(issues((c) => (c.receptions[0].corrections[0].reason = ' '))).toMatch(/sin motivo/);
    // un borrador no puede tener folio ni movimientos de inventario
    expect(issues((c) => (c.receptions[0].status = 'borrador'))).toMatch(/borrador.*(folio|movimientos)/);
  });
});

describe('corrección de datos (sin tocar kilos ni inventario)', () => {
  it('cambia proveedor/referencia/observaciones con motivo y deja el antes y el después', async () => {
    const r = await confirmReception(db, direct(100, { supplier: 'Rancho A', reference: 'CAM-1' }));
    const movesBefore = await listStockMoves(db, p.id);
    const e = await annotateReception(db, r.id, { supplier: ' Rancho  B ', notes: 'llegó con lluvia' }, 'se capturó mal el proveedor');
    expect(e).toMatchObject({ supplier: 'Rancho B', notes: 'llegó con lluvia', reference: 'CAM-1', netMilli: kg(100), confirmedNetMilli: kg(100) });
    expect(e.dataEdits).toHaveLength(1);
    expect(e.dataEdits![0]).toMatchObject({ reason: 'se capturó mal el proveedor' });
    expect(e.dataEdits![0].changes).toEqual([
      { field: 'supplier', before: 'Rancho A', after: 'Rancho B' },
      { field: 'notes', after: 'llegó con lluvia' },
    ]);
    // el inventario no se mueve: mismo movimiento, mismos kilos
    expect(await listStockMoves(db, p.id)).toEqual(movesBefore);
    expect(await phys()).toBe(kg(100));
    // dejar un dato vacío lo quita (y queda registrado)
    const e2 = await annotateReception(db, r.id, { reference: '' }, 'no había referencia');
    expect(e2.reference).toBeUndefined();
    expect(e2.dataEdits).toHaveLength(2);
    expect(e2.dataEdits![1].changes).toEqual([{ field: 'reference', before: 'CAM-1' }]);
    expect((await auditDatabase(db)).issues).toEqual([]);
  });

  it('cambiar la fecha de llegada mueve la recepción de día; el movimiento conserva su hora real de captura', async () => {
    const r = await confirmReception(db, direct(100));
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000);
    const e = await annotateReception(db, r.id, { receivedAt: twoDaysAgo.toISOString() }, 'el camión llegó antier');
    expect(e.day).toBe(localDay(twoDaysAgo));
    expect(e.receivedAt).toBe(twoDaysAgo.toISOString());
    expect(e.dataEdits![0].changes[0]).toMatchObject({ field: 'receivedAt', before: r.receivedAt, after: twoDaysAgo.toISOString() });
    const [move] = await listMovesForReception(db, r.id);
    expect(move.createdAt).toBe(r.confirmedAt);
    expect((await auditDatabase(db)).issues).toEqual([]);
  });

  it('cantidad de envases: se corrige si es solo informativa; no si define los kilos', async () => {
    const info = await confirmReception(db, { id: newId(), productId: p.id, packaging: 'arpilla', weightMode: 'directo', netDirectMilli: kg(150), containers: 9 });
    const e = await annotateReception(db, info.id, { containers: 10 }, 'eran 10');
    expect(e.containers).toBe(10);
    expect(e.netMilli).toBe(kg(150)); // los kilos NO se recalculan
    expect((await annotateReception(db, info.id, { containers: null }, 'sin conteo')).containers).toBeUndefined();

    const calc = await confirmReception(db, { id: newId(), productId: p.id, packaging: 'arpilla', containers: 10, weightMode: 'por_envase', unitNetMilli: kg(16) });
    await expect(annotateReception(db, calc.id, { containers: 11 }, 'x')).rejects.toBeInstanceOf(ReceptionValidationError);
    await expect(annotateReception(db, calc.id, { containers: null }, 'x')).rejects.toBeInstanceOf(ReceptionValidationError);
    expect((await getReception(db, calc.id))?.containers).toBe(10);
    expect(await phys()).toBe(kg(150) + kg(160));
  });

  it('exige motivo, algún cambio real y datos válidos; solo para recepciones confirmadas', async () => {
    const r = await confirmReception(db, direct(100, { supplier: 'A' }));
    await expect(annotateReception(db, r.id, { supplier: 'B' }, '  ')).rejects.toThrow(/motivo/);
    await expect(annotateReception(db, r.id, { supplier: 'A' }, 'igual')).rejects.toThrow(/No hay cambios/);
    await expect(annotateReception(db, r.id, {}, 'nada')).rejects.toThrow(/No hay cambios/);
    await expect(annotateReception(db, r.id, { receivedAt: new Date(Date.now() + 3600_000).toISOString() }, 'x')).rejects.toBeInstanceOf(ReceptionValidationError);
    await expect(annotateReception(db, r.id, { receivedAt: 'mañana' }, 'x')).rejects.toBeInstanceOf(ReceptionValidationError);
    await expect(annotateReception(db, r.id, { supplier: 'a'.repeat(121) }, 'x')).rejects.toBeInstanceOf(ReceptionValidationError);
    await expect(annotateReception(db, r.id, { notes: `a${String.fromCharCode(7)}b` }, 'x')).rejects.toBeInstanceOf(ReceptionValidationError);
    await expect(annotateReception(db, r.id, { containers: 3 }, 'x')).rejects.toBeInstanceOf(ReceptionValidationError); // a granel
    await expect(annotateReception(db, 'no-existe', { supplier: 'B' }, 'x')).rejects.toThrow(/no encontrada/);
    const d = await saveReceptionDraft(db, { id: newId(), packaging: 'granel', weightMode: 'directo', supplier: 'x' });
    await expect(annotateReception(db, d.id, { supplier: 'B' }, 'x')).rejects.toThrow(/confirmadas/);
    await voidReception(db, r.id, 'error');
    await expect(annotateReception(db, r.id, { supplier: 'B' }, 'x')).rejects.toThrow(/confirmadas/);
    expect((await getReception(db, r.id))?.dataEdits).toBeUndefined();
  });
});

describe('anular y copiar a borrador (clasificación equivocada)', () => {
  const arpilla = () => ({
    id: newId(), productId: p.id, packaging: 'arpilla' as const, containers: 10, weightMode: 'por_envase' as const,
    unitNetMilli: kg(15), supplier: 'Rancho Sol', reference: 'CAM-1', notes: 'obs',
  });

  it('en una sola operación anula la recepción y deja un borrador con los mismos datos y SIN clasificación', async () => {
    const r = await confirmReception(db, arpilla());
    const { voided, draft } = await voidAndCopyToDraft(db, r.id, 'era Con semilla');
    expect(voided).toMatchObject({ id: r.id, status: 'anulada', netMilli: 0 });
    expect(await phys()).toBe(0);
    expect(draft).toMatchObject({
      status: 'borrador', packaging: 'arpilla', containers: 10, unitNetMilli: kg(15), supplier: 'Rancho Sol',
      reference: 'CAM-1', receivedAt: r.receivedAt,
    });
    expect(draft.id).not.toBe(r.id);
    expect(draft.productId).toBeUndefined();
    expect(draft.folio).toBeUndefined();
    expect(draft.notes).toMatch(/obs/);
    expect(draft.notes).toMatch(/Copia de R-1/);
    // completar el borrador con la clasificación correcta registra los kilos una sola vez
    const ok = await confirmReception(db, { ...receptionToFields(draft), productId: q.id });
    expect(ok).toMatchObject({ status: 'confirmada', netMilli: kg(150), folio: 2 });
    expect(await phys(q)).toBe(kg(150));
    expect(await phys()).toBe(0);
    expect((await auditDatabase(db)).issues).toEqual([]);
  });

  it('es atómico: si la anulación necesita autorización no queda ni borrador ni cambios', async () => {
    const r = await confirmReception(db, arpilla());
    await createSale(db, { cart: addLine([], p, kg(100)), paymentMethod: 'tarjeta', receivedCents: 0 });
    const err = await voidAndCopyToDraft(db, r.id, 'error').catch((e) => e);
    expect(err).toBeInstanceOf(NegativeStockError);
    expect(err.availableAfterMilli).toBe(-kg(100));
    expect(await listReceptions(db, { status: 'borrador' })).toHaveLength(0);
    expect((await getReception(db, r.id))?.status).toBe('confirmada');
    expect(await phys()).toBe(kg(50));
    // con autorización explícita sí se anula y se copia
    const ok = await voidAndCopyToDraft(db, r.id, 'error', true);
    expect(ok.voided.status).toBe('anulada');
    expect(await phys()).toBe(-kg(100));
    expect(await listReceptions(db, { status: 'borrador' })).toHaveLength(1);
  });

  it('exige motivo y una recepción confirmada', async () => {
    const r = await confirmReception(db, arpilla());
    await expect(voidAndCopyToDraft(db, r.id, ' ')).rejects.toThrow(/motivo/);
    await expect(voidAndCopyToDraft(db, 'no-existe', 'x')).rejects.toThrow(/no encontrada/);
    await voidReception(db, r.id, 'ya');
    await expect(voidAndCopyToDraft(db, r.id, 'otra vez')).rejects.toThrow(/confirmadas/);
    expect(await listReceptions(db, { status: 'borrador' })).toHaveLength(0);
  });
});

describe('avisos que hay que reconocer y errores tipados', () => {
  it('corregir a la baja o anular con mercancía vendida lanza NegativeStockError con el disponible resultante', async () => {
    const r = await confirmReception(db, direct(100));
    await createSale(db, { cart: addLine([], p, kg(80)), paymentMethod: 'tarjeta', receivedCents: 0 });
    const c = await correctReception(db, r.id, kg(50), 'error').catch((e) => e);
    expect(c).toBeInstanceOf(NegativeStockError);
    expect(c.availableAfterMilli).toBe(-kg(30));
    const v = await voidReception(db, r.id, 'error').catch((e) => e);
    expect(v).toBeInstanceOf(NegativeStockError);
    expect(v.availableAfterMilli).toBe(-kg(80));
    expect(v.message).toMatch(/Se requiere autorización/);
    expect(await phys()).toBe(kg(20));
  });

  it('un conteo físico posterior a la llegada avisa que esos kilos podrían estar ya contados', async () => {
    await addStockMove(db, p.id, 'ajuste', kg(200), 'conteo del día');
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const input = direct(100, { receivedAt: yesterday });
    const err = await confirmReception(db, input).catch((e) => e);
    expect(err).toBeInstanceOf(PossibleDuplicateReceptionError);
    expect(err.warnings.join(' ')).toMatch(/conteo físico/);
    expect(err.matches).toHaveLength(0);
    expect(await phys()).toBe(kg(200));
    const ok = await confirmReception(db, input, { acknowledgeDuplicate: true });
    expect(ok.status).toBe('confirmada');
    expect(await phys()).toBe(kg(300));
    // llegada de HOY (después del conteo): sin aviso
    await expect(confirmReception(db, direct(7))).resolves.toBeTruthy();
  });

  it('una entrada manual de los mismos kilos en las últimas 24 h avisa; con otros kilos no', async () => {
    await addStockMove(db, p.id, 'entrada', kg(100), 'bajé del camión');
    const input = direct(100);
    const err = await confirmReception(db, input).catch((e) => e);
    expect(err).toBeInstanceOf(PossibleDuplicateReceptionError);
    expect(err.warnings.join(' ')).toMatch(/entrada manual/);
    expect(await phys()).toBe(kg(100));
    await expect(confirmReception(db, direct(101))).resolves.toBeTruthy();
    await expect(confirmReception(db, input, { acknowledgeDuplicate: true })).resolves.toBeTruthy();
    expect(await phys()).toBe(kg(301));
  });

  it('el movimiento de inventario tiene id determinista rcp:<id>:in y enlaza ambos sentidos', async () => {
    const input = direct(40);
    const r = await confirmReception(db, input);
    expect(r.stockMoveId).toBe(`rcp:${input.id}:in`);
    const [m] = await listStockMoves(db, p.id);
    expect(m).toMatchObject({ id: `rcp:${input.id}:in`, receptionId: input.id, type: 'recepcion' });
    const c = await correctReception(db, r.id, kg(41), 'x');
    expect(c.corrections[0].stockMoveId).toBe(`rcp:${input.id}:c1`);
    const v = await voidReception(db, r.id, 'y');
    expect(v.voidStockMoveId).toBe(`rcp:${input.id}:void`);
  });

  it('20 confirmaciones simultáneas del mismo id suman una vez; con ids distintos, cada una suma la suya', async () => {
    const same = direct(25);
    const a = await Promise.allSettled(Array.from({ length: 20 }, () => confirmReception(db, same)));
    expect(a.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await phys()).toBe(kg(25));
    const many = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => confirmReception(db, direct(10 + i * 3, { supplier: `P${i}` }))),
    );
    expect(many.filter((x) => x.status === 'fulfilled')).toHaveLength(5);
    expect(await phys()).toBe(kg(25) + kg(10 + 13 + 16 + 19 + 22));
    expect((await auditDatabase(db)).issues).toEqual([]);
    const folios = (await listReceptions(db, { status: 'confirmada' })).map((r) => r.folio).sort((x, y) => x! - y!);
    expect(folios).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('el borrador se lee dentro de la transacción: se confirma lo último que se guardó', async () => {
    const id = newId();
    await saveReceptionDraft(db, { id, productId: p.id, packaging: 'granel', weightMode: 'directo', netDirectMilli: kg(10) });
    await saveReceptionDraft(db, { id, productId: p.id, packaging: 'granel', weightMode: 'directo', netDirectMilli: kg(12) });
    const r = await confirmReceptionDraft(db, id);
    expect(r.netMilli).toBe(kg(12));
    expect(await phys()).toBe(kg(12));
  });

  it('si entre el borrador y la confirmación la variedad se ocultó o cambió de unidad, no entra nada', async () => {
    const d = await saveReceptionDraft(db, { id: newId(), productId: p.id, packaging: 'granel', weightMode: 'directo', netDirectMilli: kg(10) });
    await setProductActive(db, p.id, false);
    await expect(confirmReceptionDraft(db, d.id)).rejects.toThrow(/oculto/);
    expect(await phys()).toBe(0);
    await setProductActive(db, p.id, true);
    expect((await confirmReceptionDraft(db, d.id)).status).toBe('confirmada');
    expect(await phys()).toBe(kg(10));
  });

  it('un movimiento enlazado impide cambiar la unidad de la clasificación', async () => {
    await confirmReception(db, direct(10));
    await expect(
      saveProduct(db, { id: p.id, name: p.name, quality: 'Primera', caliber: '2X', unit: 'caja', priceCents: 3000, active: true }),
    ).rejects.toThrow(/unidad/i);
    expect((await getProduct(db, p.id))!.unit).toBe('kg');
  });
});
