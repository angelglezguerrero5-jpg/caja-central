import { expect, test, type Browser, type Page } from '@playwright/test';
import { statSync, writeFileSync } from 'node:fs';
import { charge, openApp, tab } from './helpers';
import {
  PHONES,
  UNDO_DB_NAME,
  auditRaw,
  auditoriaOk,
  captureDownload,
  cashExpected,
  chooseBackup,
  confirmRestoreSheet,
  correctReceptionUi,
  discardDraftUi,
  exact,
  expectAppReady,
  expectErrorToast,
  expectInsideViewport,
  expectRawClean,
  expectSameData,
  expectSolidTap,
  expectToast,
  exportBackupUi,
  fillReception,
  fixtureV1,
  hideKeyboard,
  invRow,
  jsonFile,
  metaOf,
  overflowing,
  rawFromBackup,
  readRawDb,
  receive,
  registerReception,
  richV2,
  rowsOf,
  runAuditUi,
  saveReceptionDraftUi,
  seedDatabase,
  seedV1,
  seedV2,
  sellExact,
  sellVale,
  showKeyboard,
  simpleV2,
  textFile,
  toastOf,
  uiInventory,
  uploadOf,
  voidReceptionUi,
  watchTaps,
  type Rec,
  type RawDb,
  type UploadFile,
} from './helpers-migracion';

/**
 * RESPALDO Y RESTAURACIÓN en un navegador REAL (casos 18, 19, 20 y, en lo que toca, 23, 24 y 25).
 *
 * Las unitarias (tests/unit/backup-v2.test.ts) ya prueban la validación y la restauración sobre fake-indexeddb. Aquí va lo que
 * solo se ve con la app abierta: descargar de verdad el archivo, restaurarlo en OTRO dispositivo (otro contexto de navegador, con
 * su propia IndexedDB), la hoja de restauración que ve la persona, los avisos, «Deshacer», y que un archivo malo no cambie
 * NADA de lo guardado. Las cifras esperadas se calculan a mano y se cruzan con una auditoría propia de las pruebas.
 */

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const V1_STORES = ['products', 'sales', 'shifts', 'cashMovements', 'stockMoves'];
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const byId = (xs: Rec[]): Rec[] => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Otro teléfono: contexto nuevo de navegador (su propia IndexedDB), sin nada guardado. */
async function newDevice(browser: Browser) {
  const ctx = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await ctx.newPage();
  return { ctx, page };
}
/** La base es EXACTAMENTE la del respaldo v1 de la fixture (y sin recepciones). */
function expectIsFixtureV1(raw: RawDb | null, f: Rec, why: string) {
  for (const k of V1_STORES) expect(rowsOf(raw, k), `${why}: «${k}» debe ser la del respaldo`).toEqual(byId(f[k]));
  expect(rowsOf(raw, 'receptions'), `${why}: sin recepciones`).toEqual([]);
}
/** Abre la app con el estado v2 completo (richV2) ya guardado y devuelve lo que se ve y lo que hay en disco. */
async function openWithRich(page: Page) {
  await seedV2(page, richV2());
  await page.goto('/');
  await expectAppReady(page);
  const before = await readRawDb(page);
  const inventory = await uiInventory(page);
  return { before, inventory };
}

test.describe('Exportar y restaurar en otro dispositivo (caso 18, 23, 25)', () => {
  test('e) ventas, vale y recepciones en sus 5 estados: el archivo exportado trae todo con sus campos auditables; restaurado en OTRO dispositivo queda igual y los folios continúan', async ({ page, browser }) => {
    test.setTimeout(240_000); // ~35 pasos de pantalla en dos teléfonos con la máquina compartida
    // ── Armar el estado POR LA PANTALLA, como lo haría la persona
    await openApp(page);
    await receive(page, { variety: 'Con semilla', packaging: 'arpilla', mode: 'por_envase', containers: '10', unit: '15', supplier: 'Rancho Sol', reference: 'CAM-1' }, { toast: 'Recepción R-1 registrada: +150 kg', milli: 150_000 });
    await receive(page, { variety: 'Limón persa', cls: 'Primera', packaging: 'granel', mode: 'directo', net: '300' }, { toast: 'Recepción R-2 registrada: +300 kg', milli: 300_000 });
    await correctReceptionUi(page, 2, '280', 'báscula'); // corregida: 300 → 280
    await receive(page, { variety: 'Limón persa', cls: 'Segunda', packaging: 'caja', mode: 'bruto_tara', gross: '110', tare: '10', containers: '5' }, { toast: 'Recepción R-3 registrada: +100 kg', milli: 100_000 });
    await voidReceptionUi(page, 3, 'producto equivocado'); // anulada
    await fillReception(page, { variety: 'Limón persa', cls: 'Primera', packaging: 'caja', mode: 'por_envase', containers: '8' });
    await saveReceptionDraftUi(page, 'Borrador guardado (aún sin peso neto): no suma al inventario'); // borrador
    await fillReception(page, { variety: 'Limón persa', cls: 'Segunda', packaging: 'granel', mode: 'directo', net: '12' });
    await saveReceptionDraftUi(page, 'Borrador guardado: no suma al inventario');
    await discardDraftUi(page, 'Segunda'); // cancelada (descartada)
    await sellExact(page, '20'); // venta #1: 20 kg × $30 = $600
    await sellVale(page, '30', 'Doña Mary'); // venta #2 / vale V-1: 30 kg × $30 = $900

    const src = await readRawDb(page);
    expectRawClean(src, 'dispositivo de origen');
    const pid = (name: string, quality?: string) => rowsOf(src, 'products').find((p) => p.name === name && p.quality === quality)!.id as string;
    const conSemilla = pid('Con semilla');
    const primera = pid('Limón persa', 'Primera');
    const segunda = pid('Limón persa', 'Segunda');
    // A mano: Primera 300 − 20 (corrección) − 20 (venta) = 260 físico y 30 apartados · Con semilla 150 · Segunda 100 − 100 = 0
    expect(rowsOf(src, 'products').find((p) => p.id === primera)).toMatchObject({ physicalMilli: 260_000, reservedMilli: 30_000 });
    expect(rowsOf(src, 'products').find((p) => p.id === conSemilla)).toMatchObject({ physicalMilli: 150_000, reservedMilli: 0 });
    expect(rowsOf(src, 'products').find((p) => p.id === segunda)).toMatchObject({ physicalMilli: 0, reservedMilli: 0 });
    expect(rowsOf(src, 'stockMoves')).toHaveLength(7); // R-1: 1 · R-2: 2 · R-3: 2 · venta: 1 · reserva del vale: 1

    // ── Exportar: el archivo trae todo y coincide con lo guardado, registro por registro
    const file = await exportBackupUi(page);
    await expectToast(page, 'Respaldo exportado (2 ventas, 5 recepciones)');
    const b = file.json;
    expect(b).toMatchObject({ app: 'caja-central', version: 3, nextFolio: 3, nextValeFolio: 2, nextReceptionFolio: 4 });
    expect(b.exportedAt).toMatch(ISO);
    for (const k of [...V1_STORES, 'receptions']) expect(byId(b[k]), `«${k}» del archivo`).toEqual(byId(rowsOf(src, k)));
    expect(b.receptions).toHaveLength(5);
    expect(b.stockMoves).toHaveLength(7);
    expect(await readRawDb(page), 'exportar no cambia nada').toEqual(src);

    // Campos auditables de cada estado
    const statusOf = (s: string) => b.receptions.filter((r: Rec) => r.status === s);
    expect([statusOf('confirmada').length, statusOf('anulada').length, statusOf('borrador').length, statusOf('cancelada').length]).toEqual([2, 1, 1, 1]);
    const r = (folio: number) => b.receptions.find((x: Rec) => x.folio === folio);
    const moves = (recId: string) => b.stockMoves.filter((m: Rec) => m.receptionId === recId).map((m: Rec) => [m.type, m.deltaMilli, m.productId]).sort();

    const r1 = r(1);
    expect(r1).toMatchObject({
      status: 'confirmada', packaging: 'arpilla', containers: 10, weightMode: 'por_envase', unitNetMilli: 15_000, netMilli: 150_000, confirmedNetMilli: 150_000,
      supplier: 'Rancho Sol', reference: 'CAM-1', productId: conSemilla, productLabel: 'Con semilla', cls: { variety: 'Con semilla' }, corrections: [],
    });
    expect(r1.stockMoveId).toBe(`rcp:${r1.id}:in`);
    expect(r1.confirmedAt).toMatch(ISO);
    expect(r1.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(r1), 'los modos de peso son excluyentes: no hay campos de otro modo').not.toContain('netDirectMilli');
    expect(moves(r1.id)).toEqual([['recepcion', 150_000, conSemilla]]);

    const r2 = r(2);
    expect(r2).toMatchObject({ status: 'confirmada', packaging: 'granel', weightMode: 'directo', netDirectMilli: 300_000, confirmedNetMilli: 300_000, netMilli: 280_000, productId: primera, productLabel: 'Limón persa · Primera' });
    expect(r2.corrections).toEqual([
      { id: expect.any(String), at: expect.stringMatching(ISO), reason: 'báscula', previousNetMilli: 300_000, newNetMilli: 280_000, deltaMilli: -20_000, stockMoveId: `rcp:${r2.id}:c1` },
    ]);
    expect(moves(r2.id)).toEqual([['correccion_recepcion', -20_000, primera], ['recepcion', 300_000, primera]]);

    const r3 = r(3);
    expect(r3).toMatchObject({
      status: 'anulada', packaging: 'caja', containers: 5, weightMode: 'bruto_tara', grossMilli: 110_000, tareMilli: 10_000, netMilli: 0, confirmedNetMilli: 100_000,
      voidReason: 'producto equivocado', voidStockMoveId: `rcp:${r3.id}:void`, productId: segunda,
    });
    expect(r3.voidedAt).toMatch(ISO);
    expect(moves(r3.id)).toEqual([['recepcion', 100_000, segunda], ['reversa_recepcion', -100_000, segunda]]);

    const draft = statusOf('borrador')[0];
    expect(draft).toMatchObject({ packaging: 'caja', containers: 8, weightMode: 'por_envase', productId: primera, corrections: [] });
    for (const k of ['folio', 'netMilli', 'confirmedAt', 'confirmedNetMilli', 'stockMoveId']) expect(draft, `el borrador no tiene «${k}»`).not.toHaveProperty(k);
    expect(moves(draft.id)).toEqual([]);
    const canc = statusOf('cancelada')[0];
    expect(canc).toMatchObject({ packaging: 'granel', weightMode: 'directo', netDirectMilli: 12_000, cancelReason: 'borrador descartado', productId: segunda });
    expect(canc.cancelledAt).toMatch(ISO);
    for (const k of ['folio', 'confirmedAt', 'stockMoveId']) expect(canc, `la descartada no tiene «${k}»`).not.toHaveProperty(k);
    expect(moves(canc.id)).toEqual([]);

    const s1 = b.sales.find((s: Rec) => s.folio === 1);
    const s2 = b.sales.find((s: Rec) => s.folio === 2);
    expect(s1).toMatchObject({ delivery: 'inmediata', status: 'completada', paymentMethod: 'efectivo', totalCents: 60_000 });
    expect(s1.items[0]).toMatchObject({ productId: primera, qtyMilli: 20_000, unitPriceCents: 3000, totalCents: 60_000, cls: { variety: 'Limón persa', quality: 'Primera' } });
    expect(s2).toMatchObject({ delivery: 'pendiente', valeFolio: 1, customerName: 'Doña Mary', totalCents: 90_000 });

    // ── Restaurar en OTRO dispositivo
    const other = await newDevice(browser);
    try {
      const p2 = other.page;
      await openApp(p2, { seed: false });
      const empty = await readRawDb(p2);
      await chooseBackup(p2, uploadOf(file));
      await expect(p2.getByTestId('restore-sheet')).toBeVisible();
      await expect(p2.getByTestId('restore-replace')).toContainText('REEMPLAZA todo');
      await expect(p2.getByTestId('restore-summary')).toContainText('2 ventas, 5 recepciones, 3 variedades, 7 movimientos de inventario');
      await expect(p2.getByTestId('restore-current')).toContainText('0 ventas, 0 recepciones, 0 variedades, 0 movimientos de inventario');
      // Dispositivo vacío: no hay nada que perder, así que no pide «Entiendo…» ni avisa de pérdidas
      for (const id of ['restore-loss', 'restore-loss-receptions', 'restore-audit', 'restore-understood-box']) await expect(p2.getByTestId(id), id).toHaveCount(0);
      expect(await readRawDb(p2), 'hasta confirmar no cambia nada').toEqual(empty);
      await confirmRestoreSheet(p2);

      const dst = await readRawDb(p2);
      expectSameData(dst, src, 'dispositivo nuevo tras restaurar');
      expect(metaOf(dst)).toEqual(metaOf(src)); // contadores de folio y turno actual
      expectRawClean(dst, 'dispositivo nuevo');
      expect(cashExpected(dst!, metaOf(dst).currentShiftId as string)).toBe(150_000);

      // Existencias que SE VEN
      expect(await uiInventory(p2)).toEqual([
        { label: 'Limón persa · Primera', physical: '260 kg', reserved: '30 kg', available: '230 kg' },
        { label: 'Limón persa · Segunda', physical: '0 g', reserved: '0 g', available: '0 g' },
        { label: 'Con semilla', physical: '150 kg', reserved: '0 g', available: '150 kg' },
      ]);
      // Movimientos con referencia a su recepción
      await invRow(p2, 'Limón persa · Primera').getByTestId('show-moves').click();
      await expect(invRow(p2, 'Limón persa · Primera').getByTestId('moves-list')).toContainText('recepción de mercancía R-2 · +300 kg físico');
      await expect(invRow(p2, 'Limón persa · Primera').getByTestId('moves-list')).toContainText('corrección de recepción R-2 · -20 kg físico');
      await invRow(p2, 'Con semilla').getByTestId('show-moves').click();
      await expect(invRow(p2, 'Con semilla').getByTestId('moves-list')).toContainText('recepción de mercancía R-1 · +150 kg físico');

      // Historial de recepciones: registradas, anulada, descartada y borrador
      await tab(p2, 'recepcion');
      await p2.getByTestId('rec-sub-historial').click();
      await expect(p2.getByTestId('rec-row')).toHaveCount(2);
      const row = (n: number) => p2.getByTestId('rec-row').filter({ hasText: new RegExp(`R-${n} ·`) });
      await expect(row(1).getByTestId('rec-row-net')).toHaveText('150 kg');
      await expect(row(2).getByTestId('rec-row-net')).toHaveText('280 kg');
      await expect(row(2).getByTestId('rec-row-corrections')).toContainText('Corregida 1 vez: original 300 kg');
      await expect(row(2).getByTestId('rec-row-corrections')).toContainText('-20 kg (báscula)');
      await row(2).getByTestId('rec-moves').click();
      await expect(row(2).getByTestId('rec-moves-list')).toContainText('+300 kg');
      await expect(row(2).getByTestId('rec-moves-list')).toContainText('-20 kg');
      await p2.getByTestId('rec-filter-anulada').click();
      await expect(p2.getByTestId('rec-row')).toHaveCount(1);
      await expect(p2.getByTestId('rec-row-net')).toHaveText('0 kg (se habían recibido 100 kg)');
      await expect(p2.getByTestId('rec-row')).toContainText('Anulada: producto equivocado');
      await p2.getByTestId('rec-filter-cancelada').click();
      await expect(p2.getByTestId('rec-row')).toHaveCount(1);
      await expect(p2.getByTestId('rec-row')).toContainText('Descartada: borrador descartado');
      await p2.getByTestId('rec-sub-borradores').click();
      await expect(p2.getByTestId('rec-draft-row')).toHaveCount(1);
      await expect(p2.getByTestId('rec-draft-row')).toContainText('Limón persa · Primera');
      await expect(p2.getByTestId('rec-draft-row')).toContainText('Falta:');

      // Clasificación intacta: la Caja ofrece las mismas variedades y clasificaciones
      await tab(p2, 'caja');
      await expect(p2.getByTestId('variety')).toHaveText(['Limón persa', 'Con semilla']);
      await p2.getByTestId('variety').filter({ hasText: exact('Limón persa') }).click();
      await expect(p2.getByTestId('quality')).toHaveText(['Primera', 'Segunda']);

      // Corte (caso 23): los mismos $1,500.00 (600 + 900) y las 2 ventas
      await tab(p2, 'corte');
      await expect(p2.getByTestId('r-expected')).toHaveText('$1,500.00');
      await expect(p2.getByTestId('r-total')).toHaveText('$1,500.00');
      await expect(p2.getByTestId('sale-row')).toHaveCount(2);

      // Los folios CONTINÚAN (no se repiten): venta #3, vale V-2 (venta #4) y recepción R-4
      await sellExact(p2, '5');
      await expect(p2.getByTestId('last-sale')).toContainText('#3');
      await sellVale(p2, '3', 'Pepe');
      await expect(p2.getByTestId('last-sale')).toContainText('#4');
      await expect(p2.getByTestId('last-sale')).toContainText('VALE V-2');
      await receive(p2, { variety: 'Con semilla', packaging: 'granel', mode: 'directo', net: '40' }, { toast: 'Recepción R-4 registrada: +40 kg', milli: 40_000 });

      const fin = await readRawDb(p2);
      expect(metaOf(fin)).toMatchObject({ nextFolio: 5, nextValeFolio: 3, nextReceptionFolio: 5 });
      expectRawClean(fin, 'dispositivo nuevo, ya operando');
      const audit = await runAuditUi(p2);
      // 4 ventas · 2 vales · 6 documentos de recepción (los 5 + R-4) · 10 movimientos (7 + venta + reserva + recepción)
      await expect(audit).toContainText(auditoriaOk(4, 2, 6, 10));
    } finally {
      await other.ctx.close();
    }
    expect(await readRawDb(page), 'el dispositivo de origen no cambió').toEqual(src);
  });

  test('e) exportar: el archivo coincide registro por registro con la base, el nombre lleva la fecha y hora locales y la pantalla recuerda el último respaldo', async ({ page }) => {
    await seedV2(page, richV2());
    await page.goto('/');
    await expectAppReady(page);
    const raw = await readRawDb(page);
    await tab(page, 'mas');
    // Hay datos y nunca se exportó: lo advierte
    await expect(page.getByTestId('last-backup')).toContainText('Último respaldo: nunca');
    await expect(page.getByTestId('last-backup')).toContainText('te conviene exportar uno ahora');

    const localTag = () =>
      page.evaluate(() => {
        const d = new Date();
        const p = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
      });
    const t0 = Date.now();
    const tagBefore = await localTag();
    const file = await exportBackupUi(page);
    const tagAfter = await localTag();
    const t1 = Date.now();

    // Nombre: respaldo-caja-central-AAAA-MM-DD-HHMM.json con la hora LOCAL (la de la Ciudad de México en el navegador)
    expect(file.filename).toMatch(/^respaldo-caja-central-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    expect([tagBefore, tagAfter]).toContain(file.filename.replace(/^respaldo-caja-central-/, '').replace(/\.json$/, ''));
    // Contenido: igual a lo guardado, con sus contadores
    expect(file.json).toMatchObject({ app: 'caja-central', version: 3, nextFolio: 3, nextValeFolio: 2, nextReceptionFolio: 4 });
    expect(Date.parse(file.json.exportedAt)).toBeGreaterThanOrEqual(t0 - 2000);
    expect(Date.parse(file.json.exportedAt)).toBeLessThanOrEqual(t1 + 2000);
    for (const k of [...V1_STORES, 'receptions']) expect(byId(file.json[k]), `«${k}» del archivo`).toEqual(byId(rowsOf(raw, k)));
    expect(Object.keys(file.json).sort()).toEqual(['app', 'cashMovements', 'exportedAt', 'freights', 'nextFolio', 'nextReceptionFolio', 'nextValeFolio', 'products', 'receptions', 'sales', 'shifts', 'stockMoves', 'version']);
    expect(file.text.startsWith('{\n  "app"'), 'JSON legible (con sangría)').toBe(true);
    await expectToast(page, 'Respaldo exportado (2 ventas, 5 recepciones)');
    await expect(page.getByTestId('last-backup')).toContainText('Último respaldo: hoy');
    await expect(page.getByTestId('last-backup')).not.toContainText('te conviene exportar');
    // Sigue recordándolo al recargar, y exportar no tocó la base
    await page.reload();
    await tab(page, 'mas');
    await expect(page.getByTestId('last-backup')).toContainText('Último respaldo: hoy');
    expect(await readRawDb(page)).toEqual(raw);
  });

  test('e) exportar con la base vacía (recién instalada) produce un respaldo válido que se puede restaurar', async ({ page }) => {
    await openApp(page, { seed: false });
    const file = await exportBackupUi(page);
    expect(file.json).toMatchObject({ app: 'caja-central', version: 3, nextFolio: 1, nextValeFolio: 1, nextReceptionFolio: 1 });
    for (const k of [...V1_STORES, 'receptions']) expect(file.json[k], `«${k}» vacía`).toEqual([]);
    await expectToast(page, 'Respaldo exportado (0 ventas, 0 recepciones)');
    await chooseBackup(page, uploadOf(file));
    await expect(page.getByTestId('restore-summary')).toContainText('0 ventas, 0 recepciones, 0 variedades, 0 movimientos de inventario');
    await confirmRestoreSheet(page);
    const raw = await readRawDb(page);
    for (const k of [...V1_STORES, 'receptions']) expect(rowsOf(raw, k), `«${k}» vacía tras restaurar`).toEqual([]);
    expect(metaOf(raw)).toEqual({ nextFolio: 1, nextValeFolio: 1, nextReceptionFolio: 1 });
  });

  test('a+e) base migrada desde v1 → recibir mercancía → exportar → restaurar en otro dispositivo: queda idéntica y los folios continúan', async ({ page, browser }) => {
    test.setTimeout(120_000);
    const f = fixtureV1();
    await seedV1(page, f);
    await page.goto('/');
    await expect(page.getByTestId('upgraded')).toBeVisible();
    await receive(page, { variety: 'Limón con semilla', packaging: 'granel', mode: 'directo', net: '100' }, { toast: 'Recepción R-1 registrada: +100 kg', milli: 100_000 });
    const src = await readRawDb(page);
    const file = await exportBackupUi(page);
    expect(file.json).toMatchObject({ version: 3, nextFolio: 8, nextValeFolio: 4, nextReceptionFolio: 2 });
    expect(file.json.sales).toHaveLength(7);
    expect(file.json.receptions).toHaveLength(1);

    const other = await newDevice(browser);
    try {
      const p2 = other.page;
      await openApp(p2, { seed: false });
      await chooseBackup(p2, uploadOf(file));
      await expect(p2.getByTestId('restore-summary')).toContainText('7 ventas, 1 recepción, 4 variedades, 14 movimientos de inventario'); // 13 de v1 + la recepción
      await confirmRestoreSheet(p2);
      const dst = await readRawDb(p2);
      expectSameData(dst, src, 'otro dispositivo');
      expect(metaOf(dst)).toEqual(metaOf(src));
      expectRawClean(dst, 'otro dispositivo');
      // Folios: la venta siguiente de v1 era la #8, el vale V-4 y, tras R-1, la recepción R-2
      await sellExact(p2, '1');
      await expect(p2.getByTestId('last-sale')).toContainText('#8');
      await sellVale(p2, '2', 'Pepe');
      await expect(p2.getByTestId('last-sale')).toContainText('VALE V-4');
      await receive(p2, { variety: 'Limón con semilla', packaging: 'granel', mode: 'directo', net: '20' }, { toast: 'Recepción R-2 registrada: +20 kg', milli: 20_000 });
      expectRawClean(await readRawDb(p2), 'otro dispositivo, ya operando');
    } finally {
      await other.ctx.close();
    }
  });
});

/**
 * v1 NO tenía topes de cantidad: se tecleó 1000000 en vez de 100 kg, se pagó por transferencia y se anuló la venta. Es un dato
 * legítimo de v1 (la app anterior lo guardó y lo muestra) que está por encima del tope de 200 000 kg por renglón de la versión nueva.
 */
function conVentaAnuladaDeKilosMalTecleados(f: Rec): Rec {
  const primera = f.products.find((p: Rec) => p.name === 'Limón persa' && p.quality === 'Primera').id;
  const turno = f.shifts.find((x: Rec) => !x.closedAt).id;
  f.sales.push({
    id: 'v1-kilos-mal-tecleados', folio: 8, createdAt: '2026-10-10T22:30:00.000Z', day: '2026-10-10', shiftId: turno,
    items: [{ productId: primera, name: 'Limón persa · Primera', unit: 'kg', qtyMilli: 1_000_000_000, unitPriceCents: 3000, totalCents: 3_000_000_000 }],
    totalCents: 3_000_000_000, paymentMethod: 'transferencia', receivedCents: 3_000_000_000, changeCents: 0,
    status: 'anulada', delivery: 'inmediata', voidReason: 'se tecleó mal los kilos', voidedAt: '2026-10-10T22:31:00.000Z',
  });
  f.stockMoves.push(
    { id: 'v1-mm1', productId: primera, createdAt: '2026-10-10T22:30:00.000Z', type: 'venta', deltaMilli: -1_000_000_000, reservedDeltaMilli: 0, note: 'Folio 8', saleId: 'v1-kilos-mal-tecleados' },
    { id: 'v1-mm2', productId: primera, createdAt: '2026-10-10T22:31:00.000Z', type: 'anulacion', deltaMilli: 1_000_000_000, reservedDeltaMilli: 0, note: 'Anula 8', saleId: 'v1-kilos-mal-tecleados' },
  );
  f.nextFolio = 9;
  return f;
}

test.describe('Exportar y restaurar: casos de borde (caso 18, 23)', () => {
  test('e) valores en los topes EXACTOS de escritura (200 000 kg, $100 000 el kilo, textos de 120/60/500/300 caracteres, salida de $1 000 000 000): todo lo que la app deja escribir se exporta y se restaura', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const rep = (n: number, c: string) => c.repeat(n);
    await openApp(page);
    // Recepción de 200 000 kg: proveedor de 120, referencia de 60 y observaciones de 500 caracteres
    await fillReception(page, { variety: 'Con semilla', packaging: 'granel', mode: 'directo', net: '200000', supplier: rep(120, 's'), reference: rep(60, 'r') });
    await page.getByTestId('rec-notes').fill(rep(500, 'n'));
    await registerReception(page, { toast: 'Recepción R-1 registrada: +200,000 kg', milli: 200_000_000 });
    // Corrección a 199 999.999 kg con un motivo de 300 caracteres
    await correctReceptionUi(page, 1, '199999.999', rep(300, 'm'));
    // Vale de 1 kg a $100 000 (precio tope) con cliente de 120 caracteres
    await tab(page, 'caja');
    await page.getByTestId('variety').filter({ hasText: exact('Con semilla') }).click();
    await page.getByTestId('price').fill('100000');
    await page.getByTestId('kg').fill('1'); // al salir del precio se guarda
    await expectToast(page, 'Precio de Con semilla: $100,000.00');
    await page.getByTestId('exact').click();
    await page.getByTestId('is-vale').check();
    await page.getByTestId('customer').fill(rep(120, 'c'));
    await charge(page);
    // Salida de efectivo de $1 000 000 000 (tope) con concepto de 120 caracteres
    await tab(page, 'corte');
    await page.getByTestId('out-amount').fill('1000000000');
    await page.getByTestId('out-concept').fill(rep(120, 'k'));
    await page.getByTestId('out-save').click();
    await expectToast(page, 'Salida registrada');

    const src = await readRawDb(page);
    // A mano: 200 000 kg − 1 milésima (corrección) − 1 kg (vale: físico intacto, 1 kg reservado)
    expect(rowsOf(src, 'products').find((p) => p.name === 'Con semilla')).toMatchObject({ physicalMilli: 199_999_999, reservedMilli: 1000, priceCents: 10_000_000 });
    expect(rowsOf(src, 'receptions')[0]).toMatchObject({ folio: 1, confirmedNetMilli: 200_000_000, netMilli: 199_999_999 });
    expect(rowsOf(src, 'cashMovements')[0]).toMatchObject({ amountCents: 100_000_000_000 });
    expectRawClean(src, 'con valores en los topes');

    const file = await exportBackupUi(page);
    const other = await newDevice(browser);
    try {
      await openApp(other.page, { seed: false });
      await chooseBackup(other.page, uploadOf(file));
      const hoja = other.page.getByTestId('restore-sheet');
      const error = other.page.locator('[data-testid="toast"].error');
      await expect(hoja.or(error)).toBeVisible();
      const mensaje = (await error.count()) ? ((await error.textContent()) ?? '') : '';
      expect(mensaje, `la app rechazó su PROPIO respaldo con valores en los topes: «${mensaje}»`).toBe('');
      await confirmRestoreSheet(other.page);
      const dst = await readRawDb(other.page);
      expectSameData(dst, src, 'otro teléfono');
      expect(metaOf(dst)).toEqual(metaOf(src));
      await expect(await runAuditUi(other.page)).toContainText(auditoriaOk(1, 1, 1, 3));
    } finally {
      await other.ctx.close();
    }
  });

  test('e) lo que la propia app exporta SE PUEDE restaurar, también si viene de v1 con un dato fuera de los topes de ahora (venta ANULADA de 1 000 000 kg tecleada por error)', async ({ page, browser }) => {
    test.setTimeout(90_000);
    const f = conVentaAnuladaDeKilosMalTecleados(fixtureV1());
    await seedV1(page, f);
    await page.goto('/');
    await expect(page.getByTestId('upgraded')).toBeVisible();
    // La propia app da por buenos esos datos: los abre, los suma bien y la auditoría no objeta nada
    expectRawClean(await readRawDb(page), 'base migrada con el dato legado');
    await expect(await runAuditUi(page)).toContainText(auditoriaOk(8, 3, 0, 15));
    const file = await exportBackupUi(page);
    expect(file.json.sales).toHaveLength(8);

    // ...pero ese archivo, hecho por la propia app, ¿se puede restaurar en otro teléfono?
    const other = await newDevice(browser);
    try {
      await openApp(other.page, { seed: false });
      await chooseBackup(other.page, uploadOf(file));
      const hoja = other.page.getByTestId('restore-sheet');
      const error = other.page.locator('[data-testid="toast"].error');
      await expect(hoja.or(error)).toBeVisible();
      const mensaje = (await error.count()) ? ((await error.textContent()) ?? '') : '';
      expect(mensaje, `la app rechazó su PROPIO respaldo de una base migrada de v1: «${mensaje}»`).toBe('');
      await confirmRestoreSheet(other.page);
      expectSameData(await readRawDb(other.page), await readRawDb(page), 'otro teléfono');
    } finally {
      await other.ctx.close();
    }
  });

  test('e) restaurar un respaldo con el turno YA CERRADO: no queda turno abierto, el corte anterior se ve y la siguiente venta abre uno nuevo', async ({ page }) => {
    const b = simpleV2(2);
    // 2 ventas de $30 en efectivo, fondo $0: esperado $60.00; contado $60.00; diferencia $0.00
    b.shifts = [{ id: 'sv-sh', openedAt: '2026-01-15T14:00:00.000Z', openingCashCents: 0, closedAt: '2026-01-15T22:00:00.000Z', countedCashCents: 6000, expectedCashCents: 6000, differenceCents: 0 }];
    await openApp(page, { seed: false });
    await chooseBackup(page, jsonFile(b));
    await expect(page.getByTestId('restore-audit'), 'el respaldo es coherente').toHaveCount(0);
    await confirmRestoreSheet(page);
    expect(metaOf(await readRawDb(page))).toEqual({ nextFolio: 3, nextValeFolio: 1, nextReceptionFolio: 1 }); // sin turno actual

    await tab(page, 'corte');
    await expect(page.getByTestId('open-shift')).toBeVisible();
    await expect(page.getByTestId('closed-shift')).toHaveCount(1);
    await expect(page.getByTestId('closed-shift')).toContainText('esperado $60.00');
    await expect(page.getByTestId('closed-shift')).toContainText('contado $60.00');
    await expect(page.getByTestId('closed-shift')).toContainText('dif $0.00');
    await expect(await runAuditUi(page)).toContainText(auditoriaOk(2, 0, 0, 3));

    await sellExact(page, '1');
    await expect(page.getByTestId('last-sale')).toContainText('#3');
    const after = await readRawDb(page);
    const abiertos = rowsOf(after, 'shifts').filter((x) => !x.closedAt);
    expect(rowsOf(after, 'shifts')).toHaveLength(2);
    expect(abiertos).toHaveLength(1);
    expect(abiertos[0].openingCashCents).toBe(0);
    expect(metaOf(after).currentShiftId).toBe(abiertos[0].id);
    expectRawClean(after, 'turno nuevo tras restaurar');
    await tab(page, 'corte');
    await expect(page.getByTestId('r-expected')).toHaveText('$30.00'); // solo la venta nueva: el turno cerrado no se mezcla
    await expect(page.getByTestId('closed-shift')).toHaveCount(1);
  });

  test('e) al restaurar en una ventana, la otra ventana abierta del mismo teléfono se actualiza sola (sin recargar)', async ({ page, context }) => {
    await openApp(page); // ventana A: 3 variedades, parada en Inventario
    expect((await uiInventory(page)).map((r) => r.label)).toEqual(['Limón persa · Primera', 'Limón persa · Segunda', 'Con semilla']);
    const b = await context.newPage(); // ventana B del mismo teléfono
    await b.goto('/');
    await expectAppReady(b);
    await chooseBackup(b, jsonFile(richV2()));
    await confirmRestoreSheet(b);
    // A no se recarga: ve el estado restaurado
    await expect(page.getByTestId('inv-row')).toHaveCount(2);
    await expect(invRow(page, 'Sin semilla · Primera · 2X').getByTestId('stock-physical')).toHaveText('130 kg');
    await expect(invRow(page, 'Con semilla · Oaxaca').getByTestId('stock-physical')).toHaveText('280 kg');
  });
});

test.describe('Respaldo de la versión anterior (caso 19)', () => {
  test('f) respaldo v1 sobre una app con datos: la hoja avisa lo que se perdería, no cambia nada hasta confirmar, y al confirmar queda en el formato actual (v3) con los folios sin repetirse', async ({ page }) => {
    test.setTimeout(150_000);
    const f = fixtureV1();
    await openApp(page);
    await receive(page, { variety: 'Limón persa', cls: 'Primera', packaging: 'granel', mode: 'directo', net: '100' }, { toast: 'Recepción R-1 registrada: +100 kg', milli: 100_000 });
    await sellExact(page, '10');
    const mine = await readRawDb(page);
    expect(rowsOf(mine, 'stockMoves')).toHaveLength(2);
    // Lo capturado hoy es POSTERIOR a la fecha del respaldo: debe avisar que se perdería
    expect(await page.evaluate(() => Date.now()), 'el reloj de la máquina debe ser posterior al respaldo de la fixture').toBeGreaterThan(Date.parse(f.exportedAt));

    await chooseBackup(page, jsonFile(f, 'respaldo-v1.json'));
    await expect(page.getByTestId('restore-sheet')).toBeVisible();
    await expect(page.getByTestId('restore-replace')).toContainText('REEMPLAZA todo lo que hay ahora en este teléfono');
    await expect(page.getByTestId('restore-replace')).toContainText('Los folios que ya se emitieron no se repiten');
    await expect(page.getByTestId('restore-summary')).toContainText('El respaldo trae');
    await expect(page.getByTestId('restore-summary')).toContainText('7 ventas, 0 recepciones, 4 variedades, 13 movimientos de inventario');
    await expect(page.getByTestId('restore-current')).toContainText('Hoy tienes');
    await expect(page.getByTestId('restore-current')).toContainText('1 venta, 1 recepción, 3 variedades, 2 movimientos de inventario');
    await expect(page.getByTestId('restore-loss')).toContainText('Se perderá lo que capturaste DESPUÉS de ese momento: 1 venta, 1 recepción y 2 movimientos de inventario');
    await expect(page.getByTestId('restore-loss-receptions')).toContainText('Este respaldo es de una versión anterior y no trae recepciones');
    await expect(page.getByTestId('restore-audit'), 'el respaldo v1 de la fixture es coherente').toHaveCount(0);
    // Hay pérdida: confirmar exige marcar «Entiendo…»
    await expect(page.getByTestId('restore-confirm')).toBeDisabled();
    await page.getByTestId('restore-understood').check();
    await expect(page.getByTestId('restore-confirm')).toBeEnabled();
    expect(await readRawDb(page), 'hasta confirmar NO cambia nada').toEqual(mine);

    // Cancelar tampoco cambia nada
    await page.getByTestId('restore-cancel').click();
    await expect(page.getByTestId('restore-sheet')).toBeHidden();
    expect(await readRawDb(page), 'tras cancelar').toEqual(mine);

    // Ahora sí: restaurar
    await chooseBackup(page, jsonFile(f, 'respaldo-v1.json'));
    await confirmRestoreSheet(page);
    const after = await readRawDb(page);
    expectIsFixtureV1(after, f, 'tras restaurar el respaldo v1');
    // Los folios NUNCA bajan: la venta #1 y la recepción R-1 ya se emitieron aquí, así que R-1 no se reutiliza
    expect(metaOf(after)).toEqual({ nextFolio: 8, nextValeFolio: 4, nextReceptionFolio: 2, currentShiftId: f.shifts.find((s: Rec) => !s.closedAt).id });
    expectRawClean(after, 'tras restaurar v1');
    await expect(page.getByTestId('undo-box')).toContainText('1 venta, 1 recepción'); // la copia de lo que había

    // Exportar ahora produce el formato actual (v3: el 3 agregó los fletes)
    const file = await exportBackupUi(page);
    expect(file.json).toMatchObject({ version: 3, receptions: [], nextFolio: 8, nextValeFolio: 4, nextReceptionFolio: 2 });
    for (const k of V1_STORES) expect(byId(file.json[k])).toEqual(byId(f[k]));

    // La app funciona sobre lo restaurado: venta #8 y recepción R-2 (no R-1)
    await sellExact(page, '1');
    await expect(page.getByTestId('last-sale')).toContainText('#8');
    await receive(page, { variety: 'Limón con semilla', packaging: 'granel', mode: 'directo', net: '10' }, { toast: 'Recepción R-2 registrada: +10 kg', milli: 10_000 });
    expectRawClean(await readRawDb(page), 'tras operar sobre lo restaurado');
    const audit = await runAuditUi(page);
    await expect(audit).toContainText(auditoriaOk(8, 3, 1, 15));
  });

  test('f) un respaldo v1 hecho por la app anterior con una venta ANULADA de kilos mal tecleados (v1 no tenía topes) también debe poder restaurarse', async ({ page }) => {
    const f = conVentaAnuladaDeKilosMalTecleados(fixtureV1());
    await openApp(page, { seed: false });
    await chooseBackup(page, jsonFile(f, 'respaldo-v1.json'));
    const hoja = page.getByTestId('restore-sheet');
    const error = page.locator('[data-testid="toast"].error');
    await expect(hoja.or(error)).toBeVisible();
    const mensaje = (await error.count()) ? ((await error.textContent()) ?? '') : '';
    expect(mensaje, `la app rechazó un respaldo hecho por la app anterior: «${mensaje}»`).toBe('');
    await expect(page.getByTestId('restore-summary')).toContainText('8 ventas, 0 recepciones, 4 variedades, 15 movimientos de inventario');
    await confirmRestoreSheet(page);
    expect(rowsOf(await readRawDb(page), 'sales')).toHaveLength(8);
  });

  test('f) respaldo v1 sobre un dispositivo nuevo: sin avisos de pérdida, queda idéntico y el primer folio de recepción es R-1', async ({ page }) => {
    const f = fixtureV1();
    await openApp(page, { seed: false });
    await chooseBackup(page, jsonFile(f, 'respaldo-v1.json'));
    await expect(page.getByTestId('restore-summary')).toContainText('7 ventas, 0 recepciones, 4 variedades, 13 movimientos de inventario');
    await expect(page.getByTestId('restore-current')).toContainText('0 ventas, 0 recepciones, 0 variedades, 0 movimientos de inventario');
    for (const id of ['restore-loss', 'restore-loss-receptions', 'restore-audit', 'restore-understood-box']) await expect(page.getByTestId(id), id).toHaveCount(0);
    await confirmRestoreSheet(page);
    const after = await readRawDb(page);
    expectIsFixtureV1(after, f, 'dispositivo nuevo');
    expect(metaOf(after)).toEqual({ nextFolio: 8, nextValeFolio: 4, nextReceptionFolio: 1, currentShiftId: f.shifts.find((s: Rec) => !s.closedAt).id });
    await receive(page, { variety: 'Limón con semilla', packaging: 'granel', mode: 'directo', net: '10' }, { toast: 'Recepción R-1 registrada: +10 kg', milli: 10_000 });
    await expect(page.getByTestId('rec-last')).toContainText('Última registrada: R-1');
    expectRawClean(await readRawDb(page), 'tras la primera recepción');
  });

  /** Estado v2 con exactamente 1 venta y 1 recepción (para los textos en singular). */
  function conUnaVentaYUnaRecepcion() {
    const b = simpleV2(1);
    b.products[0].physicalMilli += 100_000;
    b.stockMoves.push({ id: 'rcp:r1:in', productId: 'sv-p', createdAt: '2026-01-15T17:00:00.000Z', type: 'recepcion', deltaMilli: 100_000, reservedDeltaMilli: 0, note: 'Recepción R-1', receptionId: 'r1' });
    b.receptions.push({
      id: 'r1', folio: 1, status: 'confirmada', createdAt: '2026-01-15T17:00:00.000Z', updatedAt: '2026-01-15T17:00:00.000Z', receivedAt: '2026-01-15T17:00:00.000Z',
      day: '2026-01-15', productId: 'sv-p', productLabel: 'Limón persa · Primera', cls: { variety: 'Limón persa', quality: 'Primera' }, packaging: 'granel',
      weightMode: 'directo', netDirectMilli: 100_000, netMilli: 100_000, confirmedAt: '2026-01-15T17:00:00.000Z', confirmedNetMilli: 100_000, stockMoveId: 'rcp:r1:in', corrections: [],
    });
    b.nextReceptionFolio = 2;
    return b;
  }

  test('f) el aviso de las recepciones que se perderían habla en singular cuando es 1 sola («1 recepciones» sería un error de redacción)', async ({ page }) => {
    await seedV2(page, conUnaVentaYUnaRecepcion());
    await page.goto('/');
    await expectAppReady(page);
    await chooseBackup(page, jsonFile(fixtureV1(), 'respaldo-v1.json'));
    const aviso = page.getByTestId('restore-loss-receptions');
    await expect(aviso).toBeVisible();
    const texto = (await aviso.textContent()) ?? '';
    expect(texto, 'aviso con una sola recepción').toContain('recepci');
    expect(texto, 'aviso con una sola recepción: no debe decir «1 recepciones»').not.toMatch(/\b1 recepciones\b/);
  });

  test('e) el aviso de «Respaldo exportado» habla en singular cuando hay 1 venta y 1 recepción («1 ventas, 1 recepciones» sería un error de redacción)', async ({ page }) => {
    await seedV2(page, conUnaVentaYUnaRecepcion());
    await page.goto('/');
    await expectAppReady(page);
    await exportBackupUi(page);
    await expect(toastOf(page)).toContainText('Respaldo exportado');
    const texto = (await toastOf(page).textContent()) ?? '';
    expect(texto, 'aviso de exportación con 1 venta y 1 recepción').not.toMatch(/\b1 (ventas|recepciones)\b/);
  });
});

/**
 * La API de compartir del sistema (Android Chrome) se SIMULA: Chromium de escritorio en Linux no la trae y aquí no hay menú
 * real de «Compartir». Se prueba lo que la app hace con cada respuesta posible de esa API, no el menú de Android ni WhatsApp.
 */
type ShareMode = 'ok' | 'sinArchivos' | 'cancelar' | 'falla';
async function simularCompartir(page: Page, modo: ShareMode) {
  await page.addInitScript((m) => {
    const w = window as unknown as { __compartido: unknown[] };
    w.__compartido = [];
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: (data?: { files?: File[] }) => !(m === 'sinArchivos' && data?.files?.length),
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: { files?: File[]; title?: string }) => {
        const files = await Promise.all((data.files ?? []).map(async (f) => ({ name: f.name, type: f.type, text: await f.text() })));
        w.__compartido.push({ title: data.title, files });
        if (m === 'cancelar') throw new DOMException('la persona canceló', 'AbortError');
        if (m === 'falla') throw new DOMException('no permitido', 'NotAllowedError');
      },
    });
  }, modo);
}
const compartido = (page: Page) => page.evaluate(() => (window as unknown as { __compartido: Array<{ title: string; files: Array<{ name: string; type: string; text: string }> }> }).__compartido);

test.describe('Compartir el respaldo (API de compartir SIMULADA)', () => {
  test('e) «Compartir respaldo» entrega a la hoja de compartir un archivo .json (formato actual, v3) con TODO y marca el respaldo como hecho', async ({ page }) => {
    await simularCompartir(page, 'ok');
    await seedV2(page, richV2());
    await page.goto('/');
    await expectAppReady(page);
    await tab(page, 'mas');
    await expect(page.getByTestId('last-backup')).toContainText('Último respaldo: nunca');
    await page.getByTestId('share-backup').click();
    await expectToast(page, 'Respaldo compartido');
    const enviado = await compartido(page);
    expect(enviado).toHaveLength(1);
    expect(enviado[0].title).toBe('Respaldo de Venta de Limones');
    expect(enviado[0].files).toHaveLength(1);
    expect(enviado[0].files[0].name).toMatch(/^respaldo-caja-central-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    expect(enviado[0].files[0].type).toBe('application/json');
    const json = JSON.parse(enviado[0].files[0].text);
    expect(json).toMatchObject({ app: 'caja-central', version: 3, nextFolio: 3, nextValeFolio: 2, nextReceptionFolio: 4 });
    const raw = await readRawDb(page);
    for (const k of [...V1_STORES, 'receptions']) expect(byId(json[k]), `«${k}» compartida`).toEqual(byId(rowsOf(raw, k)));
    await expect(page.getByTestId('last-backup')).toContainText('Último respaldo: hoy');
  });

  test('e) si el teléfono no sabe compartir ARCHIVOS .json, «Compartir respaldo» lo descarga en vez de fallar', async ({ page }) => {
    await simularCompartir(page, 'sinArchivos');
    await seedV2(page, richV2());
    await page.goto('/');
    await expectAppReady(page);
    await tab(page, 'mas');
    const file = await captureDownload(page, () => page.getByTestId('share-backup').click());
    expect(file.json).toMatchObject({ version: 3, nextReceptionFolio: 4 });
    expect(file.json.receptions).toHaveLength(5);
    await expectToast(page, 'Respaldo exportado (2 ventas, 5 recepciones)');
    expect(await compartido(page), 'no se llegó a llamar a la hoja de compartir').toHaveLength(0);
    await expect(page.getByTestId('last-backup')).toContainText('Último respaldo: hoy');
  });

  test('e) si la persona CANCELA la hoja de compartir, no se descarga nada, no hay aviso y el respaldo NO se da por hecho', async ({ page }) => {
    await simularCompartir(page, 'cancelar');
    await seedV2(page, richV2());
    await page.goto('/');
    await expectAppReady(page);
    await tab(page, 'mas');
    let descargas = 0;
    page.on('download', () => descargas++);
    await page.getByTestId('share-backup').click();
    await expect.poll(async () => (await compartido(page)).length, { message: 'la hoja de compartir debió abrirse' }).toBe(1);
    // Caso justificado de espera fija: cuando NO debe pasar nada no hay evento que esperar; se deja que termine el manejador asíncrono.
    await page.waitForTimeout(400);
    expect(descargas, 'cancelar no descarga').toBe(0);
    await expect(toastOf(page)).toHaveCount(0);
    await expect(page.getByTestId('last-backup')).toContainText('Último respaldo: nunca');
  });

  test('e) si compartir falla por otra causa, la app lo descarga para que el respaldo no se pierda', async ({ page }) => {
    await simularCompartir(page, 'falla');
    await seedV2(page, richV2());
    await page.goto('/');
    await expectAppReady(page);
    await tab(page, 'mas');
    const file = await captureDownload(page, () => page.getByTestId('share-backup').click());
    expect(file.json.version).toBe(3);
    await expectToast(page, 'Respaldo exportado (2 ventas, 5 recepciones)');
    await expect(page.getByTestId('last-backup')).toContainText('Último respaldo: hoy');
  });
});

test.describe('Sin internet y estado visible después de restaurar', () => {
  test('e) sin internet (SIMULADO con setOffline, no es el modo avión real de Android): exportar y restaurar funcionan igual', async ({ page, context }) => {
    test.setTimeout(90_000);
    await openApp(page); // instala el service worker y deja 3 variedades
    await context.setOffline(true);
    await page.reload();
    await expectAppReady(page);
    await expect(page.getByTestId('net')).toContainText('Sin internet');
    const mio = await exportBackupUi(page);
    expect(mio.json.products).toHaveLength(3);
    await chooseBackup(page, jsonFile(richV2()));
    await expect(page.getByTestId('restore-summary')).toContainText('2 ventas, 5 recepciones, 2 variedades, 7 movimientos de inventario');
    await confirmRestoreSheet(page);
    const raw = await readRawDb(page);
    expectSameData(raw, rawFromBackup(richV2() as unknown as Rec), 'sin internet');
    expectRawClean(raw, 'sin internet');
    await expect(await runAuditUi(page)).toContainText(auditoriaOk(2, 1, 5, 7));
    // y se puede volver con el archivo que se bajó antes de restaurar
    await chooseBackup(page, uploadOf(mio));
    await confirmRestoreSheet(page);
    expect((await uiInventory(page)).map((r) => r.label)).toEqual(['Limón persa · Primera', 'Limón persa · Segunda', 'Con semilla']);
  });

  test('f) tras restaurar, la caja no sigue mostrando como «Última» una venta que la restauración ya borró', async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page);
    await receive(page, { variety: 'Limón persa', cls: 'Primera', packaging: 'granel', mode: 'directo', net: '100' }, { toast: 'Recepción R-1 registrada: +100 kg', milli: 100_000 });
    await sellExact(page, '10'); // venta #1 de $300.00
    await expect(page.getByTestId('last-sale')).toContainText('#1 · $300.00');
    // El respaldo v1 trae OTRA venta #1 ($375.00); la de $300.00 ya no existe
    await chooseBackup(page, jsonFile(fixtureV1(), 'respaldo-v1.json'));
    await confirmRestoreSheet(page);
    expect(rowsOf(await readRawDb(page), 'sales').find((x) => x.folio === 1)).toMatchObject({ totalCents: 37_500 });
    await tab(page, 'caja');
    // Es válido que la línea «Última» desaparezca o que muestre una venta que SÍ existe ahora; lo que no puede es seguir diciendo $300.00
    await expect(page.getByTestId('last-sale').filter({ hasText: '$300.00' }), 'la venta de $300.00 ya no existe').toHaveCount(0);
  });
});

test.describe('Respaldos corruptos: se rechazan SIN perder nada (caso 20)', () => {
  const rich = (mutate: (b: Rec) => void): UploadFile => {
    const b = clone(richV2()) as Rec;
    mutate(b);
    return jsonFile(b);
  };
  const v1 = (mutate: (b: Rec) => void): UploadFile => {
    const b = clone(fixtureV1());
    mutate(b);
    return jsonFile(b);
  };
  const rec = (b: Rec, id: string) => b.receptions.find((r: Rec) => r.id === id);

  const NO_JERGA = /undefined|\[object|NaN|Unexpected token|TypeError|SyntaxError/;
  const RECHAZOS: Array<{ name: string; file: () => UploadFile; error: RegExp }> = [
    { name: 'JSON inválido (archivo cortado a la mitad)', file: () => textFile(JSON.stringify(richV2()).slice(0, 300)), error: /El archivo no es JSON válido/ },
    { name: 'archivo vacío (0 bytes)', file: () => textFile(''), error: /El archivo no es JSON válido/ },
    { name: 'un JSON que no es un respaldo (una lista)', file: () => textFile('[1,2,3]'), error: /no es un respaldo válido de esta app/ },
    { name: 'app distinta', file: () => rich((b) => (b.app = 'otra-app')), error: /no es un respaldo válido de esta app/ },
    { name: 'versión desconocida (4)', file: () => rich((b) => (b.version = 4)), error: /no es un respaldo válido de esta app/ },
    { name: 'versión 3 pero sin la lista de fletes (incompleto)', file: () => rich((b) => (b.version = 3)), error: /Respaldo incompleto: falta freights/ },
    { name: 'recepción con neto negativo', file: () => rich((b) => (rec(b, 'rec-1').netMilli = -5000)), error: /Respaldo dañado: recepción nº \d+ \(netMilli: número entero inválido o fuera de rango\)/ },
    { name: 'recepción con neto desbordado (1e15 milésimas)', file: () => rich((b) => (rec(b, 'rec-1').confirmedNetMilli = 1e15)), error: /Respaldo dañado: recepción nº \d+ \(confirmedNetMilli: número entero inválido o fuera de rango\)/ },
    { name: 'folio de venta duplicado', file: () => rich((b) => (b.sales[1].folio = b.sales[0].folio)), error: /folios de venta repetidos/ },
    { name: 'folio de recepción duplicado', file: () => rich((b) => (rec(b, 'rec-2').folio = 1)), error: /folios de recepción repetidos/ },
    { name: 'texto enorme (5000 caracteres) en el nombre de una variedad', file: () => rich((b) => (b.products[0].name = 'x'.repeat(5000))), error: /Respaldo dañado: variedad nº 1 \(name: texto inválido\)/ },
    { name: 'texto enorme (2001 caracteres) en el proveedor de una recepción', file: () => rich((b) => (rec(b, 'rec-1').supplier = 'p'.repeat(2001))), error: /Respaldo dañado: recepción nº \d+ \(supplier: texto inválido\)/ },
    { name: 'respaldo v2 sin la lista de recepciones', file: () => rich((b) => delete b.receptions), error: /Respaldo incompleto: falta receptions/ },
    { name: 'siguiente folio de recepción ya usado', file: () => rich((b) => (b.nextReceptionFolio = 3)), error: /el folio de recepción siguiente ya fue usado/ },
    { name: 'estado de recepción desconocido', file: () => rich((b) => (rec(b, 'rec-1').status = 'perdida')), error: /Respaldo dañado: recepción nº \d+ \(status: valor no permitido\)/ },
    { name: 'v1 que trae lista de recepciones (formato mezclado)', file: () => v1((b) => (b.receptions = [])), error: /formato mezclado/ },
    { name: 'v1 que trae el folio de recepción (formato mezclado)', file: () => v1((b) => (b.nextReceptionFolio = 1)), error: /formato mezclado/ },
  ];
  for (const c of RECHAZOS) {
    test(`g) se rechaza con un mensaje claro y sin tocar nada: ${c.name}`, async ({ page }) => {
      const { before, inventory } = await openWithRich(page);
      await chooseBackup(page, c.file());
      await expectErrorToast(page, c.error);
      const msg = (await toastOf(page).textContent()) ?? '';
      expect(msg, 'el mensaje no debe traer jerga técnica ni valores sin sentido').not.toMatch(NO_JERGA);
      await expect(page.getByTestId('restore-sheet'), 'un archivo malo no llega a la hoja de restauración').toHaveCount(0);
      // Inventario, ventas, recepciones y todo lo demás: IDÉNTICOS en disco y en pantalla
      expect(await readRawDb(page), 'la base tras el intento').toEqual(before);
      expect(await uiInventory(page), 'lo que se ve en Inventario').toEqual(inventory);
      expectRawClean(await readRawDb(page), 'tras el intento');
    });
  }

  const ADVERTENCIAS: Array<{ name: string; file: () => UploadFile; first: RegExp }> = [
    { name: 'recepción que apunta a una variedad que no existe', file: () => rich((b) => (rec(b, 'rec-1').productId = 'no-existe')), first: /su variedad ya no existe/ },
    { name: 'movimiento de inventario huérfano (su variedad no existe)', file: () => rich((b) => b.stockMoves.push({ id: 'mv-huerfano', productId: 'fantasma', createdAt: '2026-10-05T16:00:00.000Z', type: 'entrada', deltaMilli: 1000, reservedDeltaMilli: 0, note: '' })), first: /apunta a una variedad que no existe/ },
    { name: 'movimiento que apunta a una recepción que no existe', file: () => rich((b) => (b.stockMoves.find((m: Rec) => m.id === 'rcp:rec-1:in').receptionId = 'no-existe')), first: /apunta a una recepción que no existe/ },
    { name: 'totales de venta incoherentes (el total no es la suma de los renglones)', file: () => rich((b) => (b.sales[0].totalCents += 100)), first: /el total no coincide con sus renglones/ },
  ];
  for (const c of ADVERTENCIAS) {
    // Decisión de diseño documentada en src/db/backup.ts y backup-v2.test.ts: la validación estricta es de FORMA; las incoherencias
    // contables con forma válida no se rechazan, se MUESTRAN en la hoja y exigen reconocerlas antes de reemplazar.
    test(`g) forma válida pero incoherente: no se rechaza, la hoja lo advierte, exige «Entiendo…» y cancelar no cambia nada: ${c.name}`, async ({ page }) => {
      const { before } = await openWithRich(page);
      await chooseBackup(page, c.file());
      await expect(page.getByTestId('restore-sheet')).toBeVisible();
      await expect(page.getByTestId('restore-audit')).toContainText(/inconsistencias? internas?/);
      await expect(page.getByTestId('restore-audit')).toContainText(c.first);
      await expect(page.getByTestId('restore-understood-box')).toBeVisible();
      await expect(page.getByTestId('restore-confirm')).toBeDisabled();
      await page.getByTestId('restore-cancel').click();
      await expect(page.getByTestId('restore-sheet')).toBeHidden();
      expect(await readRawDb(page), 'tras cancelar').toEqual(before);
    });
  }

  test('g) si se restaura igual un respaldo con enlaces rotos, la auditoría lo muestra (no se oculta) y «Deshacer» devuelve exactamente lo anterior', async ({ page }) => {
    test.setTimeout(90_000);
    const { before } = await openWithRich(page);
    await chooseBackup(page, rich((b) => (rec(b, 'rec-1').productId = 'no-existe')));
    await confirmRestoreSheet(page);
    const roto = await readRawDb(page);
    expect(rowsOf(roto, 'receptions').find((r) => r.id === 'rec-1')!.productId).toBe('no-existe'); // se restauró tal cual, sin «arreglarlo» a escondidas
    expect(auditRaw(roto!).join(' | ')).toMatch(/su variedad no existe|variedad/);
    const audit = await runAuditUi(page);
    await expect(audit).toContainText('problema(s)');
    await expect(audit).toContainText('su variedad ya no existe');
    await expect(audit).toHaveClass(/warn/);

    await page.getByTestId('undo-restore').click();
    await expect(page.getByTestId('restore-sheet')).toContainText('Deshacer la última restauración');
    await confirmRestoreSheet(page, 'Restauración deshecha');
    const back = await readRawDb(page);
    expectSameData(back, before, 'tras deshacer');
    expectRawClean(back, 'tras deshacer');
    await expect(await runAuditUi(page)).toContainText('Sin inconsistencias');
  });

  test('g) si la restauración falla a la mitad (almacenamiento lleno SIMULADO al escribir los movimientos), el navegador revierte TODO y la base queda como estaba', async ({ page }) => {
    test.setTimeout(90_000);
    // No es un disco lleno de verdad: se hace lanzar QuotaExceededError a una escritura de la base principal, DESPUÉS de que la
    // restauración ya vació las tablas y escribió variedades, ventas, turnos y movimientos de caja.
    await page.addInitScript(() => {
      const w = window as unknown as { __fallarEn?: string };
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
        if (w.__fallarEn && this.name === w.__fallarEn && this.transaction.db.name === 'caja-central') {
          throw new DOMException('almacenamiento lleno simulado', 'QuotaExceededError');
        }
        return put.apply(this, args);
      };
    });
    const { before, inventory } = await openWithRich(page);
    await chooseBackup(page, jsonFile(fixtureV1(), 'respaldo-v1.json'));
    await expect(page.getByTestId('restore-sheet')).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __fallarEn: string }).__fallarEn = 'stockMoves';
    });
    await page.getByTestId('restore-understood').check();
    await page.getByTestId('restore-confirm').click();
    await expectErrorToast(page, 'Almacenamiento lleno');
    await expect(page.getByTestId('restore-sheet')).toBeHidden();
    await page.evaluate(() => {
      (window as unknown as { __fallarEn?: string }).__fallarEn = undefined;
    });
    expect(await readRawDb(page), 'la base debe quedar EXACTAMENTE como estaba: ni una fila del respaldo se coló').toEqual(before);
    expectRawClean(await readRawDb(page), 'tras la restauración fallida');
    expect(await uiInventory(page)).toEqual(inventory);
    // Sin el fallo, reintentar sí restaura
    await chooseBackup(page, jsonFile(fixtureV1(), 'respaldo-v1.json'));
    await confirmRestoreSheet(page);
    expectIsFixtureV1(await readRawDb(page), fixtureV1(), 'tras reintentar');
  });

  test('g) un archivo guardado con BOM y saltos de línea de Windows (CRLF), como lo deja el Bloc de notas, se acepta', async ({ page }) => {
    const { before } = await openWithRich(page);
    const texto = JSON.stringify(simpleV2(2), null, 2).replace(/\n/g, '\r\n');
    const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(texto, 'utf8')]);
    await chooseBackup(page, { name: 'respaldo-bloc-de-notas.json', mimeType: 'application/json', buffer });
    await expect(page.getByTestId('restore-sheet')).toBeVisible();
    await expect(page.getByTestId('restore-summary')).toContainText('2 ventas, 0 recepciones, 1 variedad, 3 movimientos de inventario');
    await page.getByTestId('restore-cancel').click();
    expect(await readRawDb(page), 'cancelar no cambia nada').toEqual(before);
  });

  test('g) archivo de más de 25 MB: se rechaza sin leerlo, con un mensaje claro, y no se toca nada', async ({ page }, testInfo) => {
    const { before } = await openWithRich(page);
    // Un respaldo VÁLIDO relleno de espacios: así lo único que lo hace inaceptable es el tamaño
    const ruta = testInfo.outputPath('respaldo-gigante.json');
    const cuerpo = JSON.stringify(simpleV2(3));
    writeFileSync(ruta, cuerpo + ' '.repeat(26 * 1024 * 1024 - cuerpo.length));
    expect(statSync(ruta).size).toBeGreaterThan(25 * 1024 * 1024);
    await chooseBackup(page, ruta);
    await expectErrorToast(page, 'El archivo es demasiado grande para ser un respaldo de esta app (más de 25 MB)');
    await expect(page.getByTestId('restore-sheet')).toHaveCount(0);
    expect(await readRawDb(page)).toEqual(before);
  });

  test('g) archivo grande pero dentro del límite (24 MB con espacios): se acepta y la hoja muestra lo que trae', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const { before } = await openWithRich(page);
    const ruta = testInfo.outputPath('respaldo-grande.json');
    const cuerpo = JSON.stringify(simpleV2(3));
    writeFileSync(ruta, cuerpo + ' '.repeat(24 * 1024 * 1024 - cuerpo.length));
    expect(statSync(ruta).size).toBeLessThan(25 * 1024 * 1024);
    await chooseBackup(page, ruta);
    await expect(page.getByTestId('restore-sheet')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('restore-summary')).toContainText('3 ventas, 0 recepciones, 1 variedad, 4 movimientos de inventario');
    await page.getByTestId('restore-cancel').click();
    expect(await readRawDb(page), 'cancelar no cambia nada').toEqual(before);
  });

  test('g) respaldo válido y grande (3 000 ventas): la hoja aparece, se restaura completo y la auditoría pasa', async ({ page }) => {
    test.setTimeout(180_000);
    await openApp(page, { seed: false });
    const grande = simpleV2(3000);
    const t0 = Date.now();
    await chooseBackup(page, jsonFile(grande, 'respaldo-grande.json'));
    await expect(page.getByTestId('restore-sheet')).toBeVisible({ timeout: 60_000 });
    const hoja = Date.now() - t0;
    await expect(page.getByTestId('restore-summary')).toContainText('3000 ventas, 0 recepciones, 1 variedad, 3001 movimientos de inventario');
    const t1 = Date.now();
    await confirmRestoreSheet(page);
    const restauracion = Date.now() - t1;
    test.info().annotations.push({ type: 'rendimiento', description: `hoja de restauración en ${hoja} ms; restauración en ${restauracion} ms (respaldo de ${Math.round(JSON.stringify(grande).length / 1024)} KB)` });

    const raw = await readRawDb(page);
    expect(rowsOf(raw, 'sales')).toHaveLength(3000);
    expect(rowsOf(raw, 'stockMoves')).toHaveLength(3001);
    expect(rowsOf(raw, 'products')[0]).toMatchObject({ physicalMilli: 7_000_000, reservedMilli: 0 }); // 10 000 kg − 3 000 × 1 kg
    expect(metaOf(raw)).toMatchObject({ nextFolio: 3001, nextValeFolio: 1, nextReceptionFolio: 1 });
    expect(cashExpected(raw!, 'sv-sh')).toBe(3000 * 3000);
    const audit = await runAuditUi(page);
    await expect(audit).toContainText(auditoriaOk(3000, 0, 0, 3001), { timeout: 30_000 });
    await tab(page, 'corte');
    await expect(page.getByTestId('r-expected')).toHaveText('$90,000.00');
    // la siguiente venta sigue la numeración
    await sellExact(page, '1');
    await expect(page.getByTestId('last-sale')).toContainText('#3001');
  });
});

test.describe('Deshacer una restauración y red de seguridad (caso 20)', () => {
  test('h) «Deshacer» devuelve el estado anterior EXACTO (los folios ya emitidos no se reutilizan) y se puede seguir operando', async ({ page }) => {
    test.setTimeout(120_000);
    const f = fixtureV1();
    const { before: a } = await openWithRich(page); // estado A: richV2
    await tab(page, 'mas');
    await expect(page.getByTestId('undo-box'), 'sin restauraciones todavía no hay copia interna').toHaveCount(0);

    await chooseBackup(page, jsonFile(f, 'respaldo-v1.json')); // restaurar B (v1)
    await expect(page.getByTestId('restore-loss-receptions')).toBeVisible(); // A tiene 5 recepciones y B es v1
    await confirmRestoreSheet(page);
    const trasB = await readRawDb(page);
    expectIsFixtureV1(trasB, f, 'tras restaurar B');
    // Los contadores no bajan: A (3 / 2 / 4) y B (8 / 4 / sin recepciones → 1) → el mayor de cada uno
    expect(metaOf(trasB)).toEqual({ nextFolio: 8, nextValeFolio: 4, nextReceptionFolio: 4, currentShiftId: f.shifts.find((x: Rec) => !x.closedAt).id });
    await expect(page.getByTestId('undo-box')).toContainText('2 ventas, 5 recepciones'); // lo que había (A)
    // La copia interna sobrevive a cerrar y volver a abrir la app
    await page.reload();
    await expectAppReady(page);
    await tab(page, 'mas');
    await expect(page.getByTestId('undo-box')).toContainText('2 ventas, 5 recepciones');

    await page.getByTestId('undo-restore').click();
    await expect(page.getByTestId('restore-sheet')).toContainText('Deshacer la última restauración');
    await expect(page.getByTestId('restore-summary')).toContainText('La copia interna trae');
    await expect(page.getByTestId('restore-summary')).toContainText('2 ventas, 5 recepciones, 2 variedades, 7 movimientos de inventario');
    await expect(page.getByTestId('restore-current')).toContainText('7 ventas, 0 recepciones, 4 variedades, 13 movimientos de inventario');
    await expect(page.getByTestId('restore-confirm')).toContainText('Volver a ese estado');
    await confirmRestoreSheet(page, 'Restauración deshecha');

    const back = await readRawDb(page);
    expectSameData(back, a, 'tras deshacer'); // los 6 conjuntos de datos, registro por registro, idénticos a A
    expectRawClean(back, 'tras deshacer');
    // Los contadores NO bajan (B ya había emitido hasta la venta #7, el vale V-3): A tenía 3 / 2 / 4
    expect(metaOf(back)).toEqual({ nextFolio: 8, nextValeFolio: 4, nextReceptionFolio: 4, currentShiftId: 'sh-1' });
    expect(await uiInventory(page)).toEqual([
      { label: 'Sin semilla · Primera · 2X', physical: '130 kg', reserved: '30 kg', available: '100 kg' },
      { label: 'Con semilla · Oaxaca', physical: '280 kg', reserved: '0 g', available: '280 kg' },
    ]);
    await tab(page, 'corte');
    await expect(page.getByTestId('r-expected')).toHaveText('$785.00'); // fondo 200 + venta 600 − salida 15
    // Sigue operando y NO repite folios ya emitidos
    await sellExact(page, '1');
    await expect(page.getByTestId('last-sale')).toContainText('#8');
    // Deshacer se puede deshacer: la copia de «antes de deshacer» (B) queda disponible
    await tab(page, 'mas');
    await expect(page.getByTestId('undo-box')).toContainText('La más reciente');
  });

  test('h) «Exportar lo que tengo hoy» desde la hoja baja el estado ACTUAL y, con ese archivo, se puede volver a él sin usar «Deshacer»', async ({ page }) => {
    test.setTimeout(120_000);
    const f = fixtureV1();
    const { before: a } = await openWithRich(page);
    await chooseBackup(page, jsonFile(f, 'respaldo-v1.json'));
    await expect(page.getByTestId('restore-sheet')).toBeVisible();
    const guardado = await captureDownload(page, () => page.getByTestId('restore-export-first').click());
    await expectToast(page, 'Respaldo exportado (2 ventas, 5 recepciones)');
    await expect(page.getByTestId('restore-sheet'), 'la hoja sigue abierta para decidir').toBeVisible();
    expect(guardado.json).toMatchObject({ version: 3, nextFolio: 3, nextValeFolio: 2, nextReceptionFolio: 4 });
    for (const k of [...V1_STORES, 'receptions']) expect(byId(guardado.json[k]), `«${k}» del archivo`).toEqual(byId(rowsOf(a, k)));
    expect(await readRawDb(page), 'exportar desde la hoja no cambia nada').toEqual(a);

    await confirmRestoreSheet(page); // ahora sí se reemplaza por B
    expectIsFixtureV1(await readRawDb(page), f, 'tras restaurar B');
    // Volver al estado de antes con el ARCHIVO que se había bajado (no con «Deshacer»)
    await chooseBackup(page, uploadOf(guardado));
    await confirmRestoreSheet(page);
    const back = await readRawDb(page);
    expectSameData(back, a, 'tras volver con el archivo exportado');
    expectRawClean(back, 'tras volver con el archivo exportado');
  });

  test('h) solo se conservan las 3 copias internas más recientes', async ({ page }) => {
    test.setTimeout(120_000);
    await seedV2(page, simpleV2(2));
    await page.goto('/');
    await expectAppReady(page);
    // Cuatro restauraciones seguidas (3, 4, 5 y 6 ventas): cada una guarda lo que había (2, 3, 4 y 5 ventas)
    for (const n of [3, 4, 5, 6]) {
      await chooseBackup(page, jsonFile(simpleV2(n), `respaldo-${n}.json`));
      await confirmRestoreSheet(page);
    }
    const undo = await readRawDb(page, UNDO_DB_NAME);
    const snaps = rowsOf(undo, 'snapshots').sort((x, y) => (x.at < y.at ? -1 : 1));
    expect(snaps.map((s) => s.sales), 'ventas de cada copia, de la más vieja a la más nueva (la de 2 ventas ya se descartó)').toEqual([3, 4, 5]);
    expect(snaps.every((s) => typeof s.reason === 'string' && s.reason.startsWith('Antes de restaurar un respaldo del '))).toBe(true);
    await expect(page.getByTestId('undo-box')).toContainText('las últimas 3');
    await expect(page.getByTestId('undo-box')).toContainText('5 ventas'); // la más reciente es el estado previo a la última restauración
    // El estado actual es el último respaldo
    expect(rowsOf(await readRawDb(page), 'sales')).toHaveLength(6);
  });

  test('h) si NO se puede guardar la copia interna de seguridad, NO se restaura nada y la persona lo sabe', async ({ page }) => {
    // La base de copias internas está en una versión que esta app no puede abrir: guardar la copia falla
    await seedDatabase(page, { name: UNDO_DB_NAME, version: 99, stores: [{ name: 'snapshots', keyPath: 'id' }] });
    const { before } = await openWithRich(page); // (siembra la base principal en el mismo contexto)
    await chooseBackup(page, jsonFile(fixtureV1(), 'respaldo-v1.json'));
    await expect(page.getByTestId('restore-sheet')).toBeVisible();
    await page.getByTestId('restore-understood').check();
    await page.getByTestId('restore-confirm').click();
    await expectErrorToast(page, 'No se pudo guardar la copia interna de seguridad');
    await expectErrorToast(page, 'No se restauró nada: exporta tus datos primero');
    await expect(page.getByTestId('restore-sheet')).toBeHidden();
    expect(await readRawDb(page), 'la base principal quedó igual').toEqual(before);
    const undo = await readRawDb(page, UNDO_DB_NAME);
    expect(undo!.version).toBe(99);
    expect(rowsOf(undo, 'snapshots')).toEqual([]);
    await expect(page.getByTestId('undo-box')).toHaveCount(0);
  });

  test('h) doble pulsación en «Restaurar y reemplazar» restaura una sola vez (una sola copia interna)', async ({ page }) => {
    await seedV2(page, simpleV2(2));
    await page.goto('/');
    await expectAppReady(page);
    await chooseBackup(page, jsonFile(simpleV2(3), 'respaldo-3.json'));
    await expect(page.getByTestId('restore-sheet')).toBeVisible();
    await expect(page.getByTestId('restore-understood-box')).toHaveCount(0); // sin pérdidas: no pide «Entiendo…»
    await page.getByTestId('restore-confirm').dblclick();
    await expectToast(page, 'Respaldo restaurado');
    await expect(page.getByTestId('restore-sheet')).toBeHidden();
    const raw = await readRawDb(page);
    expect(rowsOf(raw, 'sales')).toHaveLength(3);
    expectRawClean(raw, 'tras la doble pulsación');
    const undo = await readRawDb(page, UNDO_DB_NAME);
    expect(rowsOf(undo, 'snapshots'), 'una sola copia interna').toHaveLength(1);
    expect(rowsOf(undo, 'snapshots')[0].sales).toBe(2);
  });

  test('h) «Deshacer» pulsado en el MISMO instante en que aparece «Respaldo restaurado» usa la copia más reciente, no la anterior (hallazgo de una corrida intermitente)', async ({ page }) => {
    test.setTimeout(90_000);
    await seedV2(page, simpleV2(2));
    await page.goto('/');
    await expectAppReady(page);
    await chooseBackup(page, jsonFile(simpleV2(3), 'respaldo-3.json')); // 1.ª restauración: guarda el estado de 2 ventas
    await confirmRestoreSheet(page);
    await expect(page.getByTestId('undo-box')).toContainText('2 ventas');
    await expect(page.getByTestId('toast'), 'que el aviso de la 1.ª restauración ya se haya ido: no debe confundirse con el de la 2.ª').toHaveCount(0, { timeout: 10_000 });

    await chooseBackup(page, jsonFile(simpleV2(4), 'respaldo-4.json')); // 2.ª restauración: guardará el estado de 3 ventas
    await expect(page.getByTestId('restore-sheet')).toBeVisible();
    // Un toque a «Deshacer» en el instante exacto en que se pinta el aviso (antes de que nadie pueda haber refrescado nada)
    await page.evaluate(() => {
      const watcher = new MutationObserver(() => {
        const toast = document.querySelector('[data-testid="toast"]');
        const undo = document.querySelector<HTMLButtonElement>('[data-testid="undo-restore"]');
        if (toast?.textContent?.includes('Respaldo restaurado') && undo) {
          watcher.disconnect();
          undo.click();
        }
      });
      watcher.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await page.getByTestId('restore-confirm').click();
    await expect(page.getByTestId('restore-sheet')).toContainText('Deshacer la última restauración');
    await expect(page.getByTestId('restore-summary')).toContainText('3 ventas'); // la copia MÁS RECIENTE (antes de la 2.ª restauración)
    await expect(page.getByTestId('restore-summary')).not.toContainText('2 ventas'); // no la de la 1.ª
    await confirmRestoreSheet(page, 'Restauración deshecha');
    expect(rowsOf(await readRawDb(page), 'sales')).toHaveLength(3);
  });
});

for (const phone of PHONES) {
  test.describe(`Hoja de restauración · ${phone.name}`, () => {
    test.use({ viewport: { width: phone.width, height: phone.height } });

    test('con todos los avisos a la vez: cabe, no desborda, sus botones quedan a la vista (con y sin teclado emulado) y responden al primer toque', async ({ page }) => {
      test.setTimeout(90_000);
      await seedV2(page, richV2());
      await page.goto('/');
      await expectAppReady(page);
      await sellExact(page, '1'); // algo capturado HOY, para que aparezca también «se perderá lo que capturaste después»
      await chooseBackup(page, jsonFile(fixtureV1(), 'respaldo-v1.json'));
      const sheet = page.getByTestId('restore-sheet');
      await expect(sheet).toBeVisible();
      for (const id of ['restore-replace', 'restore-summary', 'restore-current', 'restore-loss', 'restore-loss-receptions', 'restore-export-first', 'restore-understood-box']) {
        await expect(page.getByTestId(id), id).toBeVisible();
      }
      // Teclado cerrado
      expect(await overflowing(page), 'desbordamiento con el teclado cerrado').toEqual([]);
      await expectInsideViewport(page, page.getByTestId('restore-cancel'), '«Cancelar»');
      await expectInsideViewport(page, page.getByTestId('restore-confirm'), '«Restaurar y reemplazar»');
      // Ventana encogida por el teclado de Android: los botones del pie siguen a la vista
      await showKeyboard(page, phone);
      expect(await overflowing(page), 'desbordamiento con el teclado abierto').toEqual([]);
      await expectInsideViewport(page, page.getByTestId('restore-cancel'), '«Cancelar» con el teclado abierto');
      await expectInsideViewport(page, page.getByTestId('restore-confirm'), '«Restaurar y reemplazar» con el teclado abierto');
      await hideKeyboard(page, phone);

      // Toque táctil real: marcar «Entiendo…» habilita confirmar; «Cancelar» cierra al primer toque
      await expect(page.getByTestId('restore-confirm')).toBeDisabled();
      await page.getByTestId('restore-understood-box').tap();
      await expect(page.getByTestId('restore-understood')).toBeChecked();
      await expect(page.getByTestId('restore-confirm')).toBeEnabled();
      await watchTaps(page);
      await page.getByTestId('restore-cancel').tap();
      await expectSolidTap(page, 'restore-cancel');
      await expect(sheet).toBeHidden();
    });
  });
}

/** Nombres exactos de los chips que usan varias pruebas (por si cambia el texto de la app, que falle UNA vez y claro). */
test('las variedades de prueba que da de alta openApp siguen llamándose como estas pruebas esperan', async ({ page }) => {
  await openApp(page);
  expect((await uiInventory(page)).map((r) => r.label)).toEqual(['Limón persa · Primera', 'Limón persa · Segunda', 'Con semilla']);
  await tab(page, 'recepcion');
  await expect(page.getByTestId('rec-variety').filter({ hasText: exact('Con semilla') })).toHaveCount(1);
  await expect(page.getByTestId('rec-variety').filter({ hasText: exact('Limón persa') })).toHaveCount(1);
});
