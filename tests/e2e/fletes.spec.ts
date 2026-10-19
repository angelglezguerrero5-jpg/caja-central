import { expect, test, type Page } from '@playwright/test';
import { addStock, openApp, sellCash, tab } from './helpers';
import {
  FIXED_NOW,
  PHONES,
  bottomReachReport,
  buildMarket,
  clippedTextReport,
  controlNameReport,
  hideKeyboard,
  html,
  overflowReport,
  reachReport,
  readDb,
  restoreBackup,
  settled,
  showKeyboard,
  touchTargetReport,
} from './helpers-android';
import { asV3, fillFlete, kg, mkFreight, openFletes, rawFreights, rawSettings, row, sampleFreights, saveFlete } from './helpers-fletes';
import { captureDownload, readRawDb, richV2, seedV2, expectSameData } from './helpers-migracion';

/**
 * CONTROL DE PESAJE POR FLETE (peso inicial y final, diferencia en kg y porcentaje).
 *   peso neto = bruto − tara · diferencia = neto inicial − neto final · porcentaje = diferencia ÷ neto inicial × 100
 * Las cifras esperadas están calculadas a mano en los comentarios. Chromium emulando un teléfono: NO es un teléfono físico.
 */

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW); // sábado 10 oct 2026, 14:00 en la Ciudad de México: el folio sugerido es F-261010-01
});

const toast = (page: Page) => page.getByTestId('toast');

test.describe('Fletes · captura y cuentas exactas', () => {
  test('flete completo (bruto − tara en origen, neto directo en destino): neto, diferencia y % exactos en la vista previa, en la lista y en la base; inventario, ventas y caja NO se tocan', async ({ page }) => {
    test.setTimeout(60_000);
    await openApp(page);
    await sellCash(page, '1', [50]); // algo de ventas/caja para comprobar que no cambian
    const before = await readDb(page);
    await openFletes(page);
    await expect(page.getByTestId('fl-hint')).toContainText('no suma ni resta existencias');

    await page.getByTestId('fl-new').click();
    await expect(page.getByTestId('fl-folio')).toHaveValue('F-261010-01');
    await fillFlete(page, {
      origin: 'Apatzingán, Mich.',
      destination: 'Central de Abasto, CDMX',
      initial: { gross: '22000', tare: '7000', ticket: 'B-1203', scale: 'Báscula del huerto' }, // 22,000 − 7,000 = 15,000 kg
      final: { mode: 'directo', net: '14760', ticket: 'CDMX-88' }, // 14,760 kg
      notes: 'Camión de 10 ruedas',
    });
    await expect(page.getByTestId('fl-i-net-out')).toHaveAttribute('data-milli', String(kg(15_000)));
    await expect(page.getByTestId('fl-f-net-out')).toHaveAttribute('data-milli', String(kg(14_760)));
    // diferencia = 15,000 − 14,760 = 240 kg · 240 ÷ 15,000 = 1.60 %
    await expect(page.getByTestId('fl-diff')).toHaveAttribute('data-milli', String(kg(240)));
    await expect(page.getByTestId('fl-diff')).toHaveText('240 kg');
    await expect(page.getByTestId('fl-pct')).toHaveAttribute('data-bp', '160');
    await expect(page.getByTestId('fl-pct')).toHaveText('1.60 %');
    await expect(page.getByTestId('fl-class')).toHaveAttribute('data-class', 'dentro');
    await expect(page.getByTestId('fl-class')).toContainText('Dentro del rango de referencia');
    await expect(page.getByTestId('fl-class')).toContainText('pendiente de validación');
    await expect(page.getByTestId('fl-save')).not.toHaveAttribute('aria-disabled', 'true');

    await page.getByTestId('fl-save').click();
    await expect(toast(page)).toContainText('Flete F-261010-01 guardado');
    await expect(page.getByTestId('fl-form')).toHaveCount(0);

    const r = row(page, 'F-261010-01');
    await expect(r).toHaveCount(1);
    await expect(r.getByTestId('fl-state')).toHaveText('Completo');
    await expect(r.getByTestId('fl-initial')).toHaveAttribute('data-milli', String(kg(15_000)));
    await expect(r.getByTestId('fl-final')).toHaveAttribute('data-milli', String(kg(14_760)));
    await expect(r.getByTestId('fl-difference')).toHaveAttribute('data-milli', String(kg(240)));
    await expect(r.getByTestId('fl-difference')).toHaveAttribute('data-bp', '160');
    await expect(r.getByTestId('fl-difference')).toHaveText('240 kg · 1.60 %');
    await expect(r.getByTestId('fl-row-evidence')).toHaveText('Origen: boleta B-1203 (báscula Báscula del huerto) · Destino: boleta CDMX-88');
    await expect(page.getByTestId('fl-sum-initial')).toHaveAttribute('data-milli', String(kg(15_000)));
    await expect(page.getByTestId('fl-sum-final')).toHaveAttribute('data-milli', String(kg(14_760)));
    await expect(page.getByTestId('fl-sum-diff')).toHaveAttribute('data-milli', String(kg(240)));
    await expect(page.getByTestId('fl-sum-diff')).toHaveAttribute('data-bp', '160');

    // La base: exactamente lo capturado, con la fecha del reloj fijo y SIN valores derivados
    const [f] = await rawFreights(page);
    expect(f).toMatchObject({
      folio: 'F-261010-01',
      folioKey: 'F-261010-01',
      status: 'activo',
      day: '2026-10-10',
      date: FIXED_NOW.toISOString(),
      origin: 'Apatzingán, Mich.',
      destination: 'Central de Abasto, CDMX',
      notes: 'Camión de 10 ruedas',
      revisions: [],
    });
    expect(f.initial).toEqual({ mode: 'bruto_tara', grossMilli: kg(22_000), tareMilli: kg(7_000), netMilli: kg(15_000), ticket: 'B-1203', scale: 'Báscula del huerto' });
    expect(f.final).toEqual({ mode: 'directo', netMilli: kg(14_760), ticket: 'CDMX-88' });
    expect(Object.keys(f)).not.toEqual(expect.arrayContaining(['diffMilli']));

    // Ni existencias, ni ventas, ni caja, ni folios cambiaron
    expect(await readDb(page)).toEqual(before);
    await tab(page, 'corte');
    await expect(page.getByTestId('r-total')).toHaveText('$30.00');
  });

  test('cuentas con gramos y con pesos grandes: 12,345.5 kg − 345.5 kg = 12,000 kg; 199,999.999 kg se guarda y 200,000.001 kg no', async ({ page }) => {
    await openApp(page);
    await openFletes(page);
    await saveFlete(page, { folio: 'G-1', origin: 'a', destination: 'b', initial: { gross: '12345.5', tare: '345.5' }, final: { mode: 'directo', net: '11999.999' } });
    // 12,000 − 11,999.999 = 0.001 kg = 1 g · 1 ÷ 12,000,000 = 0.0000083 % → 0.00 %
    const r = row(page, 'G-1');
    await expect(r.getByTestId('fl-initial')).toHaveAttribute('data-milli', '12000000');
    await expect(r.getByTestId('fl-difference')).toHaveAttribute('data-milli', '1');
    await expect(r.getByTestId('fl-difference')).toHaveText('1 g · 0.00 %');

    await saveFlete(page, { folio: 'G-2', origin: 'a', destination: 'b', initial: { mode: 'directo', net: '199999.999' } });
    await expect(row(page, 'G-2').getByTestId('fl-initial')).toHaveAttribute('data-milli', '199999999');

    await page.getByTestId('fl-new').click();
    await fillFlete(page, { folio: 'G-3', origin: 'a', destination: 'b', initial: { mode: 'directo', net: '200000.001' } });
    await expect(page.getByTestId('fl-input-problem')).toContainText('demasiado grande');
    expect((await rawFreights(page)).map((x) => x.folio)).toEqual(['G-1', 'G-2']);
  });

  test('lo inválido NO se guarda y la pantalla dice qué falta o qué está mal (vacíos, tara mayor, cero, negativos, texto, coma ambigua, decimales de más, notación científica)', async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page);
    await openFletes(page);
    const base = { folio: 'V-1', origin: 'Zamora', destination: 'CDMX', initial: { gross: '1000', tare: '100' } };
    type Case = [string, Parameters<typeof fillFlete>[1], 'missing' | 'problem', RegExp];
    const cases: Case[] = [
      ['sin folio', { folio: '' }, 'missing', /Escribe el folio del flete/],
      ['sin origen', { origin: '' }, 'missing', /Escribe el origen del flete \(de dónde sale\)/],
      ['sin destino', { destination: '' }, 'missing', /Escribe el destino del flete \(a dónde llega\)/],
      ['ninguna pesada', { initial: { gross: '', tare: '' } }, 'missing', /Captura al menos una pesada/],
      ['tara mayor que el bruto', { initial: { gross: '100', tare: '200' } }, 'missing', /Peso inicial \(origen\): La tara debe ser menor al peso bruto/],
      ['tara igual al bruto', { initial: { gross: '100', tare: '100' } }, 'missing', /La tara debe ser menor al peso bruto/],
      ['bruto en cero', { initial: { gross: '0', tare: '0' } }, 'missing', /El peso bruto debe ser mayor a cero/],
      ['bruto sin tara', { initial: { gross: '100', tare: '' } }, 'missing', /Escribe la tara \(0 si no hay\)/],
      ['neto final en cero', { initial: { gross: '1000', tare: '0' }, final: { mode: 'directo', net: '0' } }, 'missing', /Peso final \(destino\): El peso neto debe ser mayor a cero/],
      ['bruto negativo', { initial: { gross: '-5', tare: '0' } }, 'problem', /no entiendo «-5»/],
      ['texto en vez de número', { initial: { gross: 'abc', tare: '0' } }, 'problem', /no entiendo «abc»/],
      ['notación científica', { initial: { gross: '1e3', tare: '0' } }, 'problem', /no entiendo «1e3»/],
      ['coma ambigua «1,500»', { initial: { gross: '1,500', tare: '0' } }, 'problem', /se puede leer como 1500 o como 1\.5/],
      ['más de 3 decimales', { initial: { gross: '12.3456', tare: '0' } }, 'problem', /demasiados decimales/],
      ['más de 200,000 kg', { initial: { gross: '250000', tare: '0' } }, 'problem', /demasiado grande/],
    ];
    for (const [why, patch, kind, text] of cases) {
      await page.getByTestId('fl-new').click();
      await fillFlete(page, { ...base, ...patch, ...(patch.initial ? { initial: { gross: '', tare: '', ...patch.initial } } : {}) });
      const box = page.getByTestId(kind === 'missing' ? 'fl-missing' : 'fl-input-problem');
      await expect(box, why).toContainText(text);
      await expect(page.getByTestId('fl-save'), why).toHaveAttribute('aria-disabled', 'true');
      await page.getByTestId('fl-save').click({ force: true });
      await expect(toast(page), why).toContainText(text);
      await expect(page.getByTestId('fl-form'), `${why}: el formulario sigue abierto`).toBeVisible();
      await page.getByTestId('fl-cancel').click();
      expect(await rawFreights(page), `${why}: no se guardó nada`).toEqual([]);
    }
  });

  test('si falla una pesada del lado de destino no se guarda tampoco la de origen (todo o nada)', async ({ page }) => {
    await openApp(page);
    await openFletes(page);
    await page.getByTestId('fl-new').click();
    await fillFlete(page, { folio: 'T-1', origin: 'a', destination: 'b', initial: { gross: '1000', tare: '100' }, final: { gross: '500', tare: '600' } });
    await expect(page.getByTestId('fl-missing')).toContainText('Peso final (destino): La tara debe ser menor al peso bruto');
    await page.getByTestId('fl-save').click({ force: true });
    expect(await rawFreights(page)).toEqual([]);
  });

  test('peso final MAYOR que el inicial: alerta aparte, porcentaje negativo y nunca se le llama merma ni deshidratación', async ({ page }) => {
    await openApp(page);
    await openFletes(page);
    await page.getByTestId('fl-new').click();
    await fillFlete(page, { folio: 'M-1', origin: 'a', destination: 'b', initial: { mode: 'directo', net: '10000' }, final: { mode: 'directo', net: '10100' } });
    // 10,000 − 10,100 = −100 kg · −100 ÷ 10,000 = −1.00 %
    await expect(page.getByTestId('fl-diff')).toHaveAttribute('data-milli', String(-kg(100)));
    await expect(page.getByTestId('fl-pct')).toHaveText('−1.00 %');
    await expect(page.getByTestId('fl-class')).toHaveAttribute('data-class', 'final_mayor');
    await expect(page.getByTestId('fl-class')).toContainText('MAYOR');
    await page.getByTestId('fl-save').click();
    const r = row(page, 'M-1');
    await expect(r.getByTestId('fl-row-class')).toHaveAttribute('data-class', 'final_mayor');
    await expect(r.getByTestId('fl-difference')).toHaveText('−100 kg · −1.00 %');
    const text = (await r.innerText()).toLowerCase();
    expect(text).not.toMatch(/deshidrat|merma/);
  });

  test('«sin diferencia» y las tres clases contra el rango (dentro, debajo, encima) con sus límites exactos', async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page);
    await openFletes(page);
    // origen 10,000 kg; la diferencia de cada flete es: 0, 199.999, 200, 300, 300.001
    const cases: Array<[string, string, string]> = [
      ['C-0', '10000', 'sin_diferencia'],
      ['C-199', '9800.001', 'debajo'], // 199.999 kg
      ['C-200', '9800', 'dentro'], // 200 kg justo
      ['C-300', '9700', 'dentro'], // 300 kg justo
      ['C-301', '9699.999', 'encima'], // 300.001 kg
    ];
    for (const [folio, final, klass] of cases) {
      await saveFlete(page, { folio, origin: 'a', destination: 'b', initial: { mode: 'directo', net: '10000' }, final: { mode: 'directo', net: final } });
      await expect(row(page, folio).getByTestId('fl-row-class'), folio).toHaveAttribute('data-class', klass);
    }
  });
});

test.describe('Fletes · folio único y doble toque', () => {
  test('el folio no se puede repetir (ni cambiando mayúsculas o espacios): el segundo NO se guarda, el primero queda intacto y se puede corregir el folio', async ({ page }) => {
    await openApp(page);
    await openFletes(page);
    await saveFlete(page, { folio: 'ABC-1', origin: 'a', destination: 'b', initial: { mode: 'directo', net: '1000' } });
    const first = (await rawFreights(page))[0];

    for (const variant of ['ABC-1', 'abc-1', '  Abc-1  ']) {
      await page.getByTestId('fl-new').click();
      await fillFlete(page, { folio: variant, origin: 'c', destination: 'd', initial: { mode: 'directo', net: '2000' } });
      await page.getByTestId('fl-save').click();
      await expect(toast(page), variant).toContainText('Ya existe un flete con el folio ABC-1');
      await expect(page.getByTestId('fl-form'), 'el formulario conserva lo escrito').toBeVisible();
      await expect(page.getByTestId('fl-origin')).toHaveValue('c');
      await page.getByTestId('fl-cancel').click();
    }
    expect(await rawFreights(page)).toEqual([first]);

    await page.getByTestId('fl-new').click();
    await fillFlete(page, { folio: 'ABC-2', origin: 'c', destination: 'd', initial: { mode: 'directo', net: '2000' } });
    await page.getByTestId('fl-save').click();
    await expect(toast(page)).toContainText('Flete ABC-2 guardado');
    expect((await rawFreights(page)).map((f) => f.folio)).toEqual(['ABC-1', 'ABC-2']);
  });

  test('el folio sugerido siempre es uno libre: F-261010-01, luego -02… aunque se haya usado el 01', async ({ page }) => {
    await openApp(page);
    await openFletes(page);
    for (const expected of ['F-261010-01', 'F-261010-02', 'F-261010-03']) {
      await page.getByTestId('fl-new').click();
      await expect(page.getByTestId('fl-folio')).toHaveValue(expected);
      await fillFlete(page, { origin: 'a', destination: 'b', initial: { mode: 'directo', net: '1000' } });
      await page.getByTestId('fl-save').click();
      await expect(toast(page)).toContainText(`Flete ${expected} guardado`);
      await expect(page.getByTestId('fl-form')).toHaveCount(0);
    }
  });

  test('doble toque en «Guardar flete»: se guarda UNO solo, con un solo aviso', async ({ page }) => {
    await openApp(page);
    await openFletes(page);
    await page.getByTestId('fl-new').click();
    await fillFlete(page, { origin: 'a', destination: 'b', initial: { mode: 'directo', net: '1000' } });
    await page.getByTestId('fl-save').dblclick();
    // El aviso exacto de un guardado normal: el segundo toque se ignora (no llega a decir «ya estaba guardado»)
    await expect(toast(page)).toHaveText('Flete F-261010-01 guardado');
    await expect(page.getByTestId('fl-row')).toHaveCount(1);
    expect(await rawFreights(page)).toHaveLength(1);
    await expect(toast(page)).not.toContainText('Escribe');
  });

  test('tres toques seguidos en «Guardar flete» y recarga justo después: sigue habiendo UN flete', async ({ page }) => {
    await openApp(page);
    await openFletes(page);
    await page.getByTestId('fl-new').click();
    await fillFlete(page, { origin: 'a', destination: 'b', initial: { mode: 'directo', net: '1000' } });
    await page.getByTestId('fl-save').click({ clickCount: 3, delay: 20 });
    await page.reload();
    await openFletes(page);
    await expect(page.getByTestId('fl-row')).toHaveCount(1);
    expect(await rawFreights(page)).toHaveLength(1);
  });
});

test.describe('Fletes · completar, corregir, anular y bitácora', () => {
  test('ciclo completo: origen primero → registrar el peso final (sin motivo) → corregir (con motivo) → anular (con motivo); todo queda en la bitácora y nada se borra', async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page);
    await openFletes(page);

    // 1 · Solo el origen: queda incompleto y sin diferencia
    await saveFlete(page, { folio: 'L-1', origin: 'Uruapan', destination: 'CDMX', initial: { gross: '22000', tare: '7000' } });
    let r = row(page, 'L-1');
    await expect(r.getByTestId('fl-state')).toHaveText('Falta el peso final');
    await expect(r.getByTestId('fl-row-incomplete')).toContainText('Falta el peso final (destino)');
    await expect(r.getByTestId('fl-difference')).toHaveText('—');
    await expect(r.getByTestId('fl-edit')).toHaveText('Registrar peso final');
    await expect(page.getByTestId('fl-count')).toContainText('1 flete: 0 completos, 1 incompleto');
    await page.getByTestId('fl-filter-incompletos').click();
    await expect(page.getByTestId('fl-row')).toHaveCount(1);
    await page.getByTestId('fl-filter-completos').click();
    await expect(page.getByTestId('fl-row')).toHaveCount(0);
    await page.getByTestId('fl-filter-todos').click();

    // 2 · Registrar el peso final: no pide motivo (no se pisa nada)
    await r.getByTestId('fl-edit').click();
    await expect(page.getByTestId('fl-form')).toContainText('Corregir o completar el flete L-1');
    await expect(page.getByTestId('fl-f-gross')).toBeFocused();
    await expect(page.getByTestId('fl-folio')).toHaveValue('L-1');
    await fillFlete(page, { final: { mode: 'directo', net: '14700', ticket: 'CDMX-1' } });
    await expect(page.getByTestId('fl-diff')).toHaveText('300 kg'); // 15,000 − 14,700
    await expect(page.getByTestId('fl-pct')).toHaveText('2.00 %');
    await page.getByTestId('fl-save').click();
    await expect(toast(page)).toContainText('Flete L-1 corregido');
    r = row(page, 'L-1');
    await expect(r.getByTestId('fl-state')).toHaveText('Completo');
    await expect(r.getByTestId('fl-difference')).toHaveText('300 kg · 2.00 %');
    let [f] = await rawFreights(page);
    expect(f.revisions).toHaveLength(1);
    expect(f.revisions[0].reason).toBe('Se completó el registro');
    expect(f.revisions[0].changes.every((c) => c.before === undefined), 'solo agregó datos').toBe(true);
    expect(f.initial).toMatchObject({ netMilli: kg(15_000) });

    // 3 · Corregir un dato que ya estaba: sin motivo NO se guarda
    await r.getByTestId('fl-edit').click();
    await expect(r.getByTestId('fl-edit')).toHaveText('Corregir');
    await fillFlete(page, { initial: { gross: '22500' } });
    await expect(page.getByTestId('fl-diff')).toHaveText('800 kg'); // 15,500 − 14,700
    await page.getByTestId('fl-save').click();
    await expect(toast(page)).toContainText('Escribe el motivo');
    expect((await rawFreights(page))[0].initial!.grossMilli).toBe(kg(22_000));
    await page.getByTestId('fl-reason').fill('La boleta decía 22,500');
    await page.getByTestId('fl-save').click();
    await expect(toast(page)).toContainText('Flete L-1 corregido');
    r = row(page, 'L-1');
    await expect(r.getByTestId('fl-initial')).toHaveAttribute('data-milli', String(kg(15_500)));
    await expect(r.getByTestId('fl-row-class')).toHaveAttribute('data-class', 'encima');
    [f] = await rawFreights(page);
    expect(f.revisions).toHaveLength(2);
    expect(f.revisions[1]).toMatchObject({ reason: 'La boleta decía 22,500' });
    expect(f.revisions[1].changes).toEqual(
      expect.arrayContaining([
        { field: 'initial.grossMilli', before: kg(22_000), after: kg(22_500) },
        { field: 'initial.netMilli', before: kg(15_000), after: kg(15_500) },
      ]),
    );
    // la bitácora lo muestra en lenguaje llano, lo más reciente primero
    await r.getByTestId('fl-history-btn').click();
    const rev = page.getByTestId('fl-revision');
    await expect(rev).toHaveCount(2);
    await expect(rev.first()).toContainText('La boleta decía 22,500');
    await expect(rev.first()).toContainText('Peso inicial · bruto: 22,000 kg → 22,500 kg');
    await expect(rev.first()).toContainText('Peso inicial · neto: 15,000 kg → 15,500 kg');
    await expect(rev.nth(1)).toContainText('Se completó el registro');
    await r.getByTestId('fl-history-btn').click();

    // 4 · Anular: pide motivo, conserva todo y el folio queda ocupado
    await r.getByTestId('fl-void').click();
    await expect(page.getByTestId('fl-void-panel')).toContainText('no borra nada');
    await page.getByTestId('fl-void-yes').click({ force: true });
    await expect(toast(page)).toContainText('Escribe el motivo');
    expect((await rawFreights(page))[0].status).toBe('activo');
    await page.getByTestId('fl-void-reason').fill('Se capturó en el flete equivocado');
    await page.getByTestId('fl-void-yes').click();
    await expect(toast(page)).toContainText('Flete L-1 anulado');
    r = row(page, 'L-1');
    await expect(r.getByTestId('fl-state')).toHaveText('Anulado');
    await expect(r).toContainText('Anulado: Se capturó en el flete equivocado');
    await expect(r.getByTestId('fl-edit')).toHaveCount(0);
    await expect(r.getByTestId('fl-void')).toHaveCount(0);
    [f] = await rawFreights(page);
    expect(f).toMatchObject({ status: 'anulado', voidReason: 'Se capturó en el flete equivocado' });
    expect(f.initial).toMatchObject({ netMilli: kg(15_500) }); // nada se borró
    expect(f.final).toMatchObject({ netMilli: kg(14_700) });
    expect(f.revisions).toHaveLength(3);

    // Filtros y folio reservado
    await page.getByTestId('fl-filter-anulados').click();
    await expect(page.getByTestId('fl-row')).toHaveCount(1);
    await expect(page.getByTestId('fl-sum-diff')).toHaveCount(0); // un anulado no suma
    await page.getByTestId('fl-filter-todos').click();
    await page.getByTestId('fl-new').click();
    await fillFlete(page, { folio: 'l-1', origin: 'a', destination: 'b', initial: { mode: 'directo', net: '10' } });
    await page.getByTestId('fl-save').click();
    await expect(toast(page)).toContainText('Ya existe un flete con el folio L-1');
  });

  test('corregir el folio, el origen, el destino o la fecha también exige motivo y queda en la bitácora; guardar sin cambiar nada no agrega nada', async ({ page }) => {
    await openApp(page);
    await openFletes(page);
    await saveFlete(page, { folio: 'E-1', origin: 'Zamora', destination: 'CDMX', initial: { mode: 'directo', net: '1000' } });
    await row(page, 'E-1').getByTestId('fl-edit').click();
    await page.getByTestId('fl-save').click(); // sin cambios
    await expect(toast(page)).toHaveText('Sin cambios en el flete E-1'); // no dice «corregido»: no se corrigió nada
    expect((await rawFreights(page))[0].revisions).toEqual([]);
    expect((await rawFreights(page))[0].updatedAt, 'tampoco cambia la fecha de modificación').toBe((await rawFreights(page))[0].createdAt);

    await row(page, 'E-1').getByTestId('fl-edit').click();
    await fillFlete(page, { folio: 'E-1B', origin: 'Uruapan', destination: 'Iztapalapa' });
    await page.getByTestId('fl-save').click();
    await expect(toast(page)).toContainText('Escribe el motivo');
    await page.getByTestId('fl-reason').fill('Datos mal tomados');
    await page.getByTestId('fl-save').click();
    await expect(toast(page)).toContainText('Flete E-1B corregido');
    const [f] = await rawFreights(page);
    expect(f).toMatchObject({ folio: 'E-1B', folioKey: 'E-1B', origin: 'Uruapan', destination: 'Iztapalapa' });
    expect(f.revisions[0].changes).toEqual(
      expect.arrayContaining([
        { field: 'folio', before: 'E-1', after: 'E-1B' },
        { field: 'origin', before: 'Zamora', after: 'Uruapan' },
        { field: 'destination', before: 'CDMX', after: 'Iztapalapa' },
      ]),
    );
    // el folio viejo quedó libre
    await saveFlete(page, { folio: 'E-1', origin: 'a', destination: 'b', initial: { mode: 'directo', net: '5' } });
    expect((await rawFreights(page)).map((x) => x.folio)).toEqual(['E-1', 'E-1B']);
  });
});

test.describe('Fletes · rango de referencia configurable (200–300 kg, pendiente de validación)', () => {
  test('de fábrica 200–300 kg pendiente de validación; se cambia, se marca validado, se desactiva y se restablece; todo persiste', async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page);
    await openFletes(page);
    await saveFlete(page, { folio: 'R-1', origin: 'a', destination: 'b', initial: { mode: 'directo', net: '10000' }, final: { mode: 'directo', net: '9760' } }); // 240 kg
    await expect(page.getByTestId('fl-ref-label')).toHaveText('200–300 kg · pendiente de validación');
    const klass = row(page, 'R-1').getByTestId('fl-row-class');
    await expect(klass).toHaveAttribute('data-class', 'dentro');
    await expect(klass).toContainText('referencia pendiente de validación');
    expect(await rawSettings(page)).toBeUndefined(); // nunca se cambió: es el valor de fábrica

    await page.getByTestId('fl-settings').locator('summary').click();
    // un rango inválido se rechaza y no cambia nada
    await page.getByTestId('fl-ref-min').fill('300');
    await page.getByTestId('fl-ref-max').fill('200');
    await page.getByTestId('fl-ref-save').click();
    await expect(toast(page)).toContainText('El mínimo del rango no puede ser mayor que el máximo');
    await page.getByTestId('fl-ref-min').fill('100');
    await page.getByTestId('fl-ref-max').fill('');
    await page.getByTestId('fl-ref-save').click();
    await expect(toast(page)).toContainText('Escribe el mínimo y el máximo');
    await page.getByTestId('fl-ref-max').fill('abc');
    await page.getByTestId('fl-ref-save').click();
    await expect(toast(page)).toContainText('Escribe los kilos del rango como número');
    expect(await rawSettings(page)).toBeUndefined();

    // 100–200 kg y validado: 240 kg queda POR ENCIMA y ya no dice «pendiente»
    await page.getByTestId('fl-ref-min').fill('100');
    await page.getByTestId('fl-ref-max').fill('200');
    await page.getByTestId('fl-ref-validated').check();
    await page.getByTestId('fl-ref-save').click();
    await expect(toast(page)).toContainText('Rango de referencia guardado');
    await expect(page.getByTestId('fl-ref-label')).toHaveText('100–200 kg');
    await expect(klass).toHaveAttribute('data-class', 'encima');
    await expect(klass).not.toContainText('pendiente de validación');
    expect(await rawSettings(page)).toEqual({ validated: true, refMinMilli: kg(100), refMaxMilli: kg(200) });

    // Persiste al recargar
    await page.reload();
    await openFletes(page);
    await expect(page.getByTestId('fl-ref-label')).toHaveText('100–200 kg');
    await expect(row(page, 'R-1').getByTestId('fl-row-class')).toHaveAttribute('data-class', 'encima');

    // Sin rango: solo se muestra la diferencia, sin comparar
    await page.getByTestId('fl-settings').locator('summary').click();
    await page.getByTestId('fl-ref-off').click();
    await expect(page.getByTestId('fl-ref-label')).toHaveText('Sin rango de referencia');
    await expect(row(page, 'R-1').getByTestId('fl-row-class')).toHaveAttribute('data-class', 'sin_referencia');
    await expect(row(page, 'R-1').getByTestId('fl-row-class')).toContainText('Sin rango de referencia configurado');
    expect(await rawSettings(page)).toEqual({ validated: false });

    // De vuelta a la referencia de fábrica
    await page.getByTestId('fl-ref-default').click();
    await expect(page.getByTestId('fl-ref-label')).toHaveText('200–300 kg · pendiente de validación');
    await expect(row(page, 'R-1').getByTestId('fl-row-class')).toHaveAttribute('data-class', 'dentro');
  });

  test('el total de la lista también se compara con el rango (suma de los fletes completos)', async ({ page }) => {
    await openApp(page);
    await openFletes(page);
    await saveFlete(page, { folio: 'S-1', origin: 'a', destination: 'b', initial: { mode: 'directo', net: '10000' }, final: { mode: 'directo', net: '9800' } }); // 200
    await saveFlete(page, { folio: 'S-2', origin: 'a', destination: 'b', initial: { mode: 'directo', net: '20000' }, final: { mode: 'directo', net: '19700' } }); // 300
    await saveFlete(page, { folio: 'S-3', origin: 'a', destination: 'b', initial: { mode: 'directo', net: '5000' } }); // incompleto: no suma
    // 30,000 − 29,500 = 500 kg · 500 ÷ 30,000 = 1.67 %
    await expect(page.getByTestId('fl-sum-initial')).toHaveAttribute('data-milli', String(kg(30_000)));
    await expect(page.getByTestId('fl-sum-final')).toHaveAttribute('data-milli', String(kg(29_500)));
    await expect(page.getByTestId('fl-sum-diff')).toHaveAttribute('data-milli', String(kg(500)));
    await expect(page.getByTestId('fl-sum-diff')).toHaveAttribute('data-bp', '167');
    await expect(page.getByTestId('fl-sum-diff')).toHaveText('500 kg (1.67 %)');
    await expect(page.getByTestId('fl-summary')).toContainText('Por encima del rango de referencia');
    await expect(page.getByTestId('fl-count')).toContainText('3 fletes: 2 completos, 1 incompleto, 0 anulados');
  });
});

test.describe('Fletes · persistencia, recarga y sin conexión', () => {
  test('los fletes sobreviven a recargar; una captura a medias también (y «Cancelar» la descarta)', async ({ page }) => {
    await openApp(page);
    await openFletes(page);
    await saveFlete(page, { folio: 'P-1', origin: 'a', destination: 'b', initial: { gross: '1000', tare: '100' } });

    await page.getByTestId('fl-new').click();
    await fillFlete(page, { folio: 'P-2', origin: 'Zamora', destination: 'CDMX', initial: { gross: '5000', tare: '500', ticket: 'T-9' }, final: { mode: 'directo', net: '4300' } });
    await page.reload();
    await openFletes(page);
    await expect(page.getByTestId('fl-row')).toHaveCount(1); // P-1 guardado
    await expect(page.getByTestId('fl-form')).toBeVisible(); // la captura a medias volvió
    await expect(page.getByTestId('fl-folio')).toHaveValue('P-2');
    await expect(page.getByTestId('fl-origin')).toHaveValue('Zamora');
    await expect(page.getByTestId('fl-i-gross')).toHaveValue('5000');
    await expect(page.getByTestId('fl-f-net')).toHaveValue('4300');
    await expect(page.getByTestId('fl-i-ticket')).toHaveValue('T-9');
    // y se puede terminar de guardar
    await page.getByTestId('fl-save').click();
    await expect(toast(page)).toContainText('Flete P-2 guardado');
    expect((await rawFreights(page)).map((f) => f.folio)).toEqual(['P-1', 'P-2']);

    // Cancelar descarta la captura para siempre
    await page.getByTestId('fl-new').click();
    await fillFlete(page, { folio: 'P-3', origin: 'x' });
    await page.getByTestId('fl-cancel').click();
    await page.reload();
    await openFletes(page);
    await expect(page.getByTestId('fl-form')).toHaveCount(0);
  });

  test('cambiar de pantalla no pierde la captura en curso', async ({ page }) => {
    await openApp(page);
    await openFletes(page);
    await page.getByTestId('fl-new').click();
    await fillFlete(page, { folio: 'N-1', origin: 'Zamora' });
    await tab(page, 'caja');
    await openFletes(page);
    await expect(page.getByTestId('fl-origin')).toHaveValue('Zamora');
    await expect(page.getByTestId('fl-folio')).toHaveValue('N-1');
  });

  test('sin internet (SIMULADO con setOffline, no es el modo avión real): se registra un flete, se guarda de verdad y sobrevive a recargar', async ({ page, context }) => {
    test.setTimeout(60_000);
    await openApp(page);
    await context.setOffline(true);
    await expect(page.getByTestId('net')).toHaveText('Sin internet');
    await openFletes(page);
    await saveFlete(page, { folio: 'OFF-1', origin: 'a', destination: 'b', initial: { mode: 'directo', net: '1000' }, final: { mode: 'directo', net: '990' } });
    expect((await rawFreights(page)).map((f) => f.folio)).toEqual(['OFF-1']);
    await page.reload();
    await expect(page.getByTestId('net')).toHaveText('Sin internet');
    await openFletes(page);
    await expect(row(page, 'OFF-1').getByTestId('fl-difference')).toHaveText('10 kg · 1.00 %');
    await context.setOffline(false);
  });

  test('si el guardado falla (almacenamiento lleno, SIMULADO) NO se dice «guardado»: error visible, el formulario sigue y no hay flete', async ({ page }) => {
    await openApp(page);
    await openFletes(page);
    await page.getByTestId('fl-new').click();
    await fillFlete(page, { folio: 'Q-1', origin: 'a', destination: 'b', initial: { mode: 'directo', net: '1000' } });
    await page.evaluate(() => {
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
        if (this.name === 'freights') throw new DOMException('lleno', 'QuotaExceededError');
        return add.apply(this, args);
      };
    });
    await page.getByTestId('fl-save').click();
    await expect(toast(page)).toContainText('Almacenamiento lleno: el registro NO se guardó');
    await expect(toast(page)).not.toContainText('guardado:');
    await expect(page.getByTestId('fl-form')).toBeVisible();
    await expect(page.getByTestId('fl-row')).toHaveCount(0);
    expect(await rawFreights(page)).toEqual([]);
  });

  test('«Existencias» sigue siendo la pantalla de siempre y conserva lo que se estaba haciendo al mirar los fletes', async ({ page }) => {
    await openApp(page);
    await addStock(page, 0, '100');
    await tab(page, 'inventario');
    await expect(page.getByTestId('inv-sub-existencias')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('inv-row')).toHaveCount(3);
    const row0 = page.getByTestId('inv-row').first();
    await row0.getByTestId('move-entrada').click();
    await row0.getByTestId('move-qty').fill('2');
    await page.getByTestId('inv-sub-fletes').click();
    await expect(page.getByTestId('fletes')).toBeVisible();
    await expect(page.getByTestId('inv-row').first()).toBeHidden();
    await expect(page.getByTestId('inv-row')).toHaveCount(3); // siguen montadas, solo ocultas
    await page.getByTestId('inv-sub-existencias').click();
    await expect(row0.getByTestId('move-qty')).toHaveValue('2'); // seguía ahí
    await row0.getByTestId('move-save').click();
    await expect(toast(page)).toContainText('Entrada manual registrada');
  });
});

test.describe('Fletes · respaldo y restauración', () => {
  test('el respaldo exportado trae los fletes (formato 3) y restaurarlo en una app limpia los deja idénticos y auditados', async ({ page, browser }) => {
    test.setTimeout(120_000);
    await openApp(page);
    await openFletes(page);
    await saveFlete(page, { folio: 'B-1', origin: 'a', destination: 'b', initial: { gross: '22000', tare: '7000', ticket: 'T1' }, final: { mode: 'directo', net: '14800' } });
    await saveFlete(page, { folio: 'B-2', origin: 'c', destination: 'd', initial: { mode: 'directo', net: '9000' } });
    await row(page, 'B-1').getByTestId('fl-edit').click();
    await fillFlete(page, { origin: 'a2' });
    await page.getByTestId('fl-reason').fill('typo');
    await page.getByTestId('fl-save').click();
    await expect(toast(page)).toContainText('corregido');
    await page.getByTestId('fl-settings').locator('summary').click();
    await page.getByTestId('fl-ref-min').fill('150');
    await page.getByTestId('fl-ref-max').fill('250');
    await page.getByTestId('fl-ref-save').click();
    await expect(toast(page)).toContainText('Rango de referencia guardado');

    await tab(page, 'mas');
    const file = await captureDownload(page, () => page.getByTestId('export').click());
    expect(file.json).toMatchObject({ app: 'sistema-venta-limones', version: 3 });
    expect(file.json.freights).toHaveLength(2);
    expect(file.json.freightSettings).toEqual({ validated: false, refMinMilli: kg(150), refMaxMilli: kg(250) });
    const rawBefore = await rawFreights(page);
    expect(file.json.freights.slice().sort((a: { folio: string }, b: { folio: string }) => a.folio.localeCompare(b.folio))).toEqual(rawBefore);

    // Otra app, limpia: restaura por la interfaz
    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, serviceWorkers: 'allow', viewport: { width: 412, height: 915 } });
    try {
      const other = await ctx.newPage();
      await other.goto('/');
      await expect(other.getByTestId('caja')).toBeVisible();
      await restoreBackup(other, file.json);
      expect(await rawFreights(other)).toEqual(rawBefore);
      expect(await rawSettings(other)).toEqual({ validated: false, refMinMilli: kg(150), refMaxMilli: kg(250) });
      await openFletes(other);
      await expect(row(other, 'B-1').getByTestId('fl-difference')).toHaveText('200 kg · 1.33 %'); // 15,000 − 14,800
      await expect(other.getByTestId('fl-ref-label')).toHaveText('150–250 kg · pendiente de validación');
      await tab(other, 'mas');
      await other.getByTestId('audit').click();
      await expect(other.getByTestId('audit-result')).toContainText('Sin inconsistencias');
    } finally {
      await ctx.close();
    }
  });

  test('restaurar un respaldo VIEJO (formato 2, sin fletes) avisa que los fletes de hoy se perderán, exige confirmar y los deja vacíos; «Deshacer» los devuelve', async ({ page }) => {
    test.setTimeout(120_000);
    const market = buildMarket();
    await openApp(page, { seed: false });
    await restoreBackup(page, asV3(market.backup, sampleFreights().slice(0, 3)));
    await openFletes(page);
    await expect(page.getByTestId('fl-row')).toHaveCount(3);
    const withFreights = await rawFreights(page);

    await tab(page, 'mas');
    await page.getByTestId('import-file').setInputFiles({ name: 'viejo.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(market.backup)) });
    await expect(page.getByTestId('restore-sheet')).toBeVisible();
    await expect(page.getByTestId('restore-loss-freights')).toContainText('no trae fletes: los 3 fletes que tienes hoy se perderán');
    await expect(page.getByTestId('restore-current')).toContainText('3 fletes');
    await expect(page.getByTestId('restore-confirm')).toBeDisabled(); // exige «Entiendo lo que se perderá»
    await page.getByTestId('restore-understood').check();
    await page.getByTestId('restore-confirm').click();
    await expect(toast(page)).toContainText('Respaldo restaurado');
    expect(await rawFreights(page)).toEqual([]);

    // La copia interna de seguridad los devuelve
    await page.getByTestId('undo-restore').click();
    await expect(page.getByTestId('restore-sheet')).toBeVisible();
    await expect(page.getByTestId('restore-summary')).toContainText('3 fletes');
    await page.getByTestId('restore-confirm').click();
    await expect(toast(page)).toContainText('Restauración deshecha');
    expect(await rawFreights(page)).toEqual(withFreights);
  });

  test('un respaldo con fletes dañados se rechaza ANTES de tocar nada (folio repetido, neto inválido, formato mezclado)', async ({ page }) => {
    test.setTimeout(90_000);
    const market = buildMarket();
    await openApp(page, { seed: false });
    await restoreBackup(page, asV3(market.backup, [mkFreight('OK-1')]));
    const before = await rawFreights(page);
    const dbBefore = await readDb(page);

    const bad: Array<[string, unknown, RegExp]> = [
      ['folio repetido', asV3(market.backup, [mkFreight('A-1'), mkFreight('a-1', { id: 'otro' })]), /fletes con folio repetido/],
      ['neto inválido', asV3(market.backup, [mkFreight('A-2', { initial: { mode: 'directo', netMilli: -1 } })]), /initial\.netMilli/],
      ['formato mezclado (dice 2 y trae fletes)', { ...asV3(market.backup, [mkFreight('A-3')]), version: 2 }, /formato mezclado/],
      ['falta la lista de fletes', { ...market.backup, version: 3 }, /falta freights/],
    ];
    await tab(page, 'mas');
    for (const [why, backup, message] of bad) {
      await page.getByTestId('import-file').setInputFiles({ name: 'malo.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
      await expect(toast(page), why).toContainText(message);
      await expect(page.getByTestId('restore-sheet'), why).toHaveCount(0);
    }
    expect(await rawFreights(page)).toEqual(before);
    expect(await readDb(page)).toEqual(dbBefore);
  });
});

test.describe('Fletes · migración REAL de la base v2 a la v3 en el navegador', () => {
  test('una base v2 con ventas, vales y recepciones sube a la v3: nada cambia, aparece el almacén de fletes y el aviso es el correcto', async ({ page }) => {
    test.setTimeout(90_000);
    await seedV2(page, richV2());
    const before = await readRawDb(page);
    expect(before!.version).toBe(2);
    expect(before!.stores.freights).toBeUndefined();

    await page.goto('/');
    await expect(page.getByTestId('caja')).toBeVisible();
    await expect(page.getByTestId('upgraded')).toBeVisible();
    await expect(page.getByTestId('upgraded')).toContainText('control de pesaje de tus fletes en Inventario → Fletes');
    await expect(page.getByTestId('upgraded')).toContainText('recepciones siguen igual');
    await expect(page.getByTestId('upgraded')).not.toContainText('registrar la mercancía que llega'); // eso ya lo tenía
    const after = await readRawDb(page);
    expect(after!.version).toBe(3);
    expectSameData(after, before, 'tras migrar de la v2 a la v3');
    expect(after!.stores.freights).toMatchObject({ keyPath: 'id', rows: [] });
    expect(after!.stores.freights.unique).toEqual(['byFolioKey']);

    await openFletes(page);
    await saveFlete(page, { folio: 'MIG-1', origin: 'a', destination: 'b', initial: { mode: 'directo', net: '1000' } });
    await tab(page, 'mas');
    await page.getByTestId('audit').click();
    await expect(page.getByTestId('audit-result')).toContainText('Sin inconsistencias');
  });
});

// ═════════════════════════════════════════ Diseño en pantallas de teléfono ═════════════════════════════════════════

async function boot(page: Page) {
  const market = buildMarket();
  await openApp(page, { seed: false });
  await restoreBackup(page, asV3(market.backup, sampleFreights()));
  await openFletes(page);
  await expect(page.getByTestId('fl-row')).toHaveCount(10);
  return market;
}

async function layoutProblems(page: Page): Promise<string[]> {
  await settled(page);
  const found = [
    ...(await overflowReport(page)).map((x) => `desborda: ${x}`),
    ...(await clippedTextReport(page)).map((x) => `recortado: ${x}`),
    ...(await touchTargetReport(page)).map((x) => `muy chico: ${x}`),
    ...(await bottomReachReport(page)).map((x) => `final: ${x}`),
  ];
  await page.evaluate(() => window.scrollTo(0, 0));
  return found;
}

for (const phone of PHONES) {
  test.describe(`Fletes · pantalla ${phone.name}`, () => {
    test.use({ viewport: { width: phone.width, height: phone.height } });

    test('lista poblada (los 10 casos, incluidos textos larguísimos y 199,999.999 kg), formulario, corrección, bitácora, anulación y rango: nada desborda ni se recorta y todo se alcanza', async ({ page }) => {
      test.setTimeout(120_000);
      await boot(page);
      const bad: Record<string, string[]> = {};
      const visit = async (where: string) => {
        const p = await layoutProblems(page);
        if (p.length) bad[where] = p;
      };
      await visit('Fletes · lista');

      // estados de la lista
      await expect(row(page, 'F-DENTRO').getByTestId('fl-row-class')).toHaveAttribute('data-class', 'dentro');
      await expect(row(page, 'F-DEBAJO').getByTestId('fl-row-class')).toHaveAttribute('data-class', 'debajo');
      await expect(row(page, 'F-ENCIMA').getByTestId('fl-row-class')).toHaveAttribute('data-class', 'encima');
      await expect(row(page, 'F-MAYOR').getByTestId('fl-row-class')).toHaveAttribute('data-class', 'final_mayor');
      await expect(row(page, 'F-IGUAL').getByTestId('fl-row-class')).toHaveAttribute('data-class', 'sin_diferencia');
      await expect(row(page, 'F-SOLO-ORIGEN').getByTestId('fl-state')).toHaveText('Falta el peso final');
      await expect(row(page, 'F-SOLO-DESTINO').getByTestId('fl-state')).toHaveText('Falta el peso inicial');
      await expect(row(page, 'F-ANULADO').getByTestId('fl-state')).toHaveText('Anulado');
      const long = page.locator('[data-testid="fl-row"]').last();
      await expect(long.getByTestId('fl-initial')).toHaveAttribute('data-milli', '199999999');
      // 199,999.999 kg − 1 kg = 199,998.999 kg · 99.9995 % → 99.9995 se redondea a 100.00 %: la diferencia es casi todo
      await expect(long.getByTestId('fl-difference')).toHaveAttribute('data-bp', '10000');
      await visit('Fletes · lista (final)');

      await row(page, 'F-CORREGIDO').getByTestId('fl-history-btn').click();
      await expect(page.getByTestId('fl-history')).toContainText('Peso inicial · bruto: 22,000 kg → 22,500 kg');
      await visit('Fletes · bitácora');
      await row(page, 'F-CORREGIDO').getByTestId('fl-history-btn').click();
      await row(page, 'F-DENTRO').getByTestId('fl-void').click();
      await expect(page.getByTestId('fl-void-panel')).toBeVisible();
      await visit('Fletes · anular');
      await page.getByTestId('fl-void-no').click();

      await row(page, 'F-DEBAJO').getByTestId('fl-edit').click();
      await expect(page.getByTestId('fl-form')).toBeVisible();
      await visit('Fletes · corregir');
      await page.getByTestId('fl-cancel').click();
      await row(page, 'F-SOLO-ORIGEN').getByTestId('fl-edit').click();
      await visit('Fletes · registrar peso final');
      await page.getByTestId('fl-cancel').click();

      await page.getByTestId('fl-new').click();
      await visit('Fletes · nuevo, vacío');
      await fillFlete(page, {
        folio: 'F'.repeat(40),
        origin: 'O'.repeat(120),
        destination: `${'D'.repeat(60)} ${'E'.repeat(59)}`,
        initial: { gross: '199999.999', tare: '0.001', ticket: 'T'.repeat(60), scale: 'B'.repeat(120) },
        final: { mode: 'directo', net: '1', ticket: 'U'.repeat(60) },
        notes: 'n'.repeat(300),
      });
      await expect(page.getByTestId('fl-preview')).toBeVisible();
      await visit('Fletes · nuevo, con textos y pesos máximos');
      await page.getByTestId('fl-cancel').click();

      await page.getByTestId('fl-settings').locator('summary').click();
      await visit('Fletes · rango de referencia abierto');
      expect(bad, `${phone.name}: estados con defectos de diseño`).toEqual({});
    });

    test('con el teclado abierto (ventana encogida) el formulario sigue usable: el campo enfocado cabe, «Guardar flete» se alcanza y el primer toque funciona', async ({ page }) => {
      test.setTimeout(90_000);
      await boot(page);
      await page.getByTestId('fl-new').click();
      await fillFlete(page, { origin: 'Zamora', destination: 'CDMX', initial: { gross: '1000', tare: '100' } });
      for (const id of ['fl-folio', 'fl-i-ticket', 'fl-f-net', 'fl-notes'] as const) {
        if (id === 'fl-f-net') await page.getByTestId('fl-f-mode-directo').click();
        await showKeyboard(page, phone);
        const field = page.getByTestId(id);
        await field.evaluate((el) => (el as HTMLElement).blur());
        await field.focus();
        await expect(html(page)).toHaveClass(/kbd/);
        const box = await field.boundingBox();
        expect(box, id).not.toBeNull();
        expect(box!.y, `${id} no queda arriba de la pantalla`).toBeGreaterThanOrEqual(-1);
        expect(box!.y + box!.height, `${id} cabe sobre el teclado`).toBeLessThanOrEqual(phone.height - phone.keyboardPx + 1);
        expect(await reachReport(page.getByTestId('fl-save')), `con ${id} enfocado`).toEqual([]);
        await hideKeyboard(page, phone);
        await expect(html(page)).not.toHaveClass(/kbd/);
      }
      await page.getByTestId('fl-save').click();
      await expect(toast(page)).toContainText('Flete');
      await expect(toast(page)).toContainText('guardado');
    });

    test('todos los controles de la pantalla de fletes tienen nombre accesible', async ({ page }) => {
      await boot(page);
      await page.getByTestId('fl-new').click();
      await page.getByTestId('fl-settings').locator('summary').click();
      expect(await controlNameReport(page)).toEqual({ unnamed: [], placeholderOnly: [] });
    });
  });
}
