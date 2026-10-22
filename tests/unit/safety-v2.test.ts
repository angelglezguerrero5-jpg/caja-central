import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditData, auditDatabase } from '../../src/db/audit';
import { SPECS, validateBackup } from '../../src/db/backup';
import {
  DuplicateReceptionError,
  ReceptionIdConflictError,
  ReceptionWarningError,
  annotateReception,
  cancelReceptionDraft,
  confirmReception,
  correctReception,
  listMovesForReception,
  listReceptions,
  previewReceptionWarnings,
  saveReceptionDraft,
  voidAndCopyToDraft,
  voidReception,
} from '../../src/db/receptions';
import {
  ManualEntryWarningError,
  NegativeStockError,
  addCashOut,
  addStockMove,
  cancelVale,
  closeShift,
  createSale,
  deliverVale,
  exportBackup,
  getProduct,
  importBackup,
  listStockMoves,
  newId,
  openDatabase,
  openShift,
  saveProduct,
  setOpeningCash,
  setProductActive,
  voidSale,
  type DB,
} from '../../src/db/repo';
import { addLine } from '../../src/domain/cart';
import {
  HIST_MONEY_CENTS,
  HIST_PRICE_CENTS,
  HIST_QTY_MILLI,
  MAX_MONEY_CENTS,
  MAX_PRICE_CENTS,
  MAX_QTY_MILLI,
  MAX_STOCK_MILLI,
  ambiguousNumberHint,
  isAmbiguousNumber,
  parseCount,
  parseMoney,
  parseQty,
} from '../../src/domain/money';
import { MAX_CONTAINERS, MAX_WEIGHINGS } from '../../src/domain/reception';
import type { Backup, CashMovement, Product, Reception, Sale, Shift, StockMove } from '../../src/domain/types';

const kg = (n: number) => Math.round(n * 1000);
const long = (n: number) => 'x'.repeat(n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let db: DB;
let p: Product;
let q: Product;

beforeEach(async () => {
  db = await openDatabase(`sf-${newId()}`);
  p = await saveProduct(db, { name: 'Sin semilla', quality: 'Primera', caliber: '2X', unit: 'kg', priceCents: 3000, active: true });
  q = await saveProduct(db, { name: 'Con semilla', origin: 'Oaxaca', unit: 'kg', priceCents: 2500, active: true });
});
afterEach(() => db.close());

const phys = async (prod = p) => (await getProduct(db, prod.id))!.physicalMilli;
const direct = (n: number, extra: Record<string, unknown> = {}) => ({
  id: newId(), productId: p.id, packaging: 'granel' as const, weightMode: 'directo' as const, netDirectMilli: kg(n), ...extra,
});
const sell = (qtyKg: number, extra: Record<string, unknown> = {}) =>
  createSale(db, { cart: addLine([], p, kg(qtyKg)), paymentMethod: 'tarjeta', receivedCents: 0, ...extra });

describe('existencia negativa: la autorización queda acotada y registrada', () => {
  it('anular con ventas posteriores: sin autorización falla; con el disponible que se le mostró pasa y queda registrado', async () => {
    const r = await confirmReception(db, direct(100));
    await sell(80);
    const err = await voidReception(db, r.id, 'error').catch((e) => e);
    expect(err).toBeInstanceOf(NegativeStockError);
    expect(err.availableAfterMilli).toBe(-kg(80));
    expect(await phys()).toBe(kg(20));
    const v = await voidReception(db, r.id, 'error', err.availableAfterMilli);
    expect(v.status).toBe('anulada');
    const move = (await listMovesForReception(db, r.id)).find((m) => m.type === 'reversa_recepcion')!;
    expect(move.authorizedNegativeAfterMilli).toBe(-kg(80));
    expect((await auditDatabase(db)).issues).toEqual([]);
  });

  it('si entre el aviso y la autorización otra venta empeora el resultado, la autorización ya no cubre', async () => {
    const r = await confirmReception(db, direct(100));
    await sell(80);
    const shown = (await voidReception(db, r.id, 'error').catch((e) => e)) as NegativeStockError;
    await sell(50, { allowNegativeStock: true }); // otra ventana vende mientras se decidía: físico −30
    const again = await voidReception(db, r.id, 'error', shown.availableAfterMilli).catch((e) => e);
    expect(again).toBeInstanceOf(NegativeStockError);
    expect(again.availableAfterMilli).toBe(-kg(130)); // lo nuevo, para que se decida con la cifra real
    expect(await phys()).toBe(-kg(30)); // nada cambió
    expect((await getProduct(db, p.id))!.physicalMilli).toBe(-kg(30));
    expect((await voidReception(db, r.id, 'error', true)).status).toBe('anulada'); // true = autoriza cualquier resultado
  });

  it('corregir a la baja y las mermas registran el negativo autorizado; un positivo nunca lleva la marca', async () => {
    const r = await confirmReception(db, direct(100));
    await sell(80);
    const c = await correctReception(db, r.id, kg(50), 'error', -kg(30));
    expect(c.netMilli).toBe(kg(50));
    const moves = await listMovesForReception(db, r.id);
    expect(moves.find((m) => m.type === 'correccion_recepcion')?.authorizedNegativeAfterMilli).toBe(-kg(30));
    expect(moves.find((m) => m.type === 'recepcion')?.authorizedNegativeAfterMilli).toBeUndefined();
    // merma: físico −30 → −40 con piso −40
    await expect(addStockMove(db, p.id, 'merma', kg(10), 'podrido')).rejects.toBeInstanceOf(NegativeStockError);
    await addStockMove(db, p.id, 'merma', kg(10), 'podrido', -kg(40));
    const last = (await listStockMoves(db, p.id, 1))[0];
    expect(last).toMatchObject({ type: 'merma', authorizedNegativeAfterMilli: -kg(40) });
    expect((await auditDatabase(db)).issues).toEqual([]);
  });
});

describe('corregir o anular después de un conteo físico exige reconocer el aviso', () => {
  it('lo reconocido queda registrado en la recepción; sin reconocer no cambia nada', async () => {
    const r = await confirmReception(db, direct(100));
    await sleep(5);
    await addStockMove(db, p.id, 'ajuste', kg(95), 'conteo del día');
    const e1 = await correctReception(db, r.id, kg(90), 'x').catch((e) => e);
    expect(e1).toBeInstanceOf(ReceptionWarningError);
    expect(e1.warnings[0]).toMatch(/conteo físico/);
    expect(await phys()).toBe(kg(95));
    const ok = await correctReception(db, r.id, kg(90), 'x', false, true);
    expect(ok.acknowledged).toHaveLength(1);
    expect(ok.acknowledged![0]).toMatchObject({ op: 'corregir' });
    expect(ok.acknowledged![0].warnings[0]).toMatch(/conteo físico/);
    expect(await phys()).toBe(kg(85));

    // (el negativo se evalúa primero: aquí ya se autoriza para que aparezca el aviso del conteo)
    const e2 = await voidReception(db, r.id, 'y', true).catch((e) => e);
    expect(e2).toBeInstanceOf(ReceptionWarningError);
    const v = await voidReception(db, r.id, 'y', true, true);
    expect(v.acknowledged!.map((a) => a.op)).toEqual(['corregir', 'anular']);
    expect((await auditDatabase(db)).issues).toEqual([]);
  });

  it('anular y copiar a borrador tampoco crea nada si falta reconocer el aviso', async () => {
    const r = await confirmReception(db, direct(100));
    await sleep(5);
    await addStockMove(db, p.id, 'merma', kg(1), 'podrido');
    await expect(voidAndCopyToDraft(db, r.id, 'equivocada', true)).rejects.toBeInstanceOf(ReceptionWarningError);
    expect(await listReceptions(db, { status: 'borrador' })).toHaveLength(0);
    expect((await listReceptions(db, { status: 'confirmada' }))).toHaveLength(1);
    const ok = await voidAndCopyToDraft(db, r.id, 'equivocada', true, true);
    expect(ok.draft.status).toBe('borrador');
    expect(ok.voided.acknowledged).toHaveLength(1);
  });

  it('un conteo ANTERIOR a la recepción no avisa', async () => {
    await addStockMove(db, p.id, 'ajuste', kg(10), 'conteo previo');
    await sleep(5);
    const r = await confirmReception(db, direct(100));
    await expect(correctReception(db, r.id, kg(90), 'x')).resolves.toBeTruthy();
  });
});

describe('el mismo id con otro contenido es un conflicto, no un reintento', () => {
  it('idéntico = idempotente; distinto producto, presentación o kilos = ReceptionIdConflictError', async () => {
    const input = direct(80);
    const first = await confirmReception(db, input);
    await expect(confirmReception(db, input)).rejects.toBeInstanceOf(DuplicateReceptionError);
    for (const change of [{ netDirectMilli: kg(90) }, { productId: q.id }, { packaging: 'caja' as const }, { weightMode: 'bruto_tara' as const, grossMilli: kg(90), tareMilli: kg(10), netDirectMilli: undefined }]) {
      const err = await confirmReception(db, { ...input, ...change }).catch((e) => e);
      expect(err, JSON.stringify(change)).toBeInstanceOf(ReceptionIdConflictError);
      expect(err.reception.folio).toBe(first.folio);
      expect(err.reception.confirmedNetMilli).toBe(kg(80)); // se muestra lo GUARDADO, no lo escrito
    }
    expect(await phys()).toBe(kg(80));
    expect(await phys(q)).toBe(0);
    // lo escrito se puede registrar como una recepción nueva
    const fresh = await confirmReception(db, { ...input, id: newId(), netDirectMilli: kg(90) });
    expect(fresh.folio).toBe(2);
    expect(await phys()).toBe(kg(170));
  });
});

describe('todo lo escribible se puede restaurar (simetría escritura ↔ respaldo)', () => {
  const NAMES: Array<[string, (t: string) => Promise<unknown>, number]> = [];

  it('cada ruta de escritura acepta el máximo y rechaza un carácter de más; el respaldo resultante se valida', async () => {
    await openShift(db, 10_000);
    const r = await confirmReception(db, direct(100, { supplier: long(120), reference: long(60), notes: long(500) }));
    await correctReception(db, r.id, kg(90), long(300));
    await annotateReception(db, r.id, { notes: `${long(499)}y`, supplier: `${long(119)}y` }, long(300));
    await sleep(5);
    await addStockMove(db, p.id, 'merma', kg(1), long(300));
    await addStockMove(db, p.id, 'ajuste', kg(50), long(300));
    await addStockMove(db, p.id, 'entrada', kg(5), long(300), false, true);
    await addCashOut(db, 1000, long(120));
    const vale = await sell(1, { customerName: long(120), isVale: true, allowNegativeStock: true });
    await cancelVale(db, vale.id, long(300), 'ninguna');
    const s2 = await sell(1, { allowNegativeStock: true });
    await voidSale(db, s2.id, long(300));
    const draft = await saveReceptionDraft(db, { id: newId(), packaging: 'granel', weightMode: 'directo', supplier: 'x' });
    await cancelReceptionDraft(db, draft.id, long(300));
    const r3 = await confirmReception(db, direct(7, { supplier: 'otro' }));
    await sleep(5);
    await addStockMove(db, p.id, 'ajuste', kg(60), 'otro conteo');
    await voidReception(db, r3.id, long(300), true, true);
    await voidAndCopyToDraft(db, (await confirmReception(db, direct(9, { supplier: 'z' }))).id, long(300), true, true).catch(() => undefined);

    const backup = await exportBackup(db);
    expect(() => validateBackup(JSON.parse(JSON.stringify(backup)))).not.toThrow();

    // un carácter de más se rechaza al ESCRIBIR (nunca llega a la base)
    const rr = (await listReceptions(db, { status: 'confirmada' }))[0];
    const over = long(301);
    const attempts: Array<[string, Promise<unknown>]> = [
      ['corrección', correctReception(db, rr.id, kg(1), over)],
      ['anulación', voidReception(db, rr.id, over)],
      ['anular y copiar', voidAndCopyToDraft(db, rr.id, over)],
      ['corrección de datos', annotateReception(db, rr.id, { notes: 'a' }, over)],
      ['merma', addStockMove(db, p.id, 'merma', 1, over)],
      ['conteo', addStockMove(db, p.id, 'ajuste', 1, over)],
      ['entrada', addStockMove(db, p.id, 'entrada', 1, over, false, true)],
      ['salida de efectivo', addCashOut(db, 100, long(121))],
      ['cliente', sell(1, { customerName: long(121), allowNegativeStock: true })],
      ['cancelar vale', cancelVale(db, vale.id, over, 'ninguna')],
      ['anular venta', voidSale(db, s2.id, over)],
      ['descartar borrador', cancelReceptionDraft(db, draft.id, over)],
    ];
    for (const [label, promise] of attempts) {
      await expect(promise, label).rejects.toThrow(/máximo|ya |solo |no ha|no se|Recepción|vale|venta|turno/i);
    }
    void NAMES;
  });

  it('caracteres invisibles o de control en cualquier motivo se rechazan', async () => {
    const r = await confirmReception(db, direct(100));
    const bell = String.fromCharCode(7);
    const zw = String.fromCharCode(0x200b);
    await expect(correctReception(db, r.id, kg(90), `a${bell}b`)).rejects.toThrow(/no permitidos/);
    await expect(voidReception(db, r.id, `a${zw}b`)).rejects.toThrow(/no permitidos/);
    await expect(addStockMove(db, p.id, 'merma', 1, `a${zw}b`)).rejects.toThrow(/no permitidos/);
    await expect(addCashOut(db, 100, `a${bell}`)).rejects.toThrow(/no permitidos/);
    // saltos de línea y espacios múltiples se normalizan (no se rechazan)
    const ok = await correctReception(db, r.id, kg(90), '  uno\n\n  dos  ');
    expect(ok.corrections[0].reason).toBe('uno dos');
  });
});

describe('entrada manual frente a una recepción reciente', () => {
  it('avisa (posible doble conteo) y se reconoce; sin recepción reciente, de otra clasificación o de >24 h, no', async () => {
    await confirmReception(db, direct(100));
    const e = await addStockMove(db, p.id, 'entrada', kg(100)).catch((x) => x);
    expect(e).toBeInstanceOf(ManualEntryWarningError);
    expect(e.receptions).toHaveLength(1);
    expect(await phys()).toBe(kg(100));
    await addStockMove(db, p.id, 'entrada', kg(100), '', false, true);
    expect(await phys()).toBe(kg(200));
    await expect(addStockMove(db, q.id, 'entrada', kg(5))).resolves.toBeTruthy(); // otra clasificación sin recepciones
    // una recepción de hace más de 24 h ya no cuenta
    const old = await confirmReception(db, direct(7, { productId: q.id }));
    await db.put('receptions', { ...old, confirmedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() });
    await expect(addStockMove(db, q.id, 'entrada', kg(1))).resolves.toBeTruthy();
    // mermas y conteos nunca avisan por esto
    await confirmReception(db, direct(3, { supplier: 'nueva' }));
    await expect(addStockMove(db, p.id, 'merma', kg(1), 'podrido')).resolves.toBeTruthy();
  });

  it('un producto que NO se vende por kg no avisa', async () => {
    const caja = await saveProduct(db, { name: 'Sin semilla', quality: 'Primera', caliber: '2X', unit: 'caja', priceCents: 45_000, active: true });
    await expect(addStockMove(db, caja.id, 'entrada', 5000)).resolves.toBeTruthy();
  });
});

describe('bitácora de la clasificación de un producto', () => {
  it('editar cómo se llama deja antes → después; cambiar el precio, ocultar o repetir lo mismo no; sobrevive al respaldo', async () => {
    const x = await saveProduct(db, { name: 'Persa', unit: 'kg', priceCents: 3000, active: true });
    expect(x.classEdits).toBeUndefined();
    const y = await saveProduct(db, { id: x.id, name: 'Persa', quality: 'Primera', unit: 'kg', priceCents: 3000, active: true });
    expect(y.classEdits).toHaveLength(1);
    expect(y.classEdits![0]).toMatchObject({ before: { variety: 'Persa' }, after: { variety: 'Persa', quality: 'Primera' } });
    const z = await saveProduct(db, { id: x.id, name: 'Persa', quality: 'Primera', unit: 'kg', priceCents: 3500, active: true });
    expect(z.classEdits).toHaveLength(1); // solo cambió el precio
    const same = await saveProduct(db, { id: x.id, name: 'Persa', quality: 'primera', unit: 'kg', priceCents: 3500, active: true });
    expect(same.classEdits).toHaveLength(1); // misma clasificación (se conserva la escritura ya usada)
    const w = await saveProduct(db, { id: x.id, name: 'Persa', quality: 'Primera', caliber: '2X', unit: 'kg', priceCents: 3500, active: true });
    expect(w.classEdits).toHaveLength(2);
    expect((await setProductActive(db, x.id, false)).classEdits).toHaveLength(2);
    const rt = validateBackup(JSON.parse(JSON.stringify(await exportBackup(db))));
    expect(rt.products.find((pp) => pp.id === x.id)!.classEdits).toEqual(w.classEdits);
  });
});

describe('topes numéricos de escritura', () => {
  it('dinero: efectivo recibido, fondo, contado y salidas por encima del tope se rechazan', async () => {
    await expect(openShift(db, MAX_MONEY_CENTS + 1)).rejects.toThrow(/inválido/);
    const shift = await openShift(db, MAX_MONEY_CENTS);
    await expect(setOpeningCash(db, shift.id, MAX_MONEY_CENTS + 1)).rejects.toThrow(/inválido/);
    await expect(addCashOut(db, MAX_MONEY_CENTS + 1, 'x')).rejects.toThrow(/demasiado grande/);
    await expect(createSale(db, { cart: addLine([], p, kg(1)), paymentMethod: 'efectivo', receivedCents: MAX_MONEY_CENTS + 1, allowNegativeStock: true })).rejects.toThrow(/demasiado grande/);
    await expect(closeShift(db, MAX_MONEY_CENTS + 1)).rejects.toThrow(/inválido/);
    expect((await closeShift(db, MAX_MONEY_CENTS)).countedCashCents).toBe(MAX_MONEY_CENTS);
  });

  it('inventario: ningún movimiento puede llevar el saldo más allá del máximo', async () => {
    await db.put('products', { ...(await getProduct(db, p.id))!, physicalMilli: MAX_STOCK_MILLI - 10 });
    await expect(addStockMove(db, p.id, 'entrada', 100, '', false, true)).rejects.toThrow(/máximo/);
    await expect(confirmReception(db, { ...direct(0), netDirectMilli: 100 })).rejects.toThrow(/máximo/);
    expect(await phys()).toBe(MAX_STOCK_MILLI - 10);
    expect(await listReceptions(db)).toHaveLength(0);
    await expect(addStockMove(db, p.id, 'entrada', 5, '', false, true)).resolves.toBeTruthy(); // justo debajo del tope sí
  });
});

describe('un respaldo no puede traer lo que la escritura rechaza', () => {
  async function dataset(): Promise<Backup> {
    await openShift(db, 5000);
    const r = await confirmReception(db, direct(100, { supplier: 'S', packaging: 'arpilla', containers: 7, weighingsMilli: [kg(60), kg(40)] }));
    await annotateReception(db, r.id, { containers: 8 }, 'conteo');
    await sell(10);
    return JSON.parse(JSON.stringify(await exportBackup(db)));
  }
  const bad = (b: Backup, mutate: (x: any) => void) => {
    const c = structuredClone(b);
    mutate(c);
    return () => validateBackup(c);
  };

  it('números fuera de rango', async () => {
    const b = await dataset();
    expect(() => validateBackup(b)).not.toThrow();
    // Dinero, precios y cantidades de ventas: el tope es el HISTÓRICO (lo que la versión 1 pudo guardar), no el de captura.
    expect(bad(b, (x) => (x.products[0].priceCents = HIST_PRICE_CENTS + 1))).toThrow(/producto nº 1/);
    expect(bad(b, (x) => (x.products[0].physicalMilli = MAX_STOCK_MILLI + 1))).toThrow(/producto nº 1/);
    expect(bad(b, (x) => (x.sales[0].items[0].qtyMilli = HIST_QTY_MILLI + 1))).toThrow(/venta nº 1/);
    expect(bad(b, (x) => (x.sales[0].totalCents = HIST_MONEY_CENTS + 1))).toThrow(/venta nº 1/);
    expect(bad(b, (x) => (x.shifts[0].openingCashCents = HIST_MONEY_CENTS + 1))).toThrow(/turno nº 1/);
    expect(bad(b, (x) => (x.stockMoves[0].deltaMilli = MAX_STOCK_MILLI + 1))).toThrow(/movimiento de inventario nº 1/);
    expect(bad(b, (x) => (x.receptions[0].containers = MAX_CONTAINERS + 1))).toThrow(/recepción nº 1/);
    expect(bad(b, (x) => (x.receptions[0].weighingsMilli = Array(MAX_WEIGHINGS + 1).fill(1)))).toThrow(/recepción nº 1/);
    expect(bad(b, (x) => (x.nextFolio = 1_000_000_002))).toThrow(/folio/);
  });

  it('lo que la versión 1 dejó guardar por encima de los topes de captura SE restaura (con aviso en la auditoría)', async () => {
    const b = await dataset();
    // v1 no tenía topes: 1 000 000 kg tecleados por error, un precio de $2 000 000 y un efectivo de $5 000 000 000.
    const c = structuredClone(b);
    c.sales[0].items[0].qtyMilli = 1_000_000_000;
    c.sales[0].items[0].unitPriceCents = 200_000_000;
    c.sales[0].receivedCents = 500_000_000_000;
    c.products[0].priceCents = 200_000_000;
    expect(1_000_000_000).toBeGreaterThan(MAX_QTY_MILLI);
    expect(200_000_000).toBeGreaterThan(MAX_PRICE_CENTS);
    expect(500_000_000_000).toBeGreaterThan(MAX_MONEY_CENTS);
    const restored = validateBackup(JSON.parse(JSON.stringify(c)));
    expect(restored.sales[0].items[0].qtyMilli).toBe(1_000_000_000);
    // …y se puede escribir en la base y volver a exportar tal cual.
    await importBackup(db, restored);
    expect((await exportBackup(db)).sales[0].items[0].qtyMilli).toBe(1_000_000_000);
    // La auditoría no lo oculta: lo avisa (el historial no se reescribe).
    const out = auditData(restored);
    expect(out.warnings.join(' | ')).toMatch(/por encima de lo que hoy se permite capturar/);
    expect(out.warnings.join(' | ')).toMatch(/precio por encima/);
  });

  it('fechas: solo el formato ISO que escribe la app', async () => {
    const b = await dataset();
    for (const v of ['5', '2026', '10/10/2026', '2026-10-10', '2026-10-10T10:00:00Z', '2026-10-10T10:00:00.000+00:00', '2026-02-31T10:00:00.000Z', 'mañana']) {
      expect(bad(b, (x) => (x.sales[0].createdAt = v)), v).toThrow(/venta nº 1/);
      expect(bad(b, (x) => (x.stockMoves[0].createdAt = v)), v).toThrow(/movimiento de inventario nº 1/);
    }
  });

  it('el esquema cubre TODOS los campos de cada tipo (si se agrega un campo al tipo y no al esquema, esto falla)', () => {
    const product: Record<keyof Product, true> = {
      id: true, name: true, quality: true, origin: true, caliber: true, unit: true, priceCents: true, active: true, sort: true,
      physicalMilli: true, reservedMilli: true, updatedAt: true, classEdits: true,
    };
    const sale: Record<keyof Sale, true> = {
      id: true, folio: true, createdAt: true, day: true, shiftId: true, items: true, totalCents: true, paymentMethod: true,
      receivedCents: true, changeCents: true, status: true, delivery: true, valeFolio: true, customerName: true, deliveredAt: true,
      stockOverride: true, cancelReason: true, cancelledAt: true, refundMethod: true, refundCents: true, voidReason: true, voidedAt: true,
    };
    const shift: Record<keyof Shift, true> = {
      id: true, openedAt: true, openingCashCents: true, closedAt: true, countedCashCents: true, expectedCashCents: true, differenceCents: true,
    };
    const cash: Record<keyof CashMovement, true> = { id: true, shiftId: true, createdAt: true, type: true, amountCents: true, concept: true, saleId: true };
    const move: Record<keyof StockMove, true> = {
      id: true, productId: true, createdAt: true, type: true, deltaMilli: true, reservedDeltaMilli: true, note: true, saleId: true,
      receptionId: true, authorizedNegativeAfterMilli: true,
    };
    const reception: Record<keyof Reception, true> = {
      id: true, folio: true, status: true, createdAt: true, updatedAt: true, receivedAt: true, day: true, supplier: true, reference: true,
      notes: true, productId: true, productLabel: true, cls: true, packaging: true, containers: true, weightMode: true, netDirectMilli: true,
      weighingsMilli: true, unitNetMilli: true, grossMilli: true, tareMilli: true, netMilli: true, confirmedAt: true, confirmedNetMilli: true,
      stockMoveId: true, corrections: true, dataEdits: true, acknowledged: true, cancelledAt: true, cancelReason: true, voidedAt: true,
      voidReason: true, voidStockMoveId: true,
    };
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(SPECS.product)).toEqual(keys(product));
    expect(keys(SPECS.sale)).toEqual(keys(sale));
    expect(keys(SPECS.shift)).toEqual(keys(shift));
    expect(keys(SPECS.cashMovement)).toEqual(keys(cash));
    expect(keys(SPECS.stockMove)).toEqual(keys(move));
    expect(keys(SPECS.reception)).toEqual(keys(reception));
  });

  it('un conjunto con TODOS los campos opcionales poblados hace ida y vuelta idéntico (export → validar → importar → export)', async () => {
    // Producto con bitácora de clasificación
    const x = await saveProduct(db, { name: 'Persa', unit: 'kg', priceCents: 3000, active: true });
    await saveProduct(db, { id: x.id, name: 'Persa', origin: 'Oaxaca', quality: 'Primera', caliber: '2X', unit: 'kg', priceCents: 3000, active: true });
    const shift = await openShift(db, 20_000);
    // Recepciones: una con todo, una anulada con aviso reconocido, un borrador y uno descartado
    const full = await confirmReception(db, {
      id: newId(), productId: x.id, packaging: 'arpilla', containers: 7, weightMode: 'directo', netDirectMilli: kg(100),
      weighingsMilli: [kg(60), kg(40)], supplier: 'Rancho Sol', reference: 'CAM-1', notes: 'llegó fría', receivedAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    await correctReception(db, full.id, kg(98), 'báscula');
    await annotateReception(db, full.id, { supplier: 'Rancho Sur', reference: '', notes: 'ok', receivedAt: new Date(Date.now() - 7200_000).toISOString(), containers: 8 }, 'datos');
    const gone = await confirmReception(db, { id: newId(), productId: x.id, packaging: 'granel', weightMode: 'bruto_tara', grossMilli: kg(55), tareMilli: kg(5), supplier: 'Otro' });
    await sleep(5);
    await addStockMove(db, x.id, 'ajuste', kg(140), 'conteo');
    await voidReception(db, gone.id, 'equivocada', false, true);
    await saveReceptionDraft(db, { id: newId(), productId: x.id, packaging: 'caja', containers: 4, weightMode: 'por_envase' });
    const cancelled = await saveReceptionDraft(db, { id: newId(), packaging: 'granel', weightMode: 'directo', supplier: 'cancel' });
    await cancelReceptionDraft(db, cancelled.id, 'se rechazó');
    // Ventas: inmediata sobre stock; con autorización; vale entregado con cliente; vale cancelado con devolución en efectivo; anulada
    const cart = (n: number) => addLine([], (x as Product), kg(n));
    await createSale(db, { cart: cart(5), paymentMethod: 'efectivo', receivedCents: 50_000 });
    await createSale(db, { cart: cart(500), paymentMethod: 'tarjeta', receivedCents: 0, allowNegativeStock: true });
    const delivered = await createSale(db, { cart: cart(2), paymentMethod: 'transferencia', receivedCents: 0, isVale: true, customerName: 'Doña Mary', allowNegativeStock: true });
    await deliverVale(db, delivered.id);
    const cancelledVale = await createSale(db, { cart: cart(1), paymentMethod: 'efectivo', receivedCents: 3000, isVale: true, allowNegativeStock: true });
    await cancelVale(db, cancelledVale.id, 'no vino', 'efectivo');
    const voided = await createSale(db, { cart: cart(1), paymentMethod: 'tarjeta', receivedCents: 0, allowNegativeStock: true });
    await voidSale(db, voided.id, 'cliente se arrepintió');
    await addCashOut(db, 500, 'bolsas');
    const closed = await closeShift(db, 21_000);
    expect(closed.id).toBe(shift.id);
    await openShift(db, 100);
    // autorización de negativo registrada
    const big = await confirmReception(db, { id: newId(), productId: x.id, packaging: 'granel', weightMode: 'directo', netDirectMilli: kg(1000), supplier: 'Grande' });
    await createSale(db, { cart: cart(1000), paymentMethod: 'tarjeta', receivedCents: 0, allowNegativeStock: true });
    await sleep(5);
    await voidReception(db, big.id, 'x', true, true).catch(() => undefined);

    const exported = JSON.parse(JSON.stringify(await exportBackup(db))) as Backup;
    // asegura que el conjunto realmente ejercita los campos opcionales que se pretende cubrir
    const has = (pred: boolean, what: string) => expect(pred, `el conjunto no cubre: ${what}`).toBe(true);
    has(exported.products.some((pp) => !!pp.classEdits?.length), 'classEdits');
    has(exported.sales.some((s) => s.customerName && s.deliveredAt), 'cliente + entrega');
    has(exported.sales.some((s) => s.stockOverride), 'stockOverride');
    has(exported.sales.some((s) => s.cancelReason && s.cancelledAt && s.refundMethod && s.refundCents !== undefined), 'cancelación');
    has(exported.sales.some((s) => s.voidReason && s.voidedAt), 'anulación');
    has(exported.cashMovements.some((m) => m.saleId), 'devolución con venta');
    has(exported.shifts.some((s) => s.closedAt && s.countedCashCents !== undefined && s.expectedCashCents !== undefined && s.differenceCents !== undefined), 'turno cerrado');
    has(exported.stockMoves.some((m) => m.saleId) && exported.stockMoves.some((m) => m.receptionId), 'enlaces de movimientos');
    has(exported.stockMoves.some((m) => m.authorizedNegativeAfterMilli !== undefined), 'negativo autorizado');
    const recs = exported.receptions;
    has(recs.some((r) => r.weighingsMilli && r.dataEdits?.length && r.corrections.length && r.cls && r.productLabel && r.containers), 'pesadas + correcciones + datos');
    has(recs.some((r) => r.dataEdits?.some((e) => e.changes.some((c) => c.field === 'reference' && c.before !== undefined && c.after === undefined))), 'edición que quita un dato');
    has(recs.some((r) => r.status === 'anulada' && r.voidReason && r.voidedAt && r.voidStockMoveId && r.acknowledged?.length), 'anulada con aviso reconocido');
    has(recs.some((r) => r.status === 'cancelada' && r.cancelReason && r.cancelledAt), 'descartada');
    has(recs.some((r) => r.status === 'borrador'), 'borrador');
    has(recs.some((r) => r.grossMilli !== undefined && r.tareMilli !== undefined), 'bruto/tara');
    has(recs.some((r) => r.unitNetMilli === undefined && r.weightMode === 'por_envase'), 'por envase sin peso (borrador)');

    const validated = validateBackup(exported);
    expect(validated).toEqual(exported);

    const other = await openDatabase(`sf-rt-${newId()}`);
    await importBackup(other, exported);
    const again = JSON.parse(JSON.stringify(await exportBackup(other))) as Backup;
    expect({ ...again, exportedAt: '' }).toEqual({ ...exported, exportedAt: '' });
    expect((await auditDatabase(other)).issues).toEqual([]);
    other.close();
  });
});

describe('números escritos con coma: nunca se adivina', () => {
  it('«1,500» es ambiguo y se rechaza; coma decimal con 1 o 2 decimales y miles sin ambigüedad se aceptan', () => {
    for (const t of ['1,500', '12,500', '0,500', ' 3,000 ']) {
      expect(isAmbiguousNumber(t), t).toBe(true);
      expect(parseQty(t), t).toBeNull();
      expect(parseMoney(t), t).toBeNull();
      expect(ambiguousNumberHint(t), t).toMatch(/se puede leer como/);
    }
    expect(ambiguousNumberHint('1,500')).toBe('«1,500» se puede leer como 1500 o como 1.5. Escribe 1500 o 1.5 para que quede claro.');
    expect(ambiguousNumberHint('12,500')).toContain('12500');
    expect(ambiguousNumberHint('12,500')).toContain('12.5');
    expect(ambiguousNumberHint('0,500')).toContain('0.5');
    expect(parseQty('15,5')).toBe(15_500);
    expect(parseQty('1,5')).toBe(1_500);
    expect(parseQty('0,25')).toBe(250);
    expect(parseQty('1,500.5')).toBe(1_500_500); // miles + punto decimal: sin ambigüedad
    expect(parseMoney('1,500,000')).toBe(150_000_000);
    expect(parseQty('1500')).toBe(1_500_000);
    expect(parseQty('1.500')).toBe(1_500); // punto decimal: 1.5 kg
    for (const t of ['', ' ', ',', '1,,5', '1,5,5', '1.5,5', '12,3456', 'abc', '1e3', '-5', '1 500']) {
      expect(parseQty(t), JSON.stringify(t)).toBeNull();
    }
    expect(isAmbiguousNumber('15,5')).toBe(false);
    expect(ambiguousNumberHint('15,5')).toBe('');
  });

  it('parseCount: solo enteros de 1 a 9 dígitos (sin signo, decimales, comas ni notación científica)', () => {
    expect(parseCount('10')).toBe(10);
    expect(parseCount(' 007 ')).toBe(7);
    expect(parseCount('100000')).toBe(100_000);
    for (const t of ['', '0', '-3', '10.5', '1e3', '1,000', '+5', '0x10', '१२', '１２', '1234567890', 'diez']) {
      expect(parseCount(t), JSON.stringify(t)).toBeNull();
    }
    expect(parseCount('5', 4)).toBeNull();
  });
});

describe('persistencia: durabilidad estricta sin romper nada', () => {
  it('las transacciones de escritura piden durabilidad estricta', async () => {
    const original = db.transaction.bind(db);
    const seen: unknown[] = [];
    (db as unknown as { transaction: (...a: unknown[]) => unknown }).transaction = (...a: unknown[]) => {
      seen.push(a[2]);
      return (original as (...b: unknown[]) => unknown)(...a);
    };
    await confirmReception(db, direct(10));
    expect(seen.some((o) => (o as { durability?: string } | undefined)?.durability === 'strict')).toBe(true);
  });
});

describe('vista previa de los avisos (solo lectura)', () => {
  it('muestra los avisos ANTES de confirmar y no cambia nada', async () => {
    await confirmReception(db, direct(100, { reference: 'CAM-5' }));
    const before = await exportBackup(db);
    const again = { ...direct(100, { reference: 'cam-5' }) };
    const pre = await previewReceptionWarnings(db, again);
    expect(pre.errors).toEqual([]);
    expect(pre.matches).toHaveLength(1);
    expect(pre.warnings[0]).toMatch(/Ya hay una recepción parecida/);
    // nada se escribió: ni inventario, ni folio, ni movimientos
    expect({ ...(await exportBackup(db)), exportedAt: '' }).toEqual({ ...before, exportedAt: '' });
    // y confirmar pide exactamente los mismos avisos
    const err = await confirmReception(db, again).catch((e) => e);
    expect(err.warnings).toEqual(pre.warnings);
  });

  it('avisa por conteo posterior y por entrada manual igual aunque no haya recepciones parecidas', async () => {
    await addStockMove(db, p.id, 'entrada', kg(50), 'inventario inicial');
    const pre = await previewReceptionWarnings(db, direct(50, { receivedAt: new Date(Date.now() - 3600_000).toISOString() }));
    expect(pre.matches).toEqual([]);
    expect(pre.warnings.join(' ')).toMatch(/entrada manual de los mismos kilos/);
    await addStockMove(db, p.id, 'ajuste', kg(60), 'conteo');
    const pre2 = await previewReceptionWarnings(db, direct(7, { receivedAt: new Date(Date.now() - 3600_000).toISOString() }));
    expect(pre2.warnings.join(' ')).toMatch(/conteo físico/);
  });

  it('errores de captura se devuelven sin lanzar; un intento ya registrado se reporta (igual o distinto)', async () => {
    const empty = await previewReceptionWarnings(db, { id: newId(), packaging: 'granel', weightMode: 'directo', netDirectMilli: kg(10) });
    expect(empty.errors.join(' ')).toMatch(/Elige qué producto llegó/);
    const input = direct(80);
    const saved = await confirmReception(db, input);
    const same = await previewReceptionWarnings(db, input);
    expect(same.already).toMatchObject({ same: true, reception: { id: saved.id, folio: 1 } });
    const other = await previewReceptionWarnings(db, { ...input, netDirectMilli: kg(90) });
    expect(other.already).toMatchObject({ same: false });
    expect(other.warnings).toEqual([]);
  });
});
