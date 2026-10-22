import { chromium, devices, expect, test as base } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openApp, tab } from './helpers';
import {
  FORM_KEY,
  PHONES,
  auditRaw,
  autosaved,
  byStatus,
  centerOf,
  confirmDisabled,
  doubleTapAt,
  expectFormClean,
  expectNet,
  expectNothingChanged,
  expectSolidTap,
  expectStock,
  expectTabsIntact,
  goReceive,
  hideKeyboard,
  html,
  innerHeight,
  invRow,
  lastTap,
  localInput,
  movesOf,
  nextReceptionFolio,
  orderedMoves,
  overflowing,
  physicalOf,
  pick,
  readDb,
  receive,
  register,
  rectOf,
  reservedOf,
  sellExact,
  sellVale,
  setMode,
  setPackaging,
  showKeyboard,
  subTab,
  tapDisabledConfirm,
  toast,
  typeContainers,
  typeLot,
  typeNet,
  watchTaps,
} from './helpers-recepcion';

/**
 * Cada prueba falla además si la página lanzó un error de JavaScript sin atrapar (incluye promesas rechazadas sin atender):
 * la app los mostraría como «Error inesperado», pero una prueba que solo mira lo que se ve podría no notarlo.
 */
const test = base.extend<{ sinErroresDeJs: void }>({
  sinErroresDeJs: [
    async ({ page }, use) => {
      const errores: string[] = [];
      page.on('pageerror', (e) => errores.push(`${e.name}: ${e.message}`));
      await use();
      expect(errores, 'la página lanzó errores de JavaScript sin atrapar').toEqual([]);
    },
    { auto: true },
  ],
});

/**
 * RECEPCIÓN DE MERCANCÍA · pruebas E2E (Chromium, perfil Pixel 7, zona America/Mexico_City, es-MX).
 *
 * Cada prueba usa un contexto aislado (IndexedDB propia). Se comprueba el EFECTO REAL: lo que se ve en pantalla Y lo que
 * quedó en la base (milésimas de kilo exactas, vínculos entre documentos, folios), con su camino negativo.
 * Un fallo de estas pruebas que no sea un error de la prueba es un fallo de la APP: no se afloja la aserción.
 */

test.describe('Recepción · kilos netos (casos 8 a 11)', () => {
  test('8 · a granel directo (120 kg): la hoja muestra +120 kg y bodega 0 g → 120 kg; registra UNA recepción R-1 y deja inventario, movimiento, historial y formulario en orden', async ({
    page,
  }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await expect(page.getByTestId('rec-selected')).toContainText('en bodega ahora: 0 g');

    await test.step('valores iniciales: a granel, kilos netos directos y nada que registrar todavía', async () => {
      await expect(page.getByTestId('rec-pack-granel')).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('rec-mode-directo')).toHaveAttribute('aria-checked', 'true');
      await confirmDisabled(page, true);
    });

    await typeNet(page, '120');
    await typeLot(page, { supplier: 'Rancho Los Limones', reference: 'CAM-01' });
    await expectNet(page, 120000, '120 kg');
    await confirmDisabled(page, false);

    await test.step('la hoja de confirmación muestra el efecto y todavía NO registra nada', async () => {
      await page.getByTestId('rec-confirm').click();
      const sheet = page.getByTestId('rec-sheet');
      await expect(sheet).toBeVisible();
      await expect(sheet.getByTestId('rec-sheet-net')).toHaveAttribute('data-milli', '120000');
      await expect(sheet.getByTestId('rec-sheet-net')).toHaveText('+120 kg');
      await expect(sheet.getByTestId('rec-sheet-stock')).toHaveText(/En bodega: 0 g → 120 kg/);
      await expect(sheet.getByTestId('rec-sheet-detail')).toContainText('A granel');
      await expect(sheet.getByTestId('rec-dup-warning')).toHaveCount(0);
      await expectNothingChanged(page, 'con la hoja abierta (antes de confirmar)');
    });

    await test.step('«Volver» cierra la hoja sin registrar y conserva lo capturado', async () => {
      await page.getByTestId('rec-confirm-no').click();
      await expect(page.getByTestId('rec-sheet')).toBeHidden();
      await expect(page.getByTestId('rec-net-direct')).toHaveValue('120');
      await expectNothingChanged(page, 'tras «Volver»');
    });

    await test.step('confirmar registra, avisa y deja el formulario listo para otra', async () => {
      await register(page, 'Recepción R-1 registrada: +120 kg');
      await expectFormClean(page);
      await expect(page.getByTestId('rec-last')).toContainText('Última registrada: R-1 · Con semilla · 120 kg');
      await expect(page.getByTestId('rec-pick-hint')).toBeVisible();
    });

    await test.step('inventario exacto y el movimiento visible en «Movimientos»', async () => {
      await expectStock(page, 'semilla', { physical: '120 kg', available: '120 kg', received: '120 kg', sold: '0 g' });
      await expectStock(page, 'primera', { physical: '0 g' });
      await expectStock(page, 'segunda', { physical: '0 g' });
      const row = invRow(page, 'semilla');
      await row.getByTestId('show-moves').click();
      await expect(row.getByTestId('moves-list')).toContainText('recepción de mercancía R-1');
      await expect(row.getByTestId('moves-list')).toContainText('+120 kg físico');
    });

    await test.step('una sola recepción en el historial, con folio', async () => {
      await subTab(page, 'historial');
      await expect(page.getByTestId('rec-row')).toHaveCount(1);
      await expect(page.getByTestId('rec-hist-count')).toHaveText('Mostrando 1 de 1');
      const row = page.getByTestId('rec-row').first();
      await expect(row).toContainText('R-1 · Con semilla');
      await expect(row.getByTestId('rec-row-net')).toHaveText('120 kg');
      await expect(row).toContainText('A granel');
      await expect(row).toContainText('Rancho Los Limones');
      await expect(row).toContainText('ref. CAM-01');
      await expect(page.getByTestId('rec-hist-total')).toContainText('1 recepción registrada · 120 kg en total');
    });

    await test.step('en la base: un documento, un movimiento enlazado, kilos exactos y el siguiente folio', async () => {
      const d = await readDb(page);
      expect(d.receptions).toHaveLength(1);
      const rec = d.receptions[0];
      expect(rec).toMatchObject({
        status: 'confirmada', folio: 1, packaging: 'granel', weightMode: 'directo', netDirectMilli: 120000,
        confirmedNetMilli: 120000, netMilli: 120000, supplier: 'Rancho Los Limones', reference: 'CAM-01',
      });
      expect(rec.corrections).toEqual([]);
      const mv = movesOf(d, 'semilla');
      expect(mv).toHaveLength(1);
      expect(mv[0]).toMatchObject({ type: 'recepcion', deltaMilli: 120000, reservedDeltaMilli: 0, receptionId: rec.id });
      expect(rec.stockMoveId).toBe(mv[0].id);
      expect(physicalOf(d, 'semilla')).toBe(120000);
      expect(nextReceptionFolio(d)).toBe(2);
      expect(auditRaw(d)).toEqual([]);
    });
  });

  test('9 · cajas con peso configurado: 10 cajas × 12.5 kg = 125 kg (fraccionario); no hay peso preseleccionado y las cajas se registran aparte de los kilos', async ({
    page,
  }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await setPackaging(page, 'caja');

    await test.step('la caja se cuenta × lo que pesa cada una y NADA viene preseleccionado', async () => {
      await expect(page.getByTestId('rec-mode-por_envase')).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('rec-containers')).toHaveValue('');
      await expect(page.getByTestId('rec-unit-net')).toHaveValue('');
      await expect(page.getByTestId('rec-use-last')).toHaveCount(0); // sin historial no se sugiere ningún peso
      await expect(page.getByTestId('rec-net-direct')).toHaveCount(0);
      await expect(page.getByTestId('rec-net')).toHaveText('—'); // sin kilos: ni 0 ni un valor inventado
      await expect(page.getByTestId('rec-net')).toHaveAttribute('data-milli', '');
      await confirmDisabled(page, true);
    });

    await test.step('camino negativo: cajas contadas pero SIN peso por caja → no deja registrar y lo dice', async () => {
      await page.getByTestId('rec-containers').fill('10');
      await confirmDisabled(page, true);
      await tapDisabledConfirm(page);
      await expect(toast(page)).toHaveClass(/error/);
      await expect(toast(page)).toContainText('Escribe el peso neto de cada caja');
      await expect(page.getByTestId('rec-sheet')).toHaveCount(0);
      await expectNothingChanged(page, 'cajas sin peso');
    });

    await page.getByTestId('rec-unit-net').fill('12.5');
    await expectNet(page, 125000, '125 kg');
    await expect(page.getByTestId('rec-net-hint')).toContainText('10 cajas × 12.5 kg');
    await confirmDisabled(page, false);

    await page.getByTestId('rec-confirm').click();
    await expect(page.getByTestId('rec-sheet-net')).toHaveAttribute('data-milli', '125000');
    await expect(page.getByTestId('rec-sheet-detail')).toHaveText('Caja limonera · 10 cajas · 10 cajas × 12.5 kg');
    await page.getByTestId('rec-confirm-yes').click();
    await expect(toast(page)).toContainText('Recepción R-1 registrada: +125 kg');

    await test.step('inventario en KILOS (125, no 10 ni 135) y cajas aparte en el historial y el resumen', async () => {
      await expectStock(page, 'semilla', { physical: '125 kg', received: '125 kg' });
      await subTab(page, 'historial');
      const row = page.getByTestId('rec-row').first();
      await expect(row.getByTestId('rec-row-net')).toHaveText('125 kg');
      await expect(row).toContainText('Caja limonera · 10 cajas · Envases × peso de cada uno (12.5 kg c/u)');
      await subTab(page, 'resumen');
      await page.getByTestId('rep-fold-breakdown').locator('summary').click();
      const pk = page.getByTestId('rep-by-packaging-row');
      await expect(pk).toHaveCount(1);
      await expect(pk).toContainText('Caja limonera');
      await expect(pk).toContainText('1 recepción · 10 cajas · 125 kg');
    });

    await test.step('en la base: solo los campos del modo activo; envases guardados, kilos exactos', async () => {
      const d = await readDb(page);
      const rec = d.receptions[0];
      expect(rec).toMatchObject({
        packaging: 'caja', containers: 10, weightMode: 'por_envase', unitNetMilli: 12500, confirmedNetMilli: 125000, folio: 1,
      });
      expect(rec.netDirectMilli).toBeUndefined();
      expect(rec.grossMilli).toBeUndefined();
      expect(rec.tareMilli).toBeUndefined();
      expect(physicalOf(d, 'semilla')).toBe(125000);
      expect(movesOf(d, 'semilla')).toHaveLength(1);
      expect(auditRaw(d)).toEqual([]);
    });
  });

  test('10 · arpillas con peso configurado: 10 × 15 kg = 150 kg; el 15 NO viene precargado y solo se ofrece reutilizar lo ya capturado para ESA clasificación y presentación', async ({
    page,
  }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await setPackaging(page, 'arpilla');

    await test.step('la arpilla pide cuántas y cuánto pesa cada una; sin valor «típico» de 15 kg', async () => {
      await expect(page.getByTestId('rec-mode-por_envase')).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('rec-unit-net')).toHaveValue('');
      await expect(page.getByTestId('rec-mode-help')).toContainText('Cuenta las arpillas');
      await expect(page.getByTestId('rec-mode-help')).toContainText('La app no supone ese peso');
      await expect(page.getByTestId('rec-use-last')).toHaveCount(0);
    });

    await typeContainers(page, '10', '15');
    await expectNet(page, 150000, '150 kg');
    await page.getByTestId('rec-confirm').click();
    await expect(page.getByTestId('rec-sheet-detail')).toHaveText('Arpilla · 10 arpillas · 10 arpillas × 15 kg');
    await page.getByTestId('rec-confirm-yes').click();
    await expect(toast(page)).toContainText('Recepción R-1 registrada: +150 kg');
    await expect(page.getByTestId('rec-sheet')).toBeHidden();

    await test.step('la siguiente captura ofrece el peso REAL de R-1, solo para la misma clasificación y presentación', async () => {
      await pick(page, 'semilla');
      await setPackaging(page, 'arpilla');
      const last = page.getByTestId('rec-use-last');
      await expect(last).toContainText('Usar 15 kg por arpilla (lo que capturaste en R-1)');
      await setPackaging(page, 'caja'); // otra presentación: no hay historial → no se sugiere nada
      await expect(last).toHaveCount(0);
      await setPackaging(page, 'arpilla');
      await expect(last).toBeVisible();
      await pick(page, 'primera'); // otra clasificación: tampoco
      await expect(last).toHaveCount(0);
      await pick(page, 'semilla');
      await expect(last).toBeVisible();
      await last.click();
      await expect(page.getByTestId('rec-unit-net')).toHaveValue('15');
      await page.getByTestId('rec-containers').fill('4');
      await expectNet(page, 60000, '60 kg');
      await register(page, 'Recepción R-2 registrada: +60 kg');
    });

    const d = await readDb(page);
    expect(d.receptions.map((r) => [r.folio, r.packaging, r.containers, r.unitNetMilli, r.confirmedNetMilli])).toEqual(
      expect.arrayContaining([
        [1, 'arpilla', 10, 15000, 150000],
        [2, 'arpilla', 4, 15000, 60000],
      ]),
    );
    expect(physicalOf(d, 'semilla')).toBe(210000);
    expect(auditRaw(d)).toEqual([]);
    await expectStock(page, 'semilla', { physical: '210 kg', received: '210 kg' });
  });

  test('11 · bruto − tara: 135.5 − 4.25 = 131.25 kg exactos; las cajas son solo conteo informativo (promedio) y no multiplican nada', async ({
    page,
  }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await setPackaging(page, 'caja');
    await setMode(page, 'bruto_tara');
    await expect(page.getByTestId('rec-mode-help')).toContainText('Bruto = con la caja o el costal');

    await page.getByTestId('rec-gross').fill('135.5');
    await expect(page.getByTestId('rec-net-hint')).toContainText('Escribe la tara'); // falta la tara: aún no hay neto
    await expect(page.getByTestId('rec-net')).toHaveText('—');
    await page.getByTestId('rec-tare').fill('4.25');
    await expectNet(page, 131250, '131.25 kg');
    await expect(page.getByTestId('rec-net-hint')).toContainText('bruto 135.5 kg − tara 4.25 kg');
    await page.getByTestId('rec-containers').fill('5');
    await expect(page.getByTestId('rec-avg')).toHaveText('Eso da 26.25 kg por caja (promedio, solo informativo).');
    await expectNet(page, 131250, '131.25 kg'); // contar cajas no cambia los kilos

    await page.getByTestId('rec-confirm').click();
    await expect(page.getByTestId('rec-sheet-net')).toHaveAttribute('data-milli', '131250');
    await expect(page.getByTestId('rec-sheet-avg')).toHaveText('Promedio: 26.25 kg por caja (informativo).');
    await expect(page.getByTestId('rec-sheet-detail')).toHaveText('Caja limonera · 5 cajas · bruto 135.5 kg − tara 4.25 kg');
    await page.getByTestId('rec-confirm-yes').click();
    await expect(toast(page)).toContainText('Recepción R-1 registrada: +131.25 kg');

    await expectStock(page, 'semilla', { physical: '131.25 kg', received: '131.25 kg' });
    const d = await readDb(page);
    const rec = d.receptions[0];
    expect(rec).toMatchObject({ weightMode: 'bruto_tara', grossMilli: 135500, tareMilli: 4250, confirmedNetMilli: 131250, containers: 5 });
    expect(rec.netDirectMilli).toBeUndefined();
    expect(rec.unitNetMilli).toBeUndefined();
    expect(physicalOf(d, 'semilla')).toBe(131250);
    expect(auditRaw(d)).toEqual([]);
  });

  test('11 · varias pesadas: 40.5 + 35.25 + 44.25 = 120 kg; quitar una recalcula, las pesadas ilegibles no entran y el detalle conserva cada pesada', async ({
    page,
  }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await page.getByTestId('rec-weigh-toggle').click();
    await expect(page.getByTestId('rec-weigh')).toBeVisible();
    await expect(page.getByTestId('rec-weigh-total')).toHaveText('0 pesadas = 0 g');

    for (const w of ['40.5', '35.25', '44.25']) {
      await page.getByTestId('rec-weigh-input').fill(w);
      await page.getByTestId('rec-weigh-add').click();
    }
    await expect(page.getByTestId('rec-weigh-item')).toHaveCount(3);
    await expect(page.getByTestId('rec-weigh-total')).toHaveText('3 pesadas = 120 kg');
    await expectNet(page, 120000, '120 kg');

    await test.step('camino negativo: pesadas inválidas no se agregan y el total no cambia', async () => {
      for (const bad of ['abc', '-3', '1,500', '1.2345', '1e2', '200001']) {
        await page.getByTestId('rec-weigh-input').fill(bad);
        await page.getByTestId('rec-weigh-add').click();
        await expect(page.getByTestId('rec-weigh-item'), `la pesada «${bad}» no debe agregarse`).toHaveCount(3);
      }
      await expect(page.getByTestId('rec-weigh-total')).toHaveText('3 pesadas = 120 kg');
      await expectNet(page, 120000, '120 kg');
    });

    await test.step('quitar una pesada recalcula; volver a «un solo total» no suma dos veces', async () => {
      await page.getByTestId('rec-weigh-remove').nth(1).click(); // quita 35.25
      await expect(page.getByTestId('rec-weigh-total')).toHaveText('2 pesadas = 84.75 kg');
      await expectNet(page, 84750, '84.75 kg');
      await page.getByTestId('rec-weigh-input').fill('35.25');
      await page.getByTestId('rec-weigh-add').click();
      await expect(page.getByTestId('rec-weigh-total')).toHaveText('3 pesadas = 120 kg');
      await page.getByTestId('rec-weigh-toggle').click(); // «Capturar un solo total»
      await expect(page.getByTestId('rec-net-direct')).toHaveValue('120');
      await expectNet(page, 120000, '120 kg');
      await page.getByTestId('rec-weigh-toggle').click(); // otra vez varias pesadas: queda UNA pesada de 120
      await expect(page.getByTestId('rec-weigh-total')).toHaveText('1 pesada = 120 kg');
      await expectNet(page, 120000, '120 kg');
      await page.getByTestId('rec-weigh-remove').first().click(); // se vacía la lista para volver a pesar por partes
      await expect(page.getByTestId('rec-weigh-item')).toHaveCount(0);
      await expect(page.getByTestId('rec-net')).toHaveText('—');
      for (const w of ['40.5', '35.25', '44.25']) {
        await page.getByTestId('rec-weigh-input').fill(w);
        await page.getByTestId('rec-weigh-add').click();
      }
      await expect(page.getByTestId('rec-weigh-total')).toHaveText('3 pesadas = 120 kg');
    });

    await page.getByTestId('rec-confirm').click();
    await expect(page.getByTestId('rec-sheet-detail')).toHaveText('A granel · 3 pesadas: 40.5 kg + 35.25 kg + 44.25 kg');
    await page.getByTestId('rec-confirm-yes').click();
    await expect(toast(page)).toContainText('Recepción R-1 registrada: +120 kg');
    await subTab(page, 'historial');
    await expect(page.getByTestId('rec-row').first()).toContainText('(3 pesadas)');
    const d = await readDb(page);
    expect(d.receptions[0]).toMatchObject({ netDirectMilli: 120000, weighingsMilli: [40500, 35250, 44250], confirmedNetMilli: 120000 });
    expect(physicalOf(d, 'semilla')).toBe(120000);
    expect(auditRaw(d)).toEqual([]);
  });

  test('11 · los modos de peso son excluyentes: cambiar de modo NUNCA mezcla un cálculo con un valor capturado y solo se guarda el modo activo', async ({
    page,
  }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await setPackaging(page, 'caja');

    // modo envases × peso: 10 × 12.5 = 125
    await typeContainers(page, '10', '12.5');
    await expectNet(page, 125000, '125 kg');

    // modo directo: los envases ya escritos NO se suman al neto capturado
    await setMode(page, 'directo');
    await expect(page.getByTestId('rec-net')).toHaveText('—'); // aún sin kilos directos: no se hereda el 125
    await page.getByTestId('rec-net-direct').fill('50');
    await expectNet(page, 50000, '50 kg'); // no 175
    await expect(page.getByTestId('rec-avg')).toHaveText('Eso da 5 kg por caja (promedio, solo informativo).'); // 50 / 10 cajas

    // modo bruto − tara
    await setMode(page, 'bruto_tara');
    await expect(page.getByTestId('rec-net')).toHaveText('—'); // sin bruto: no se hereda el 50 ni el 125
    await page.getByTestId('rec-gross').fill('80');
    await page.getByTestId('rec-tare').fill('5');
    await expectNet(page, 75000, '75 kg'); // no 125 ni 130 ni 200

    // de regreso a cada modo: cada uno conserva SOLO lo suyo
    await setMode(page, 'directo');
    await expectNet(page, 50000, '50 kg');
    await setMode(page, 'por_envase');
    await expectNet(page, 125000, '125 kg');

    await register(page, 'Recepción R-1 registrada: +125 kg');
    const d = await readDb(page);
    const rec = d.receptions[0];
    expect(rec.weightMode).toBe('por_envase');
    expect(rec.confirmedNetMilli).toBe(125000);
    expect(rec).toMatchObject({ containers: 10, unitNetMilli: 12500 });
    // lo capturado en los OTROS modos no se guarda
    expect(rec.netDirectMilli).toBeUndefined();
    expect(rec.grossMilli).toBeUndefined();
    expect(rec.tareMilli).toBeUndefined();
    expect(physicalOf(d, 'semilla')).toBe(125000);
    expect(auditRaw(d)).toEqual([]);
  });
});

test.describe('Recepción · pesadas de cero (negativo de captura)', () => {
  test('una pesada de 0 kg NO entra a la lista de pesadas (pide kilos mayores a cero) y no bloquea el registro de las demás', async ({ page }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await page.getByTestId('rec-weigh-toggle').click();
    await page.getByTestId('rec-weigh-input').fill('40');
    await page.getByTestId('rec-weigh-add').click();
    await expect(page.getByTestId('rec-weigh-item')).toHaveCount(1);

    await page.getByTestId('rec-weigh-input').fill('0');
    await page.getByTestId('rec-weigh-add').click();
    // La app dice «Escribe los kilos de la pesada (mayor a cero)»: una pesada de cero no es una pesada.
    await expect(page.getByTestId('rec-weigh-item'), 'la pesada de 0 no debe agregarse').toHaveCount(1);
    await expect(toast(page)).toHaveClass(/error/);
    await expect(toast(page)).toContainText('mayor a cero');

    await page.getByTestId('rec-weigh-input').fill('35');
    await page.getByTestId('rec-weigh-add').click();
    await expect(page.getByTestId('rec-weigh-total')).toHaveText('2 pesadas = 75 kg');
    await confirmDisabled(page, false); // sin una pesada de cero colada, se puede registrar
    await register(page, 'Recepción R-1 registrada: +75 kg');
  });

  test('una pesada de 0 kg colada en la lista no hace que se PIERDA la captura en curso al recargar la página', async ({ page }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await page.getByTestId('rec-weigh-toggle').click();
    for (const w of ['40', '0', '35']) {
      await page.getByTestId('rec-weigh-input').fill(w);
      await page.getByTestId('rec-weigh-add').click();
    }
    await page.getByTestId('rec-supplier').fill('Rancho que no debe perderse');
    // La captura en curso se guarda sola… o debería: con una pesada de cero la guardada se descarta entera al leerla.
    await expect
      .poll(() => page.evaluate((k) => localStorage.getItem(k), 'cc.rec.form.v1'), { message: 'la captura debería guardarse sola' })
      .not.toBeNull();
    await page.reload();
    await goReceive(page);
    await expect(page.getByTestId('rec-restored'), 'la captura en curso debería recuperarse tras recargar').toBeVisible();
    await expect(page.getByTestId('rec-supplier')).toHaveValue('Rancho que no debe perderse');
  });
});

test.describe('Recepción · máximo de pesadas', () => {
  test('sumar más de 100 pesadas se rechaza con aviso y las 100 primeras siguen sumando exacto', async ({ page }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await page.getByTestId('rec-weigh-toggle').click();
    const input = page.getByTestId('rec-weigh-input');
    // Se agrega con la tecla «Listo» (Enter) del teclado: con la lista larga, el botón «＋ Sumar» queda arriba, debajo del
    // encabezado o de la barra fija al desplazarse, y esa vía (que también existe en el teléfono) no depende de dónde esté.
    for (let i = 0; i < 100; i++) {
      await input.fill('1.5');
      await input.press('Enter');
    }
    await expect(page.getByTestId('rec-weigh-item')).toHaveCount(100);
    await expect(page.getByTestId('rec-weigh-total')).toHaveText('100 pesadas = 150 kg');
    await input.fill('1.5');
    await input.press('Enter');
    await expect(toast(page)).toHaveClass(/error/);
    await expect(toast(page)).toContainText('Máximo 100 pesadas');
    await expect(page.getByTestId('rec-weigh-item')).toHaveCount(100);
    await expectNet(page, 150000, '150 kg');
    await register(page, 'Recepción R-1 registrada: +150 kg');
    const d = await readDb(page);
    expect(d.receptions[0].weighingsMilli).toHaveLength(100);
    expect(physicalOf(d, 'semilla')).toBe(150000);
    expect(auditRaw(d)).toEqual([]);
  });
});

test.describe('Recepción · borradores y peso desconocido (caso 13)', () => {
  test('13 · cajas SIN peso: «Registrar» no deja (aria-disabled + mensaje claro) pero SÍ se guarda un borrador que no toca el inventario y deja un contador en la pestaña', async ({
    page,
  }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await setPackaging(page, 'caja');
    await page.getByTestId('rec-containers').fill('40');
    await typeLot(page, { supplier: 'Huerta Sur', reference: 'CAM-40' });

    await confirmDisabled(page, true);
    await tapDisabledConfirm(page);
    await expect(toast(page)).toHaveClass(/error/);
    await expect(toast(page)).toContainText('Escribe el peso neto de cada caja (si no lo conoces, guarda un borrador)');
    await expect(page.getByTestId('rec-missing')).toContainText('Escribe el peso neto de cada caja');
    await expect(page.getByTestId('rec-sheet')).toHaveCount(0);
    await expectNothingChanged(page, 'intento de registrar sin peso');

    await test.step('guardar borrador: sin peso es válido, no suma y avisa', async () => {
      await expect(page.getByTestId('rec-save-draft')).toHaveAttribute('aria-disabled', 'false');
      await page.getByTestId('rec-save-draft').click();
      await expect(toast(page)).toContainText('Borrador guardado (aún sin peso neto): no suma al inventario');
      await expect(page.getByTestId('rec-parked')).toContainText('NO suma al inventario');
      await expectFormClean(page);
    });

    await test.step('contador en la pestaña y en la subpestaña; el inventario sigue en cero', async () => {
      await expect(page.getByTestId('menu-count')).toHaveText('1');
      await expect(page.getByTestId('menu-btn')).toHaveAttribute('aria-label', 'Más secciones, 1 borrador pendiente');
      await expect(page.getByTestId('rec-sub-borradores')).toHaveText('Pendientes (1)');
      await expectStock(page, 'semilla', { physical: '0 g', available: '0 g' });
      await expect(invRow(page, 'semilla').getByTestId('stock-recibido')).toHaveCount(0); // ni un movimiento
    });

    await test.step('aparece en Borradores diciendo qué falta, y no cuenta en el Resumen', async () => {
      await subTab(page, 'borradores');
      const row = page.getByTestId('rec-draft-row');
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('Con semilla');
      await expect(row).toContainText('Caja limonera · 40 cajas');
      await expect(row).toContainText('Huerta Sur');
      await expect(row).toContainText('Falta: Escribe el peso neto de cada caja');
      await subTab(page, 'resumen');
      await expect(page.getByTestId('rep-drafts')).toContainText('Hay 1 borrador sin registrar');
      await expect(page.getByTestId('rep-received')).toHaveAttribute('data-milli', '0');
    });

    const d = await readDb(page);
    expect(d.receptions).toHaveLength(1);
    expect(d.receptions[0]).toMatchObject({ status: 'borrador', packaging: 'caja', containers: 40, weightMode: 'por_envase' });
    expect(d.receptions[0].folio).toBeUndefined();
    expect(d.receptions[0].confirmedAt).toBeUndefined();
    expect(d.stockMoves).toHaveLength(0);
    expect(nextReceptionFolio(d)).toBe(1); // un borrador no gasta folio
    expect(auditRaw(d)).toEqual([]);
  });

  test('13 · completar un borrador y confirmarlo suma UNA sola vez (el mismo documento, sin duplicarse) y el contador desaparece', async ({
    page,
  }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await setPackaging(page, 'caja');
    await page.getByTestId('rec-containers').fill('40');
    await page.getByTestId('rec-save-draft').click();
    await expect(page.getByTestId('menu-count')).toHaveText('1');
    const draftId = (await readDb(page)).receptions[0].id;

    await subTab(page, 'borradores');
    await page.getByTestId('rec-draft-open').click();
    await expect(toast(page)).toContainText('Borrador abierto: completa lo que falta');
    await expect(page.getByTestId('rec-nueva')).toBeVisible();
    await expect(page.getByTestId('rec-selected')).toContainText('Con semilla');
    await expect(page.getByTestId('rec-pack-caja')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('rec-containers')).toHaveValue('40');
    await expect(page.getByTestId('rec-unit-net')).toHaveValue('');
    await confirmDisabled(page, true); // sigue faltando el peso

    await page.getByTestId('rec-unit-net').fill('18.25');
    await expectNet(page, 730000, '730 kg');
    await register(page, 'Recepción R-1 registrada: +730 kg');

    await expect(page.getByTestId('menu-count')).toHaveCount(0);
    await expect(page.getByTestId('rec-sub-borradores')).toHaveText('Pendientes');
    await subTab(page, 'borradores');
    await expect(page.getByTestId('rec-draft-row')).toHaveCount(0);
    await expect(page.getByTestId('rec-borradores')).toContainText('No hay borradores.');
    await expectStock(page, 'semilla', { physical: '730 kg' });

    const d = await readDb(page);
    expect(d.receptions, 'el borrador se completó, no se creó otro documento').toHaveLength(1);
    expect(d.receptions[0]).toMatchObject({ id: draftId, status: 'confirmada', folio: 1, containers: 40, unitNetMilli: 18250, confirmedNetMilli: 730000 });
    expect(movesOf(d, 'semilla')).toHaveLength(1);
    expect(physicalOf(d, 'semilla')).toBe(730000);
    expect(auditRaw(d)).toEqual([]);
  });

  test('13 · descartar un borrador NO cambia existencias ni gasta folio; queda en el historial como «Descartada» y «No» conserva el borrador', async ({
    page,
  }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await typeNet(page, '100');
    await register(page, 'Recepción R-1 registrada: +100 kg');

    // otro borrador, ahora con peso
    await pick(page, 'semilla');
    await typeNet(page, '50');
    await page.getByTestId('rec-save-draft').click();
    await expect(toast(page)).toContainText('Borrador guardado: no suma al inventario');
    await expectStock(page, 'semilla', { physical: '100 kg' });

    await subTab(page, 'borradores');
    await page.getByTestId('rec-draft-cancel').click();
    await expect(page.getByTestId('rec-draft-cancel-yes')).toBeVisible();
    await page.getByTestId('rec-draft-cancel-no').click(); // camino negativo: «No» no descarta
    await expect(page.getByTestId('rec-draft-row')).toHaveCount(1);
    expect(byStatus(await readDb(page), 'borrador')).toHaveLength(1);

    await page.getByTestId('rec-draft-cancel').click();
    await page.getByTestId('rec-draft-cancel-yes').click();
    await expect(toast(page)).toContainText('Borrador descartado: no cambió el inventario');
    await expect(page.getByTestId('rec-draft-row')).toHaveCount(0);
    await expect(page.getByTestId('menu-count')).toHaveCount(0);

    await test.step('queda en el historial como descartada, sin kilos', async () => {
      await subTab(page, 'historial');
      await page.getByTestId('rec-filter-cancelada').click();
      const row = page.getByTestId('rec-row');
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('Sin folio');
      await expect(row).toContainText('Descartada');
      await expect(row.getByTestId('rec-row-net')).toHaveText('—');
      await expect(row).toContainText('Descartada: borrador descartado');
      await expect(page.getByTestId('rec-correct')).toHaveCount(0); // un descartado no se corrige ni se anula
      await expect(page.getByTestId('rec-void')).toHaveCount(0);
    });

    await expectStock(page, 'semilla', { physical: '100 kg', received: '100 kg' });
    let d = await readDb(page);
    expect(byStatus(d, 'cancelada')).toHaveLength(1);
    expect(byStatus(d, 'cancelada')[0].cancelledAt).toBeTruthy();
    expect(byStatus(d, 'cancelada')[0].folio).toBeUndefined();
    expect(d.stockMoves).toHaveLength(1);
    expect(nextReceptionFolio(d)).toBe(2);

    // el siguiente folio es R-2: lo descartado no gastó numeración
    await goReceive(page);
    await pick(page, 'semilla');
    await typeNet(page, '30');
    await register(page, 'Recepción R-2 registrada: +30 kg');
    d = await readDb(page);
    expect(physicalOf(d, 'semilla')).toBe(130000);
    expect(auditRaw(d)).toEqual([]);
  });

  test('13 · abrir un borrador con otra captura en curso NO la pierde: la deja guardada en Borradores', async ({ page }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await typeNet(page, '40');
    await page.getByTestId('rec-save-draft').click();
    await expect(toast(page)).toContainText('Borrador guardado');

    // captura nueva a medias (completa, sin registrar ni guardar)
    await pick(page, 'primera');
    await typeNet(page, '25');
    await typeLot(page, { supplier: 'Rancho de paso' });

    await subTab(page, 'borradores');
    await page.getByTestId('rec-draft-open').click();
    await expect(toast(page)).toContainText('Borrador abierto: completa lo que falta');
    await expect(page.getByTestId('rec-selected')).toContainText('Con semilla');
    await expect(page.getByTestId('rec-net-direct')).toHaveValue('40');
    await expect(page.getByTestId('rec-supplier')).toHaveValue('');

    // lo que se estaba capturando quedó como borrador: hay DOS y ninguno suma al inventario
    await expect(page.getByTestId('menu-count')).toHaveText('2');
    await subTab(page, 'borradores');
    await expect(page.getByTestId('rec-draft-row')).toHaveCount(2);
    await expect(page.getByTestId('rec-draft-row').filter({ hasText: 'Rancho de paso' })).toContainText('Limón persa · Primera');
    await expect(page.getByTestId('rec-draft-row').filter({ hasText: 'Rancho de paso' })).toContainText('Kilos netos: 25 kg');
    const d = await readDb(page);
    expect(byStatus(d, 'borrador')).toHaveLength(2);
    expect(d.stockMoves).toHaveLength(0);
  });

  test('mirar otra pestaña NO pierde la captura de Recepción (ni el tipo elegido ni los kilos escritos)', async ({ page }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'primera');
    await setPackaging(page, 'arpilla');
    await typeContainers(page, '7', '14.5');
    await typeLot(page, { supplier: 'Rancho Sur' });
    for (const other of ['inventario', 'corte', 'caja', 'vales', 'mas'] as const) {
      await tab(page, other);
      await expect(page.getByTestId('recepcion')).toBeHidden();
    }
    await tab(page, 'recepcion');
    await expect(page.getByTestId('rec-selected')).toContainText('Limón persa · Primera');
    await expect(page.getByTestId('rec-pack-arpilla')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('rec-containers')).toHaveValue('7');
    await expect(page.getByTestId('rec-unit-net')).toHaveValue('14.5');
    await expect(page.getByTestId('rec-supplier')).toHaveValue('Rancho Sur');
    await expectNet(page, 101500, '101.5 kg');
    await expectNothingChanged(page, 'solo se miraron otras pestañas');
  });

  test('13 · el historial de «Descartadas» dice QUÉ tipo de limón era el borrador descartado (no solo «sin tipo»)', async ({ page }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'primera');
    await typeNet(page, '75');
    await page.getByTestId('rec-save-draft').click();
    await expect(toast(page)).toContainText('Borrador guardado');
    await subTab(page, 'borradores');
    // el borrador, en su lista, sí dice qué limón es
    await expect(page.getByTestId('rec-draft-row')).toContainText('Limón persa · Primera');
    await page.getByTestId('rec-draft-cancel').click();
    await page.getByTestId('rec-draft-cancel-yes').click();
    await expect(toast(page)).toContainText('Borrador descartado');
    await subTab(page, 'historial');
    await page.getByTestId('rec-filter-cancelada').click();
    await expect(page.getByTestId('rec-row')).toHaveCount(1);
    // lo descartado conserva su clasificación en el historial (el borrador ya la tenía elegida)
    await expect(page.getByTestId('rec-row')).toContainText('Limón persa · Primera');
    await tab(page, 'inventario');
    await expect(invRow(page, 'primera').getByTestId('stock-physical')).toHaveText('0 g');
  });
});


test.describe('Recepción · duplicados y doble pulsación (caso 12)', () => {
  test('12 · doble clic rápido en «Registrar recepción» y en «Confirmar» (y dos clics en el mismo instante) registra UNA sola recepción por intento y suma una sola vez', async ({
    page,
  }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await typeNet(page, '80');

    await test.step('doble clic real en «Registrar recepción»: abre UNA hoja y todavía no registra nada', async () => {
      await page.getByTestId('rec-confirm').dblclick();
      await expect(page.getByTestId('rec-sheet')).toHaveCount(1);
      await expect(page.getByTestId('rec-confirm-yes')).toBeVisible();
      await expectNothingChanged(page, 'tras el doble clic en «Registrar recepción» (solo debía abrir la hoja)');
    });

    await test.step('doble clic real en «Confirmar»: una recepción, una suma', async () => {
      await page.getByTestId('rec-confirm-yes').dblclick();
      await expect(toast(page)).toContainText('Recepción R-1 registrada: +80 kg');
      await expect(page.getByTestId('rec-sheet')).toHaveCount(0);
    });

    // (el segundo clic del doble clic pudo caer en lo que quedó debajo de la hoja; se vuelve a un estado conocido)
    await expectStock(page, 'semilla', { physical: '80 kg', received: '80 kg' });
    let d = await readDb(page);
    expect(d.receptions, 'doble clic en Confirmar: una sola recepción').toHaveLength(1);
    expect(d.stockMoves).toHaveLength(1);
    expect(physicalOf(d, 'semilla')).toBe(80000);
    expect(nextReceptionFolio(d)).toBe(2);

    await test.step('dos clics en el MISMO instante (sin esperar a que la pantalla cambie), en ambos botones', async () => {
      await goReceive(page);
      await pick(page, 'semilla');
      await typeNet(page, '55');
      await page.getByTestId('rec-confirm').evaluate((el: HTMLElement) => {
        el.click();
        el.click();
      });
      await expect(page.getByTestId('rec-sheet')).toHaveCount(1);
      await page.getByTestId('rec-confirm-yes').evaluate((el: HTMLElement) => {
        el.click();
        el.click();
      });
      await expect(toast(page)).toContainText('Recepción R-2 registrada: +55 kg');
    });

    await subTab(page, 'historial');
    await expect(page.getByTestId('rec-row')).toHaveCount(2);
    await expect(page.getByTestId('rec-hist-total')).toContainText('2 recepciones registradas · 135 kg en total');
    d = await readDb(page);
    expect(d.receptions.map((r) => r.folio).sort()).toEqual([1, 2]);
    expect(d.stockMoves.filter((m) => m.type === 'recepcion')).toHaveLength(2);
    expect(physicalOf(d, 'semilla')).toBe(135000); // 80 + 55, nunca 160 ni 190
    expect(auditRaw(d)).toEqual([]);
  });

  test('12 · la misma referencia (camión) y el mismo tipo dentro de 48 h avisa ANTES de registrar y exige «Registrar de todos modos»; otro tipo, o más de 48 h, no avisa', async ({
    page,
  }) => {
    await openApp(page);
    await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg', { supplier: 'Rancho Sur', reference: 'CAM-77' });

    await test.step('misma referencia escrita distinto (mayúsculas y espacio) y mismo tipo: parece repetida', async () => {
      await pick(page, 'primera');
      await typeNet(page, '60');
      await typeLot(page, { reference: 'cam 77' });
      await page.getByTestId('rec-confirm').click();
      const warn = page.getByTestId('rec-dup-warning');
      await expect(warn).toBeVisible();
      await expect(warn).toContainText('Ya hay una recepción parecida: R-1');
      await expect(page.getByTestId('rec-confirm-yes')).toHaveCount(0); // no hay «Confirmar» normal
      await expect(page.getByTestId('rec-dup-ack')).toHaveText('Registrar de todos modos');
      expect(physicalOf(await readDb(page), 'primera'), 'el aviso sale ANTES de registrar: nada se sumó').toBe(100000);
    });

    await test.step('«Volver» no registra; reconocer el aviso registra y deja constancia', async () => {
      await page.getByTestId('rec-confirm-no').click();
      await expect(page.getByTestId('rec-sheet')).toBeHidden();
      expect((await readDb(page)).receptions).toHaveLength(1);
      await page.getByTestId('rec-confirm').click();
      await page.getByTestId('rec-dup-ack').click();
      await expect(toast(page)).toContainText('Recepción R-2 registrada: +60 kg');
      const d = await readDb(page);
      const r2 = d.receptions.find((r) => r.folio === 2)!;
      expect(r2.acknowledged?.[0].op).toBe('confirmar');
      expect(r2.acknowledged?.[0].warnings.join(' ')).toContain('R-1');
      expect(physicalOf(d, 'primera')).toBe(160000);
    });

    await test.step('otro tipo de limón con la misma referencia NO avisa', async () => {
      await pick(page, 'segunda');
      await typeNet(page, '40');
      await typeLot(page, { reference: 'CAM-77' });
      await page.getByTestId('rec-confirm').click();
      await expect(page.getByTestId('rec-confirm-yes')).toBeVisible();
      await expect(page.getByTestId('rec-dup-warning')).toHaveCount(0);
      await page.getByTestId('rec-confirm-yes').click();
      await expect(toast(page)).toContainText('Recepción R-3 registrada: +40 kg');
    });

    await test.step('límite de 48 h: a 47 h avisa; a 49 h ya es otra entrega', async () => {
      await pick(page, 'primera');
      await typeNet(page, '25');
      await typeLot(page, { reference: 'CAM-77' });
      await page.getByTestId('rec-datetime').fill(await localInput(page, -47 * 3600e3));
      await page.getByTestId('rec-confirm').click();
      await expect(page.getByTestId('rec-dup-warning')).toBeVisible();
      await page.getByTestId('rec-confirm-no').click();
      await page.getByTestId('rec-datetime').fill(await localInput(page, -49 * 3600e3));
      await page.getByTestId('rec-confirm').click();
      await expect(page.getByTestId('rec-sheet')).toBeVisible();
      await expect(page.getByTestId('rec-dup-warning')).toHaveCount(0);
      await expect(page.getByTestId('rec-sheet-old')).toBeVisible(); // y la hoja avisa que la llegada es de otro día
      await page.getByTestId('rec-confirm-yes').click();
      await expect(toast(page)).toContainText('Recepción R-4 registrada: +25 kg');
    });
    expect(auditRaw(await readDb(page))).toEqual([]);
  });

  test('12 · mismo proveedor + mismo tipo + mismos kilos + mismo día avisa aunque pasen horas; otro proveedor u otros kilos no (reloj simulado)', async ({
    page,
  }) => {
    // Reloj fijo: viernes 9-oct-2026 09:00 hora de CDMX (UTC-6). Luego pasan 3 horas: ya no aplica la regla de «hace 10 minutos».
    await page.clock.setFixedTime(new Date('2026-10-09T15:00:00Z'));
    await openApp(page);
    await receive(page, 'semilla', '90', 'Recepción R-1 registrada: +90 kg', { supplier: 'Rancho Norte' });
    await page.clock.setFixedTime(new Date('2026-10-09T18:00:00Z'));

    await pick(page, 'semilla');
    await typeNet(page, '90');
    await typeLot(page, { supplier: 'rancho  NORTE' }); // mismo proveedor escrito distinto
    await page.getByTestId('rec-confirm').click();
    await expect(page.getByTestId('rec-dup-warning')).toContainText('Ya hay una recepción parecida: R-1');
    await expect(page.getByTestId('rec-dup-ack')).toBeVisible();
    await page.getByTestId('rec-confirm-no').click();

    await test.step('otro proveedor con los mismos kilos: no avisa', async () => {
      await typeLot(page, { supplier: 'Rancho Sur' });
      await page.getByTestId('rec-confirm').click();
      await expect(page.getByTestId('rec-confirm-yes')).toBeVisible();
      await expect(page.getByTestId('rec-dup-warning')).toHaveCount(0);
      await page.getByTestId('rec-confirm-yes').click();
      await expect(toast(page)).toContainText('Recepción R-2 registrada: +90 kg');
    });

    await test.step('el mismo proveedor con otros kilos: no avisa', async () => {
      await pick(page, 'semilla');
      await typeNet(page, '95');
      await typeLot(page, { supplier: 'Rancho Norte' });
      await page.getByTestId('rec-confirm').click();
      await expect(page.getByTestId('rec-confirm-yes')).toBeVisible();
      await expect(page.getByTestId('rec-dup-warning')).toHaveCount(0);
      await page.getByTestId('rec-confirm-yes').click();
      await expect(toast(page)).toContainText('Recepción R-3 registrada: +95 kg');
    });
    const d = await readDb(page);
    expect(physicalOf(d, 'semilla')).toBe(275000); // 90 + 90 + 95
    expect(auditRaw(d)).toEqual([]);
  });

  test('12 · mismo tipo y mismos kilos hace menos de 10 minutos (aunque sin proveedor ni camión) avisa antes de registrar', async ({ page }) => {
    await openApp(page);
    await receive(page, 'segunda', '70', 'Recepción R-1 registrada: +70 kg');
    await pick(page, 'segunda');
    await typeNet(page, '70');
    await page.getByTestId('rec-confirm').click();
    await expect(page.getByTestId('rec-dup-warning')).toContainText('Ya hay una recepción parecida: R-1');
    await expect(page.getByTestId('rec-confirm-yes')).toHaveCount(0);
    await page.getByTestId('rec-confirm-no').click();
    await expect(page.getByTestId('rec-net-direct')).toHaveValue('70'); // lo capturado se conserva
    expect(physicalOf(await readDb(page), 'segunda')).toBe(70000);
  });

  test('12 · reintento tras recargar con el MISMO intento no duplica («ya estaba registrada»); si lo escrito cambió, se ofrece registrarlo como una NUEVA sin tocar la anterior', async ({
    page,
  }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await typeNet(page, '120');
    await autosaved(page); // la captura en curso se guarda sola, con el id de este intento
    const saved = await page.evaluate((k) => localStorage.getItem(k)!, FORM_KEY);
    await register(page, 'Recepción R-1 registrada: +120 kg');
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), FORM_KEY)).toBeNull();

    await test.step('misma captura (apagón entre guardar y limpiar la pantalla): no se suma otra vez', async () => {
      await page.evaluate(([k, v]) => localStorage.setItem(k, v), [FORM_KEY, saved]);
      await page.reload();
      await goReceive(page);
      await expect(page.getByTestId('rec-restored')).toBeVisible();
      await expect(page.getByTestId('rec-selected')).toContainText('Con semilla');
      await expect(page.getByTestId('rec-net-direct')).toHaveValue('120');
      await page.getByTestId('rec-confirm').click();
      await expect(toast(page)).toContainText('Esta recepción ya estaba registrada como R-1 (120 kg). No se sumó otra vez.');
      await expect(page.getByTestId('rec-sheet')).toHaveCount(0);
      await expectFormClean(page);
      const d = await readDb(page);
      expect(d.receptions).toHaveLength(1);
      expect(physicalOf(d, 'semilla')).toBe(120000);
    });

    await test.step('mismo intento pero con OTROS kilos: nunca se da por registrado; «Volver» no cambia nada', async () => {
      const changed = JSON.stringify({ ...JSON.parse(saved), netText: '130' });
      await page.evaluate(([k, v]) => localStorage.setItem(k, v), [FORM_KEY, changed]);
      await page.reload();
      await goReceive(page);
      await expect(page.getByTestId('rec-net-direct')).toHaveValue('130');
      await page.getByTestId('rec-confirm').click();
      await expect(page.getByTestId('rec-conflict')).toContainText('Este intento ya se registró como R-1 (120 kg · Con semilla)');
      await expect(page.getByTestId('rec-conflict')).toContainText('(130 kg · Con semilla)');
      await expect(page.getByTestId('rec-confirm-yes')).toHaveCount(0);
      await page.getByTestId('rec-confirm-no').click();
      expect(physicalOf(await readDb(page), 'semilla')).toBe(120000);
    });

    await test.step('«Registrar lo escrito como nueva» crea R-2 con 130 kg y deja R-1 intacta', async () => {
      await page.getByTestId('rec-confirm').click();
      await page.getByTestId('rec-conflict-new').click();
      await expect(toast(page)).toContainText('Recepción R-2 registrada: +130 kg');
      const d = await readDb(page);
      expect(d.receptions.map((r) => [r.folio, r.confirmedNetMilli]).sort()).toEqual([
        [1, 120000],
        [2, 130000],
      ]);
      expect(physicalOf(d, 'semilla')).toBe(250000);
      expect(auditRaw(d)).toEqual([]);
    });
  });

  test('12 · la misma captura abierta en DOS ventanas (app instalada y pestaña del navegador): registrar en una y luego en la otra no suma dos veces', async ({
    page,
    context,
  }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await typeNet(page, '90');
    await autosaved(page);

    const other = await context.newPage();
    await other.goto('/');
    await goReceive(other);
    await expect(other.getByTestId('rec-restored')).toBeVisible(); // la otra ventana recupera la MISMA captura (mismo intento)
    await expect(other.getByTestId('rec-net-direct')).toHaveValue('90');

    await register(page, 'Recepción R-1 registrada: +90 kg');
    // la otra ventana se entera sola de que la base cambió
    await expect(other.getByTestId('rec-selected')).toContainText('en bodega ahora: 90 kg');
    await other.getByTestId('rec-confirm').click();
    await expect(toast(other)).toContainText('Esta recepción ya estaba registrada como R-1 (90 kg). No se sumó otra vez.');
    const d = await readDb(page);
    expect(d.receptions).toHaveLength(1);
    expect(physicalOf(d, 'semilla')).toBe(90000);
    expect(auditRaw(d)).toEqual([]);
  });
});

test.describe('Recepción · recepciones seguidas y «mismo camión» (caso 14)', () => {
  test('dos recepciones seguidas: folios R-1 y R-2 consecutivos, el formulario no hereda nada y los kilos se acumulan', async ({ page }) => {
    await openApp(page);
    await receive(page, 'semilla', '100', 'Recepción R-1 registrada: +100 kg', { supplier: 'Rancho Sur', reference: 'CAM-1', notes: 'lote 1' });

    await test.step('el siguiente camión no hereda tipo, kilos, proveedor ni camión', async () => {
      await expectFormClean(page);
      await expect(page.getByTestId('rec-pick-hint')).toBeVisible();
      // Al cerrarse la hoja de confirmar, la pantalla ignora los toques 0.45 s (escudo contra el segundo toque de un doble toque);
      // aquí la persona toca a propósito, ya con el formulario a la vista.
      await expect(page.locator('html.shield')).toHaveCount(0);
      await tapDisabledConfirm(page);
      await expect(toast(page)).toHaveClass(/error/); // sin tipo ni kilos: avisa en vez de registrar «lo anterior»
    });

    await receive(page, 'semilla', '50', 'Recepción R-2 registrada: +50 kg', { supplier: 'Huerta Norte', reference: 'CAM-2' });

    await test.step('los proveedores ya usados quedan como atajos (el más reciente primero) y un toque los captura', async () => {
      const chips = page.getByTestId('rec-supplier-chip');
      await expect(chips).toHaveText(['Huerta Norte', 'Rancho Sur']);
      await chips.filter({ hasText: 'Rancho Sur' }).click();
      await expect(page.getByTestId('rec-supplier')).toHaveValue('Rancho Sur');
      await expect(chips.filter({ hasText: 'Rancho Sur' })).toHaveClass(/active/);
      await page.getByTestId('rec-clear').click(); // «Limpiar» pide un segundo toque
      await page.getByTestId('rec-clear').click();
      await expect(page.getByTestId('rec-supplier')).toHaveValue('');
    });
    await expectStock(page, 'semilla', { physical: '150 kg', received: '150 kg' });
    await subTab(page, 'historial');
    await expect(page.getByTestId('rec-row')).toHaveCount(2);
    await expect(page.getByTestId('rec-hist-total')).toContainText('2 recepciones registradas · 150 kg en total');
    const d = await readDb(page);
    expect(d.receptions.map((r) => r.folio).sort()).toEqual([1, 2]);
    expect(nextReceptionFolio(d)).toBe(3);
    expect(auditRaw(d)).toEqual([]);
  });

  test('«Otra clasificación del mismo camión» copia proveedor, camión y hora, pero deja elegir otro tipo y capturar sus kilos', async ({ page }) => {
    await openApp(page);
    await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg', { supplier: 'Rancho Sur', reference: 'CAM-9', notes: 'bajó lluvia' });

    await page.getByTestId('rec-same-truck').click();
    await expect(toast(page)).toContainText('Mismo camión: elige la siguiente clasificación y captura sus kilos');
    await expect(page.getByTestId('rec-supplier')).toHaveValue('Rancho Sur');
    await expect(page.getByTestId('rec-reference')).toHaveValue('CAM-9');
    await expect(page.getByTestId('rec-notes')).toHaveValue('bajó lluvia');
    await expect(page.getByTestId('rec-selected')).toHaveCount(0); // el tipo NO se hereda: se elige a propósito
    await expect(page.getByTestId('rec-net-direct')).toHaveValue(''); // ni los kilos
    await confirmDisabled(page, true);

    await pick(page, 'segunda');
    await typeNet(page, '60');
    await page.getByTestId('rec-confirm').click();
    // misma referencia pero OTRO tipo: es otra parte del mismo camión, no un duplicado
    await expect(page.getByTestId('rec-dup-warning')).toHaveCount(0);
    await page.getByTestId('rec-confirm-yes').click();
    await expect(toast(page)).toContainText('Recepción R-2 registrada: +60 kg');

    await expectStock(page, 'primera', { physical: '100 kg' });
    await expectStock(page, 'segunda', { physical: '60 kg' });
    await subTab(page, 'historial');
    await expect(page.getByTestId('rec-row')).toHaveCount(2);
    for (const row of await page.getByTestId('rec-row').all()) {
      await expect(row).toContainText('Rancho Sur');
      await expect(row).toContainText('ref. CAM-9');
    }
    const d = await readDb(page);
    expect(physicalOf(d, 'primera')).toBe(100000);
    expect(physicalOf(d, 'segunda')).toBe(60000);
    expect(d.receptions.map((r) => r.reference)).toEqual(['CAM-9', 'CAM-9']);
    expect(auditRaw(d)).toEqual([]);
  });
});

const histRow = (page: import('@playwright/test').Page, folio: number) =>
  page.getByTestId('rec-row').filter({ hasText: `R-${folio} ·` });

test.describe('Recepción · historial auditable: corregir, anular y copiar (caso 11 y 25)', () => {
  test('corregir kilos con motivo: el original se conserva, la corrección queda a la vista y el inventario ajusta al nuevo neto; sin motivo o con kilos inválidos no se corrige', async ({
    page,
  }) => {
    await openApp(page);
    await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg');
    await subTab(page, 'historial');
    const row = histRow(page, 1);
    await row.getByTestId('rec-correct').click();
    const form = row.getByTestId('rec-correct-form');
    const qty = form.getByTestId('rec-correct-qty');
    const save = form.getByTestId('rec-correct-save');
    const reason = form.getByTestId('rec-correct-reason');

    await test.step('el formulario arranca con los kilos vigentes y no deja guardar sin motivo', async () => {
      await expect(qty).toHaveValue('100');
      await expect(save).toBeDisabled();
      await qty.fill('95.5');
      await expect(save).toBeDisabled(); // kilos nuevos pero sin motivo
    });

    await test.step('con motivo, los kilos ilegibles o ambiguos siguen sin poder guardarse', async () => {
      await reason.fill('Báscula mal calibrada');
      for (const bad of ['', '-5', 'abc', '200001', '1e2', '1.2345']) {
        await qty.fill(bad);
        await expect(save, `«${bad}» no debe poder guardarse`).toBeDisabled();
      }
      await qty.fill('1,500');
      await expect(form.getByTestId('rec-correct-ambiguous')).toContainText('«1,500» se puede leer como 1500 o como 1.5');
      await expect(save).toBeDisabled();
    });

    await test.step('cero y «los mismos kilos» se rechazan con un mensaje y no cambian nada', async () => {
      await qty.fill('0');
      await save.click();
      await expect(toast(page)).toContainText('Los kilos corregidos deben ser mayores a cero');
      await qty.fill('100');
      await save.click();
      await expect(toast(page)).toContainText('Los kilos ya son esos: no hay nada que corregir');
      const d = await readDb(page);
      expect(d.stockMoves).toHaveLength(1);
      expect(d.receptions[0].corrections).toEqual([]);
      expect(physicalOf(d, 'primera')).toBe(100000);
    });

    await test.step('la corrección válida queda registrada y el inventario sigue al nuevo neto', async () => {
      await qty.fill('95.5');
      await save.click();
      await expect(toast(page)).toContainText('Recepción R-1 corregida');
      await expect(row.getByTestId('rec-row-net')).toHaveText('95.5 kg');
      await expect(row.getByTestId('rec-row-corrections')).toContainText(
        'Corregida 1 vez: original 100 kg → -4.5 kg (Báscula mal calibrada) → vigente 95.5 kg',
      );
      await expectStock(page, 'primera', { physical: '95.5 kg', available: '95.5 kg', received: '95.5 kg' });
      const mine = invRow(page, 'primera');
      await mine.getByTestId('show-moves').click();
      await expect(mine.getByTestId('moves-list')).toContainText('recepción de mercancía R-1');
      await expect(mine.getByTestId('moves-list')).toContainText('+100 kg físico');
      await expect(mine.getByTestId('moves-list')).toContainText('corrección de recepción R-1');
      await expect(mine.getByTestId('moves-list')).toContainText('-4.5 kg físico');
    });

    await test.step('una segunda corrección encadena sobre la anterior sin tocar el original', async () => {
      await subTab(page, 'historial');
      await histRow(page, 1).getByTestId('rec-correct').click();
      await histRow(page, 1).getByTestId('rec-correct-qty').fill('98');
      await histRow(page, 1).getByTestId('rec-correct-reason').fill('Segundo pesaje');
      await histRow(page, 1).getByTestId('rec-correct-save').click();
      await expect(toast(page)).toContainText('Recepción R-1 corregida');
      await expect(histRow(page, 1).getByTestId('rec-row-corrections')).toContainText(
        'Corregida 2 veces: original 100 kg → -4.5 kg (Báscula mal calibrada) → +2.5 kg (Segundo pesaje) → vigente 98 kg',
      );
    });

    const d = await readDb(page);
    const rec = d.receptions[0];
    expect(rec.confirmedNetMilli, 'el dato original NO se modifica').toBe(100000);
    expect(rec.netMilli).toBe(98000);
    expect(rec.corrections.map((c) => [c.previousNetMilli, c.newNetMilli, c.deltaMilli, c.reason])).toEqual([
      [100000, 95500, -4500, 'Báscula mal calibrada'],
      [95500, 98000, 2500, 'Segundo pesaje'],
    ]);
    expect(orderedMoves(d).map((m) => [m.type, m.deltaMilli])).toEqual([
      ['recepcion', 100000],
      ['correccion_recepcion', -4500],
      ['correccion_recepcion', 2500],
    ]);
    expect(physicalOf(d, 'primera')).toBe(98000);
    expect(auditRaw(d)).toEqual([]);
  });

  test('anular con motivo: el inventario revierte, la recepción queda «Anulada» con sus kilos originales visibles y ya no se corrige ni se vuelve a anular', async ({
    page,
  }) => {
    await openApp(page);
    await receive(page, 'primera', '120', 'Recepción R-1 registrada: +120 kg');
    await subTab(page, 'historial');
    await histRow(page, 1).getByTestId('rec-void').click();
    const confirm = page.getByTestId('rec-void-confirm');
    await expect(confirm).toBeDisabled(); // el motivo es obligatorio
    await expect(page.getByTestId('rec-void-copy')).toBeDisabled();
    await expect(page.getByTestId('rec-void-form')).toContainText('Se restan 120 kg del inventario');
    await page.getByTestId('rec-void-reason').fill('   '); // solo espacios no cuentan como motivo
    await expect(confirm).toBeDisabled();
    await page.getByTestId('rec-void-reason').fill('Se registró por error');
    await confirm.click();
    await expect(toast(page)).toContainText('Recepción R-1 anulada');

    await test.step('ya no está entre las Registradas; en Anuladas conserva lo que se había recibido', async () => {
      await expect(page.getByTestId('rec-row')).toHaveCount(0);
      await expect(page.getByTestId('rec-historial')).toContainText('No hay recepciones con ese filtro.');
      await page.getByTestId('rec-filter-anulada').click();
      const row = histRow(page, 1);
      await expect(row).toContainText('Anulada');
      await expect(row.getByTestId('rec-row-net')).toHaveText('0 kg (se habían recibido 120 kg)');
      await expect(row).toContainText('Anulada: Se registró por error');
      await expect(row.getByTestId('rec-correct')).toHaveCount(0);
      await expect(row.getByTestId('rec-void')).toHaveCount(0);
      await row.getByTestId('rec-moves').click();
      await expect(row.getByTestId('rec-moves-list')).toContainText('Recepción (entrada) · +120 kg');
      await expect(row.getByTestId('rec-moves-list')).toContainText('Anulación (resta los kilos) · -120 kg');
      await expect(row.getByTestId('rec-moves-list').locator('li')).toHaveCount(2);
    });

    await test.step('inventario en cero y el Resumen no cuenta lo anulado como recibido', async () => {
      await goReceive(page);
      await expect(page.getByTestId('rec-last'), 'una anulada ya no es «la última registrada»').toHaveCount(0);
      await expectStock(page, 'primera', { physical: '0 g', available: '0 g', received: '0 g' });
      await subTab(page, 'resumen');
      await expect(page.getByTestId('rep-received')).toHaveAttribute('data-milli', '0');
      await expect(page.getByTestId('rep-voided')).toHaveText('120 kg');
    });

    const d = await readDb(page);
    expect(d.receptions[0]).toMatchObject({ status: 'anulada', netMilli: 0, confirmedNetMilli: 120000, voidReason: 'Se registró por error' });
    expect(orderedMoves(d).map((m) => [m.type, m.deltaMilli])).toEqual([
      ['recepcion', 120000],
      ['reversa_recepcion', -120000],
    ]);
    expect(d.receptions[0].voidStockMoveId).toBe(orderedMoves(d)[1].id);
    expect(physicalOf(d, 'primera')).toBe(0);
    expect(auditRaw(d)).toEqual([]);
  });

  test('anular una recepción cuya mercancía YA se vendió exige AUTORIZACIÓN explícita: «Cancelar» no cambia nada y «Autorizar» deja el negativo a la vista', async ({
    page,
  }) => {
    await openApp(page);
    await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg');
    await sellExact(page, '30');
    await expectStock(page, 'primera', { physical: '70 kg', sold: '30 kg' });

    await subTab(page, 'historial');
    await histRow(page, 1).getByTestId('rec-void').click();
    await page.getByTestId('rec-void-reason').fill('Camión equivocado');
    await page.getByTestId('rec-void-confirm').click();
    await expect(page.getByTestId('authorize-sheet')).toBeVisible();
    await expect(page.getByTestId('authorize-text')).toContainText('«Limón persa · Primera» quedaría con -30 kg disponibles');

    await page.getByTestId('authorize-no').click(); // camino negativo: sin autorización no pasa nada
    await expect(page.getByTestId('authorize-sheet')).toBeHidden();
    let d = await readDb(page);
    expect(d.receptions[0].status).toBe('confirmada');
    expect(physicalOf(d, 'primera')).toBe(70000);
    expect(d.stockMoves.filter((m) => m.type === 'reversa_recepcion')).toHaveLength(0);

    await page.getByTestId('rec-void-confirm').click();
    await page.getByTestId('authorize-yes').click();
    await expect(toast(page)).toContainText('Recepción R-1 anulada');
    d = await readDb(page);
    expect(physicalOf(d, 'primera')).toBe(-30000);
    const reversa = d.stockMoves.find((m) => m.type === 'reversa_recepcion')!;
    expect(reversa.deltaMilli).toBe(-100000);
    expect(reversa.authorizedNegativeAfterMilli, 'la autorización queda registrada en el movimiento').toBe(-30000);
    await tab(page, 'inventario');
    await expect(invRow(page, 'primera').getByTestId('stock-physical')).toHaveText('-30 kg');
    await expect(invRow(page, 'primera').getByTestId('stock-negative')).toBeVisible();
    expect(auditRaw(d)).toEqual([]);
  });

  test('anular con un vale pagado pendiente (mercancía apartada) avisa cuántos kilos están apartados y exige autorización si ya no alcanzan', async ({ page }) => {
    await openApp(page);
    await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg');
    await sellVale(page, '10', 'Doña Mary');
    await expectStock(page, 'primera', { physical: '100 kg', reserved: '10 kg', available: '90 kg' });
    await subTab(page, 'historial');
    await histRow(page, 1).getByTestId('rec-void').click();
    await page.getByTestId('rec-void-reason').fill('Camión equivocado');
    await page.getByTestId('rec-void-confirm').click();
    await expect(page.getByTestId('authorize-text')).toContainText('quedaría con -10 kg disponibles');
    await expect(page.getByTestId('authorize-text')).toContainText('Hay 10 kg apartados por vales');
    await page.getByTestId('authorize-no').click();
    const d = await readDb(page);
    expect(d.receptions[0].status).toBe('confirmada');
    expect([physicalOf(d, 'primera'), reservedOf(d, 'primera')]).toEqual([100000, 10000]);
    expect(auditRaw(d)).toEqual([]);
  });

  test('corregir a la baja: mientras el disponible alcance no pide nada; si la corrección lo dejaría negativo pide autorización explícita', async ({ page }) => {
    await openApp(page);
    await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg');
    await sellExact(page, '30'); // quedan 70
    await subTab(page, 'historial');
    const row = histRow(page, 1);

    await row.getByTestId('rec-correct').click();
    await row.getByTestId('rec-correct-qty').fill('60'); // −40 → quedan 30 disponibles: alcanza
    await row.getByTestId('rec-correct-reason').fill('Pesaje final');
    await row.getByTestId('rec-correct-save').click();
    await expect(toast(page)).toContainText('Recepción R-1 corregida');
    await expect(page.getByTestId('authorize-sheet')).toHaveCount(0);
    expect(physicalOf(await readDb(page), 'primera')).toBe(30000);

    await row.getByTestId('rec-correct').click();
    await row.getByTestId('rec-correct-qty').fill('20'); // −40 más → 30 − 40 = −10: ya vendido
    await row.getByTestId('rec-correct-reason').fill('Otro pesaje');
    await row.getByTestId('rec-correct-save').click();
    await expect(page.getByTestId('authorize-text')).toContainText('quedaría con -10 kg disponibles');
    await page.getByTestId('authorize-no').click();
    expect(physicalOf(await readDb(page), 'primera'), 'sin autorización no cambia').toBe(30000);
    await row.getByTestId('rec-correct-save').click();
    await page.getByTestId('authorize-yes').click();
    await expect(toast(page)).toContainText('Recepción R-1 corregida');
    const d = await readDb(page);
    expect(physicalOf(d, 'primera')).toBe(-10000);
    expect(d.receptions[0].netMilli).toBe(20000);
    expect(d.receptions[0].confirmedNetMilli).toBe(100000);
    expect(auditRaw(d)).toEqual([]);
  });

  test('«Anular y copiar a borrador» (me equivoqué de tipo): anula, abre un borrador con los mismos datos SIN tipo y, al elegir el correcto, suma al tipo correcto con un folio nuevo', async ({
    page,
  }) => {
    await openApp(page);
    await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg', { supplier: 'Rancho Sur', reference: 'CAM-5', notes: 'lote A' });
    await subTab(page, 'historial');
    await histRow(page, 1).getByTestId('rec-void').click();
    await page.getByTestId('rec-void-reason').fill('Era Segunda');
    await page.getByTestId('rec-void-copy').click();

    await test.step('queda el borrador abierto con los mismos datos y sin tipo de limón', async () => {
      await expect(page.getByTestId('rec-nueva')).toBeVisible();
      await expect(page.getByTestId('rec-net-direct')).toHaveValue('100');
      await expect(page.getByTestId('rec-supplier')).toHaveValue('Rancho Sur');
      await expect(page.getByTestId('rec-reference')).toHaveValue('CAM-5');
      await expect(page.getByTestId('rec-notes')).toHaveValue(/Copia de R-1 \(anulada: Era Segunda\)/);
      await expect(page.getByTestId('rec-selected')).toHaveCount(0);
      await confirmDisabled(page, true); // falta elegir el tipo
      expect(physicalOf(await readDb(page), 'primera'), 'la anulación ya revirtió los kilos').toBe(0);
    });

    await pick(page, 'segunda');
    await register(page, 'Recepción R-2 registrada: +100 kg');
    await expectStock(page, 'primera', { physical: '0 g' });
    await expectStock(page, 'segunda', { physical: '100 kg', received: '100 kg' });

    await subTab(page, 'historial');
    await expect(page.getByTestId('rec-row')).toHaveCount(1);
    await expect(histRow(page, 2)).toContainText('Limón persa · Segunda');
    await page.getByTestId('rec-filter-anulada').click();
    await expect(histRow(page, 1)).toContainText('Limón persa · Primera');
    const d = await readDb(page);
    expect(d.receptions.map((r) => [r.folio, r.status, r.productLabel]).sort()).toEqual([
      [1, 'anulada', 'Limón persa · Primera'],
      [2, 'confirmada', 'Limón persa · Segunda'],
    ]);
    expect(byStatus(d, 'borrador'), 'el borrador copiado se completó, no quedó uno huérfano').toHaveLength(0);
    expect(auditRaw(d)).toEqual([]);
  });

  test('corregir DATOS (proveedor, camión, observaciones) con motivo no toca los kilos ni el inventario y deja el antes y el después', async ({ page }) => {
    await openApp(page);
    await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg', { supplier: 'Rancho Sur', reference: 'CAM-2', notes: 'sin novedad' });
    await subTab(page, 'historial');
    await histRow(page, 1).getByTestId('rec-edit-data').click();
    const form = page.getByTestId('rec-data-form');
    await expect(form.getByTestId('rec-data-supplier')).toHaveValue('Rancho Sur');
    await expect(form.getByTestId('rec-data-reference')).toHaveValue('CAM-2');
    await expect(form.getByTestId('rec-data-save')).toBeDisabled(); // sin motivo

    await form.getByTestId('rec-data-reason').fill('Error de captura');
    await form.getByTestId('rec-data-save').click(); // camino negativo: sin cambios no hay nada que guardar
    await expect(toast(page)).toContainText('No cambiaste ningún dato');
    expect((await readDb(page)).receptions[0].dataEdits ?? []).toHaveLength(0);

    await form.getByTestId('rec-data-supplier').fill('Rancho Norte');
    await form.getByTestId('rec-data-reference').fill('CAM-22');
    await form.getByTestId('rec-data-notes').fill('llegó con retraso');
    await form.getByTestId('rec-data-save').click();
    await expect(toast(page)).toContainText('Datos de R-1 corregidos (los kilos no cambian)');

    const row = histRow(page, 1);
    await expect(row).toContainText('Rancho Norte');
    await expect(row).toContainText('ref. CAM-22');
    await expect(row).toContainText('Obs.: llegó con retraso');
    await expect(row.getByTestId('rec-row-dataedits')).toContainText('Datos corregidos 1 vez');
    await expect(row.getByTestId('rec-row-net')).toHaveText('100 kg');
    await row.getByTestId('rec-moves').click();
    await expect(row.getByTestId('rec-dataedits-list')).toContainText('Datos corregidos (Error de captura)');
    await expect(row.getByTestId('rec-dataedits-list')).toContainText('Proveedor: Rancho Sur → Rancho Norte');
    await expect(row.getByTestId('rec-dataedits-list')).toContainText('Referencia: CAM-2 → CAM-22');
    await expect(row.getByTestId('rec-moves-list').locator('li'), 'ningún movimiento de inventario nuevo').toHaveCount(1);

    const d = await readDb(page);
    expect(d.stockMoves).toHaveLength(1);
    expect(d.receptions[0]).toMatchObject({ confirmedNetMilli: 100000, netMilli: 100000, supplier: 'Rancho Norte', reference: 'CAM-22' });
    expect(d.receptions[0].dataEdits?.[0].reason).toBe('Error de captura');
    expect(d.receptions[0].dataEdits?.[0].changes.map((c) => [c.field, c.before, c.after])).toEqual(
      expect.arrayContaining([
        ['supplier', 'Rancho Sur', 'Rancho Norte'],
        ['reference', 'CAM-2', 'CAM-22'],
        ['notes', 'sin novedad', 'llegó con retraso'],
      ]),
    );
    expect(physicalOf(d, 'primera')).toBe(100000);
    expect(auditRaw(d)).toEqual([]);
  });

  test('corregir la FECHA de llegada mueve la recepción de día en el Resumen sin tocar los kilos ni el movimiento de inventario; una fecha futura se rechaza (reloj simulado)', async ({
    page,
  }) => {
    // 12:00 hora de CDMX del viernes 9-oct-2026
    await page.clock.setFixedTime(new Date('2026-10-09T18:00:00Z'));
    await openApp(page);
    await receive(page, 'semilla', '100', 'Recepción R-1 registrada: +100 kg');
    await subTab(page, 'historial');
    await histRow(page, 1).getByTestId('rec-edit-data').click();
    const when = page.getByTestId('rec-data-when');
    await page.getByTestId('rec-data-reason').fill('Llegó ayer');

    await when.fill('2026-10-10T09:00'); // mañana: imposible
    await page.getByTestId('rec-data-save').click();
    await expect(toast(page)).toContainText('La fecha de llegada no puede ser futura');
    expect((await readDb(page)).receptions[0].day).toBe('2026-10-09');

    await when.fill('2026-10-08T09:00');
    await page.getByTestId('rec-data-save').click();
    await expect(toast(page)).toContainText('Datos de R-1 corregidos (los kilos no cambian)');

    await subTab(page, 'resumen');
    await page.getByTestId('rep-today').click();
    await expect(page.getByTestId('rep-received')).toHaveAttribute('data-milli', '0');
    await page.getByTestId('rep-yesterday').click();
    await expect(page.getByTestId('rep-received')).toHaveAttribute('data-milli', '100000');
    const d = await readDb(page);
    expect(d.receptions[0].day).toBe('2026-10-08');
    expect(d.receptions[0].dataEdits?.[0].changes.map((c) => c.field)).toEqual(['receivedAt']);
    expect(d.stockMoves[0].createdAt, 'el movimiento conserva su hora real de captura').toBe('2026-10-09T18:00:00.000Z');
    expect(physicalOf(d, 'semilla')).toBe(100000);
    expect(auditRaw(d)).toEqual([]);
  });

  test('búsqueda y filtros del historial: por proveedor, camión, folio, presentación y tipo (sin acentos ni mayúsculas), por día y por estado', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-09T18:00:00Z')); // 12:00 en CDMX: el «hoy» del filtro por día es fijo
    await openApp(page);
    await receive(page, 'semilla', '100', 'Recepción R-1 registrada: +100 kg', { supplier: 'Rancho Sur', reference: 'CAM-1' });
    await receive(page, 'primera', '60', 'Recepción R-2 registrada: +60 kg', { supplier: 'Huerta Norte', reference: 'CAM-2' });
    await pick(page, 'semilla');
    await setPackaging(page, 'arpilla');
    await typeContainers(page, '10', '15');
    await typeLot(page, { supplier: 'Rancho Sur', reference: 'CAM-3' });
    await register(page, 'Recepción R-3 registrada: +150 kg');

    await subTab(page, 'historial');
    await expect(page.getByTestId('rec-row')).toHaveCount(3);
    await expect(page.getByTestId('rec-hist-total')).toContainText('3 recepciones registradas · 310 kg en total');

    const search = page.getByTestId('rec-search');
    const cases: Array<[string, number[], string]> = [
      ['rancho', [1, 3], '2 recepciones registradas · 250 kg en total'],
      ['CAM-2', [2], '1 recepción registrada · 60 kg en total'],
      ['r-3', [3], '1 recepción registrada · 150 kg en total'],
      ['arpilla', [3], '1 recepción registrada · 150 kg en total'],
      ['LIMON PERSA', [2], '1 recepción registrada · 60 kg en total'],
      ['huerta norte', [2], '1 recepción registrada · 60 kg en total'],
    ];
    for (const [text, folios, total] of cases) {
      await search.fill(text);
      await expect(page.getByTestId('rec-row'), `búsqueda «${text}»`).toHaveCount(folios.length);
      for (const f of folios) await expect(histRow(page, f), `búsqueda «${text}» debe incluir R-${f}`).toHaveCount(1);
      await expect(page.getByTestId('rec-hist-total')).toContainText(total);
    }
    await search.fill('zzz-no-existe');
    await expect(page.getByTestId('rec-row')).toHaveCount(0);
    await expect(page.getByTestId('rec-historial')).toContainText('No hay recepciones con ese filtro.');
    await expect(page.getByTestId('rec-hist-total')).toHaveCount(0);
    await search.fill('');

    await test.step('por día de llegada', async () => {
      await page.getByTestId('rec-hist-day').fill('2020-01-01');
      await expect(page.getByTestId('rec-row')).toHaveCount(0);
      await page.getByTestId('rec-hist-day').fill('2026-10-08'); // ayer: no llegó nada
      await expect(page.getByTestId('rec-row')).toHaveCount(0);
      await page.getByTestId('rec-hist-day').fill('2026-10-09'); // hoy: las tres
      await expect(page.getByTestId('rec-row')).toHaveCount(3);
      await page.getByTestId('rec-hist-day').fill('');
    });

    await test.step('por estado: anular R-2 lo pasa de Registradas a Anuladas; Todas muestra ambas', async () => {
      await histRow(page, 2).getByTestId('rec-void').click();
      await page.getByTestId('rec-void-reason').fill('Prueba de filtros');
      await page.getByTestId('rec-void-confirm').click();
      await expect(toast(page)).toContainText('Recepción R-2 anulada');
      await expect(page.getByTestId('rec-row')).toHaveCount(2);
      await page.getByTestId('rec-filter-anulada').click();
      await expect(page.getByTestId('rec-row')).toHaveCount(1);
      await expect(histRow(page, 2)).toBeVisible();
      await page.getByTestId('rec-filter-todas').click();
      await expect(page.getByTestId('rec-row')).toHaveCount(3);
      await page.getByTestId('rec-filter-cancelada').click();
      await expect(page.getByTestId('rec-row')).toHaveCount(0);
      await expect(page.getByTestId('rec-hist-count')).toHaveCount(0);
    });
    expect(auditRaw(await readDb(page))).toEqual([]);
  });
});

test.describe('Recepción · avisos de conteo y de entrada manual (doble conteo)', () => {
  test('anular después de un conteo físico posterior avisa que esos kilos podrían estar ya contados: «Cancelar» no cambia nada y «Entiendo, continuar» anula y deja constancia', async ({
    page,
  }) => {
    await openApp(page);
    await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg');
    await tab(page, 'inventario');
    const inv = invRow(page, 'primera');
    await inv.getByTestId('move-ajuste').click();
    await inv.getByTestId('move-qty').fill('100');
    await inv.getByTestId('move-note').fill('conteo de la tarde');
    await inv.getByTestId('move-save').click();
    await expect(toast(page)).toContainText('Conteo físico registrado');

    await subTab(page, 'historial');
    await histRow(page, 1).getByTestId('rec-void').click();
    await page.getByTestId('rec-void-reason').fill('Error de captura');
    await page.getByTestId('rec-void-confirm').click();
    await expect(page.getByTestId('warnings-sheet')).toBeVisible();
    await expect(page.getByTestId('warnings-text')).toContainText('Después de registrar esta recepción hubo un conteo físico de esta clasificación');
    await page.getByTestId('warnings-no').click();
    let d = await readDb(page);
    expect(d.receptions[0].status, 'sin reconocer el aviso no se anula').toBe('confirmada');
    expect(physicalOf(d, 'primera')).toBe(100000);

    await page.getByTestId('rec-void-confirm').click();
    await page.getByTestId('warnings-yes').click();
    await expect(toast(page)).toContainText('Recepción R-1 anulada');
    d = await readDb(page);
    expect(d.receptions[0].status).toBe('anulada');
    expect(d.receptions[0].acknowledged?.map((a) => a.op)).toContain('anular');
    expect(physicalOf(d, 'primera')).toBe(0);
    expect(auditRaw(d)).toEqual([]);
  });

  test('anular con un conteo posterior Y mercancía ya vendida encadena las dos hojas (autorización y aviso) y solo anula al aceptar ambas', async ({
    page,
  }) => {
    await openApp(page);
    await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg');
    await tab(page, 'inventario');
    const inv = invRow(page, 'primera');
    await inv.getByTestId('move-ajuste').click();
    await inv.getByTestId('move-qty').fill('98'); // al contar faltaban 2 kg
    await inv.getByTestId('move-note').fill('conteo: faltan 2 kg');
    await inv.getByTestId('move-save').click();
    await expect(toast(page)).toContainText('Conteo físico registrado');
    await expectStock(page, 'primera', { physical: '98 kg' });

    await subTab(page, 'historial');
    await histRow(page, 1).getByTestId('rec-void').click();
    await page.getByTestId('rec-void-reason').fill('Camión equivocado');
    await page.getByTestId('rec-void-confirm').click();
    await expect(page.getByTestId('authorize-text')).toContainText('quedaría con -2 kg disponibles');
    await page.getByTestId('authorize-yes').click();
    await expect(page.getByTestId('warnings-sheet')).toBeVisible();
    expect((await readDb(page)).receptions[0].status, 'a medias no se anula').toBe('confirmada');
    await page.getByTestId('warnings-yes').click();
    await expect(toast(page)).toContainText('Recepción R-1 anulada');
    const d = await readDb(page);
    expect(physicalOf(d, 'primera')).toBe(-2000);
    expect(d.stockMoves.find((m) => m.type === 'reversa_recepcion')?.authorizedNegativeAfterMilli).toBe(-2000);
    expect(auditRaw(d)).toEqual([]);
  });

  test('una entrada manual en Inventario de la misma clasificación recién recibida avisa del posible doble conteo; «Registrar de todos modos» sí la suma', async ({
    page,
  }) => {
    await openApp(page);
    await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg');
    await tab(page, 'inventario');
    const inv = invRow(page, 'primera');
    await inv.getByTestId('move-entrada').click();
    await inv.getByTestId('move-qty').fill('100');
    await inv.getByTestId('move-save').click();
    await expect(page.getByTestId('warnings-sheet')).toBeVisible();
    await expect(page.getByTestId('warnings-text')).toContainText('Hace poco se registró en Recepción mercancía de esta misma clasificación (R-1)');
    await page.getByTestId('warnings-no').click();
    expect(physicalOf(await readDb(page), 'primera'), 'sin reconocer el aviso no se suma').toBe(100000);

    await inv.getByTestId('move-save').click();
    await page.getByTestId('warnings-yes').click();
    await expect(toast(page)).toContainText('Entrada manual registrada');
    await expect(inv.getByTestId('stock-physical')).toHaveText('200 kg');
    await expect(inv.getByTestId('stock-recibido')).toHaveText('100 kg'); // lo recibido sigue siendo 100: la entrada manual va aparte
    await expect(inv.getByTestId('stock-manual')).toHaveText('100 kg');
    expect(auditRaw(await readDb(page))).toEqual([]);
  });

  test('registrar una recepción con los mismos kilos de una entrada manual de las últimas 24 h avisa antes de sumar', async ({ page }) => {
    await openApp(page);
    await tab(page, 'inventario');
    const inv = invRow(page, 'primera');
    await inv.getByTestId('move-entrada').click();
    await inv.getByTestId('move-qty').fill('100');
    await inv.getByTestId('move-save').click();
    await expect(toast(page)).toContainText('Entrada manual registrada');

    await goReceive(page);
    await pick(page, 'primera');
    await typeNet(page, '100');
    await page.getByTestId('rec-confirm').click();
    await expect(page.getByTestId('rec-dup-warning')).toContainText('Hay una entrada manual de los mismos kilos de las últimas 24 horas');
    await expect(page.getByTestId('rec-confirm-yes')).toHaveCount(0);
    await page.getByTestId('rec-confirm-no').click();
    expect(physicalOf(await readDb(page), 'primera')).toBe(100000);

    await register(page, 'Recepción R-1 registrada: +100 kg', { ack: true });
    const d = await readDb(page);
    expect(physicalOf(d, 'primera')).toBe(200000);
    expect(d.receptions[0].acknowledged?.[0].warnings.join(' ')).toContain('entrada manual');
  });

  test('registrar una llegada de «ayer» después de un conteo físico de hoy avisa que esos kilos podrían estar ya contados', async ({ page }) => {
    await openApp(page);
    await tab(page, 'inventario');
    const inv = invRow(page, 'primera');
    await inv.getByTestId('move-ajuste').click();
    await inv.getByTestId('move-qty').fill('50');
    await inv.getByTestId('move-note').fill('conteo inicial');
    await inv.getByTestId('move-save').click();
    await expect(toast(page)).toContainText('Conteo físico registrado');

    await goReceive(page);
    await pick(page, 'primera');
    await typeNet(page, '30');
    await page.getByTestId('rec-date-yesterday').click();
    await expect(page.getByTestId('rec-date-hint')).toContainText('Llegó ayer');
    await page.getByTestId('rec-confirm').click();
    await expect(page.getByTestId('rec-sheet-old')).toContainText('La llegada es de ayer');
    await expect(page.getByTestId('rec-dup-warning')).toContainText('Ya hubo un conteo físico de esta clasificación');
    await expect(page.getByTestId('rec-dup-warning')).toContainText('después de la llegada');
    await page.getByTestId('rec-dup-ack').click();
    await expect(toast(page)).toContainText('Recepción R-1 registrada: +30 kg');
    expect(physicalOf(await readDb(page), 'primera')).toBe(80000);
  });
});

test.describe('Recepción · negativos de captura (kilos inválidos, negativos, desbordados, vacíos)', () => {
  const DECIMALS = /es demasiado grande \(máximo 200,000 kg\) o tiene demasiados decimales \(máximo 3\)/;
  const NEEDS_POSITIVE = 'Los kilos netos deben ser mayores a cero';

  test('kilos netos directos: vacío, cero, negativo, texto, notación científica, coma ambigua, más de 3 decimales y excesos NO se registran y el mensaje dice por qué', async ({
    page,
  }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    const net = page.getByTestId('rec-net-direct');
    const problem = page.getByTestId('rec-input-problem');

    const bad: Array<{ text: string; problem?: RegExp; hint: string }> = [
      { text: '', hint: 'Escribe los kilos netos' },
      { text: '   ', hint: 'Escribe los kilos netos' },
      { text: '0', hint: NEEDS_POSITIVE },
      { text: '0.000', hint: NEEDS_POSITIVE },
      { text: '-5', problem: /No entiendo «-5»\. Escribe solo el número; para decimales usa punto \(por ejemplo 15\.5\)\./, hint: NEEDS_POSITIVE },
      { text: '-0.5', problem: /No entiendo «-0\.5»/, hint: NEEDS_POSITIVE },
      { text: 'abc', problem: /No entiendo «abc»/, hint: NEEDS_POSITIVE },
      { text: '12 kg', problem: /No entiendo «12 kg»/, hint: NEEDS_POSITIVE },
      { text: '1e3', problem: /No entiendo «1e3»/, hint: NEEDS_POSITIVE },
      { text: '1E+3', problem: /No entiendo «1E\+3»/, hint: NEEDS_POSITIVE },
      { text: 'Infinity', problem: /No entiendo «Infinity»/, hint: NEEDS_POSITIVE },
      { text: 'NaN', problem: /No entiendo «NaN»/, hint: NEEDS_POSITIVE },
      { text: '5..5', problem: /No entiendo «5\.\.5»/, hint: NEEDS_POSITIVE },
      { text: '1,500', problem: /«1,500» se puede leer como 1500 o como 1\.5\. Escribe 1500 o 1\.5 para que quede claro\./, hint: NEEDS_POSITIVE },
      { text: '1.2345', problem: DECIMALS, hint: NEEDS_POSITIVE },
      { text: '0.0001', problem: DECIMALS, hint: NEEDS_POSITIVE },
      { text: '200001', problem: DECIMALS, hint: NEEDS_POSITIVE },
      { text: '200000.001', problem: DECIMALS, hint: NEEDS_POSITIVE },
      { text: '99999999999999999999', problem: DECIMALS, hint: NEEDS_POSITIVE },
    ];
    for (const c of bad) {
      await net.fill(c.text);
      await confirmDisabled(page, true);
      await expect(page.getByTestId('rec-net'), `«${c.text}» no debe dar kilos netos`).toHaveText('—');
      await expect(page.getByTestId('rec-net-hint'), `«${c.text}»: texto de ayuda`).toHaveText(c.hint);
      if (c.problem) await expect(problem, `«${c.text}»: mensaje de qué no se entendió`).toHaveText(c.problem);
      else await expect(problem, `«${c.text}»: sin mensaje de ilegible (solo falta o es cero)`).toHaveCount(0);
      await tapDisabledConfirm(page);
      await expect(page.getByTestId('rec-sheet'), `«${c.text}» no debe abrir la hoja`).toHaveCount(0);
    }
    await expect(toast(page)).toHaveClass(/error/);
    await expectNothingChanged(page, 'después de todos los kilos inválidos');

    await test.step('lo escrito sin ambigüedad SÍ vale (para que las reglas no rechacen de más)', async () => {
      const good: Array<[string, number]> = [
        ['0.001', 1], // 1 g
        ['15,5', 15500], // coma decimal clara
        ['1,500.5', 1500500], // coma de miles + punto decimal
        [' 7 ', 7000], // espacios alrededor
        ['1500', 1500000],
        ['200000', 200000000], // el máximo exacto
      ];
      for (const [text, milli] of good) {
        await net.fill(text);
        await expect(page.getByTestId('rec-net'), `«${text}» debe valer ${milli} milésimas`).toHaveAttribute('data-milli', String(milli));
        await expect(problem).toHaveCount(0);
        await confirmDisabled(page, false);
      }
    });
  });

  test('envases × peso: cantidades decimales, negativas, cero, ilegibles o enormes, y totales que rebasan 200,000 kg NO se registran', async ({ page }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await setPackaging(page, 'caja');
    const problem = page.getByTestId('rec-input-problem');
    const COUNT = (t: string) => new RegExp(`No entiendo «${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}»\\. Escribe solo un número entero de cajas \\(por ejemplo 40\\)\\.`);

    const bad: Array<{ boxes: string; unit: string; problem?: RegExp; hint: string }> = [
      { boxes: '2.5', unit: '10', problem: COUNT('2.5'), hint: 'La cantidad de envases debe ser un entero mayor a cero' },
      { boxes: '-3', unit: '10', problem: COUNT('-3'), hint: 'La cantidad de envases debe ser un entero mayor a cero' },
      { boxes: '0', unit: '10', problem: COUNT('0'), hint: 'La cantidad de envases debe ser un entero mayor a cero' },
      { boxes: '1e2', unit: '10', problem: COUNT('1e2'), hint: 'La cantidad de envases debe ser un entero mayor a cero' },
      { boxes: 'diez', unit: '10', problem: COUNT('diez'), hint: 'La cantidad de envases debe ser un entero mayor a cero' },
      { boxes: '1,5', unit: '10', problem: COUNT('1,5'), hint: 'La cantidad de envases debe ser un entero mayor a cero' },
      { boxes: '100001', unit: '1', hint: 'Máximo 100,000 envases' },
      { boxes: '', unit: '12.5', hint: 'Escribe cuántas cajas' },
      { boxes: '10', unit: '', hint: 'Escribe el peso neto de cada caja (si no lo conoces, guarda un borrador)' },
      { boxes: '10', unit: '0', hint: 'El peso por caja debe ser mayor a cero' },
      { boxes: '10', unit: '-12', problem: /No entiendo «-12»/, hint: 'El peso por caja debe ser mayor a cero' },
      { boxes: '10', unit: '12,500', problem: /«12,500» se puede leer como 12500 o como 12\.5/, hint: 'El peso por caja debe ser mayor a cero' },
      { boxes: '10', unit: '12.5kg', problem: /No entiendo «12\.5kg»/, hint: 'El peso por caja debe ser mayor a cero' },
      { boxes: '1000', unit: '250', hint: 'El total no puede pasar de 200,000 kg' },
      { boxes: '100000', unit: '200', hint: 'El total no puede pasar de 200,000 kg' },
    ];
    for (const c of bad) {
      await page.getByTestId('rec-containers').fill(c.boxes);
      await page.getByTestId('rec-unit-net').fill(c.unit);
      const label = `${c.boxes || '(vacío)'} cajas × ${c.unit || '(vacío)'} kg`;
      await confirmDisabled(page, true);
      await expect(page.getByTestId('rec-net'), label).toHaveText('—');
      await expect(page.getByTestId('rec-net-hint'), `${label}: texto de ayuda`).toHaveText(c.hint);
      if (c.problem) await expect(problem, `${label}: mensaje`).toHaveText(c.problem);
      else await expect(problem, `${label}: sin mensaje de ilegible`).toHaveCount(0);
      await tapDisabledConfirm(page);
      await expect(page.getByTestId('rec-sheet'), `${label} no debe abrir la hoja`).toHaveCount(0);
    }
    await expectNothingChanged(page, 'después de todos los envases inválidos');

    await test.step('el borde exacto sí vale: 1000 cajas × 200 kg = 200,000 kg', async () => {
      await page.getByTestId('rec-containers').fill('1000');
      await page.getByTestId('rec-unit-net').fill('200');
      await expectNet(page, 200000000, '200,000 kg');
      await confirmDisabled(page, false);
    });
  });

  test('bruto − tara: tara igual o mayor al bruto, bruto cero, tara negativa o ilegible y excesos NO se registran', async ({ page }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await setPackaging(page, 'caja');
    await setMode(page, 'bruto_tara');
    const problem = page.getByTestId('rec-input-problem');

    const bad: Array<{ gross: string; tare: string; problem?: RegExp; hint: string }> = [
      { gross: '10', tare: '10', hint: 'La tara debe ser menor al peso bruto' },
      { gross: '10', tare: '12', hint: 'La tara debe ser menor al peso bruto' },
      { gross: '0', tare: '0', hint: 'El peso bruto debe ser mayor a cero' },
      { gross: '10', tare: '', hint: 'Escribe la tara (0 si no hay)' },
      { gross: '', tare: '1', hint: 'Escribe el peso bruto' },
      { gross: '10', tare: '-1', problem: /No entiendo «-1»/, hint: 'La tara no puede ser negativa' },
      { gross: '10', tare: '1.2345', problem: DECIMALS, hint: 'La tara no puede ser negativa' },
      { gross: '10', tare: 'x', problem: /No entiendo «x»/, hint: 'La tara no puede ser negativa' },
      { gross: '-10', tare: '1', problem: /No entiendo «-10»/, hint: 'El peso bruto debe ser mayor a cero' },
      { gross: '200001', tare: '1', problem: DECIMALS, hint: 'El peso bruto debe ser mayor a cero' },
    ];
    for (const c of bad) {
      await page.getByTestId('rec-gross').fill(c.gross);
      await page.getByTestId('rec-tare').fill(c.tare);
      const label = `bruto ${c.gross || '(vacío)'} − tara ${c.tare || '(vacío)'}`;
      await confirmDisabled(page, true);
      await expect(page.getByTestId('rec-net'), label).toHaveText('—');
      await expect(page.getByTestId('rec-net-hint'), `${label}: texto de ayuda`).toHaveText(c.hint);
      if (c.problem) await expect(problem, `${label}: mensaje`).toHaveText(c.problem);
      else await expect(problem, `${label}: sin mensaje de ilegible`).toHaveCount(0);
      await tapDisabledConfirm(page);
      await expect(page.getByTestId('rec-sheet'), `${label} no debe abrir la hoja`).toHaveCount(0);
    }
    await expectNothingChanged(page, 'después de todos los bruto/tara inválidos');

    // tara cero es válida (envase sin peso propio): neto = bruto
    await page.getByTestId('rec-gross').fill('135.5');
    await page.getByTestId('rec-tare').fill('0');
    await expectNet(page, 135500, '135.5 kg');
  });

  test('sin elegir el tipo de limón (o sin elegir la clasificación de una variedad con varias) no se registra y el aviso lo dice', async ({ page }) => {
    await openApp(page);
    await goReceive(page);
    await typeNet(page, '50');
    await confirmDisabled(page, true);
    await expect(page.getByTestId('rec-missing')).toContainText('Elige el tipo de limón (variedad y clasificación)');
    await tapDisabledConfirm(page);
    await expect(toast(page)).toHaveClass(/error/);
    await expect(toast(page)).toContainText('Elige el tipo de limón (variedad y clasificación)');
    await expect(page.getByTestId('rec-sheet')).toHaveCount(0);

    // «Limón persa» tiene Primera y Segunda: elegir solo la variedad no basta
    await page.getByTestId('rec-variety').filter({ hasText: 'Limón persa' }).click();
    await expect(page.getByTestId('rec-class-hint')).toContainText('Elige la clasificación de «Limón persa»');
    await expect(page.getByTestId('rec-selected')).toHaveCount(0);
    await confirmDisabled(page, true);
    await expectNothingChanged(page, 'sin elegir la clasificación');
    await page.getByTestId('rec-class').filter({ hasText: 'Segunda' }).click();
    await confirmDisabled(page, false);
  });

  test('guardar borrador: vacío o con kilos ilegibles NO se guarda; con un solo dato (el proveedor) sí', async ({ page }) => {
    await openApp(page);
    await goReceive(page);
    await page.getByTestId('rec-save-draft').click({ force: true });
    await expect(toast(page)).toContainText('El borrador está vacío: captura al menos un dato');
    await typeNet(page, 'abc');
    await expect(page.getByTestId('rec-save-draft')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('rec-draft-hint')).toContainText('Para guardar un borrador: los kilos netos deben ser mayores a cero');
    await page.getByTestId('rec-save-draft').click({ force: true });
    await expect(toast(page)).toContainText(NEEDS_POSITIVE);
    await expectNothingChanged(page, 'borradores inválidos');

    await typeNet(page, '');
    await typeLot(page, { supplier: 'Rancho Sur' });
    await expect(page.getByTestId('rec-save-draft')).toHaveAttribute('aria-disabled', 'false');
    await page.getByTestId('rec-save-draft').click();
    await expect(toast(page)).toContainText('Borrador guardado (aún sin peso neto): no suma al inventario');
    await subTab(page, 'borradores');
    await expect(page.getByTestId('rec-draft-row')).toContainText('Sin producto elegido');
    await expect(page.getByTestId('rec-draft-row')).toContainText('Rancho Sur');
    const d = await readDb(page);
    expect(byStatus(d, 'borrador')).toHaveLength(1);
    expect(d.stockMoves).toHaveLength(0);
  });

  test('textos del lote: proveedor, camión y observaciones demasiado largos o con caracteres invisibles no se registran; el largo máximo exacto sí', async ({
    page,
  }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await typeNet(page, '50');
    const missing = page.getByTestId('rec-missing');

    await typeLot(page, { supplier: 'P'.repeat(121) });
    await confirmDisabled(page, true);
    await expect(missing).toContainText('Proveedor: máximo 120 caracteres');
    await typeLot(page, { supplier: 'P'.repeat(120), reference: 'R'.repeat(61) });
    await expect(missing).toContainText('Referencia: máximo 60 caracteres');
    await expect(missing).not.toContainText('Proveedor');
    await typeLot(page, { reference: 'R'.repeat(60), notes: 'N'.repeat(501) });
    await expect(missing).toContainText('Observaciones: máximo 500 caracteres');
    await typeLot(page, { notes: 'N'.repeat(500) });
    await confirmDisabled(page, false); // los máximos exactos valen
    await expect(missing).toHaveCount(0);

    await typeLot(page, { supplier: 'Rancho\u0007Sur' }); // carácter de control
    await confirmDisabled(page, true);
    await expect(missing).toContainText('Proveedor: contiene caracteres no permitidos');
    await typeLot(page, { supplier: 'Rancho​Sur' }); // espacio de ancho cero (invisible)
    await confirmDisabled(page, true);
    await expect(missing).toContainText('Proveedor: contiene caracteres no permitidos');
    await tapDisabledConfirm(page);
    await expect(page.getByTestId('rec-sheet')).toHaveCount(0);
    await expectNothingChanged(page, 'textos inválidos');

    await typeLot(page, { supplier: '  Rancho    Sur  ' }); // espacios de más se limpian al registrar
    await register(page, 'Recepción R-1 registrada: +50 kg');
    const d = await readDb(page);
    expect(d.receptions[0].supplier).toBe('Rancho Sur');
    expect(d.receptions[0].reference).toHaveLength(60);
    expect(d.receptions[0].notes).toHaveLength(500);
  });

  test('la fecha de llegada no puede ser futura ni anterior al año 2000; «Ayer» y una fecha pasada válida sí', async ({ page }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await typeNet(page, '50');
    const when = page.getByTestId('rec-datetime');
    await when.fill(await localInput(page, 2 * 24 * 3600e3));
    await confirmDisabled(page, true);
    await expect(page.getByTestId('rec-missing')).toContainText('La fecha de recepción no puede ser futura');
    await when.fill('1999-12-31T10:00');
    await confirmDisabled(page, true);
    await expect(page.getByTestId('rec-missing')).toContainText('La fecha de recepción es demasiado antigua');
    await expectNothingChanged(page, 'fechas inválidas');
    await page.getByTestId('rec-date-yesterday').click();
    await confirmDisabled(page, false);
    await page.getByTestId('rec-date-now').click();
    await confirmDisabled(page, false);
  });

  test('borde del máximo: exactamente 200,000 kg en una recepción se registran (sin desbordar existencias ni formatos), 1 g también, y 200,000.001 kg no', async ({ page }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await typeNet(page, '200000.001');
    await confirmDisabled(page, true);
    await expect(page.getByTestId('rec-input-problem')).toBeVisible();
    await typeNet(page, '200000');
    await register(page, 'Recepción R-1 registrada: +200,000 kg');
    await goReceive(page);
    await pick(page, 'semilla');
    await typeNet(page, '199999.999');
    await register(page, 'Recepción R-2 registrada: +199,999.999 kg');
    await expectStock(page, 'semilla', { physical: '399,999.999 kg', received: '399,999.999 kg' });
    await goReceive(page);
    await pick(page, 'semilla');
    await typeNet(page, '0.001'); // un solo gramo: la suma entera no pierde ni inventa nada
    await register(page, 'Recepción R-3 registrada: +1 g');
    await expectStock(page, 'semilla', { physical: '400,000 kg', received: '400,000 kg' });
    const d = await readDb(page);
    expect(physicalOf(d, 'semilla')).toBe(400000000);
    expect(auditRaw(d)).toEqual([]);
  });
});

test.describe('Recepción · persistencia y sin conexión (casos 17 y 22)', () => {
  test('17 · recargar la página conserva lo registrado, los borradores y la captura en curso (con el aviso «Recuperé lo que estabas capturando»), y lo recuperado se puede registrar', async ({
    page,
  }) => {
    await openApp(page);
    await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg', { supplier: 'Rancho Sur' });
    await pick(page, 'segunda');
    await typeNet(page, '40');
    await page.getByTestId('rec-save-draft').click();
    await expect(toast(page)).toContainText('Borrador guardado: no suma al inventario');
    // una captura a medias: 12 cajas de 10.5 kg de «Con semilla», sin terminar de registrar
    await pick(page, 'semilla');
    await setPackaging(page, 'caja');
    await typeContainers(page, '12', '10.5');
    await typeLot(page, { supplier: 'En curso SA' });
    await autosaved(page);

    await page.reload();
    await expect(page.getByTestId('caja')).toBeVisible();

    await test.step('lo registrado sigue: existencias, folio y movimiento', async () => {
      await expectStock(page, 'primera', { physical: '100 kg', received: '100 kg' });
      await subTab(page, 'historial');
      await expect(page.getByTestId('rec-row')).toHaveCount(1);
      await expect(histRow(page, 1).getByTestId('rec-row-net')).toHaveText('100 kg');
    });
    await test.step('el borrador sigue y el contador de la pestaña también', async () => {
      await expect(page.getByTestId('menu-count')).toHaveText('1');
      await subTab(page, 'borradores');
      await expect(page.getByTestId('rec-draft-row')).toHaveCount(1);
      await expect(page.getByTestId('rec-draft-row')).toContainText('Limón persa · Segunda');
      await expect(page.getByTestId('rec-draft-row')).toContainText('Kilos netos: 40 kg');
    });
    await test.step('la captura en curso se recuperó completa, con aviso', async () => {
      await subTab(page, 'nueva');
      await expect(page.getByTestId('rec-restored')).toContainText('Recuperé lo que estabas capturando');
      await expect(page.getByTestId('rec-selected')).toContainText('Con semilla');
      await expect(page.getByTestId('rec-pack-caja')).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('rec-containers')).toHaveValue('12');
      await expect(page.getByTestId('rec-unit-net')).toHaveValue('10.5');
      await expect(page.getByTestId('rec-supplier')).toHaveValue('En curso SA');
      await expectNet(page, 126000, '126 kg');
    });
    await register(page, 'Recepción R-2 registrada: +126 kg');
    await expect(page.getByTestId('rec-restored')).toHaveCount(0);

    // tras registrar, otra recarga ya NO trae la captura (no se registra dos veces lo mismo)
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), FORM_KEY)).toBeNull();
    await page.reload();
    await goReceive(page);
    await expect(page.getByTestId('rec-restored')).toHaveCount(0);
    await expectFormClean(page);
    const d = await readDb(page);
    expect(physicalOf(d, 'semilla')).toBe(126000);
    expect(physicalOf(d, 'primera')).toBe(100000);
    expect(d.receptions.filter((r) => r.status === 'confirmada')).toHaveLength(2);
    expect(byStatus(d, 'borrador')).toHaveLength(1);
    expect(auditRaw(d)).toEqual([]);
  });

  test('17 · «Limpiar» / «Empezar de cero» pide un segundo toque antes de borrar la captura, y borrada ya no vuelve al recargar', async ({ page }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await typeNet(page, '77');
    await typeLot(page, { supplier: 'Rancho Sur' });
    await autosaved(page);
    await page.reload();
    await goReceive(page);
    await expect(page.getByTestId('rec-restored')).toBeVisible();

    await page.getByTestId('rec-restored').getByRole('button').click(); // 1er toque: solo avisa
    await expect(page.getByTestId('rec-restored')).toContainText('Toca otra vez para borrar');
    await expect(page.getByTestId('rec-net-direct')).toHaveValue('77'); // nada se borró todavía
    await page.getByTestId('rec-restored').getByRole('button').click(); // 2º toque: borra
    await expect(toast(page)).toContainText('Formulario limpio');
    await expect(page.getByTestId('rec-restored')).toHaveCount(0);
    await expectFormClean(page);
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), FORM_KEY)).toBeNull();
    await page.reload();
    await goReceive(page);
    await expect(page.getByTestId('rec-restored')).toHaveCount(0);
    await expectNothingChanged(page, 'limpiar el formulario no registra nada');
  });

  test('17 · reinicio REAL (se cierra el navegador y se abre otra vez con el mismo perfil): conserva recepciones, folios, borradores, existencias y la captura en curso', async ({}, testInfo) => {
    // Ruta SOLO ASCII a propósito: en este entorno Chromium no abre IndexedDB ni el service worker si el perfil está en una
    // carpeta con acentos (el nombre de la carpeta de la prueba los trae). Se borra antes y después.
    const userDataDir = join(testInfo.project.outputDir, 'perfil-reinicio-recepcion');
    rmSync(userDataDir, { recursive: true, force: true });
    const use = testInfo.project.use;
    const { userAgent, viewport, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7'];
    const options = {
      userAgent,
      viewport,
      deviceScaleFactor,
      isMobile,
      hasTouch,
      baseURL: use.baseURL,
      timezoneId: 'America/Mexico_City',
      locale: 'es-MX',
      args: ['--no-sandbox'],
      executablePath: use.launchOptions?.executablePath,
    };

    let ctx = await chromium.launchPersistentContext(userDataDir, options);
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await openApp(page);
      await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg', { supplier: 'Rancho Sur', reference: 'CAM-1' });
      await goReceive(page);
      await pick(page, 'semilla');
      await setPackaging(page, 'arpilla');
      await typeContainers(page, '4', '15');
      await register(page, 'Recepción R-2 registrada: +60 kg');
      await pick(page, 'segunda');
      await setPackaging(page, 'granel');
      await typeNet(page, '40');
      await page.getByTestId('rec-save-draft').click();
      await expect(toast(page)).toContainText('Borrador guardado');
      await pick(page, 'semilla');
      await typeNet(page, '33');
      await autosaved(page);
    } finally {
      await ctx.close(); // el «reinicio»: se cierra el navegador entero
    }

    ctx = await chromium.launchPersistentContext(userDataDir, options);
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto('/');
      await expect(page.getByTestId('caja')).toBeVisible();
      await expect(page.getByTestId('menu-count')).toHaveText('1');
      await expectStock(page, 'primera', { physical: '100 kg', received: '100 kg' });
      await expectStock(page, 'semilla', { physical: '60 kg', received: '60 kg' });
      await subTab(page, 'historial');
      await expect(page.getByTestId('rec-row')).toHaveCount(2);
      await expect(histRow(page, 1)).toContainText('Rancho Sur');
      await expect(histRow(page, 2)).toContainText('Arpilla · 4 arpillas');
      await subTab(page, 'nueva');
      await expect(page.getByTestId('rec-restored')).toBeVisible();
      await expect(page.getByTestId('rec-net-direct')).toHaveValue('33');
      await register(page, 'Recepción R-3 registrada: +33 kg'); // el folio CONTINÚA: no se repite R-1
      const d = await readDb(page);
      expect(d.receptions.filter((r) => r.status === 'confirmada').map((r) => r.folio).sort()).toEqual([1, 2, 3]);
      expect(physicalOf(d, 'semilla')).toBe(93000);
      expect(byStatus(d, 'borrador')).toHaveLength(1);
      expect(auditRaw(d)).toEqual([]);
    } finally {
      await ctx.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('22 · [sin conexión SIMULADA con context.setOffline(true); NO equivale al modo avión real de Android] registrar una recepción y un borrador sin red, verlos en inventario e historial, y que sigan ahí al volver la red y recargar', async ({
    page,
    context,
  }) => {
    await openApp(page);
    await context.setOffline(true);
    await page.reload(); // la app carga desde el service worker
    await expect(page.getByTestId('caja')).toBeVisible();
    await expect(page.getByTestId('net')).toContainText('Sin internet');

    await receive(page, 'primera', '80', 'Recepción R-1 registrada: +80 kg', { supplier: 'Rancho Sin Señal' });
    await pick(page, 'segunda');
    await setPackaging(page, 'caja');
    await page.getByTestId('rec-containers').fill('5');
    await page.getByTestId('rec-save-draft').click();
    await expect(toast(page)).toContainText('Borrador guardado (aún sin peso neto)');
    await expectStock(page, 'primera', { physical: '80 kg', received: '80 kg' });
    await subTab(page, 'historial');
    await expect(histRow(page, 1)).toContainText('Rancho Sin Señal');

    await page.reload(); // sigue sin red
    await expect(page.getByTestId('net')).toContainText('Sin internet');
    await expectStock(page, 'primera', { physical: '80 kg' });
    await expect(page.getByTestId('menu-count')).toHaveText('1');

    await context.setOffline(false);
    await page.reload();
    await expect(page.getByTestId('net')).toContainText('En línea');
    await subTab(page, 'historial');
    await expect(page.getByTestId('rec-row')).toHaveCount(1);
    await expect(page.getByTestId('menu-count')).toHaveText('1');
    await receive(page, 'primera', '20', 'Recepción R-2 registrada: +20 kg'); // y con red todo sigue funcionando
    const d = await readDb(page);
    expect(physicalOf(d, 'primera')).toBe(100000);
    expect(auditRaw(d)).toEqual([]);
  });
});

test.describe('Recepción · almacenamiento local bloqueado', () => {
  test('con el almacenamiento local bloqueado (modo privado o permisos) la recepción igual se registra y sobrevive a recargar; solo se pierde la captura a medias', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('Acceso bloqueado', 'SecurityError');
        },
      });
    });
    await openApp(page);
    await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg');
    await goReceive(page);
    await pick(page, 'segunda');
    await setPackaging(page, 'caja'); // recordar la presentación usa el almacenamiento local: debe fallar en silencio
    await page.getByTestId('rec-containers').fill('5');
    await page.getByTestId('rec-unit-net').fill('12');
    await page.reload();
    await expect(page.getByTestId('caja')).toBeVisible();
    await expectStock(page, 'primera', { physical: '100 kg', received: '100 kg' });
    await goReceive(page);
    await expect(page.getByTestId('rec-restored')).toHaveCount(0); // sin dónde guardar la captura a medias, no se recupera
    await expectFormClean(page);
    await subTab(page, 'historial');
    await expect(page.getByTestId('rec-row')).toHaveCount(1);
    await expect(page.getByTestId('toast')).toHaveCount(0); // y nada de «Error inesperado»
    expect(auditRaw(await readDb(page))).toEqual([]);
  });
});

test.describe('Recepción · integración con ventas, vales, corte y auditoría (casos 14, 15, 23 y 25)', () => {
  test('14 · recibir 100 kg y vender 20 kg descuenta exactamente 20 (físico 80); pedir más de lo que hay exige autorización y «Volver» no vende', async ({
    page,
  }) => {
    await openApp(page);
    await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg');
    await sellExact(page, '20');
    await expectStock(page, 'primera', { physical: '80 kg', available: '80 kg', received: '100 kg', sold: '20 kg' });
    let d = await readDb(page);
    expect(orderedMoves(d, 'primera').map((m) => [m.type, m.deltaMilli])).toEqual([
      ['recepcion', 100000],
      ['venta', -20000],
    ]);
    expect(d.sales).toHaveLength(1);
    expect(d.sales[0].items[0].qtyMilli).toBe(20000);

    await test.step('camino negativo: 90 kg con solo 80 disponibles pide autorización; «Volver» no vende', async () => {
      await tab(page, 'caja');
      await page.getByTestId('kg').fill('90');
      await page.getByTestId('exact').click();
      await page.getByTestId('confirm').click();
      await expect(page.getByTestId('stock-warning')).toBeVisible();
      await expect(page.getByTestId('confirm-yes')).toHaveCount(0);
      await expect(page.getByTestId('authorize')).toBeVisible();
      await page.getByTestId('confirm-no').click();
      d = await readDb(page);
      expect(d.sales).toHaveLength(1);
      expect(physicalOf(d, 'primera')).toBe(80000);
    });

    await sellExact(page, '80'); // todo lo que queda: sin aviso
    await expectStock(page, 'primera', { physical: '0 g', sold: '100 kg', received: '100 kg' });
    d = await readDb(page);
    expect(d.sales).toHaveLength(2);
    expect(auditRaw(d)).toEqual([]);
  });

  test('15 · un vale pagado de 10 kg reserva (el físico no cambia, el disponible baja) y al entregarlo el físico baja 10 UNA sola vez; recibir con un vale pendiente muestra el disponible real', async ({
    page,
  }) => {
    await openApp(page);
    await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg');
    await sellVale(page, '10', 'Doña Mary');
    await expectStock(page, 'primera', { physical: '100 kg', reserved: '10 kg', available: '90 kg' });

    await test.step('recibir 60 kg más con el vale pendiente: la hoja separa bodega y disponible', async () => {
      await goReceive(page);
      await pick(page, 'primera');
      await expect(page.getByTestId('rec-selected')).toContainText('en bodega ahora: 100 kg (apartado por vales: 10 kg)');
      await typeNet(page, '60');
      await page.getByTestId('rec-confirm').click();
      await expect(page.getByTestId('rec-sheet-stock')).toHaveText(/En bodega: 100 kg → 160 kg\s*·\s*Disponible: 90 kg → 150 kg/);
      await page.getByTestId('rec-confirm-yes').click();
      await expect(toast(page)).toContainText('Recepción R-2 registrada: +60 kg');
      await expectStock(page, 'primera', { physical: '160 kg', reserved: '10 kg', available: '150 kg' });
    });

    await tab(page, 'vales');
    await expect(page.getByTestId('vale')).toHaveCount(1);
    await page.getByTestId('deliver').click();
    await expect(toast(page)).toContainText('Vale V-1 entregado');
    await expectStock(page, 'primera', { physical: '150 kg', reserved: '0 g', available: '150 kg' }); // 160 − 10, nunca 140

    const d = await readDb(page);
    expect(orderedMoves(d, 'primera').map((m) => [m.type, m.deltaMilli, m.reservedDeltaMilli])).toEqual([
      ['recepcion', 100000, 0],
      ['reserva', 0, 10000],
      ['recepcion', 60000, 0],
      ['entrega_vale', -10000, -10000],
    ]);
    expect(physicalOf(d, 'primera')).toBe(150000);
    expect(reservedOf(d, 'primera')).toBe(0);
    expect(auditRaw(d)).toEqual([]);
  });

  test('23 · registrar, corregir, anular y descartar recepciones NO altera el corte de caja (ventas, efectivo esperado, salidas) y el cierre sigue cuadrando; recibir cubre un faltante vendido sin existencia', async ({
    page,
  }) => {
    page.on('dialog', (dlg) => dlg.accept());
    await openApp(page);
    await tab(page, 'corte');
    await page.getByTestId('opening').fill('200');
    await page.getByTestId('open-shift').click();
    await expect(page.getByTestId('r-expected')).toContainText('$200.00');
    await sellExact(page, '10'); // sin existencia: se autoriza; $300
    await tab(page, 'corte');
    await expect(page.getByTestId('r-total')).toContainText('$300.00');
    await expect(page.getByTestId('r-expected')).toContainText('$500.00');
    const corte = () => page.getByTestId('corte').locator('dl.report').innerText();
    const before = await corte();
    await expect(page.getByTestId('sale-row')).toHaveCount(1);

    await test.step('recibir CUBRE el faltante (-10 kg vendidos sin existencia) y lo dice', async () => {
      await goReceive(page);
      await pick(page, 'primera');
      await expect(page.getByTestId('rec-selected')).toContainText('disponible negativo (-10 kg): esta recepción lo cubre');
      await typeNet(page, '100');
      await page.getByTestId('rec-confirm').click();
      await expect(page.getByTestId('rec-sheet-covers')).toContainText('Hoy hay 10 kg vendidos o apartados sin existencia: esta recepción los cubre');
      await expect(page.getByTestId('rec-sheet-stock')).toHaveText(/En bodega: -10 kg → 90 kg/);
      await page.getByTestId('rec-confirm-yes').click();
      await expect(toast(page)).toContainText('Recepción R-1 registrada: +100 kg');
    });

    await test.step('más movimientos de recepción: otra, corrección, anulación, borrador y descarte', async () => {
      await receive(page, 'segunda', '40', 'Recepción R-2 registrada: +40 kg');
      await subTab(page, 'historial');
      await histRow(page, 1).getByTestId('rec-correct').click();
      await histRow(page, 1).getByTestId('rec-correct-qty').fill('95');
      await histRow(page, 1).getByTestId('rec-correct-reason').fill('Ajuste de báscula');
      await histRow(page, 1).getByTestId('rec-correct-save').click();
      await expect(toast(page)).toContainText('Recepción R-1 corregida');
      await histRow(page, 2).getByTestId('rec-void').click();
      await page.getByTestId('rec-void-reason').fill('Error');
      await page.getByTestId('rec-void-confirm').click();
      await expect(toast(page)).toContainText('Recepción R-2 anulada');
      await goReceive(page);
      await pick(page, 'semilla');
      await typeNet(page, '15');
      await page.getByTestId('rec-save-draft').click();
      await subTab(page, 'borradores');
      await page.getByTestId('rec-draft-cancel').click();
      await page.getByTestId('rec-draft-cancel-yes').click();
      await expect(toast(page)).toContainText('Borrador descartado');
    });

    await tab(page, 'corte');
    expect(await corte(), 'el corte es exactamente el mismo').toBe(before);
    await expect(page.getByTestId('sale-row')).toHaveCount(1);
    await expect(page.getByTestId('r-total')).toContainText('$300.00');
    await expect(page.getByTestId('r-expected')).toContainText('$500.00');
    let d = await readDb(page);
    expect(d.sales).toHaveLength(1);
    expect(d.cashMovements).toHaveLength(0);
    expect(d.shifts).toHaveLength(1);

    await test.step('el cierre del turno cuadra y recibir después no cambia el corte cerrado', async () => {
      await page.getByTestId('counted').fill('500');
      await expect(page.getByTestId('diff')).toContainText('Cuadra exacto');
      await page.getByTestId('close-shift').click();
      await expect(toast(page)).toContainText('Turno cerrado');
      await expect(page.getByTestId('closed-shift')).toContainText('esperado $500.00');
      await expect(page.getByTestId('closed-shift')).toContainText('contado $500.00');
      await expect(page.getByTestId('closed-shift')).toContainText('dif $0.00');
      await receive(page, 'semilla', '8', 'Recepción R-3 registrada: +8 kg');
      await tab(page, 'corte');
      await expect(page.getByTestId('closed-shift')).toHaveCount(1);
      await expect(page.getByTestId('closed-shift')).toContainText('dif $0.00');
    });
    d = await readDb(page);
    expect(d.cashMovements).toHaveLength(0);
    expect(auditRaw(d)).toEqual([]);
  });

  test('25 · tras mezclar recepciones (granel, cajas, arpillas, bruto−tara), corrección, anulación, borradores, venta, vale, entrega, merma y conteo, «Auditar integridad» no encuentra problemas y las cuentas cuadran con la base cruda', async ({
    page,
  }) => {
    await openApp(page);
    await receive(page, 'primera', '200', 'Recepción R-1 registrada: +200 kg', { supplier: 'Rancho Sur', reference: 'CAM-1' });
    await goReceive(page);
    await pick(page, 'semilla');
    await setPackaging(page, 'caja');
    await typeContainers(page, '20', '12.5');
    await register(page, 'Recepción R-2 registrada: +250 kg');
    await pick(page, 'segunda');
    await setPackaging(page, 'arpilla');
    await typeContainers(page, '8', '15');
    await register(page, 'Recepción R-3 registrada: +120 kg');
    await pick(page, 'semilla');
    await setPackaging(page, 'caja');
    await setMode(page, 'bruto_tara');
    await page.getByTestId('rec-gross').fill('80');
    await page.getByTestId('rec-tare').fill('2.5');
    await register(page, 'Recepción R-4 registrada: +77.5 kg');

    await test.step('dos borradores: uno se queda, otro se descarta', async () => {
      await pick(page, 'primera');
      await setPackaging(page, 'granel');
      await typeNet(page, '40');
      await page.getByTestId('rec-save-draft').click();
      await expect(toast(page)).toContainText('Borrador guardado');
      await pick(page, 'segunda');
      await setPackaging(page, 'caja');
      await setMode(page, 'por_envase');
      await page.getByTestId('rec-containers').fill('10');
      await page.getByTestId('rec-save-draft').click();
      await subTab(page, 'borradores');
      await expect(page.getByTestId('rec-draft-row')).toHaveCount(2);
      await page.getByTestId('rec-draft-row').filter({ hasText: 'Limón persa · Segunda' }).getByTestId('rec-draft-cancel').click();
      await page.getByTestId('rec-draft-cancel-yes').click();
      await expect(toast(page)).toContainText('Borrador descartado');
    });

    await test.step('corregir R-1 a 195 kg y anular R-3', async () => {
      await subTab(page, 'historial');
      await histRow(page, 1).getByTestId('rec-correct').click();
      await histRow(page, 1).getByTestId('rec-correct-qty').fill('195');
      await histRow(page, 1).getByTestId('rec-correct-reason').fill('Merma en el camino');
      await histRow(page, 1).getByTestId('rec-correct-save').click();
      await expect(toast(page)).toContainText('Recepción R-1 corregida');
      await histRow(page, 3).getByTestId('rec-void').click();
      await page.getByTestId('rec-void-reason').fill('Camión rechazado');
      await page.getByTestId('rec-void-confirm').click();
      await expect(toast(page)).toContainText('Recepción R-3 anulada');
    });

    await sellExact(page, '25');
    await sellVale(page, '10', 'Doña Mary');
    await tab(page, 'vales');
    await page.getByTestId('deliver').click();
    await expect(toast(page)).toContainText('entregado');

    await test.step('merma de 5 kg y conteo físico de «Con semilla»', async () => {
      await tab(page, 'inventario');
      const inv = invRow(page, 'semilla');
      await inv.getByTestId('move-merma').click();
      await inv.getByTestId('move-qty').fill('5');
      await inv.getByTestId('move-note').fill('se echó a perder');
      await inv.getByTestId('move-save').click();
      await expect(toast(page)).toContainText('Merma registrada');
      await inv.getByTestId('move-ajuste').click();
      await inv.getByTestId('move-qty').fill('322'); // había 322.5: faltaba medio kilo
      await inv.getByTestId('move-note').fill('conteo de cierre');
      await inv.getByTestId('move-save').click();
      await expect(toast(page)).toContainText('Conteo físico registrado');
    });

    await expectStock(page, 'primera', { physical: '160 kg', reserved: '0 g' }); // 195 − 25 − 10
    await expectStock(page, 'segunda', { physical: '0 g' }); // 120 − 120 (anulada)
    await expectStock(page, 'semilla', { physical: '322 kg' }); // 250 + 77.5 − 5 − 0.5

    await tab(page, 'mas');
    await page.getByTestId('audit').click();
    await expect(page.getByTestId('audit-result')).toContainText('Sin inconsistencias');
    await expect(page.getByTestId('audit-result')).toContainText('2 ventas, 1 vale, 6 recepciones, 11 movimientos');

    await test.step('el Resumen refleja la merma, el conteo y la existencia de cada clasificación (desplegables cerrados por defecto)', async () => {
      await subTab(page, 'resumen');
      await page.getByTestId('rep-fold-stock').locator('summary').click();
      await page.getByTestId('rep-fold-adjust').locator('summary').click();
      await expect(page.getByTestId('rep-merma')).toHaveText('5 kg');
      await expect(page.getByTestId('rep-conteo')).toHaveText('-500 g');
      await expect(page.getByTestId('rep-manual')).toHaveText('0 g');
      await expect(page.getByTestId('rep-adjust-row')).toHaveCount(2);
      await expect(page.getByTestId('rep-adjust-row').filter({ hasText: 'Merma' })).toContainText('se echó a perder');
      await expect(page.getByTestId('rep-adjust-row').filter({ hasText: 'Conteo físico' })).toContainText('conteo de cierre');
      await expect(page.getByTestId('rep-stock-row')).toHaveCount(3);
      await expect(page.getByTestId('rep-stock-row').filter({ hasText: 'Limón persa · Primera' })).toContainText('disp. 160 kg');
      await expect(page.getByTestId('rep-stock-row').filter({ hasText: 'Limón persa · Segunda' })).toContainText('disp. 0 g');
      await expect(page.getByTestId('rep-stock-row').filter({ hasText: 'Con semilla' })).toContainText('disp. 322 kg');
      await expect(page.getByTestId('rep-ledger-cuadra')).toBeVisible();
    });

    const d = await readDb(page);
    expect(auditRaw(d), 'la auditoría independiente tampoco encuentra nada').toEqual([]);
    expect(d.receptions).toHaveLength(6);
    expect(byStatus(d, 'confirmada')).toHaveLength(3);
    expect(byStatus(d, 'anulada')).toHaveLength(1);
    expect(byStatus(d, 'borrador')).toHaveLength(1);
    expect(byStatus(d, 'cancelada')).toHaveLength(1);
    expect(d.stockMoves).toHaveLength(11); // R-1 (2) + R-2 (1) + R-3 (2) + R-4 (1) + venta (1) + vale (2) + merma (1) + conteo (1)
    expect([physicalOf(d, 'primera'), physicalOf(d, 'segunda'), physicalOf(d, 'semilla')]).toEqual([160000, 0, 322000]);
    expect(nextReceptionFolio(d)).toBe(5);
  });
});

test.describe('Recepción · Resumen de mercancía (caso 11 y 25)', () => {
  test('el Resumen cuadra con lo hecho: recibido por día, vendido y disponible; una llegada de «ayer» se cuenta en ayer y el cuadre usa el día de captura (reloj simulado)', async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date('2026-10-09T18:00:00Z')); // 12:00 en CDMX
    await openApp(page);
    await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg');
    await goReceive(page);
    await pick(page, 'segunda');
    await typeNet(page, '60');
    await page.getByTestId('rec-date-yesterday').click();
    await expect(page.getByTestId('rec-date-hint')).toContainText('Llegó ayer: se contará en ese día en el Resumen');
    await page.getByTestId('rec-confirm').click();
    await expect(page.getByTestId('rec-sheet-old')).toContainText('La llegada es de ayer');
    await page.getByTestId('rec-confirm-yes').click();
    await expect(toast(page)).toContainText('Recepción R-2 registrada: +60 kg');
    await sellExact(page, '30');

    await subTab(page, 'resumen');
    await test.step('hoy: llegó 100 (la de ayer no cuenta), vendí 30, disponible 130 (70 + 60)', async () => {
      await expect(page.getByTestId('rep-received')).toHaveAttribute('data-milli', '100000');
      await expect(page.getByTestId('rep-sold')).toHaveAttribute('data-milli', '30000');
      await expect(page.getByTestId('rep-available')).toHaveAttribute('data-milli', '130000');
      await expect(page.getByTestId('rep-physical')).toHaveText('130 kg / 0 g');
      await page.getByTestId('rep-fold-days').locator('summary').click(); // los detalles vienen cerrados
      await expect(page.getByTestId('rep-day-row')).toHaveCount(1);
      await expect(page.getByTestId('rep-day-row')).toHaveAttribute('data-day', '2026-10-09');
      await expect(page.getByTestId('rep-day-row')).toContainText('llegó 100 kg · vendí 30 kg');
      // el cuadre del inventario se hace por el día en que se CAPTURÓ: hoy se capturaron las dos recepciones
      await expect(page.getByTestId('rep-ledger-rec')).toHaveText('+160 kg');
      await expect(page.getByTestId('rep-ledger-out')).toHaveText('30 kg');
      await expect(page.getByTestId('rep-ledger-close')).toHaveAttribute('data-milli', '130000');
      await expect(page.getByTestId('rep-ledger-cuadra')).toBeVisible();
    });
    await test.step('ayer: llegaron 60 kg y no se vendió nada', async () => {
      await page.getByTestId('rep-yesterday').click();
      await expect(page.getByTestId('rep-received')).toHaveAttribute('data-milli', '60000');
      await expect(page.getByTestId('rep-sold')).toHaveAttribute('data-milli', '0');
      await expect(page.getByTestId('rep-day-row')).toHaveCount(1);
      await expect(page.getByTestId('rep-day-row')).toHaveAttribute('data-day', '2026-10-08');
      await expect(page.getByTestId('rep-day-row')).toContainText('llegó 60 kg · vendí 0 g');
      await expect(page.getByTestId('rep-available')).toHaveAttribute('data-milli', '130000'); // la existencia es la de AHORA
    });
    await test.step('últimos 7 días: ambas, y el desglose por calidad y presentación', async () => {
      await page.getByTestId('rep-week').click();
      await expect(page.getByTestId('rep-received')).toHaveAttribute('data-milli', '160000');
      await expect(page.getByTestId('rep-sold')).toHaveAttribute('data-milli', '30000');
      await expect(page.getByTestId('rep-day-row')).toHaveCount(2);
      await expect(page.getByTestId('rep-arrivals')).toContainText('Llegó (vigente)');
      await expect(page.getByTestId('rep-fold-arrivals').locator('summary')).toContainText('160 kg');
      await page.getByTestId('rep-fold-breakdown').locator('summary').click();
      const primera = page.getByTestId('rep-by-quality-row').filter({ hasText: 'Primera' });
      await expect(primera).toContainText(/Llegó\s*100 kg/);
      await expect(primera).toContainText(/Vendí\s*30 kg/);
      await expect(primera).toContainText(/Disponible ahora\s*70 kg/);
      const segunda = page.getByTestId('rep-by-quality-row').filter({ hasText: 'Segunda' });
      await expect(segunda).toContainText(/Llegó\s*60 kg/);
      await expect(segunda).toContainText(/Vendí\s*0 g/);
      await expect(segunda).toContainText(/Disponible ahora\s*60 kg/);
      await expect(page.getByTestId('rep-by-packaging-row')).toContainText('A granel');
      await expect(page.getByTestId('rep-by-packaging-row')).toContainText('2 recepciones');
      await expect(page.getByTestId('rep-by-packaging-row')).toContainText('160 kg');
    });
    expect(auditRaw(await readDb(page))).toEqual([]);
  });

  test('el Resumen no cuenta borradores, descartados ni anulados como recibidos; la corrección ajusta lo recibido y deja el original a la vista', async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date('2026-10-09T18:00:00Z')); // el «Hoy» del Resumen no depende de la hora de la corrida
    await openApp(page);
    await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg');
    await receive(page, 'segunda', '25', 'Recepción R-2 registrada: +25 kg');
    await goReceive(page);
    await pick(page, 'semilla');
    await typeNet(page, '40');
    await page.getByTestId('rec-save-draft').click(); // este borrador se queda
    await pick(page, 'semilla');
    await typeNet(page, '10');
    await page.getByTestId('rec-save-draft').click(); // este se descarta
    await subTab(page, 'borradores');
    await page.getByTestId('rec-draft-row').filter({ hasText: '10 kg' }).getByTestId('rec-draft-cancel').click();
    await page.getByTestId('rec-draft-cancel-yes').click();
    await subTab(page, 'historial');
    await histRow(page, 1).getByTestId('rec-correct').click();
    await histRow(page, 1).getByTestId('rec-correct-qty').fill('90');
    await histRow(page, 1).getByTestId('rec-correct-reason').fill('Pesaje final');
    await histRow(page, 1).getByTestId('rec-correct-save').click();
    await expect(toast(page)).toContainText('Recepción R-1 corregida');
    await histRow(page, 2).getByTestId('rec-void').click();
    await page.getByTestId('rec-void-reason').fill('Error');
    await page.getByTestId('rec-void-confirm').click();
    await expect(toast(page)).toContainText('Recepción R-2 anulada');

    await subTab(page, 'resumen');
    await expect(page.getByTestId('rep-received')).toHaveAttribute('data-milli', '90000');
    await expect(page.getByTestId('rep-original')).toHaveText('100 kg');
    await expect(page.getByTestId('rep-corrections')).toHaveText('-10 kg');
    await expect(page.getByTestId('rep-voided')).toHaveText('25 kg');
    await expect(page.getByTestId('rep-fold-arrivals')).toContainText('1 recepción anulada (no cuentan)');
    await expect(page.getByTestId('rep-drafts')).toContainText('Hay 1 borrador sin registrar');
    await expect(page.getByTestId('rep-available')).toHaveAttribute('data-milli', '90000');
    await expect(page.getByTestId('rep-ledger-rec')).toHaveText('+90 kg'); // +100 −10 +25 −25
    await expect(page.getByTestId('rep-ledger-close')).toHaveAttribute('data-milli', '90000');
    await expect(page.getByTestId('rep-ledger-cuadra')).toBeVisible();

    await test.step('camino negativo: un rango al revés avisa y no muestra cifras confusas', async () => {
      await page.getByTestId('rep-from').fill('2030-01-02');
      await page.getByTestId('rep-to').fill('2030-01-01');
      await expect(page.getByTestId('rec-resumen')).toContainText('La fecha inicial es posterior a la final.');
      await expect(page.getByTestId('rep-received')).toHaveCount(0);
      await page.getByTestId('rep-today').click();
      await expect(page.getByTestId('rep-received')).toHaveAttribute('data-milli', '90000');
    });
    const d = await readDb(page);
    expect(auditRaw(d)).toEqual([]);
    expect(d.receptions).toHaveLength(4);
  });

  test('de madrugada la app avisa que el camión pudo llegar anoche; «Ayer» manda la llegada al día anterior y el Resumen la cuenta ahí (reloj simulado a las 02:30)', async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date('2026-10-10T08:30:00Z')); // 02:30 en CDMX del sábado 10-oct-2026
    await openApp(page);
    await goReceive(page);
    await expect(page.getByTestId('rec-date-hint')).toHaveText('Es de madrugada. Si el camión llegó anoche, toca «Ayer» y ajusta la hora.');
    await pick(page, 'semilla');
    await typeNet(page, '50');
    await page.getByTestId('rec-date-yesterday').click();
    await expect(page.getByTestId('rec-date-hint')).toContainText('Llegó ayer');
    await register(page, 'Recepción R-1 registrada: +50 kg');
    const d = await readDb(page);
    expect(d.receptions[0].day).toBe('2026-10-09');
    expect(d.receptions[0].receivedAt).toBe('2026-10-09T08:30:00.000Z'); // 24 h antes de «ahora»
    await subTab(page, 'resumen');
    await expect(page.getByTestId('rep-received')).toHaveAttribute('data-milli', '0'); // hoy (sábado) no llegó nada
    await page.getByTestId('rep-yesterday').click();
    await expect(page.getByTestId('rep-received')).toHaveAttribute('data-milli', '50000');
  });

  test('la recepción conserva el nombre con el que se registró aunque luego se edite la clasificación del producto; las nuevas usan el nombre actual y el Resumen no mezcla las dos épocas', async ({
    page,
  }) => {
    await openApp(page);
    await receive(page, 'semilla', '100', 'Recepción R-1 registrada: +100 kg');
    await tab(page, 'inventario');
    await invRow(page, 'semilla').getByTestId('edit-product').click();
    await expect(page.getByTestId('edit-moves-warning')).toBeVisible();
    await page.getByTestId('edit-origin').fill('Oaxaca');
    await page.getByTestId('edit-add').click();
    await expect(toast(page)).toContainText('Clasificación actualizada');
    await expect(invRow(page, 'semilla')).toContainText('Con semilla · Oaxaca');

    await goReceive(page);
    await pick(page, 'semilla');
    await expect(page.getByTestId('rec-selected')).toContainText('Con semilla · Oaxaca');
    await typeNet(page, '50');
    await register(page, 'Recepción R-2 registrada: +50 kg');

    await subTab(page, 'historial');
    await expect(histRow(page, 1)).not.toContainText('Oaxaca'); // R-1 se registró cuando se llamaba «Con semilla»
    await expect(histRow(page, 1)).toContainText('R-1 · Con semilla');
    await expect(histRow(page, 2)).toContainText('R-2 · Con semilla · Oaxaca');

    await subTab(page, 'resumen');
    await page.getByTestId('rep-fold-breakdown').locator('summary').click();
    const oaxaca = page.getByTestId('rep-by-origin-row').filter({ hasText: 'Oaxaca' });
    await expect(oaxaca).toContainText(/Llegó\s*50 kg/);
    await expect(oaxaca).toContainText(/Disponible ahora\s*150 kg/); // la existencia es del producto ACTUAL
    const sinOrigen = page.getByTestId('rep-by-origin-row').filter({ hasText: 'No especificada' });
    await expect(sinOrigen).toContainText(/Llegó\s*100 kg/);
    const d = await readDb(page);
    expect(d.receptions.map((r) => [r.folio, r.productLabel])).toEqual(
      expect.arrayContaining([
        [1, 'Con semilla'],
        [2, 'Con semilla · Oaxaca'],
      ]),
    );
    expect(auditRaw(d)).toEqual([]);
  });
});

// ───────────────────────── Pantallas de teléfono Android: 360 y 412 px, teclado cerrado y abierto ─────────────────────────
// El teclado del teléfono se EMULA encogiendo la ventana (como lo hace Android con interactive-widget=resizes-content). NO es un
// teléfono real: la prueba física en Android sigue pendiente (docs/PRUEBAS.md).

for (const phone of PHONES) {
  test.describe(`Recepción en teléfono ${phone.name} (caso 21 en lo que toca a Recepción)`, () => {
    test.use({ viewport: { width: phone.width, height: phone.height } });

    test('teclado CERRADO: se registra con toques; nada se desborda ni queda tapado; las subsecciones y sus formularios caben; un doble toque en «Registrar» solo abre la hoja', async ({
      page,
    }) => {
      await openApp(page);
      await expectTabsIntact(page);
      await goReceive(page);
      await pick(page, 'semilla');
      await page.getByTestId('rec-pack-caja').tap();
      await typeContainers(page, '12', '10.5');
      await typeLot(page, {
        supplier: 'Proveedor con un nombre bastante largo para probar el ancho de la pantalla',
        reference: 'CAMIÓN-CON-REFERENCIA-MUY-LARGA-1234567890',
        notes: 'Observaciones largas con muchas palabras para ver si el texto hace salto de línea y no se sale de la pantalla.',
      });
      expect(await overflowing(page), 'Recepción › Nueva con textos largos').toEqual([]);

      await test.step('la barra de registro queda a la vista, por encima de las pestañas y con botón tocable', async () => {
        const dock = await rectOf(page.getByTestId('rec-dock'));
        const tabs = await rectOf(page.locator('nav.tabs'));
        const vh = await innerHeight(page);
        expect(dock.top).toBeGreaterThanOrEqual(0);
        expect(dock.bottom, 'la barra de registro no debe quedar debajo de las pestañas').toBeLessThanOrEqual(tabs.top + 0.5);
        expect(tabs.bottom).toBeLessThanOrEqual(vh + 0.5);
        expect((await rectOf(page.getByTestId('rec-confirm'))).height).toBeGreaterThanOrEqual(48);
      });

      await test.step('doble toque humano en «Registrar recepción»: abre UNA hoja y NO registra', async () => {
        const at = await centerOf(page.getByTestId('rec-confirm'));
        await doubleTapAt(page, at.x, at.y);
        await expect(page.getByTestId('rec-sheet')).toHaveCount(1);
        await expect(page.getByTestId('rec-confirm-yes')).toBeVisible();
        await expectNothingChanged(page, `doble toque en «Registrar» a ${phone.name} con el teclado cerrado`);
        expect(await overflowing(page), 'la hoja de confirmación').toEqual([]);
        const vh = await innerHeight(page);
        for (const id of ['rec-confirm-yes', 'rec-confirm-no']) {
          const r = await rectOf(page.getByTestId(id));
          expect(r.top, `«${id}» queda dentro de la pantalla`).toBeGreaterThanOrEqual(0);
          expect(r.bottom, `«${id}» queda dentro de la pantalla`).toBeLessThanOrEqual(vh + 0.5);
          expect(r.height).toBeGreaterThanOrEqual(48);
        }
        await page.getByTestId('rec-confirm-no').tap();
        await expect(page.getByTestId('rec-sheet')).toBeHidden();
      });

      await test.step('toque normal: «Registrar» y «Confirmar» responden al primer toque', async () => {
        await watchTaps(page);
        await page.getByTestId('rec-confirm').tap();
        await expectSolidTap(page, 'rec-confirm');
        await expect(page.getByTestId('rec-sheet-net')).toHaveAttribute('data-milli', '126000');
        await watchTaps(page);
        await page.getByTestId('rec-confirm-yes').tap();
        await expectSolidTap(page, 'rec-confirm-yes');
        await expect(toast(page)).toContainText('Recepción R-1 registrada: +126 kg');
      });

      await test.step('las 4 subsecciones y los formularios del historial caben en el ancho', async () => {
        await goReceive(page);
        await pick(page, 'semilla');
        await page.getByTestId('rec-pack-caja').tap();
        await page.getByTestId('rec-containers').fill('40');
        await page.getByTestId('rec-save-draft').tap();
        await expect(toast(page)).toContainText('Borrador guardado');
        await subTab(page, 'borradores');
        expect(await overflowing(page), 'Recepción › Borradores').toEqual([]);
        await subTab(page, 'historial');
        expect(await overflowing(page), 'Recepción › Historial').toEqual([]);
        for (const [btn, form] of [
          ['rec-correct', 'rec-correct-form'],
          ['rec-edit-data', 'rec-data-form'],
          ['rec-void', 'rec-void-form'],
          ['rec-moves', 'rec-detail'],
        ] as const) {
          await histRow(page, 1).getByTestId(btn).tap();
          await expect(histRow(page, 1).getByTestId(form)).toBeVisible();
          expect(await overflowing(page), `Historial con «${btn}» abierto`).toEqual([]);
        }
        await subTab(page, 'resumen');
        await page.locator('details.fold').evaluateAll((els) => els.forEach((e) => ((e as HTMLDetailsElement).open = true)));
        expect(await overflowing(page), 'Resumen con todos los desplegables abiertos').toEqual([]);
        await expectTabsIntact(page);
      });
    });

    test('teclado ABIERTO · regresión del toque perdido: «Guardar borrador», «＋ Sumar», «Guardar corrección» y «Anular recepción» responden al PRIMER toque con el campo aún enfocado; al cerrarse el teclado las pestañas vuelven', async ({
      page,
    }) => {
      await openApp(page);
      await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg');

      await test.step('barra fija: «Registrar recepción» y «Confirmar» con el campo de kilos por caja aún enfocado', async () => {
        await goReceive(page);
        await pick(page, 'semilla');
        await setPackaging(page, 'caja');
        await page.getByTestId('rec-supplier').fill('Proveedor con un nombre bastante largo para probar el ancho de la pantalla');
        await page.getByTestId('rec-containers').fill('12');
        await page.getByTestId('rec-unit-net').fill('10.5');
        await expect(page.getByTestId('rec-unit-net')).toBeFocused();
        await showKeyboard(page, phone);
        await expect(html(page)).toHaveClass(/kbd/);
        expect(await overflowing(page), 'formulario de cajas con textos largos y el teclado abierto').toEqual([]);
        await watchTaps(page);
        await page.getByTestId('rec-confirm').tap();
        await expectSolidTap(page, 'rec-confirm');
        await expect(page.getByTestId('rec-sheet-net')).toHaveAttribute('data-milli', '126000');
        expect(await overflowing(page), 'hoja de confirmación con el teclado abierto').toEqual([]);
        const vh = await innerHeight(page);
        for (const id of ['rec-confirm-yes', 'rec-confirm-no']) {
          const r = await rectOf(page.getByTestId(id));
          expect(r.top, `«${id}» queda dentro de la pantalla con el teclado abierto`).toBeGreaterThanOrEqual(0);
          expect(r.bottom, `«${id}» queda dentro de la pantalla con el teclado abierto`).toBeLessThanOrEqual(vh + 0.5);
        }
        await watchTaps(page);
        await page.getByTestId('rec-confirm-yes').tap();
        await expectSolidTap(page, 'rec-confirm-yes');
        await expect(toast(page)).toContainText('Recepción R-2 registrada: +126 kg');
        await hideKeyboard(page, phone);
      });

      await test.step('«Guardar borrador» con el proveedor enfocado', async () => {
        await goReceive(page);
        await pick(page, 'semilla');
        await setPackaging(page, 'granel');
        await typeNet(page, '25');
        await page.getByTestId('rec-supplier').fill('Rancho Sur');
        await expect(page.getByTestId('rec-supplier')).toBeFocused();
        await showKeyboard(page, phone);
        await expect(html(page)).toHaveClass(/kbd/);
        await expect(page.locator('.topbar'), 'con el teclado abierto la barra de arriba deja de estar fija y no tapa lo que se escribe').toHaveCSS('position', 'static');
        await watchTaps(page);
        await page.getByTestId('rec-save-draft').tap();
        await expectSolidTap(page, 'rec-save-draft');
        await expect(toast(page)).toContainText('Borrador guardado: no suma al inventario');
        await hideKeyboard(page, phone);
      });

      await test.step('«＋ Sumar» una pesada con el campo de la pesada enfocado', async () => {
        await pick(page, 'semilla');
        await page.getByTestId('rec-weigh-toggle').tap();
        await page.getByTestId('rec-weigh-input').fill('40');
        await expect(page.getByTestId('rec-weigh-input')).toBeFocused();
        await showKeyboard(page, phone);
        await expect(html(page)).toHaveClass(/kbd/);
        await watchTaps(page);
        await page.getByTestId('rec-weigh-add').tap();
        await expectSolidTap(page, 'rec-weigh-add');
        await expect(page.getByTestId('rec-weigh-item')).toHaveCount(1);
        await expect(page.getByTestId('rec-weigh-total')).toHaveText('1 pesada = 40 kg');
        await hideKeyboard(page, phone);
      });

      await test.step('Historial › «Guardar corrección» con el motivo enfocado', async () => {
        await subTab(page, 'historial');
        await histRow(page, 1).getByTestId('rec-correct').tap();
        await histRow(page, 1).getByTestId('rec-correct-qty').fill('95');
        await histRow(page, 1).getByTestId('rec-correct-reason').fill('Pesaje final');
        await expect(histRow(page, 1).getByTestId('rec-correct-reason')).toBeFocused();
        await showKeyboard(page, phone);
        await expect(html(page)).toHaveClass(/kbd/);
        expect(await overflowing(page), 'formulario de corrección con el teclado abierto').toEqual([]);
        await watchTaps(page);
        await histRow(page, 1).getByTestId('rec-correct-save').tap();
        await expectSolidTap(page, 'rec-correct-save');
        await expect(toast(page)).toContainText('Recepción R-1 corregida');
        await hideKeyboard(page, phone);
      });

      await test.step('Historial › «Anular recepción» con el motivo enfocado', async () => {
        await histRow(page, 1).getByTestId('rec-void').tap();
        await histRow(page, 1).getByTestId('rec-void-reason').fill('Camión equivocado');
        await expect(histRow(page, 1).getByTestId('rec-void-reason')).toBeFocused();
        await showKeyboard(page, phone);
        await expect(html(page)).toHaveClass(/kbd/);
        await watchTaps(page);
        await histRow(page, 1).getByTestId('rec-void-confirm').tap();
        await expectSolidTap(page, 'rec-void-confirm');
        await expect(toast(page)).toContainText('Recepción R-1 anulada');
        await hideKeyboard(page, phone);
      });

      // el teclado se fue: las pestañas están completas y a la vista (sin esconderse para siempre)
      await expect(html(page)).not.toHaveClass(/kbd/);
      await expectTabsIntact(page);
      const d = await readDb(page);
      expect(byStatus(d, 'anulada')).toHaveLength(1);
      expect(byStatus(d, 'borrador')).toHaveLength(1);
      expect(physicalOf(d, 'primera')).toBe(0);
      expect(auditRaw(d)).toEqual([]);
    });

    test('teclado ABIERTO · REPRODUCCIÓN del defecto original: si el modo teclado se quitara al instante al perder el foco, el primer toque en «Registrar recepción» se PERDERÍA (esta comprobación lo detecta; la app real no lo hace)', async ({
      page,
    }) => {
      await openApp(page);
      await goReceive(page);
      await pick(page, 'semilla');
      await typeNet(page, '120');
      await showKeyboard(page, phone);
      await expect(html(page)).toHaveClass(/kbd/);

      // Defecto original SIMULADO (no se toca src/): la clase `kbd` se quita en el mismo instante en que el campo pierde el foco,
      // así que la barra de registro sube 62 px bajo el dedo antes de que se levante.
      await page.evaluate(() => document.addEventListener('focusout', () => document.documentElement.classList.remove('kbd'), true));
      await watchTaps(page);
      await page.getByTestId('rec-confirm').tap();
      const tap = await lastTap(page);
      expect(tap.testid).toBe('rec-confirm');
      expect(tap.onButton, 'con el defecto, el click NO le llega al botón').toBe(false);
      expect(tap.up, 'con el defecto, el botón se movió entre poner y levantar el dedo').not.toEqual(tap.down);
      await expect(page.getByTestId('rec-sheet'), 'con el defecto, «el primer toque no hace nada»').toHaveCount(0);
      await expectNothingChanged(page, 'toque perdido');
    });

    test('teclado ABIERTO · un doble toque rápido en «Registrar recepción» solo abre la hoja: NO debe registrar sin que se vea y se confirme a propósito', async ({
      page,
    }) => {
      await openApp(page);
      await goReceive(page);
      await pick(page, 'semilla');
      await typeNet(page, '120');
      await showKeyboard(page, phone);
      await expect(html(page)).toHaveClass(/kbd/);
      const dock = await rectOf(page.getByTestId('rec-dock'));
      expect(Math.abs(dock.bottom - (await innerHeight(page)))).toBeLessThanOrEqual(1.5); // la barra bajó al borde

      const at = await centerOf(page.getByTestId('rec-confirm'));
      await doubleTapAt(page, at.x, at.y);

      // El segundo toque cae donde ahora está «Confirmar» de la hoja. Registrar así saltaría la revisión que la hoja pide.
      const d = await readDb(page);
      expect(d.receptions, 'el doble toque registró SIN que la persona viera la hoja de confirmación').toHaveLength(0);
      expect(physicalOf(d, 'semilla')).toBe(0);
      await expect(page.getByTestId('rec-sheet')).toBeVisible();
      await expect(page.getByTestId('rec-confirm-yes')).toBeVisible();
    });

    test('teclado ABIERTO · un doble toque en «Confirmar» registra UNA vez y deja el aviso de éxito (no un error encima)', async ({ page }) => {
      await openApp(page);
      await goReceive(page);
      await pick(page, 'semilla');
      await typeNet(page, '120');
      await showKeyboard(page, phone);
      await expect(html(page)).toHaveClass(/kbd/);
      await page.getByTestId('rec-confirm').tap();
      await expect(page.getByTestId('rec-confirm-yes')).toBeVisible();
      // La hoja recién abierta ignora los toques 0.45 s a propósito (protege del segundo toque de «Registrar recepción»);
      // el doble toque que se prueba aquí es el que la persona da DESPUÉS de leerla.
      await expect(page.locator('.sheet.arming')).toHaveCount(0);

      const at = await centerOf(page.getByTestId('rec-confirm-yes'));
      await doubleTapAt(page, at.x, at.y);

      const d = await readDb(page);
      expect(d.receptions, 'una sola recepción').toHaveLength(1);
      expect(physicalOf(d, 'semilla')).toBe(120000);
      // El segundo toque cae en la barra de registro (ya vacía) y lanza «Escribe los kilos netos» encima del éxito: parece que falló.
      await expect(toast(page), 'después de registrar bien no debe quedar un aviso de error').not.toHaveClass(/error/);
      await expect(toast(page)).toContainText('Recepción R-1 registrada: +120 kg');
    });

    test('un doble toque en «Guardar borrador» guarda UN solo borrador y no deja un aviso de error encima del éxito', async ({ page }) => {
      await openApp(page);
      await goReceive(page);
      await pick(page, 'semilla');
      await typeNet(page, '25');
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.getByTestId('rec-save-draft').scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, -120)); // a media pantalla, lejos de las barras fijas
      const at = await centerOf(page.getByTestId('rec-save-draft'));
      await doubleTapAt(page, at.x, at.y);

      const d = await readDb(page);
      expect(byStatus(d, 'borrador'), 'un solo borrador').toHaveLength(1);
      expect(d.stockMoves).toHaveLength(0);
      // El segundo toque cae en el formulario ya vacío y lanza «El borrador está vacío» encima del éxito: parece que falló.
      await expect(toast(page), 'después de guardar bien no debe quedar un aviso de error').not.toHaveClass(/error/);
      await expect(toast(page)).toContainText('Borrador guardado: no suma al inventario');
    });
  });
}

test.describe('Recepción · primer uso, teclado «Ir», unidades y respaldo', () => {
  test('primer uso: sin ninguna clasificación, Recepción deja darla de alta SIN precio y recibir; la caja pide el precio antes de cobrar', async ({ page }) => {
    await openApp(page, { seed: false });
    await tab(page, 'recepcion');
    await expect(page.getByTestId('rec-sin-productos')).toBeVisible();
    await expect(page.getByTestId('rec-variety')).toHaveCount(0);
    await confirmDisabled(page, true);

    await page.getByTestId('rec-new-class-toggle').click();
    const sheet = page.getByTestId('rec-newclass-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('recnew-unit')).toHaveCount(0); // aquí siempre es por kilo
    await expect(sheet.getByTestId('recnew-no-price')).toBeChecked(); // y el precio puede esperar
    await sheet.getByTestId('recnew-name').fill('Limón sin semilla');
    await expect(sheet.getByTestId('recnew-preview')).toContainText('Quedará como: Sin semilla'); // la vista previa dice lo que se GUARDA (se canoniza igual que al guardar)
    await sheet.getByTestId('recnew-add').click();
    await expect(toast(page)).toContainText('Variedad agregada');
    await expect(sheet).toBeHidden();
    // al guardar, «Limón sin semilla» se canoniza a la variedad «Sin semilla» (docs/DISENO-CLASIFICACION-RECEPCION.md §2)
    await expect(page.getByTestId('rec-selected')).toContainText('Sin semilla');
    await expect(page.getByTestId('rec-selected')).toContainText('sin precio todavía');

    await typeNet(page, '70');
    await register(page, 'Recepción R-1 registrada: +70 kg');
    await tab(page, 'inventario');
    const row = page.getByTestId('inv-row').filter({ hasText: 'Sin semilla' });
    await expect(row).toContainText('Sin precio');
    await expect(row.getByTestId('stock-physical')).toHaveText('70 kg');

    await tab(page, 'caja');
    await expect(page.getByTestId('no-price-hint')).toBeVisible();
    await page.getByTestId('kg').fill('5');
    await expect(page.getByTestId('confirm')).toBeDisabled(); // sin precio no se cobra
    await page.getByTestId('price').fill('28');
    await expect(page.getByTestId('total')).toContainText('$140.00');
    await page.getByTestId('exact').click();
    await expect(page.getByTestId('confirm')).toBeEnabled();
    const d = await readDb(page);
    expect(d.products).toHaveLength(1);
    expect(d.products[0]).toMatchObject({ name: 'Sin semilla', unit: 'kg', physicalMilli: 70000 });
    expect(auditRaw(d)).toEqual([]);
  });

  test('la tecla «Ir» (Enter) en los kilos abre la hoja si todo está completo y explica qué falta si no', async ({ page }) => {
    await openApp(page);
    await goReceive(page);
    await pick(page, 'semilla');
    await typeNet(page, '75');
    await page.getByTestId('rec-net-direct').press('Enter');
    await expect(page.getByTestId('rec-sheet-net')).toHaveAttribute('data-milli', '75000');
    await page.getByTestId('rec-confirm-no').click();
    await typeNet(page, '');
    await page.getByTestId('rec-net-direct').press('Enter');
    await expect(toast(page)).toHaveClass(/error/);
    await expect(toast(page)).toContainText('Escribe los kilos netos');
    await expect(page.getByTestId('rec-sheet')).toHaveCount(0);
    await expectNothingChanged(page, 'Enter sin kilos');
  });

  test('solo se puede recibir en clasificaciones activas que se venden por kg: las de otra unidad y las ocultas no aparecen', async ({ page }) => {
    await openApp(page);
    await tab(page, 'inventario');
    await page.getByTestId('new-name').fill('Limón embolsado');
    await page.getByTestId('new-unit').selectOption('pieza');
    await page.getByTestId('new-price').fill('12');
    await page.getByTestId('add-product').click();
    await expect(toast(page)).toContainText('Variedad agregada');
    await invRow(page, 'segunda').getByRole('button', { name: 'Ocultar' }).click();
    await expect(invRow(page, 'segunda')).toHaveClass(/inactive/);

    await goReceive(page);
    const varieties = page.getByTestId('rec-variety');
    await expect(varieties).toHaveCount(2); // «Limón persa» y «Con semilla»; no «Limón embolsado» (pieza)
    await expect(varieties.filter({ hasText: 'embolsado' })).toHaveCount(0);
    await varieties.filter({ hasText: 'Limón persa' }).click();
    // «Segunda» está oculta: «Limón persa» queda con UNA sola clasificación y se elige sola
    await expect(page.getByTestId('rec-class')).toHaveCount(0);
    await expect(page.getByTestId('rec-selected')).toContainText('Limón persa · Primera');
  });

  test('18 · el respaldo exporta e importa las recepciones (registrada, corregida, anulada y borrador) con folios y existencias en otro dispositivo, y el siguiente folio continúa (complementa el caso 18)', async ({
    page,
    browser,
  }) => {
    await openApp(page);
    await receive(page, 'primera', '100', 'Recepción R-1 registrada: +100 kg');
    await receive(page, 'segunda', '60', 'Recepción R-2 registrada: +60 kg');
    await subTab(page, 'historial');
    await histRow(page, 1).getByTestId('rec-correct').click();
    await histRow(page, 1).getByTestId('rec-correct-qty').fill('95');
    await histRow(page, 1).getByTestId('rec-correct-reason').fill('Pesaje final');
    await histRow(page, 1).getByTestId('rec-correct-save').click();
    await expect(toast(page)).toContainText('Recepción R-1 corregida');
    await histRow(page, 2).getByTestId('rec-void').click();
    await page.getByTestId('rec-void-reason').fill('Error');
    await page.getByTestId('rec-void-confirm').click();
    await expect(toast(page)).toContainText('Recepción R-2 anulada');
    await goReceive(page);
    await pick(page, 'semilla');
    await typeNet(page, '30');
    await page.getByTestId('rec-save-draft').click();
    await expect(toast(page)).toContainText('Borrador guardado');

    await tab(page, 'mas');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export').click()]);
    await expect(toast(page)).toContainText('Respaldo exportado (0 ventas, 3 recepciones)');
    const path = await dl.path();
    const backup = JSON.parse(readFileSync(path, 'utf8'));
    expect(backup.version).toBe(3); // formato actual (el 3 agregó los fletes)
    expect(backup.nextReceptionFolio).toBe(3);
    expect(backup.receptions.map((r: { status: string }) => r.status).sort()).toEqual(['anulada', 'borrador', 'confirmada']);

    const ctx = await browser.newContext({ serviceWorkers: 'allow' }); // «otro teléfono»: sin datos
    const p2 = await ctx.newPage();
    p2.on('dialog', (dlg) => dlg.accept());
    await openApp(p2, { seed: false });
    await tab(p2, 'mas');
    await p2.getByTestId('import-file').setInputFiles(path);
    await expect(p2.getByTestId('restore-sheet')).toBeVisible();
    await expect(p2.getByTestId('restore-summary')).toContainText('3 recepciones');
    await p2.getByTestId('restore-confirm').click();
    await expect(toast(p2)).toContainText('Respaldo restaurado');

    await expectStock(p2, 'primera', { physical: '95 kg', received: '95 kg' });
    await expectStock(p2, 'segunda', { physical: '0 g' });
    await expect(p2.getByTestId('menu-count')).toHaveText('1');
    await subTab(p2, 'historial');
    await expect(histRow(p2, 1).getByTestId('rec-row-net')).toHaveText('95 kg');
    await expect(histRow(p2, 1).getByTestId('rec-row-corrections')).toContainText('original 100 kg');
    await p2.getByTestId('rec-filter-anulada').click();
    await expect(histRow(p2, 2)).toContainText('Anulada: Error');
    await receive(p2, 'primera', '5', 'Recepción R-3 registrada: +5 kg'); // el folio CONTINÚA
    await tab(p2, 'mas');
    await p2.getByTestId('audit').click();
    await expect(p2.getByTestId('audit-result')).toContainText('Sin inconsistencias');
    const d = await readDb(p2);
    expect(physicalOf(d, 'primera')).toBe(100000);
    expect(auditRaw(d)).toEqual([]);
    await ctx.close();
  });
});
