import { describe, expect, it } from 'vitest';
import { buildMerchandiseReport, movementTotals } from '../../src/domain/mercancia';
import type { Product, Reception, Sale, StockMove } from '../../src/domain/types';

const kg = (n: number) => Math.round(n * 1000);

const prod = (id: string, name: string, extra: Partial<Product> = {}): Product => ({
  id, name, unit: 'kg', priceCents: 3000, active: true, sort: 0, physicalMilli: 0, reservedMilli: 0, updatedAt: '', ...extra,
});
const P1 = prod('p1', 'Sin semilla', { quality: 'Primera', caliber: '2X', physicalMilli: kg(100), reservedMilli: kg(20) });
const P2 = prod('p2', 'Con semilla', { origin: 'Oaxaca', quality: 'Segunda', caliber: '300', physicalMilli: kg(50) });
const P3 = prod('p3', 'Sin semilla', { unit: 'caja', physicalMilli: 4000 }); // se vende por caja: no suma a kilos

const rec = (o: Partial<Reception>): Reception => ({
  id: 'r', status: 'confirmada', folio: 1, createdAt: '', updatedAt: '', receivedAt: '2026-10-10T08:00:00.000Z', day: '2026-10-10',
  packaging: 'granel', weightMode: 'directo', corrections: [], productId: 'p1', productLabel: 'Sin semilla · Primera · 2X',
  cls: { variety: 'Sin semilla', quality: 'Primera', caliber: '2X' }, confirmedNetMilli: kg(100), netMilli: kg(100), ...o,
});

const sale = (o: Partial<Sale> & { id: string; day: string }, items: Array<{ p: Product; q: number; price?: number; cls?: boolean }>): Sale => ({
  folio: 1, createdAt: `${o.day}T10:00:00.000Z`, shiftId: 's', totalCents: 0, paymentMethod: 'efectivo', receivedCents: 0, changeCents: 0,
  status: 'completada', delivery: 'inmediata',
  items: items.map(({ p, q, price = 3000, cls }) => ({
    productId: p.id, name: p.name, unit: p.unit, qtyMilli: q, unitPriceCents: price, totalCents: Math.round((price * q) / 1000),
    ...(cls
      ? {
          cls: {
            variety: p.name,
            ...(p.origin ? { origin: p.origin } : {}),
            ...(p.quality ? { quality: p.quality } : {}),
            ...(p.caliber ? { caliber: p.caliber } : {}),
          },
        }
      : {}),
  })),
  ...o,
});

const input = (over: Partial<Parameters<typeof buildMerchandiseReport>[0]> = {}) => ({
  from: '2026-10-10', to: '2026-10-10', receptions: [], sales: [], stockMoves: [], products: [P1, P2, P3], ...over,
});

describe('reporte de mercancía (Fase E)', () => {
  it('kilos recibidos por día, con kilos vigentes (original + correcciones), sin anuladas, borradores ni canceladas', () => {
    const c = { id: 'c', at: '', reason: 'x', previousNetMilli: kg(100), newNetMilli: kg(90), deltaMilli: -kg(10), stockMoveId: 'm' };
    const r = buildMerchandiseReport(input({
      from: '2026-10-09', to: '2026-10-10',
      receptions: [
        rec({ id: 'a', corrections: [c], netMilli: kg(90) }),
        rec({ id: 'b', day: '2026-10-09', confirmedNetMilli: kg(40), netMilli: kg(40) }),
        rec({ id: 'x', status: 'anulada', netMilli: 0 }),
        rec({ id: 'y', status: 'borrador' }),
        rec({ id: 'z', status: 'cancelada' }),
        rec({ id: 'fuera', day: '2026-09-01' }),
      ],
    }));
    expect(r.receivedMilli).toBe(kg(130));
    expect(r.receptionCount).toBe(2);
    expect(r.voidedCount).toBe(1);
    // Recibido = Original + Correcciones; lo anulado se informa aparte y NO cuenta; los borradores se cuentan sin importar el rango
    expect(r.receivedOriginalMilli).toBe(kg(140));
    expect(r.correctionsMilli).toBe(-kg(10));
    expect(r.receivedOriginalMilli + r.correctionsMilli).toBe(r.receivedMilli);
    expect(r.voidedMilli).toBe(kg(100));
    expect(r.draftCount).toBe(1);
    expect(r.byDay).toEqual([
      { day: '2026-10-09', receivedMilli: kg(40), receptions: 1, soldMilli: 0 },
      { day: '2026-10-10', receivedMilli: kg(90), receptions: 1, soldMilli: 0 },
    ]);
  });

  it('kilos vendidos: ventas completadas; el vale cuenta al venderse; cancelados y anuladas no; otras unidades aparte', () => {
    const r = buildMerchandiseReport(input({
      sales: [
        sale({ id: '1', day: '2026-10-10' }, [{ p: P1, q: kg(12.5), cls: true }]),
        sale({ id: '2', day: '2026-10-10', delivery: 'pendiente', valeFolio: 1 }, [{ p: P1, q: kg(20) }]),
        sale({ id: '3', day: '2026-10-10', delivery: 'entregado', valeFolio: 2 }, [{ p: P2, q: kg(5) }]),
        sale({ id: '4', day: '2026-10-10', delivery: 'cancelado', valeFolio: 3 }, [{ p: P2, q: kg(99) }]),
        sale({ id: '5', day: '2026-10-10', status: 'anulada' }, [{ p: P1, q: kg(77) }]),
        sale({ id: '6', day: '2026-10-10' }, [{ p: P3, q: 2000 }]), // 2 cajas
        sale({ id: '7', day: '2026-10-11' }, [{ p: P1, q: kg(1) }]), // fuera de rango
      ],
    }));
    expect(r.soldMilli).toBe(kg(37.5));
    expect(r.soldInPendingValesMilli).toBe(kg(20));
    expect(r.legacySoldMilli).toBe(kg(25)); // las ventas 2 y 3 no traen foto de clasificación
    expect(r.soldOtherUnits).toEqual([{ unit: 'caja', qtyMilli: 2000 }]);
    expect(r.byDay).toEqual([{ day: '2026-10-10', receivedMilli: 0, receptions: 0, soldMilli: kg(37.5) }]);
  });

  it('recibir mercancía no es vender ni cobrar: los kilos no se mezclan', () => {
    const r = buildMerchandiseReport(input({
      receptions: [rec({ id: 'a' })],
      sales: [sale({ id: '1', day: '2026-10-10' }, [{ p: P1, q: kg(30) }])],
    }));
    expect(r.receivedMilli).toBe(kg(100));
    expect(r.soldMilli).toBe(kg(30));
    expect(JSON.stringify(r)).not.toMatch(/cents|pago|proveedor.*(debe|adeuda)/i); // sin dinero ni cuentas por pagar
  });

  it('desglose por variedad, procedencia, calidad y calibre (con "no especificado" cuando falta)', () => {
    const r = buildMerchandiseReport(input({
      receptions: [
        rec({ id: 'a' }),
        rec({ id: 'b', productId: 'p2', cls: { variety: 'Con semilla', origin: 'Oaxaca', quality: 'Segunda', caliber: '300' }, confirmedNetMilli: kg(60), netMilli: kg(60) }),
        rec({ id: 'c', productId: 'p1', cls: { variety: 'Sin semilla' }, confirmedNetMilli: kg(10), netMilli: kg(10) }),
      ],
      sales: [sale({ id: '1', day: '2026-10-10' }, [{ p: P2, q: kg(25), cls: true }])],
    }));
    const get = (arr: typeof r.byVariety, label: string) => arr.find((b) => b.label === label);
    expect(get(r.byVariety, 'Sin semilla')).toMatchObject({ receivedMilli: kg(110), soldMilli: 0 });
    expect(get(r.byVariety, 'Con semilla')).toMatchObject({ receivedMilli: kg(60), soldMilli: kg(25) });
    expect(get(r.byOrigin, 'Oaxaca')).toMatchObject({ receivedMilli: kg(60), soldMilli: kg(25) });
    expect(get(r.byOrigin, 'No especificada')).toMatchObject({ receivedMilli: kg(110) });
    expect(get(r.byQuality, 'Primera')).toMatchObject({ receivedMilli: kg(100) });
    expect(get(r.byQuality, 'Sin clasificar')).toMatchObject({ receivedMilli: kg(10) });
    expect(get(r.byCaliber, '2X')).toMatchObject({ receivedMilli: kg(100) });
    expect(get(r.byCaliber, '300')).toMatchObject({ receivedMilli: kg(60), soldMilli: kg(25) });
    // Σ de cada dimensión = total recibido
    for (const dim of [r.byVariety, r.byOrigin, r.byQuality, r.byCaliber]) {
      expect(dim.reduce((a, b) => a + b.receivedMilli, 0)).toBe(r.receivedMilli);
    }
  });

  it('desglose por presentación: envases aparte de kilos, sin convertir cajas/arpillas en kilos', () => {
    const r = buildMerchandiseReport(input({
      receptions: [
        rec({ id: 'a', packaging: 'arpilla', containers: 10, weightMode: 'por_envase', unitNetMilli: kg(15), confirmedNetMilli: kg(150), netMilli: kg(150) }),
        rec({ id: 'b', packaging: 'arpilla', containers: 4, confirmedNetMilli: kg(58), netMilli: kg(58) }),
        rec({ id: 'c', packaging: 'caja', containers: 30, confirmedNetMilli: kg(500), netMilli: kg(500) }),
        rec({ id: 'd', packaging: 'granel', confirmedNetMilli: kg(1000), netMilli: kg(1000) }),
        rec({ id: 'e', packaging: 'caja', status: 'borrador' }),
      ],
    }));
    const by = Object.fromEntries(r.byPackaging.map((p) => [p.packaging, p]));
    expect(by.arpilla).toEqual({ packaging: 'arpilla', receptions: 2, containers: 14, receivedMilli: kg(208) });
    expect(by.caja).toEqual({ packaging: 'caja', receptions: 1, containers: 30, receivedMilli: kg(500) });
    expect(by.granel).toEqual({ packaging: 'granel', receptions: 1, containers: 0, receivedMilli: kg(1000) });
  });

  it('existencia actual: solo productos en kg; disponible = físico − reservado', () => {
    const r = buildMerchandiseReport(input());
    expect(r.stockNow.rows.map((x) => x.label)).toEqual(['Sin semilla · Primera · 2X', 'Con semilla · Oaxaca · Segunda · 300']);
    expect(r.stockNow).toMatchObject({ physicalMilli: kg(150), reservedMilli: kg(20), availableMilli: kg(130) });
  });

  it('mermas, conteos y entradas manuales del periodo; las correcciones de recepción NO se suman a "ajustes"', () => {
    const mv = (o: Partial<StockMove> & { id: string; type: StockMove['type'] }): StockMove => ({
      productId: 'p1', createdAt: '2026-10-10T12:00:00.000Z', deltaMilli: 0, reservedDeltaMilli: 0, note: '', ...o,
    });
    const r = buildMerchandiseReport(input({
      stockMoves: [
        mv({ id: '1', type: 'merma', deltaMilli: -kg(3), note: 'podrido' }),
        mv({ id: '2', type: 'ajuste', deltaMilli: kg(-2), note: 'conteo' }),
        mv({ id: '3', type: 'ajuste', deltaMilli: kg(5), note: 'conteo 2' }),
        mv({ id: '4', type: 'correccion_recepcion', deltaMilli: -kg(10), receptionId: 'r1' }),
        mv({ id: '5', type: 'reversa_recepcion', deltaMilli: -kg(40), receptionId: 'r2' }),
        mv({ id: '6', type: 'venta', deltaMilli: -kg(7) }), // no es ajuste
        mv({ id: '7', type: 'merma', deltaMilli: -kg(1), createdAt: '2026-09-01T12:00:00.000Z' }), // fuera de rango
        mv({ id: '8', type: 'entrada', deltaMilli: kg(12), note: 'inventario inicial' }),
        mv({ id: '9', type: 'entrada', deltaMilli: kg(99), productId: 'p3' }), // se vende por caja: no es kilos
      ],
    }));
    expect(r.adjustments.map((a) => a.id).sort()).toEqual(['1', '2', '3', '8']);
    expect(r.mermasMilli).toBe(kg(3));
    expect(r.ajustesMilli).toBe(kg(3));
    expect(r.manualInMilli).toBe(kg(12));
    // cuadre por movimientos: inicial (−1 de septiembre) + recepciones netas (−50) + manual 12 − salidas 7 − mermas 3 + conteos 3
    expect(r.ledger).toMatchObject({
      openingMilli: -kg(1), receptionsMilli: -kg(50), manualInMilli: kg(12), outMilli: kg(7), mermasMilli: kg(3), countsMilli: kg(3),
      closingMilli: -kg(46), laterMovesMilli: 0,
    });
    expect(r.ledger.reconciles).toBe(false); // estos datos de prueba no cuadran con la existencia de los productos
  });

  it('el cuadre por movimientos concilia con la existencia actual cuando los datos son consistentes', () => {
    const mv = (id: string, type: StockMove['type'], d: number, createdAt: string, productId = 'p1', res = 0): StockMove => ({
      id, productId, createdAt, type, deltaMilli: d, reservedDeltaMilli: res, note: type === 'merma' || type === 'ajuste' ? 'x' : '',
    });
    const p1 = prod('p1', 'Sin semilla', { physicalMilli: kg(75), reservedMilli: kg(5) });
    const moves = [
      mv('1', 'recepcion', kg(100), '2026-10-08T15:00:00.000Z'),
      mv('2', 'venta', -kg(10), '2026-10-09T15:00:00.000Z'),
      mv('3', 'reserva', 0, '2026-10-10T15:00:00.000Z', 'p1', kg(5)),
      mv('4', 'merma', -kg(3), '2026-10-10T16:00:00.000Z'),
      mv('5', 'entrada', kg(8), '2026-10-11T15:00:00.000Z'),
      mv('6', 'venta', -kg(20), '2026-10-12T15:00:00.000Z'),
    ];
    // 100 − 10 − 3 + 8 − 20 = 75 = existencia física
    const all = buildMerchandiseReport({ from: '2026-10-08', to: '2026-10-12', receptions: [], sales: [], stockMoves: moves, products: [p1] });
    expect(all.ledger).toMatchObject({ openingMilli: 0, receptionsMilli: kg(100), manualInMilli: kg(8), outMilli: kg(30), mermasMilli: kg(3), closingMilli: kg(75), reconciles: true });
    // un solo día: inicial = lo anterior; los posteriores completan la conciliación
    const day = buildMerchandiseReport({ from: '2026-10-10', to: '2026-10-10', receptions: [], sales: [], stockMoves: moves, products: [p1] });
    expect(day.ledger).toMatchObject({ openingMilli: kg(90), mermasMilli: kg(3), closingMilli: kg(87), laterMovesMilli: -kg(12), reconciles: true });
    expect(day.ledger.closingMilli + day.ledger.laterMovesMilli).toBe(day.stockNow.physicalMilli);
  });

  it('existencia por grupo: "cuánto me queda" por variedad, procedencia, calidad y calibre, con ocultos y negativos', () => {
    const P4 = prod('p4', 'Sin semilla', { quality: 'Primera', caliber: '400', physicalMilli: kg(30) });
    const P5 = prod('p5', 'Con semilla', { origin: 'Michoacán', caliber: '300', physicalMilli: -kg(4), active: false }); // oculto y en negativo
    const P6 = prod('p6', 'Con semilla', { origin: 'Michoacán', caliber: '500' }); // sin existencia ni movimientos: no aparece
    const r = buildMerchandiseReport(input({ products: [P1, P2, P3, P4, P5, P6] }));
    const cal = (label: string) => r.byCaliber.find((b) => b.label === label);
    expect(cal('2X')).toMatchObject({ physicalMilli: kg(100), reservedMilli: kg(20), availableMilli: kg(80) });
    expect(cal('300')).toMatchObject({ physicalMilli: kg(46), availableMilli: kg(46) }); // 50 (P2) − 4 (P5): el negativo se ve
    expect(cal('400')).toMatchObject({ physicalMilli: kg(30) });
    expect(cal('500')).toBeUndefined();
    // los grupos suman la existencia total en cada dimensión
    for (const dim of [r.byVariety, r.byOrigin, r.byQuality, r.byCaliber]) {
      expect(dim.reduce((a, b) => a + b.availableMilli, 0)).toBe(r.stockNow.availableMilli);
      expect(dim.reduce((a, b) => a + b.physicalMilli, 0)).toBe(r.stockNow.physicalMilli);
    }
    // el "no especificado" aparece como un grupo más para que sume
    expect(r.byOrigin.find((b) => b.label === 'No especificada')).toMatchObject({ physicalMilli: kg(130) });
    expect(r.byOrigin.find((b) => b.label === 'Michoacán')).toMatchObject({ physicalMilli: -kg(4) });
  });

  it('una misma variedad con dos ortografías (dato anterior y chip nuevo) es UN solo grupo; calibres 3X vs 300 nunca se mezclan', () => {
    const legacy = prod('l', 'CON semilla', { physicalMilli: kg(10) });
    const fresh = prod('f', 'Con semilla', { origin: 'Oaxaca', physicalMilli: kg(5) });
    const x3 = prod('x', 'Sin semilla', { caliber: '3 X', physicalMilli: kg(7) });
    const n3 = prod('n', 'Sin semilla', { caliber: '300', physicalMilli: kg(9) });
    const r = buildMerchandiseReport(input({ products: [legacy, fresh, x3, n3] }));
    expect(r.byVariety.filter((b) => /semilla/i.test(b.label))).toHaveLength(2); // Con semilla y Sin semilla
    const con = r.byVariety.find((b) => /^con semilla$/i.test(b.label))!;
    expect(con.physicalMilli).toBe(kg(15));
    expect(con.label).toBe('CON semilla'); // la primera ortografía vista
    expect(r.byCaliber.map((b) => b.label).sort()).toEqual(['3 X', '300', 'No especificado']);
    expect(r.byCaliber.find((b) => b.label === '3 X')!.physicalMilli).toBe(kg(7));
    expect(r.byCaliber.find((b) => b.label === '300')!.physicalMilli).toBe(kg(9));
  });

  it('"Torreones" capturado como calidad en un producto y como calibre en otro NO se junta (decisión de negocio pendiente)', () => {
    const a = prod('a', 'Sin semilla', { quality: 'Torreones', physicalMilli: kg(10) });
    const b = prod('b', 'Sin semilla', { caliber: 'Torreones', physicalMilli: kg(20) });
    const r = buildMerchandiseReport(input({ products: [a, b] }));
    expect(r.byQuality.find((x) => x.label === 'Torreones')!.physicalMilli).toBe(kg(10));
    expect(r.byCaliber.find((x) => x.label === 'Torreones')!.physicalMilli).toBe(kg(20));
  });

  it('ventas anteriores a la clasificación (sin foto): se agrupan por el nombre con que se vendieron, nunca por la clasificación de hoy', () => {
    // P2 hoy es "Con semilla · Oaxaca · Segunda · 300", pero la venta antigua solo guardó "con semilla"
    const legacySale = sale({ id: 'v1', day: '2026-10-10' }, [{ p: { ...P2, name: 'con semilla' }, q: kg(25) }]);
    const r = buildMerchandiseReport(input({ sales: [legacySale] }));
    expect(r.legacySoldMilli).toBe(kg(25));
    expect(r.byVariety.find((b) => b.label === 'Con semilla')).toMatchObject({ soldMilli: kg(25) }); // misma variedad (clave sin acentos ni mayúsculas)
    expect(r.byOrigin.find((b) => b.label === 'Oaxaca')!.soldMilli).toBe(0);
    expect(r.byOrigin.find((b) => b.label === 'No especificada')!.soldMilli).toBe(kg(25));
    expect(r.byQuality.find((b) => b.label === 'Sin clasificar')!.soldMilli).toBe(kg(25));
    expect(r.byCaliber.find((b) => b.label === 'No especificado')!.soldMilli).toBe(kg(25));
    // y si el nombre congelado no coincide con ninguna variedad actual, queda en su propio grupo
    const other = sale({ id: 'v2', day: '2026-10-10' }, [{ p: { ...P1, name: 'Limón persa · Primera' }, q: kg(4) }]);
    const r2 = buildMerchandiseReport(input({ sales: [other] }));
    expect(r2.byVariety.find((b) => b.label === 'Limón persa · Primera')).toMatchObject({ soldMilli: kg(4) });
  });
});

describe('identidad contable por movimientos', () => {
  it('físico = recepciones + entradas manuales − ventas netas − mermas ± ajustes (todos los tipos)', () => {
    const t = (type: StockMove['type'], d: number): StockMove => ({ id: type + d, productId: 'p', createdAt: '', type, deltaMilli: d, reservedDeltaMilli: 0, note: '' });
    const moves = [
      t('entrada', kg(100)), t('recepcion', kg(500)), t('correccion_recepcion', -kg(20)), t('reversa_recepcion', -kg(30)),
      t('venta', -kg(40)), t('entrega_vale', -kg(10)), t('anulacion', kg(5)), t('reserva', 0), t('merma', -kg(4)), t('ajuste', -kg(1)),
    ];
    const r = movementTotals(moves);
    expect(r).toMatchObject({
      recepcionesMilli: kg(450), entradasManualesMilli: kg(100), ventasNetasMilli: kg(45), mermasMilli: kg(4), ajustesMilli: -kg(1),
    });
    expect(r.physicalMilli).toBe(moves.reduce((s, m) => s + m.deltaMilli, 0));
    expect(r.physicalMilli).toBe(kg(100 + 500 - 20 - 30 - 40 - 10 + 5 - 4 - 1));
  });
});
