import { expect, test } from '@playwright/test';
import { addStock, charge, openApp, sellCash, tab } from './helpers';
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
  await charge(page);
  await expect(page.getByTestId('toast')).toContainText('Venta #2');
  await expect(page.getByTestId('last-sale')).toContainText('VALE V-1');

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
  await page.getByTestId('deliver').dblclick(); // doble pulsación: se entrega una sola vez
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

test('existencias: sin disponible suficiente exige autorización explícita; con inventario no', async ({ page }) => {
  await openApp(page);
  await addStock(page, 0, '5');

  // 3 kg con 5 disponibles: confirmación normal, sin advertencia
  await page.getByTestId('tab-caja').click();
  await page.getByTestId('kg').fill('3');
  await page.getByTestId('exact').click();
  await page.getByTestId('confirm').click();
  await expect(page.getByTestId('stock-warning')).toHaveCount(0);
  await page.getByTestId('confirm-yes').click();
  await expect(page.getByTestId('toast')).toContainText('guardada');

  // 4 kg con 2 disponibles: advertencia y botón de autorización; "Volver" no vende
  await page.getByTestId('kg').fill('4');
  await page.getByTestId('exact').click();
  await page.getByTestId('confirm').click();
  await expect(page.getByTestId('stock-warning')).toBeVisible();
  await expect(page.getByTestId('confirm-yes')).toHaveCount(0);
  await page.getByTestId('confirm-no').click();
  await tab(page, 'inventario');
  await expect(page.getByTestId('stock-available').first()).toHaveText('2 kg');

  // Autorizar: vende y deja la existencia en negativo, visible
  await tab(page, 'caja'); // al cambiar de pestaña la caja se reinicia
  await page.getByTestId('kg').fill('4');
  await page.getByTestId('exact').click();
  await page.getByTestId('confirm').click();
  await page.getByTestId('authorize').click();
  await expect(page.getByTestId('toast')).toContainText('guardada');
  await tab(page, 'inventario');
  await expect(page.getByTestId('stock-available').first()).toHaveText('-2 kg');
});

test('inventario: mermas y ajustes exigen motivo y quedan en el historial de movimientos', async ({ page }) => {
  await openApp(page);
  await addStock(page, 0, '20');
  const row = page.getByTestId('inv-row').first();
  await row.getByTestId('move-merma').click();
  await row.getByTestId('move-qty').fill('2');
  await expect(row.getByTestId('move-save')).toBeDisabled(); // sin motivo
  await row.getByTestId('move-note').fill('se echó a perder');
  await row.getByTestId('move-save').click();
  await expect(row.getByTestId('stock-physical')).toHaveText('18 kg');
  await row.getByTestId('show-moves').click();
  await expect(row.getByTestId('moves-list')).toContainText('merma');
  await expect(row.getByTestId('moves-list')).toContainText('se echó a perder');
  await expect(row.getByTestId('moves-list')).toContainText('entrada');
});

test('vale: cancelar exige motivo y decidir qué pasa con el dinero; devolución en efectivo sale de caja', async ({ page }) => {
  await openApp(page);
  await addStock(page, 0, '50');
  await tab(page, 'caja');
  await page.getByTestId('kg').fill('10');
  await page.getByTestId('exact').click();
  await page.getByTestId('is-vale').check();
  await charge(page); // $300 cobrados

  await tab(page, 'corte');
  await expect(page.getByTestId('r-expected')).toContainText('$300.00');

  await tab(page, 'vales');
  await page.getByTestId('cancel-vale').click();
  await expect(page.getByTestId('cancel-confirm')).toBeDisabled();
  await page.getByTestId('cancel-reason').fill('cliente no vino');
  await expect(page.getByTestId('cancel-confirm')).toBeDisabled(); // falta decidir el dinero
  await page.getByTestId('refund-efectivo').check();
  await page.getByTestId('cancel-confirm').click();
  await expect(page.getByTestId('toast')).toContainText('cancelado');
  await expect(page.getByTestId('vale')).toHaveCount(0);

  await page.getByTestId('vales-cancelado').click();
  await expect(page.getByTestId('cancel-info')).toContainText('cliente no vino');
  await expect(page.getByTestId('cancel-info')).toContainText('EFECTIVO');
  await expect(page.getByTestId('deliver')).toHaveCount(0);

  await tab(page, 'inventario');
  const row = page.getByTestId('inv-row').first();
  await expect(row.getByTestId('stock-reserved')).toHaveText('0 g');
  await expect(row.getByTestId('stock-physical')).toHaveText('50 kg');

  await tab(page, 'corte');
  await expect(page.getByTestId('r-refunds')).toContainText('$300.00');
  await expect(page.getByTestId('r-expected')).toContainText('$0.00'); // entró y salió
});

test('vale: cancelar SIN devolver dinero no altera el efectivo esperado', async ({ page }) => {
  await openApp(page);
  await tab(page, 'caja');
  await page.getByTestId('kg').fill('1');
  await page.getByTestId('exact').click();
  await page.getByTestId('is-vale').check();
  await charge(page);
  await tab(page, 'vales');
  await page.getByTestId('cancel-vale').click();
  await page.getByTestId('cancel-reason').fill('error');
  await page.getByTestId('refund-ninguna').check();
  await page.getByTestId('cancel-confirm').click();
  await tab(page, 'corte');
  await expect(page.getByTestId('r-refunds')).toContainText('$0.00');
  await expect(page.getByTestId('r-expected')).toContainText('$30.00');
});

test('vale entregado no puede canjearse otra vez', async ({ page }) => {
  await openApp(page);
  await tab(page, 'caja');
  await page.getByTestId('kg').fill('1');
  await page.getByTestId('exact').click();
  await page.getByTestId('is-vale').check();
  await charge(page);
  await tab(page, 'vales');
  await page.getByTestId('deliver').click();
  await page.getByTestId('vales-entregado').click();
  await expect(page.getByTestId('vale')).toHaveCount(1);
  await expect(page.getByTestId('deliver')).toHaveCount(0);
  await expect(page.getByTestId('cancel-vale')).toHaveCount(0);
  await page.getByTestId('vales-pendiente').click();
  await expect(page.getByTestId('vale')).toHaveCount(0);
});

test('historial: consulta ventas por día con su estado; auditoría de integridad sin problemas', async ({ page }) => {
  await openApp(page);
  await addStock(page, 0, '50');
  await tab(page, 'caja');
  await sellCash(page, '2', [100]);
  await page.getByTestId('kg').fill('5');
  await page.getByTestId('exact').click();
  await page.getByTestId('is-vale').check();
  await charge(page);

  await tab(page, 'mas');
  await expect(page.getByTestId('hist-row')).toHaveCount(2);
  await expect(page.getByTestId('hist-summary')).toContainText('2 ventas · $210.00');
  await expect(page.getByTestId('hist-row').first()).toContainText('VALE V-1 · PENDIENTE');
  await expect(page.getByTestId('hist-row').nth(1)).toContainText('Entregada');

  await page.getByTestId('hist-day').fill('2020-01-01');
  await expect(page.getByTestId('hist-row')).toHaveCount(0);
  await expect(page.getByTestId('hist-summary')).toContainText('0 ventas');

  await page.getByTestId('audit').click();
  await expect(page.getByTestId('audit-result')).toContainText('Sin inconsistencias');
  await expect(page.getByTestId('storage-state')).toContainText('Almacenamiento');
});
