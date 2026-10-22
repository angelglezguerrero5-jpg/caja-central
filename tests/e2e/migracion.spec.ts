import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { charge, openApp, sellCash, tab } from './helpers';
import {
  EDGE_CART_DRAFT,
  PHONES,
  auditRaw,
  auditoriaOk,
  captureDownload,
  cashExpected,
  chooseBackup,
  compilarAppAnterior,
  confirmRestoreSheet,
  edgeV1,
  exportBackupUi,
  expectAppReady,
  expectInsideViewport,
  expectRawClean,
  expectSameData,
  expectSolidTap,
  expectToast,
  fillReception,
  fixtureV1,
  hideKeyboard,
  invRow,
  launchProfile,
  metaOf,
  mxn,
  overflowing,
  raizDelProyecto,
  rawFromBackup,
  readRawDb,
  receive,
  registerReception,
  richV2,
  rowsOf,
  runAuditUi,
  saveReceptionDraftUi,
  sellExact,
  sellVale,
  seedDatabase,
  seedV1,
  servirCarpeta,
  showKeyboard,
  simpleV2,
  textFile,
  uiInventory,
  v1Stores,
  versionOf,
  watchTaps,
  type RawDb,
} from './helpers-migracion';

/**
 * MIGRACIÓN v1 → v2 en un navegador REAL (Chromium) y qué pasa cuando la base no se puede abrir.
 *
 * Lo que ya cubren las unitarias (tests/unit/migration-v2.test.ts, con fake-indexeddb) NO se repite: aquí va lo que solo se ve
 * en el navegador: la actualización real de IndexedDB al abrir la app, el aviso en pantalla, qué hacen varias ventanas a la
 * vez, el panel de error con la copia de emergencia y el reinicio real del navegador con el mismo perfil.
 *
 * Cómo se prepara el «teléfono con la app anterior»: se crea una base `venta-limones` en VERSIÓN 1 con el esquema real de v1
 * (el MIGRATIONS[1] del último commit) desde una página del mismo origen que NO carga la app, se llena con datos de v1 y SOLO
 * entonces se abre la app. Las cifras esperadas se calcularon a mano desde esos datos (ver los comentarios).
 */

/** Ids de la fixture real, buscados por sus datos (no copiados a mano). */
function fixtureIds() {
  const f = fixtureV1();
  const prod = (name: string, quality?: string) => f.products.find((p: { name: string; quality?: string }) => p.name === name && p.quality === quality).id as string;
  return {
    f,
    primera: prod('Limón persa', 'Primera'),
    segunda: prod('Limón persa', 'Segunda'),
    conSemilla: prod('Limón con semilla'),
    torreones: prod('Limón sin semilla', 'Torreones'),
    turnoAbierto: f.shifts.find((s: { closedAt?: string }) => !s.closedAt).id as string,
    vale2: f.sales.find((s: { valeFolio?: number }) => s.valeFolio === 2).id as string,
  };
}

const indexes = (raw: RawDb | null, store: string) => [...(raw?.stores[store]?.indexes ?? [])].sort();

const V1_DATA_STORES = ['products', 'sales', 'shifts', 'cashMovements', 'stockMoves'];

test.describe('Migración v1→v2 con datos previos (casos 24, 23, 25)', () => {
  test('a) base v1 real (fixture): al abrir la app sube a la versión actual (3, de un solo paso), avisa y TODOS los registros quedan idénticos', async ({ page }) => {
    const { f } = fixtureIds();
    await seedV1(page, f);
    const before = await readRawDb(page);

    // Punto de partida: de verdad es una base de versión 1 (sin recepciones y sin el índice nuevo).
    expect(before!.version).toBe(1);
    expect(Object.keys(before!.stores).sort()).toEqual(['cashMovements', 'meta', 'products', 'sales', 'shifts', 'stockMoves']);
    expect(indexes(before, 'stockMoves')).toEqual(['byProduct']);
    expect(rowsOf(before, 'sales')).toHaveLength(7);
    expect(rowsOf(before, 'stockMoves')).toHaveLength(13);

    await page.goto('/');
    await expect(page.getByTestId('upgraded')).toBeVisible();
    await expect(page.getByTestId('upgraded')).toContainText('La app se actualizó');
    await expect(page.getByTestId('upgraded')).toContainText('Tus ventas, vales, precios e inventario siguen igual');
    await expectAppReady(page);

    const after = await readRawDb(page);
    expect(after!.version, 'versión de la base tras abrir la app').toBe(3);
    expect(await versionOf(page)).toBe(3);

    // Todo lo anterior, registro por registro
    expectSameData(after, before, 'tras migrar', V1_DATA_STORES);
    // La migración no toca los contadores ni el turno actual, y no inventa claves
    expect(metaOf(after)).toEqual(metaOf(before));
    expect(metaOf(after)).toEqual({ nextFolio: 8, nextValeFolio: 4, currentShiftId: fixtureIds().turnoAbierto });

    // Solo se AÑADIÓ: tabla `receptions` vacía con sus índices (folio único) y el índice por recepción en los movimientos
    expect(Object.keys(after!.stores).sort()).toEqual(['cashMovements', 'freights', 'meta', 'products', 'receptions', 'sales', 'shifts', 'stockMoves']);
    expect(rowsOf(after, 'receptions')).toEqual([]);
    expect(rowsOf(after, 'freights')).toEqual([]); // los fletes llegaron con la versión 3: la base nueva no trae ninguno
    expect(indexes(after, 'freights')).toEqual(['byDay', 'byFolioKey', 'byStatus']);
    expect(after!.stores.freights.unique).toEqual(['byFolioKey']);
    expect(indexes(after, 'receptions')).toEqual(['byDay', 'byFolio', 'byProduct', 'byStatus']);
    expect(after!.stores.receptions.unique).toEqual(['byFolio']);
    expect(indexes(after, 'stockMoves')).toEqual(['byProduct', 'byReception']);
    // Los índices anteriores siguen (el folio de venta sigue siendo único)
    expect(indexes(after, 'sales')).toEqual(['byDay', 'byDelivery', 'byFolio', 'byShift']);
    expect(after!.stores.sales.unique).toEqual(['byFolio']);
    expect(indexes(after, 'shifts')).toEqual(['byOpenedAt']);
    expect(indexes(after, 'cashMovements')).toEqual(['byShift']);
  });

  test('a) tras migrar: Corte, Inventario, Vales, Historial y Auditoría dan las cifras de los datos v1 (calculadas a mano)', async ({ page }) => {
    const { f, turnoAbierto } = fixtureIds();
    await seedV1(page, f);
    const seeded = await readRawDb(page);
    // Control del cálculo a mano con el cálculo independiente: turno abierto = fondo $100 + efectivo ($1,500 + $350 + $256)
    // − devolución del vale cancelado ($350) = $1,856.00
    expect(cashExpected(seeded!, turnoAbierto)).toBe(185_600);
    expect(mxn(185_600)).toBe('$1,856.00');

    await page.goto('/');
    await expect(page.getByTestId('upgraded')).toBeVisible();

    // ── Corte (casos 23): el MISMO efectivo esperado que dan los datos sembrados
    await tab(page, 'corte');
    await expect(page.getByTestId('r-expected')).toHaveText('$1,856.00');
    await expect(page.getByTestId('r-total')).toHaveText('$2,106.00'); // 3 ventas válidas: #5 $1,500 + #6 $350 + #7 $256
    await expect(page.getByTestId('r-efectivo')).toHaveText('$2,106.00');
    await expect(page.getByTestId('r-refunds')).toContainText('$350.00');
    await expect(page.getByTestId('sale-row')).toHaveCount(4); // las 3 válidas + la #4 anulada
    await expect(page.getByTestId('sale-row').filter({ hasText: '#4' })).toContainText('ANULADA');
    const closed = page.getByTestId('closed-shift');
    await expect(closed).toHaveCount(1);
    await expect(closed).toContainText('esperado $1,160.00'); // el corte cerrado conserva lo que dijo v1
    await expect(closed).toContainText('contado $565.00');
    await expect(closed).toContainText('dif -$595.00');

    // ── Inventario: físico / apartado / disponible exactos, sin recepciones
    const inv = await uiInventory(page);
    expect(inv).toEqual([
      { label: 'Limón persa · Primera', physical: '459.5 kg', reserved: '50 kg', available: '409.5 kg' },
      { label: 'Limón persa · Segunda', physical: '200 kg', reserved: '0 g', available: '200 kg' },
      { label: 'Limón con semilla', physical: '270 kg', reserved: '0 g', available: '270 kg' },
      { label: 'Limón sin semilla · Torreones', physical: '0 g', reserved: '0 g', available: '0 g' },
    ]);
    const primera = invRow(page, 'Limón persa · Primera');
    await expect(primera.getByTestId('stock-manual')).toHaveText('500 kg'); // el «inventario inicial» de v1 sigue siendo entrada manual
    await expect(primera.getByTestId('stock-recibido')).toHaveText('0 g'); // nada se convirtió en recepción

    // ── Vales: pendiente, entregado y cancelado conservan su estado, cliente y dinero
    await tab(page, 'vales');
    await expect(page.getByTestId('vale')).toHaveCount(1);
    const pendiente = page.getByTestId('vale').first();
    await expect(pendiente).toContainText('Vale V-2');
    await expect(pendiente).toContainText('Taquería Lupita');
    await expect(pendiente).toContainText('Limón persa · Primera · 50 kg');
    await expect(pendiente).toContainText('$1,500.00 pagado');
    await page.getByTestId('vales-entregado').click();
    await expect(page.getByTestId('vale')).toHaveCount(1);
    await expect(page.getByTestId('vale').first()).toContainText('Vale V-1');
    await expect(page.getByTestId('vale').first()).toContainText('Doña Mary');
    await page.getByTestId('vales-cancelado').click();
    await expect(page.getByTestId('vale')).toHaveCount(1);
    await expect(page.getByTestId('vale').first()).toContainText('Vale V-3');
    await expect(page.getByTestId('cancel-info')).toContainText('el cliente ya no vino');
    await expect(page.getByTestId('cancel-info')).toContainText('EFECTIVO');
    await expect(page.getByTestId('cancel-info')).toContainText('$350.00');

    // ── Historial de ventas del día 2026-10-10: 7 ventas (6 válidas = $4,131.00 y 1 anulada)
    await tab(page, 'mas');
    await page.getByTestId('hist-day').fill('2026-10-10');
    await expect(page.getByTestId('hist-row')).toHaveCount(7);
    await expect(page.getByTestId('hist-summary')).toContainText('6 ventas · $4,131.00 · 1 anuladas');
    const histRow = (n: number) => page.getByTestId('hist-row').filter({ hasText: `#${n}` });
    await expect(histRow(1)).toContainText('Entregada');
    await expect(histRow(3)).toContainText('VALE V-1 · ENTREGADO');
    await expect(histRow(4)).toContainText('ANULADA');
    await expect(histRow(5)).toContainText('VALE V-2 · PENDIENTE');
    await expect(histRow(6)).toContainText('VALE V-3 · CANCELADO');

    // ── Auditoría (caso 25): sin problemas, con las mismas cuentas
    const audit = await runAuditUi(page);
    await expect(audit).toContainText(auditoriaOk(7, 3, 0, 13));
    expectRawClean(await readRawDb(page), 'base migrada');
  });

  test('a) tras migrar la app sigue operando: recepción R-1, venta #8, vale V-4 y entrega del vale V-2 sin doble descuento', async ({ page }) => {
    test.setTimeout(90_000); // muchos pasos de pantalla seguidos con la máquina compartida
    const { f, primera, conSemilla, segunda, torreones, turnoAbierto, vale2 } = fixtureIds();
    await seedV1(page, f);
    await page.goto('/');
    await expect(page.getByTestId('upgraded')).toBeVisible();
    const before = await readRawDb(page);

    // 1) Recepción de 100 kg de una variedad ANTERIOR (sin procedencia ni calibre): 270 → 370 kg
    await fillReception(page, { variety: 'Limón con semilla', packaging: 'granel', mode: 'directo', net: '100', supplier: 'Rancho Nuevo' });
    await expect(page.getByTestId('rec-selected')).toContainText('en bodega ahora: 270 kg');
    await page.getByTestId('rec-confirm').click();
    await expect(page.getByTestId('rec-sheet')).toBeVisible();
    await expect(page.getByTestId('rec-sheet-net')).toHaveAttribute('data-milli', '100000');
    await expect(page.getByTestId('rec-sheet-stock')).toContainText('En bodega: 270 kg → 370 kg');
    await page.getByTestId('rec-confirm-yes').click();
    await expectToast(page, 'Recepción R-1 registrada: +100 kg');

    // 2) Venta normal: 1 kg de Limón persa · Primera a $32 pagada con $50 → folio SIGUIENTE al último de v1 (#8)
    await tab(page, 'caja');
    await sellCash(page, '1', [50]);
    await expect(page.getByTestId('last-sale')).toContainText('#8');
    await expect(page.getByTestId('last-sale')).toContainText('cambio $18.00');

    // 3) Vale nuevo de 10 kg ($320 exactos): venta #9 y vale V-4 (v1 ya había emitido V-1, V-2 y V-3)
    await sellVale(page, '10', 'Pepe');
    await expect(page.getByTestId('last-sale')).toContainText('#9');
    await expect(page.getByTestId('last-sale')).toContainText('VALE V-4 pendiente de entrega');

    // 4) Entregar el vale pendiente V-2 que venía de v1 (50 kg): sale de bodega y se libera la reserva, SIN cobrar otra vez
    await tab(page, 'vales');
    await expect(page.getByTestId('vale')).toHaveCount(2);
    const v2 = page.getByTestId('vale').filter({ hasText: 'Vale V-2' });
    await v2.getByTestId('deliver').click();
    await expectToast(page, 'Vale V-2 entregado');
    await expect(page.getByTestId('vale')).toHaveCount(1);

    // Inventario (a mano): Primera 459.5 − 1 (venta) − 50 (entrega) = 408.5 físico; reservado 50 + 10 − 50 = 10; disponible 398.5
    const inv = await uiInventory(page);
    expect(inv.find((r) => r.label === 'Limón persa · Primera')).toEqual({ label: 'Limón persa · Primera', physical: '408.5 kg', reserved: '10 kg', available: '398.5 kg' });
    expect(inv.find((r) => r.label === 'Limón con semilla')).toEqual({ label: 'Limón con semilla', physical: '370 kg', reserved: '0 g', available: '370 kg' });

    // Corte (a mano): 185,600 + 3,200 (venta #8) + 32,000 (vale V-4) = 220,800; entregar y recibir mercancía NO mueven efectivo
    await tab(page, 'corte');
    await expect(page.getByTestId('r-expected')).toHaveText('$2,208.00');
    await expect(page.getByTestId('r-total')).toHaveText('$2,458.00'); // 210,600 + 3,200 + 32,000
    await expect(page.getByTestId('r-refunds')).toContainText('$350.00'); // la devolución de v1 sigue ahí

    // Base cruda: milésimas exactas, folios y que lo anterior no cambió
    const after = await readRawDb(page);
    const prod = (raw: RawDb | null, id: string) => rowsOf(raw, 'products').find((p) => p.id === id)!;
    expect(prod(after, primera)).toMatchObject({ physicalMilli: 408_500, reservedMilli: 10_000, priceCents: 3200 });
    expect(prod(after, conSemilla)).toMatchObject({ physicalMilli: 370_000, reservedMilli: 0 });
    expect(prod(after, segunda)).toEqual(prod(before, segunda)); // lo que no se tocó, idéntico
    expect(prod(after, torreones)).toEqual(prod(before, torreones));
    expect(metaOf(after)).toEqual({ nextFolio: 10, nextValeFolio: 5, nextReceptionFolio: 2, currentShiftId: turnoAbierto });
    const recs = rowsOf(after, 'receptions');
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ folio: 1, status: 'confirmada', productId: conSemilla, confirmedNetMilli: 100_000, netMilli: 100_000, supplier: 'Rancho Nuevo' });
    expect(rowsOf(after, 'stockMoves').filter((m) => m.receptionId === recs[0].id)).toEqual([
      expect.objectContaining({ type: 'recepcion', deltaMilli: 100_000, productId: conSemilla, id: recs[0].stockMoveId }),
    ]);
    // Las 7 ventas de v1 siguen idénticas, salvo el vale entregado (solo cambia su estado)
    const oldSales = rowsOf(before, 'sales');
    for (const s of oldSales.filter((x) => x.id !== vale2)) expect(rowsOf(after, 'sales').find((x) => x.id === s.id), `venta #${s.folio}`).toEqual(s);
    expect(rowsOf(after, 'sales').find((x) => x.id === vale2)).toEqual({ ...oldSales.find((x) => x.id === vale2), delivery: 'entregado', deliveredAt: expect.any(String) });
    expect(rowsOf(after, 'sales')).toHaveLength(9);
    expect(cashExpected(after!, turnoAbierto)).toBe(220_800);
    expectRawClean(after, 'base migrada y operada');

    // El historial de la recepción (usa el índice NUEVO por recepción) funciona sobre la base migrada
    await tab(page, 'recepcion');
    await page.getByTestId('rec-sub-historial').click();
    await expect(page.getByTestId('rec-row')).toHaveCount(1);
    await page.getByTestId('rec-moves').click();
    await expect(page.getByTestId('rec-moves-list')).toContainText('+100 kg');

    // Auditoría de la app: 9 ventas, 4 vales, 1 recepción y 17 movimientos (13 + recepción + venta + reserva + entrega)
    const audit = await runAuditUi(page);
    await expect(audit).toContainText(auditoriaOk(9, 4, 1, 17));
  });

  test('a) la migración corre UNA sola vez: al recargar, abrir otra ventana o reabrir no reaparece el aviso y nada cambia', async ({ page, context }) => {
    const { f } = fixtureIds();
    await seedV1(page, f);
    await page.goto('/');
    await expect(page.getByTestId('upgraded')).toBeVisible();

    // «Cerrar» quita el aviso
    await page.getByTestId('upgraded-close').click();
    await expect(page.getByTestId('upgraded')).toHaveCount(0);
    const first = await readRawDb(page);
    expect(first!.version).toBe(3);

    // Recargas: ni aviso ni cambios (la actualización de esquema no vuelve a correr)
    for (let i = 0; i < 3; i++) {
      await page.reload();
      await expectAppReady(page);
      await expect(page.getByTestId('upgraded')).toHaveCount(0);
      expect(await readRawDb(page), `tras la recarga ${i + 1}`).toEqual(first);
    }
    // Otra ventana del mismo perfil
    const otra = await context.newPage();
    await otra.goto('/');
    await expectAppReady(otra);
    await expect(otra.getByTestId('upgraded')).toHaveCount(0);
    expect(await versionOf(otra)).toBe(3);
    // Una venta y otra recarga: el dato nuevo se queda, el aviso sigue sin volver
    await sellCash(page, '1', [50]);
    const withSale = await readRawDb(page);
    await page.reload();
    await expectAppReady(page);
    await expect(page.getByTestId('upgraded')).toHaveCount(0);
    expect(await readRawDb(page)).toEqual(withSale);
  });

  test('a) dos ventanas abren la app a la vez sobre una base v1: la migración corre una sola vez, solo una ventana avisa y los datos quedan intactos', async ({ page, context }) => {
    const { f } = fixtureIds();
    await seedV1(page, f);
    const antes = await readRawDb(page);
    const a = await context.newPage();
    const b = await context.newPage();
    await Promise.all([a.goto('/'), b.goto('/')]);
    await expectAppReady(a);
    await expectAppReady(b);
    const avisos = (await a.getByTestId('upgraded').count()) + (await b.getByTestId('upgraded').count());
    expect(avisos, 'solo la ventana que hizo la actualización avisa').toBe(1);
    const despues = await readRawDb(page);
    expect(despues!.version).toBe(3);
    expectSameData(despues, antes, 'dos ventanas a la vez', V1_DATA_STORES);
    expect(metaOf(despues)).toEqual(metaOf(antes));
    // Ambas ventanas funcionan sobre la misma base: lo que una vende, la otra lo ve sin recargar
    await sellCash(a, '1', [50]);
    await tab(b, 'corte');
    await expect(b.getByTestId('r-expected')).toHaveText('$1,888.00'); // 1,856 + 32
  });

  test('a) instalación nueva (sin datos previos): no hay aviso de actualización y la base nace en la versión actual (3)', async ({ page }) => {
    await openApp(page, { seed: false });
    await expect(page.getByTestId('upgraded')).toHaveCount(0);
    const raw = await readRawDb(page);
    expect(raw!.version).toBe(3);
    expect(Object.keys(raw!.stores).sort()).toEqual(['cashMovements', 'freights', 'meta', 'products', 'receptions', 'sales', 'shifts', 'stockMoves']);
    expect(indexes(raw, 'freights')).toEqual(['byDay', 'byFolioKey', 'byStatus']);
    expect(indexes(raw, 'stockMoves')).toEqual(['byProduct', 'byReception']);
    expect(indexes(raw, 'receptions')).toEqual(['byDay', 'byFolio', 'byProduct', 'byStatus']);
    for (const s of ['products', 'sales', 'receptions', 'stockMoves']) expect(rowsOf(raw, s), `«${s}» vacía`).toEqual([]);
  });

  test('a) el aviso lleva a «Respaldo», que recuerda exportar; el archivo exportado de la base migrada ya es del formato actual (v3)', async ({ page }) => {
    const { f } = fixtureIds();
    await seedV1(page, f);
    await page.goto('/');
    await page.getByTestId('upgraded-go').click();
    await expect(page.getByTestId('mas')).toBeVisible();
    await expect(page.getByTestId('upgraded')).toHaveCount(0);
    // Hay ventas y nunca se exportó: la pantalla lo advierte
    await expect(page.getByTestId('last-backup')).toContainText('Último respaldo: nunca');
    await expect(page.getByTestId('last-backup')).toContainText('te conviene exportar uno ahora');

    const file = await exportBackupUi(page);
    await expectToast(page, 'Respaldo exportado (7 ventas, 0 recepciones)');
    expect(file.json.version).toBe(3);
    expect(file.json.app).toBe('sistema-venta-limones');
    expect(file.json.receptions).toEqual([]);
    expect(file.json.freights).toEqual([]);
    expect(file.json.nextReceptionFolio).toBe(1);
    expect(file.json.nextFolio).toBe(8);
    expect(file.json.nextValeFolio).toBe(4);
    for (const k of V1_DATA_STORES) expect(file.json[k], `«${k}» exportada`).toEqual(f[k].slice().sort((a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1)));
    await expect(page.getByTestId('last-backup')).toContainText('Último respaldo: hoy');
    await expect(page.getByTestId('last-backup')).not.toContainText('te conviene exportar');
  });
});

test.describe('Migración: casos límite de v1 (caso 24)', () => {
  test('b) v1 con producto sin calidad, por caja, oculto, existencia negativa autorizada, vale y borrador de carrito: se preserva sin inventar clasificación ni precios', async ({ page }) => {
    const e = edgeV1();
    await seedV1(page, e, { extraMeta: [EDGE_CART_DRAFT] });
    const before = await readRawDb(page);
    expect(cashExpected(before!, 'e-turno')).toBe(190_000); // fondo $500 + efectivo (250 + 900 + 270) − salida $20 = $1,900.00

    await page.goto('/');
    await expect(page.getByTestId('upgraded')).toBeVisible();
    const after = await readRawDb(page);

    // Idéntico, registro por registro, incluido el borrador de carrito de `meta`
    expectSameData(after, before, 'casos límite', V1_DATA_STORES);
    expect(metaOf(after)).toEqual(metaOf(before));
    expect(metaOf(after).cartDraft).toEqual(EDGE_CART_DRAFT.value);

    // NO se inventó clasificación, foto de clasificación ni precio
    for (const p of rowsOf(after, 'products')) {
      expect(Object.keys(p), `campos de «${p.name}»`).not.toContain('origin');
      expect(Object.keys(p), `campos de «${p.name}»`).not.toContain('caliber');
      expect(Object.keys(p), `campos de «${p.name}»`).not.toContain('classEdits');
    }
    expect(Object.keys(rowsOf(after, 'products').find((p) => p.id === 'e-limon')!)).not.toContain('quality'); // sin calidad sigue sin calidad
    for (const s of rowsOf(after, 'sales')) for (const i of s.items) expect(Object.keys(i), `renglón de la venta #${s.folio}`).not.toContain('cls');
    expect(Object.fromEntries(rowsOf(after, 'products').map((p) => [p.id, p.priceCents]))).toEqual({ 'e-limon': 2500, 'e-criollo': 1800, 'e-caja': 45_000, 'e-viejo': 1500 });

    // Inventario: la existencia negativa se ve (y se avisa), la caja se cuenta en cajas y el producto oculto sigue oculto
    const inv = await uiInventory(page);
    expect(inv).toEqual([
      { label: 'Limón', physical: '80 kg', reserved: '0 g', available: '80 kg' },
      { label: 'Limón criollo · Segunda', physical: '-5 kg', reserved: '0 g', available: '-5 kg' },
      { label: 'Caja limonera', physical: '12 caja', reserved: '2 caja', available: '10 caja' },
      { label: 'Limón viejo', physical: '3 kg', reserved: '0 g', available: '3 kg' },
    ]);
    await expect(invRow(page, 'Limón criollo · Segunda').getByTestId('stock-negative')).toContainText('Quedan -5 kg');
    await expect(invRow(page, 'Limón viejo')).toHaveClass(/inactive/);
    await expect(invRow(page, 'Limón viejo').getByRole('button', { name: 'Activar' })).toBeVisible();
    await expect(page.getByTestId('stock-negative')).toHaveCount(1); // solo el de «Limón criollo»

    // Caja: ofrece las 3 variedades activas (no la oculta), con el precio guardado y sin inventar nada
    await tab(page, 'caja');
    await expect(page.getByTestId('variety')).toHaveText(['Limón', 'Limón criollo', 'Caja limonera']);
    await expect(page.getByTestId('selling')).toContainText('Vendiendo: Limón');
    await expect(page.getByTestId('price')).toHaveValue('25');
    await expect(page.getByTestId('stock-hint')).toContainText('Disponible: 80 kg');

    // Corte: $1,900.00 y 3 ventas por $1,420.00
    await tab(page, 'corte');
    await expect(page.getByTestId('r-expected')).toHaveText('$1,900.00');
    await expect(page.getByTestId('r-total')).toHaveText('$1,420.00');

    // Vales: el pendiente por 2 cajas conserva cliente, unidad y dinero
    await tab(page, 'vales');
    await expect(page.getByTestId('vale')).toHaveCount(1);
    await expect(page.getByTestId('vale').first()).toContainText('Vale V-1');
    await expect(page.getByTestId('vale').first()).toContainText('Abarrotes Lupe');
    await expect(page.getByTestId('vale').first()).toContainText('Caja limonera · 2 caja');
    await expect(page.getByTestId('vale').first()).toContainText('$900.00 pagado');

    // Auditoría: sin inconsistencias, y el negativo autorizado se informa como aviso (no se oculta ni se «arregla»)
    const audit = await runAuditUi(page);
    await expect(audit).toContainText(auditoriaOk(3, 1, 0, 7));
    await expect(page.getByTestId('audit-warnings')).toContainText('Limón criollo · Segunda');
    await expect(page.getByTestId('audit-warnings')).toContainText('existencia disponible negativa');
    await expect(page.getByTestId('audit-warnings')).toContainText('autorizaciones registradas');
    expectRawClean(await readRawDb(page), 'casos límite');
  });

  test('b) sobre esos datos: se entrega el vale por cajas y una recepción cubre la existencia negativa (solo variedades por kg y activas)', async ({ page }) => {
    test.setTimeout(60_000);
    await seedV1(page, edgeV1(), { extraMeta: [EDGE_CART_DRAFT] });
    await page.goto('/');
    await expect(page.getByTestId('upgraded')).toBeVisible();

    // Entregar el vale de 2 cajas: salen 2 del físico y del apartado
    await tab(page, 'vales');
    await page.getByTestId('deliver').click();
    await expectToast(page, 'Vale V-1 entregado');
    const inv = await uiInventory(page);
    expect(inv.find((r) => r.label === 'Caja limonera')).toEqual({ label: 'Caja limonera', physical: '10 caja', reserved: '0 caja', available: '10 caja' });

    // Recepción: solo se ofrecen las variedades ACTIVAS vendidas por kg (no la caja, no la oculta)
    await tab(page, 'recepcion');
    await page.getByTestId('rec-sub-nueva').click();
    await expect(page.getByTestId('rec-variety')).toHaveText(['Limón', 'Limón criollo']);

    // La variedad con -5 kg: la pantalla lo dice y la recepción de 20 kg lo cubre (-5 + 20 = 15)
    await fillReception(page, { variety: 'Limón criollo', packaging: 'granel', mode: 'directo', net: '20' });
    await expect(page.getByTestId('rec-selected')).toContainText('disponible negativo (-5 kg): esta recepción lo cubre');
    await page.getByTestId('rec-confirm').click();
    await expect(page.getByTestId('rec-sheet-covers')).toContainText('5 kg vendidos o apartados sin existencia');
    await expect(page.getByTestId('rec-sheet-stock')).toContainText('-5 kg');
    await expect(page.getByTestId('rec-sheet-stock')).toContainText('15 kg');
    await page.getByTestId('rec-confirm-yes').click();
    await expectToast(page, 'Recepción R-1 registrada: +20 kg');

    const raw = await readRawDb(page);
    expect(rowsOf(raw, 'products').find((p) => p.id === 'e-criollo')).toMatchObject({ physicalMilli: 15_000, reservedMilli: 0 });
    expect(rowsOf(raw, 'products').find((p) => p.id === 'e-caja')).toMatchObject({ physicalMilli: 10_000, reservedMilli: 0 });
    expect(rowsOf(raw, 'products').find((p) => p.id === 'e-viejo')).toMatchObject({ active: false, physicalMilli: 3000 }); // sigue oculto e intacto
    expectRawClean(raw, 'casos límite operados');
    // Con existencia positiva, el aviso de negativo desaparece de Inventario
    await uiInventory(page);
    await expect(page.getByTestId('stock-negative')).toHaveCount(0);
  });
});

test.describe('Base que no se puede abrir: versión más nueva, migración fallida y ventanas a la vez (caso 24, c y d)', () => {
  /** Base de VERSIÓN 99 (de una app futura): lo de v1 + una tabla que esta app no conoce. */
  async function seedFuture(page: Page) {
    const f = fixtureV1();
    await seedDatabase(page, {
      version: 99,
      stores: [
        ...v1Stores({
          products: f.products, sales: f.sales, shifts: f.shifts, cashMovements: f.cashMovements, stockMoves: f.stockMoves,
          meta: [{ key: 'nextFolio', value: f.nextFolio }, { key: 'nextValeFolio', value: f.nextValeFolio }],
        }),
        { name: 'tablaDelFuturo', keyPath: 'id', rows: [{ id: 'x1', dato: 'solo la app futura lo entiende' }] },
      ],
    });
    return f;
  }
  const totalRows = (raw: RawDb | null) => Object.values(raw!.stores).reduce((a, s) => a + s.rows.length, 0);

  test('c) base de versión MÁS NUEVA (v99): panel de error con ayuda clara, sin caja ni pestañas, y la base no se borra ni baja de versión', async ({ page }) => {
    await seedFuture(page);
    const before = await readRawDb(page);
    expect(before!.version).toBe(99);

    await page.goto('/');
    await expect(page.getByTestId('fatal')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No se pudo abrir la base de datos' })).toBeVisible();
    // Ayuda en español llano, sin jerga y sin culpar
    await expect(page.getByTestId('fatal-help')).toContainText('versión MÁS NUEVA que esta copia de la app');
    await expect(page.getByTestId('fatal-help')).toContainText('No se borró nada');
    await expect(page.getByTestId('fatal')).toContainText('No borres los datos de la app ni la desinstales');
    await expect(page.getByTestId('emergency-dump')).toBeVisible();
    await expect(page.getByTestId('emergency-dump')).toContainText('Descargar copia de emergencia de mis datos');
    // El detalle técnico existe pero está plegado
    await page.getByText('Detalle técnico').click();
    await expect(page.locator('.fatal details')).toContainText('VersionError');

    // Sin caja ni pestañas: no se puede vender ni escribir en una base que esta app no entiende
    await expect(page.getByTestId('caja')).toHaveCount(0);
    await expect(page.getByTestId('tab-caja')).toHaveCount(0);
    await expect(page.getByTestId('upgraded')).toHaveCount(0);

    // La base: misma versión (99), mismas tablas e índices, mismas filas; no se creó nada
    expect(await readRawDb(page)).toEqual(before);
    expect(await versionOf(page)).toBe(99);
    // Recargar tampoco la toca
    await page.reload();
    await expect(page.getByTestId('fatal')).toBeVisible();
    expect(await readRawDb(page)).toEqual(before);
  });

  test('c) base v99: la copia de emergencia baja TODO lo que hay (también lo que la app no entiende) y no toca la base', async ({ page }) => {
    await seedFuture(page);
    const before = await readRawDb(page);
    await page.goto('/');
    await expect(page.getByTestId('fatal')).toBeVisible();

    const dump = await captureDownload(page, () => page.getByTestId('emergency-dump').click());
    expect(dump.filename).toMatch(/^emergencia-limones-\d{4}-\d{2}-\d{2}\.json$/);
    expect(dump.json).toMatchObject({ app: 'sistema-venta-limones', kind: 'emergency-raw-dump', database: 'venta-limones', version: 99 });
    expect(Object.keys(dump.json.stores).sort()).toEqual(Object.keys(before!.stores).sort());
    for (const [name, store] of Object.entries(before!.stores)) expect(dump.json.stores[name], `tabla «${name}» en la copia`).toEqual(store.rows);
    expect(dump.json.stores.tablaDelFuturo).toEqual([{ id: 'x1', dato: 'solo la app futura lo entiende' }]);
    // Se le dice a la persona cuántos registros se bajaron
    await expect(page.getByTestId('emergency-result')).toContainText(`se descargó una copia con ${totalRows(before)} registros`);
    expect(totalRows(before)).toBe(4 + 7 + 2 + 2 + 13 + 2 + 1); // variedades + ventas + turnos + caja + movimientos + meta + tabla futura
    // La copia de emergencia solo LEE
    expect(await readRawDb(page)).toEqual(before);
  });

  test('d) migración que FALLA en el navegador (base v1 sin la tabla stockMoves): se revierte, queda en v1 con todos sus datos y la copia de emergencia los saca', async ({ page }) => {
    const f = fixtureV1();
    // Una v1 «mutilada»: sin stockMoves la migración 2 no puede crear su índice y lanza un error a media actualización
    await seedV1(page, f, { omit: ['stockMoves'] });
    const before = await readRawDb(page);
    expect(before!.version).toBe(1);
    expect(before!.stores.stockMoves).toBeUndefined();

    await page.goto('/');
    await expect(page.getByTestId('fatal')).toBeVisible();
    await expect(page.getByTestId('fatal-help')).toContainText('La actualización de los datos no se pudo completar');
    await expect(page.getByTestId('fatal-help')).toContainText('No se perdió nada: los datos siguen como estaban');
    await expect(page.getByTestId('emergency-dump')).toBeVisible();
    await expect(page.getByTestId('upgraded')).toHaveCount(0); // no se avisa de una actualización que no ocurrió
    await expect(page.getByTestId('caja')).toHaveCount(0);

    // El navegador revirtió TODO: sigue en la versión 1, sin la tabla nueva y con todas las filas
    const after = await readRawDb(page);
    expect(after, 'la base quedó exactamente como antes del intento').toEqual(before);
    expect(after!.version).toBe(1);
    expect(after!.stores.receptions).toBeUndefined();
    expect(await versionOf(page)).toBe(1);

    // La copia de emergencia saca los datos de la base v1 intacta
    const dump = await captureDownload(page, () => page.getByTestId('emergency-dump').click());
    expect(dump.json).toMatchObject({ kind: 'emergency-raw-dump', version: 1 });
    expect(dump.json.stores.sales).toEqual(rowsOf(before, 'sales'));
    expect(dump.json.stores.products).toEqual(rowsOf(before, 'products'));
    expect(dump.json.stores.stockMoves).toBeUndefined();
    // Y reintentar no empeora nada
    await page.reload();
    await expect(page.getByTestId('fatal')).toBeVisible();
    expect(await readRawDb(page)).toEqual(before);
  });

  test('d) otra ventana con la versión anterior sigue abierta y bloquea la actualización: la app avisa y continúa sola al cerrarla', async ({ page, context }) => {
    const { f } = fixtureIds();
    await seedV1(page, f);
    // `page` hace de ventana VIEJA: mantiene abierta la base v1 y no atiende el aviso de cambio de versión (no es la app real)
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open('venta-limones', 1);
          req.onsuccess = () => {
            (window as unknown as { __vieja: IDBDatabase }).__vieja = req.result;
            resolve();
          };
          req.onerror = () => reject(req.error);
        }),
    );
    const before = await readRawDb(page);

    const nueva = await context.newPage();
    await nueva.goto('/');
    // Aparece solo si tarda (a los ~2.5 s)
    await expect(nueva.getByTestId('blocked')).toBeVisible({ timeout: 10_000 });
    await expect(nueva.getByTestId('blocked')).toContainText('otra ventana de la app abierta con una versión anterior');
    await expect(nueva.getByTestId('blocked')).toContainText('continuará sola');
    await expect(nueva.getByTestId('caja')).toHaveCount(0);
    // Mientras tanto no se tocó nada: sigue v1. (No se LEE la base aquí: en IndexedDB una apertura nueva espera su turno detrás
    // de la actualización pendiente; solo la lista de bases y su versión responden de inmediato.)
    expect(await versionOf(page)).toBe(1);

    // Se cierra la ventana vieja → la nueva termina de actualizar sin que nadie recargue
    await page.evaluate(() => (window as unknown as { __vieja: IDBDatabase }).__vieja.close());
    await expect(nueva.getByTestId('upgraded')).toBeVisible({ timeout: 10_000 });
    await expect(nueva.getByTestId('blocked')).toHaveCount(0);
    await expectAppReady(nueva);
    const after = await readRawDb(nueva);
    expect(after!.version).toBe(3);
    expectSameData(after, before, 'tras desbloquear', V1_DATA_STORES);
  });

  test('d) una ventana con la versión NUEVA pide la base: esta se aparta («La app se actualizó») y no se pierde nada', async ({ page, context }) => {
    test.setTimeout(60_000);
    await openApp(page); // ventana de la app (v2) con datos
    await sellCash(page, '1', [50]);
    const before = await readRawDb(page);
    expect(rowsOf(before, 'sales')).toHaveLength(1);

    // Otra «ventana» (no es la app real: es una conexión simple) pide la versión 4, como lo haría una app más nueva que la actual (3)
    const nueva = await context.newPage();
    await nueva.goto('/manifest.webmanifest');
    await nueva.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open('venta-limones', 4);
          req.onsuccess = () => {
            req.result.close();
            resolve();
          };
          req.onerror = () => reject(req.error);
          req.onblocked = () => reject(new Error('la ventana abierta no se apartó'));
        }),
    );

    await expect(page.getByTestId('stale')).toBeVisible();
    await expect(page.getByTestId('stale')).toContainText('La app se actualizó');
    await expect(page.getByTestId('stale')).toContainText('ya no puede guardar datos');
    await expect(page.getByTestId('reload')).toBeVisible();
    await expect(page.getByTestId('caja')).toHaveCount(0); // no se puede seguir vendiendo desde la ventana vieja
    const after = await readRawDb(page);
    expect(after!.version).toBe(4);
    expectSameData(after, before, 'tras apartarse');
    expect(metaOf(after)).toEqual(metaOf(before));
  });
});

test.describe('Actualización REAL desde la app anterior (caso 24, 19)', () => {
  test('real) datos creados por la app ANTERIOR de verdad (v1 compilada del último commit): al servir la versión nueva en el mismo origen, el service worker se actualiza, la base migra sin perder nada y el respaldo v1 real se restaura', async ({ browser }, testInfo) => {
    test.setTimeout(300_000); // compilar la app anterior + dos versiones de la app en el mismo teléfono
    const v1 = compilarAppAnterior(testInfo);
    const v2 = join(raizDelProyecto(), process.env.E2E_OUT_DIR ?? 'dist-e2e');
    const a = await servirCarpeta(v1);
    const origen = `http://127.0.0.1:${a.port}`;
    let b: Awaited<ReturnType<typeof servirCarpeta>> | undefined;
    const ctx = await browser.newContext({ serviceWorkers: 'allow', baseURL: origen });
    try {
      const page = await ctx.newPage();

      // ── La app ANTERIOR, usada por la pantalla: 3 variedades, inventario, una venta, un vale pendiente y una salida de efectivo
      await openApp(page);
      await expect(page.getByTestId('tab-recepcion'), 'esta es la app anterior: no tiene Recepción').toHaveCount(0);
      await tab(page, 'inventario');
      const fila = page.getByTestId('inv-row').first();
      await fila.getByTestId('move-entrada').click();
      await fila.getByTestId('move-qty').fill('100');
      await fila.getByTestId('move-save').click();
      await expectToast(page, 'Entrada registrada'); // (el texto de la app anterior)
      await tab(page, 'caja');
      await sellCash(page, '1', [50]); // venta #1: 1 kg × $30
      await page.getByTestId('kg').fill('20');
      await page.getByTestId('exact').click();
      await page.getByTestId('is-vale').check();
      await page.getByTestId('customer').fill('Doña Mary');
      await charge(page); // venta #2 / vale V-1: 20 kg × $30 = $600
      await tab(page, 'corte');
      await page.getByTestId('out-amount').fill('15');
      await page.getByTestId('out-concept').fill('bolsas');
      await page.getByTestId('out-save').click();
      await expect(page.getByTestId('r-expected')).toHaveText('$615.00'); // 30 + 600 − 15
      // Respaldo REAL de la app anterior (formato v1) y foto de su base
      await tab(page, 'mas');
      const respaldoV1 = await captureDownload(page, () => page.getByTestId('export').click());
      expect(respaldoV1.json.version).toBe(1);
      expect(respaldoV1.json.receptions).toBeUndefined();
      const antes = await readRawDb(page);
      expect(antes!.version).toBe(1);
      expect(rowsOf(antes, 'sales')).toHaveLength(2);
      const cachesAntes = await page.evaluate(async () => (await caches.keys()).sort());
      expect(cachesAntes.length, 'la app anterior dejó su caché sin conexión').toBe(1);

      // ── Se «actualiza la app»: el equipo que la sirve pasa a la versión nueva (mismo origen, mismo teléfono, mismos datos)
      await a.close();
      b = await servirCarpeta(v2, a.port);
      await page.goto('/'); // el service worker VIEJO sirve la app vieja desde su caché; el nuevo se instala en segundo plano
      await expect
        .poll(async () => page.evaluate(async () => (await caches.keys()).sort()), { message: 'el service worker nuevo debe tomar el control y cambiar la caché', timeout: 20_000 })
        .not.toEqual(cachesAntes);
      // Como la persona: cierra y vuelve a abrir (recarga) hasta ver la app nueva
      let recargas = 0;
      while (!(await page.getByTestId('upgraded').count()) && recargas < 4) {
        await page.reload();
        recargas++;
        await expect(page.getByTestId('caja')).toBeVisible();
      }
      testInfo.annotations.push({ type: 'actualización', description: `la app nueva apareció tras ${recargas} recarga(s) después de abrir con el service worker viejo` });
      console.log(`[migración real] la app nueva apareció tras ${recargas} recarga(s) después de abrir con el service worker viejo`);
      await expect(page.getByTestId('upgraded'), 'tras recargar debe verse la app NUEVA con su aviso de actualización').toBeVisible();
      await expect(page.getByTestId('tab-recepcion')).toBeVisible();

      // ── La base: v3 (la actual), y lo que creó la app anterior, idéntico
      const despues = await readRawDb(page);
      expect(despues!.version).toBe(3);
      expectSameData(despues, antes, 'tras actualizar la app', V1_DATA_STORES);
      expect(metaOf(despues)).toEqual(metaOf(antes));
      expect(rowsOf(despues, 'receptions')).toEqual([]);
      expectRawClean(despues, 'datos de la app anterior, ya en la nueva');
      // Lo que se ve (a mano): Primera 100 − 1 = 99 kg en bodega, 20 apartados, 79 disponibles; efectivo $615.00
      const inv = await uiInventory(page);
      expect(inv[0]).toEqual({ label: 'Limón persa · Primera', physical: '99 kg', reserved: '20 kg', available: '79 kg' });
      await tab(page, 'corte');
      await expect(page.getByTestId('r-expected')).toHaveText('$615.00');
      await expect(page.getByTestId('r-total')).toHaveText('$630.00');
      await tab(page, 'vales');
      await expect(page.getByTestId('vale')).toHaveCount(1);
      await expect(page.getByTestId('vale').first()).toContainText('Vale V-1');
      await expect(page.getByTestId('vale').first()).toContainText('Doña Mary');
      // La app nueva sigue sobre esos datos: recepción R-1, venta #3, entrega del vale V-1
      await receive(page, { variety: 'Limón persa', cls: 'Primera', packaging: 'granel', mode: 'directo', net: '10' }, { toast: 'Recepción R-1 registrada: +10 kg', milli: 10_000 });
      await sellExact(page, '1');
      await expect(page.getByTestId('last-sale')).toContainText('#3');
      await tab(page, 'vales');
      await page.getByTestId('deliver').click();
      await expectToast(page, 'Vale V-1 entregado');
      expectRawClean(await readRawDb(page), 'app nueva operando sobre datos de la anterior');
      await expect(await runAuditUi(page)).toContainText(auditoriaOk(3, 1, 1));

      // ── El respaldo REAL de la app anterior se restaura en otro teléfono con la app nueva
      const otro = await browser.newContext({ serviceWorkers: 'allow', baseURL: origen });
      try {
        const p2 = await otro.newPage();
        await openApp(p2, { seed: false });
        await chooseBackup(p2, textFile(respaldoV1.text, respaldoV1.filename));
        await expect(p2.getByTestId('restore-summary')).toContainText('2 ventas, 0 recepciones, 3 variedades, 3 movimientos de inventario');
        await confirmRestoreSheet(p2);
        const restaurado = await readRawDb(p2);
        expectSameData(restaurado, antes, 'respaldo real de la app anterior', V1_DATA_STORES);
        expect(metaOf(restaurado)).toMatchObject({ nextFolio: 3, nextValeFolio: 2, nextReceptionFolio: 1 });
        expectRawClean(restaurado, 'respaldo real de la app anterior, restaurado');
        await expect(p2.getByTestId('upgraded')).toHaveCount(0);
      } finally {
        await otro.close();
      }
    } finally {
      await ctx.close();
      await a.close();
      await b?.close();
    }
  });
});

test.describe('Reinicio real del navegador (caso 17)', () => {
  test('i) cerrar y reabrir Chromium con el mismo perfil: recepciones, borradores, ventas y vales siguen con los mismos folios y la captura a medias se recupera', async ({}, testInfo) => {
    test.setTimeout(240_000); // dos sesiones completas de navegador, con muchos pasos de pantalla
    const dir = testInfo.outputPath('perfil-reinicio');
    let ctx = await launchProfile(testInfo, dir);
    let page = ctx.pages()[0] ?? (await ctx.newPage());
    try {
      await openApp(page); // 3 variedades por la interfaz
      // Tres recepciones: a granel, en arpillas y en cajas con bruto − tara
      await receive(page, { variety: 'Con semilla', packaging: 'granel', mode: 'directo', net: '120', supplier: 'Rancho Sol', reference: 'CAM-1' }, { toast: 'Recepción R-1 registrada: +120 kg', milli: 120_000 });
      await receive(page, { variety: 'Limón persa', cls: 'Primera', packaging: 'arpilla', mode: 'por_envase', containers: '20', unit: '15.5' }, { toast: 'Recepción R-2 registrada: +310 kg', milli: 310_000 });
      await receive(page, { variety: 'Limón persa', cls: 'Segunda', packaging: 'caja', mode: 'bruto_tara', gross: '210', tare: '10', containers: '10' }, { toast: 'Recepción R-3 registrada: +200 kg', milli: 200_000 });
      // Un borrador (no suma) y ventas: normal (#1) y vale (#2 / V-1)
      await fillReception(page, { variety: 'Limón persa', cls: 'Primera', packaging: 'caja', mode: 'por_envase', containers: '8' });
      await saveReceptionDraftUi(page, 'Borrador guardado (aún sin peso neto): no suma al inventario');
      await sellExact(page, '10');
      await sellVale(page, '25', 'Doña Mary');
      // Captura a medias (NO se registra): se guarda sola
      await fillReception(page, { variety: 'Con semilla', packaging: 'granel', mode: 'directo', net: '55', supplier: 'Pendiente de pesar' });
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem('limones.rec.form.v1')), { message: 'la captura en curso debería guardarse sola' })
        .toContain('Pendiente de pesar');

      const before = await readRawDb(page);
      // A mano: Primera 310 − 10 = 300 kg físico y 25 reservados; Segunda 200; Con semilla 120
      const phys = (raw: RawDb | null, name: string, q?: string) => rowsOf(raw, 'products').find((p) => p.name === name && p.quality === q)!;
      expect(phys(before, 'Limón persa', 'Primera')).toMatchObject({ physicalMilli: 300_000, reservedMilli: 25_000 });
      expect(phys(before, 'Limón persa', 'Segunda')).toMatchObject({ physicalMilli: 200_000, reservedMilli: 0 });
      expect(phys(before, 'Con semilla')).toMatchObject({ physicalMilli: 120_000 });
      expect(rowsOf(before, 'receptions').map((r) => `${r.folio ?? '-'}:${r.status}`).sort()).toEqual(['-:borrador', '1:confirmada', '2:confirmada', '3:confirmada']);
      expect(metaOf(before)).toMatchObject({ nextFolio: 3, nextValeFolio: 2, nextReceptionFolio: 4 });
      expectRawClean(before, 'antes de reiniciar');

      await ctx.close(); // el navegador se cierra por completo
      ctx = await launchProfile(testInfo, dir);
      page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto('/');
      await expectAppReady(page);
      await expect(page.getByTestId('upgraded')).toHaveCount(0);

      // Lo guardado en disco está idéntico: registros, índices, folios y movimientos
      expect(await readRawDb(page), 'la base tras el reinicio').toEqual(before);

      // Lo que se VE: historial con los mismos folios y kilos, borrador y última registrada
      await tab(page, 'recepcion');
      await expect(page.getByTestId('rec-sub-borradores')).toHaveText('Borradores (1)');
      await page.getByTestId('rec-sub-historial').click();
      await expect(page.getByTestId('rec-row')).toHaveCount(3);
      await expect(page.getByTestId('rec-hist-total')).toContainText('3 recepciones registradas · 630 kg en total');
      for (const [folio, kg] of [[1, '120 kg'], [2, '310 kg'], [3, '200 kg']] as const) {
        await expect(page.getByTestId('rec-row').filter({ hasText: new RegExp(`R-${folio} ·`) }).getByTestId('rec-row-net')).toHaveText(kg);
      }
      const inv = await uiInventory(page);
      expect(inv.find((r) => r.label === 'Limón persa · Primera')).toMatchObject({ physical: '300 kg', reserved: '25 kg', available: '275 kg' });
      expect(inv.find((r) => r.label === 'Con semilla')).toMatchObject({ physical: '120 kg' });
      await tab(page, 'vales');
      await expect(page.getByTestId('vale')).toHaveCount(1);
      await expect(page.getByTestId('vale').first()).toContainText('Vale V-1');

      // La captura a medias volvió, con lo escrito, y se puede terminar de registrar: R-4 (los folios continúan)
      await tab(page, 'recepcion');
      await page.getByTestId('rec-sub-nueva').click();
      await expect(page.getByTestId('rec-restored')).toBeVisible();
      await expect(page.getByTestId('rec-supplier')).toHaveValue('Pendiente de pesar');
      await expect(page.getByTestId('rec-net-direct')).toHaveValue('55');
      await expect(page.getByTestId('rec-selected')).toContainText('Con semilla');
      await registerReception(page, { toast: 'Recepción R-4 registrada: +55 kg', milli: 55_000 });
      await sellExact(page, '1');
      await expect(page.getByTestId('last-sale')).toContainText('#3'); // el siguiente de #1 y #2
      await sellVale(page, '2', 'Pepe');
      await expect(page.getByTestId('last-sale')).toContainText('#4');
      await expect(page.getByTestId('last-sale')).toContainText('VALE V-2');

      const after = await readRawDb(page);
      expect(metaOf(after)).toMatchObject({ nextFolio: 5, nextValeFolio: 3, nextReceptionFolio: 5 });
      expect(rowsOf(after, 'receptions').filter((r) => r.folio !== undefined).map((r) => r.folio).sort()).toEqual([1, 2, 3, 4]);
      expectRawClean(after, 'después de reiniciar y seguir');
      // (el contador de recepciones de la auditoría cuenta todos los documentos: R-1 a R-4 y el borrador)
      const audit = await runAuditUi(page);
      await expect(audit).toContainText(auditoriaOk(4, 2, 5));
    } finally {
      await ctx.close(); // (cerrar un contexto ya cerrado no falla)
    }
  });
});

for (const phone of PHONES) {
  test.describe(`Pantallas de migración · ${phone.name}`, () => {
    test.use({ viewport: { width: phone.width, height: phone.height } });

    test('aviso «La app se actualizó»: cabe en la pantalla, sin desbordar, con y sin teclado emulado, y sus botones responden al primer toque', async ({ page }) => {
      await seedV1(page, fixtureV1());
      await page.goto('/');
      const notice = page.getByTestId('upgraded');
      await expect(notice).toBeVisible();
      expect(await overflowing(page), 'desbordamiento con el teclado cerrado').toEqual([]);
      await expectInsideViewport(page, notice, 'el aviso de actualización');
      await expectInsideViewport(page, page.getByTestId('upgraded-go'), '«Ir a Respaldo»');
      await expectInsideViewport(page, page.getByTestId('upgraded-close'), '«Cerrar»');

      // Misma pantalla con la ventana encogida como la deja el teclado de Android
      await showKeyboard(page, phone);
      expect(await overflowing(page), 'desbordamiento con el teclado abierto').toEqual([]);
      await expect(notice).toBeVisible();
      await hideKeyboard(page, phone);

      // Toque táctil real: el primer toque lleva a Respaldo y quita el aviso
      await watchTaps(page);
      await page.getByTestId('upgraded-go').tap();
      await expectSolidTap(page, 'upgraded-go');
      await expect(page.getByTestId('mas')).toBeVisible();
      await expect(notice).toHaveCount(0);
      expect(await overflowing(page), 'desbordamiento en Respaldo').toEqual([]);
    });

    test('avisos de varias ventanas («ventana anterior abierta» y «La app se actualizó»): caben, sin desbordar, con y sin teclado emulado', async ({ page, context }) => {
      test.setTimeout(60_000);
      // Otra ventana (que no es la app real) mantiene abierta la base v1 y bloquea la actualización
      const vieja = await context.newPage();
      await seedV1(vieja, fixtureV1());
      await vieja.evaluate(
        () =>
          new Promise<void>((resolve, reject) => {
            const req = indexedDB.open('venta-limones', 1);
            req.onsuccess = () => {
              (window as unknown as { __vieja: IDBDatabase }).__vieja = req.result;
              resolve();
            };
            req.onerror = () => reject(req.error);
          }),
      );
      await page.goto('/');
      const blocked = page.getByTestId('blocked');
      await expect(blocked).toBeVisible({ timeout: 10_000 });
      expect(await overflowing(page), 'desbordamiento en «ventana anterior abierta»').toEqual([]);
      await expectInsideViewport(page, blocked, 'el aviso de ventana anterior abierta');
      await showKeyboard(page, phone);
      expect(await overflowing(page), 'desbordamiento en «ventana anterior abierta» con el teclado abierto').toEqual([]);
      await hideKeyboard(page, phone);

      // Se cierra la vieja: la app termina de actualizar. Luego otra ventana pide la versión 4 (más nueva que la 3 actual) y esta se aparta.
      await vieja.evaluate(() => (window as unknown as { __vieja: IDBDatabase }).__vieja.close());
      await expect(page.getByTestId('upgraded')).toBeVisible({ timeout: 10_000 });
      const nueva = await context.newPage();
      await nueva.goto('/manifest.webmanifest');
      await nueva.evaluate(
        () =>
          new Promise<void>((resolve, reject) => {
            const req = indexedDB.open('venta-limones', 4);
            req.onsuccess = () => {
              req.result.close();
              resolve();
            };
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('la ventana abierta no se apartó'));
          }),
      );
      const stale = page.getByTestId('stale');
      await expect(stale).toBeVisible();
      expect(await overflowing(page), 'desbordamiento en «La app se actualizó»').toEqual([]);
      await expectInsideViewport(page, page.getByTestId('reload'), '«Recargar para continuar»');
      await showKeyboard(page, phone);
      expect(await overflowing(page), 'desbordamiento en «La app se actualizó» con el teclado abierto').toEqual([]);
      await expectInsideViewport(page, page.getByTestId('reload'), '«Recargar para continuar» con el teclado abierto');
    });

    test('panel de error (base de versión más nueva): cabe en la pantalla, sin desbordar, y «Descargar copia de emergencia» responde al primer toque', async ({ page }) => {
      const f = fixtureV1();
      await seedDatabase(page, { version: 99, stores: v1Stores({ products: f.products, sales: f.sales, shifts: f.shifts, cashMovements: f.cashMovements, stockMoves: f.stockMoves, meta: [] }) });
      await page.goto('/');
      await expect(page.getByTestId('fatal')).toBeVisible();
      expect(await overflowing(page), 'desbordamiento con el teclado cerrado').toEqual([]);
      await expectInsideViewport(page, page.getByTestId('emergency-dump'), 'el botón de la copia de emergencia');

      await showKeyboard(page, phone);
      expect(await overflowing(page), 'desbordamiento con el teclado abierto').toEqual([]);
      await hideKeyboard(page, phone);

      await watchTaps(page);
      const dump = await captureDownload(page, () => page.getByTestId('emergency-dump').tap());
      await expectSolidTap(page, 'emergency-dump');
      expect(dump.json.version).toBe(99);
      expect(dump.json.stores.sales).toHaveLength(7);
      await expect(page.getByTestId('emergency-result')).toBeVisible();
      expect(await overflowing(page), 'desbordamiento tras descargar').toEqual([]);
    });
  });
}

/**
 * Control de las propias pruebas: los datos que se siembran a mano deben ser coherentes según la auditoría INDEPENDIENTE de
 * las pruebas (si no, las demás pruebas se medirían contra datos mal armados) y esa auditoría debe DETECTAR desajustes (si
 * aceptara todo, «sin problemas» no probaría nada). No necesita navegador.
 */
test('la auditoría independiente de las pruebas acepta los datos de partida y detecta los desajustes inyectados (control negativo)', () => {
  const partida: Array<[string, Record<string, unknown>]> = [
    ['fixture v1', fixtureV1()],
    ['casos límite de v1', edgeV1()],
    ['estado v2 completo', richV2() as unknown as Record<string, unknown>],
    ['respaldo sencillo de 5 ventas', simpleV2(5) as unknown as Record<string, unknown>],
  ];
  for (const [nombre, datos] of partida) expect(auditRaw(rawFromBackup(datos)), `datos de partida «${nombre}»`).toEqual([]);

  const roto = rawFromBackup(richV2() as unknown as Record<string, unknown>);
  rowsOf(roto, 'products').find((p) => p.id === 'p-sin')!.physicalMilli += 1; // saldo ≠ suma de movimientos
  rowsOf(roto, 'sales').find((x) => x.id === 'sale-1')!.totalCents += 100; // total ≠ renglones
  rowsOf(roto, 'receptions').find((r) => r.id === 'rec-1')!.confirmedNetMilli += 1; // recepción ≠ su movimiento
  rowsOf(roto, 'receptions').find((r) => r.id === 'rec-2')!.folio = 1; // folio repetido (R-1 y R-2)
  rowsOf(roto, 'receptions').find((r) => r.id === 'rec-4')!.productId = 'no-existe'; // borrador con una variedad que no existe
  rowsOf(roto, 'stockMoves').push({ id: 'huerfano', productId: 'fantasma', createdAt: '2026-10-05T16:00:00.000Z', type: 'entrada', deltaMilli: 1000, reservedDeltaMilli: 0, note: '' });
  const problemas = auditRaw(roto).join(' | ');
  expect(problemas).toMatch(/físico 130001 ≠ Σ movimientos 130000/);
  expect(problemas).toMatch(/el total no es la suma de sus renglones/);
  expect(problemas).toMatch(/el movimiento sumó 150000 y se confirmaron 150001/);
  expect(problemas).toMatch(/folio de recepción repetido: 1/);
  expect(problemas).toMatch(/movimiento huerfano: su variedad no existe/);
  expect(problemas).toMatch(/recepción [^:]*\(borrador\): su variedad no existe/);
});
