import { expect, test } from '@playwright/test';
import { addStock, openApp, sellCash, tab } from './helpers';
import { readFileSync } from 'node:fs';

test('inventario: físico, reservado y disponible; vale reserva y entrega sin cobrar dos veces', async ({ page }) => {
  await openApp(page);
  await addStock(page, 0, '100');
  const row = page.getByTestId('inv-row').first();
  await expect(row.getByTestId('stock-physical')).toHaveText('100 kg');
  await expect(row.getByTestId('stock-available')).toHaveText('100 kg');

  // Venta normal de 10 kg
  await tab(page, 'caja');
  await sellCash(page, '10', [500]);

  // Vale: 20 kg pagados en efectivo exacto, entrega pendiente
  await page.getByTestId('kg').fill('20');
  await page.getByTestId('exact').click();
  await page.getByTestId('is-vale').check();
  await page.getByTestId('customer').fill('Doña Mary');
  await page.getByTestId('confirm').click();
  await expect(page.getByTestId('toast')).toContainText('Venta #2');
  await expect(page.getByTestId('last-sale')).toContainText('VALE');

  await tab(page, 'inventario');
  await expect(row.getByTestId('stock-physical')).toHaveText('90 kg');
  await expect(row.getByTestId('stock-reserved')).toHaveText('20 kg');
  await expect(row.getByTestId('stock-available')).toHaveText('70 kg');

  await tab(page, 'corte');
  await expect(page.getByTestId('r-expected')).toContainText('$900.00'); // 300 + 600
  await expect(page.getByTestId('r-total')).toContainText('$900.00');

  await tab(page, 'vales');
  await expect(page.getByTestId('vale')).toHaveCount(1);
  await expect(page.getByTestId('vale')).toContainText('Doña Mary');
  await page.getByTestId('deliver').click();
  await expect(page.getByTestId('vale')).toHaveCount(0);

  await tab(page, 'inventario');
  await expect(row.getByTestId('stock-physical')).toHaveText('70 kg');
  await expect(row.getByTestId('stock-reserved')).toHaveText('0 g');
  await expect(row.getByTestId('stock-available')).toHaveText('70 kg');

  await tab(page, 'corte');
  await expect(page.getByTestId('r-expected')).toContainText('$900.00'); // entregar no suma dinero
  await expect(page.getByTestId('r-total')).toContainText('$900.00');
});

test('corte: fondo, salida, cierre con diferencia y turno nuevo', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await openApp(page);
  await tab(page, 'corte');
  await page.getByTestId('opening').fill('200');
  await page.getByTestId('open-shift').click();
  await expect(page.getByTestId('r-expected')).toContainText('$200.00');

  await tab(page, 'caja');
  await sellCash(page, '1', [50]); // +30 efectivo
  await tab(page, 'corte');
  await page.getByTestId('out-amount').fill('10');
  await page.getByTestId('out-concept').fill('bolsas');
  await page.getByTestId('out-save').click();
  await expect(page.getByTestId('r-expected')).toContainText('$220.00');

  await page.getByTestId('counted').fill('215');
  await expect(page.getByTestId('diff')).toContainText('Faltan $5.00');
  await page.getByTestId('close-shift').click();
  await expect(page.getByTestId('toast')).toContainText('Turno cerrado');
  await expect(page.getByTestId('closed-shift')).toContainText('dif -$5.00');
  await expect(page.getByTestId('open-shift')).toBeVisible();
});

test('respaldo: exportar, borrar datos y restaurar recupera ventas y folio', async ({ page, browser }) => {
  await openApp(page);
  await sellCash(page, '1', [50]);
  await sellCash(page, '2', [100]);
  await tab(page, 'mas');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export').click()]);
  const path = await dl.path();
  const backup = JSON.parse(readFileSync(path, 'utf8'));
  expect(backup.sales).toHaveLength(2);
  expect(backup.nextFolio).toBe(3);

  // Dispositivo "nuevo": contexto limpio sin datos
  const ctx = await browser.newContext({ serviceWorkers: 'allow' });
  const p2 = await ctx.newPage();
  p2.on('dialog', (d) => d.accept());
  await openApp(p2);
  await tab(p2, 'mas');
  await p2.getByTestId('import-file').setInputFiles(path);
  await expect(p2.getByTestId('toast')).toContainText('restaurado');
  await tab(p2, 'corte');
  await expect(p2.getByTestId('sale-row')).toHaveCount(2);
  await tab(p2, 'caja');
  await sellCash(p2, '1', [50]);
  await expect(p2.getByTestId('last-sale')).toContainText('#3');
  await ctx.close();
});

test('respaldo inválido no borra datos', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await openApp(page);
  await sellCash(page, '1', [50]);
  await tab(page, 'mas');
  await page.getByTestId('import-file').setInputFiles({
    name: 'malo.json', mimeType: 'application/json', buffer: Buffer.from('{"app":"otra"}'),
  });
  await expect(page.getByTestId('toast')).toContainText('no es un respaldo válido');
  await tab(page, 'corte');
  await expect(page.getByTestId('sale-row')).toHaveCount(1);
});
