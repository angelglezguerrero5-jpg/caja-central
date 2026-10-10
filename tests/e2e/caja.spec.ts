import { expect, test } from '@playwright/test';
import { charge, openApp, sellCash, tab } from './helpers';

test('caja: total, billetes, cambio, limpieza y foco tras confirmar', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('price')).toHaveValue('30');
  await page.getByTestId('kg').fill('1.5');
  await expect(page.getByTestId('total')).toContainText('$45.00');

  await page.getByTestId('bill-20').click();
  await page.getByTestId('bill-50').click();
  await expect(page.getByTestId('cash')).toHaveValue('70');
  await expect(page.getByTestId('change')).toContainText('$25.00');

  await page.getByTestId('clear-cash').click();
  await expect(page.getByTestId('confirm')).toBeDisabled(); // sin efectivo no cobra
  await page.getByTestId('exact').click();
  await expect(page.getByTestId('change')).toContainText('$0.00');
  await page.getByTestId('bill-100').click(); // 45 + 100 acumulado = 145
  await expect(page.getByTestId('change')).toContainText('$100.00');

  // Confirmación explícita: primero se ve el resumen, aún sin registrar nada.
  await page.getByTestId('confirm').click();
  await expect(page.getByTestId('sheet-total')).toHaveText('$45.00');
  await expect(page.getByTestId('sheet-change')).toContainText('$100.00');
  await page.getByTestId('authorize').click(); // sin inventario cargado pide autorización
  await expect(page.getByTestId('toast')).toContainText('Venta #1 guardada');
  await expect(page.getByTestId('kg')).toHaveValue('');
  await expect(page.getByTestId('cash')).toHaveValue('');
  await expect(page.getByTestId('price')).toHaveValue('30');
  await expect(page.getByTestId('kg')).toBeFocused();
  await expect(page.getByTestId('last-sale')).toContainText('#1');
});

test('caja: conserva la variedad elegida entre ventas', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('variety').nth(1).click();
  await expect(page.getByTestId('price')).toHaveValue('35');
  await sellCash(page, '2', [100]);
  await expect(page.getByTestId('variety').nth(1)).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('price')).toHaveValue('35');
});

test('caja: "Volver" en la confirmación no registra nada y devuelve el foco a kilos', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('kg').fill('1');
  await page.getByTestId('exact').click();
  await page.getByTestId('confirm').click();
  await page.getByTestId('confirm-no').click();
  await expect(page.getByTestId('confirm-sheet')).toHaveCount(0);
  await expect(page.getByTestId('kg')).toBeFocused();
  await expect(page.getByTestId('kg')).toHaveValue('1');
  await tab(page, 'corte');
  await expect(page.getByTestId('sale-row')).toHaveCount(0);
});

test('calidad: cada calidad conserva su propio precio y se vende con su nombre', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('quality')).toHaveCount(2); // persa: Primera / Segunda
  await expect(page.getByTestId('price')).toHaveValue('30');
  await page.getByTestId('quality').nth(1).click(); // Segunda
  await expect(page.getByTestId('price')).toHaveValue('20');
  await page.getByTestId('price').fill('22');
  await page.getByTestId('price').blur();
  await page.getByTestId('quality').nth(0).click();
  await expect(page.getByTestId('price')).toHaveValue('30'); // Primera intacta
  await page.getByTestId('quality').nth(1).click();
  await expect(page.getByTestId('price')).toHaveValue('22');
  await sellCash(page, '1', [50]);
  await tab(page, 'corte');
  await expect(page.getByTestId('sale-row').first()).toContainText('Limón persa · Segunda');
  await tab(page, 'caja');
  await page.getByTestId('variety').nth(1).click(); // Con semilla: sin calidades
  await expect(page.getByTestId('quality')).toHaveCount(0);
});

test('precio por kg editable persiste tras recargar y no cambia ventas previas', async ({ page }) => {
  await openApp(page);
  await sellCash(page, '1', [50]); // vendida a $30
  await page.getByTestId('price').fill('38.5');
  await page.getByTestId('price').blur();
  await expect(page.getByTestId('toast')).toContainText('$38.50');
  await page.reload();
  await expect(page.getByTestId('price')).toHaveValue('38.50');
  await page.getByTestId('kg').fill('2');
  await expect(page.getByTestId('total')).toContainText('$77.00');
  await tab(page, 'corte');
  await expect(page.getByTestId('sale-row').first()).toContainText('$30.00');
});

test('doble toque en confirmar no duplica la venta', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('kg').fill('1');
  await page.getByTestId('exact').click();
  await page.getByTestId('confirm').click();
  await page.getByTestId('authorize').or(page.getByTestId('confirm-yes')).dblclick();
  await expect(page.getByTestId('toast')).toContainText('guardada');
  await tab(page, 'corte');
  await expect(page.getByTestId('sale-row')).toHaveCount(1);
});

test('pago con transferencia no pide efectivo', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('method-transferencia').click();
  await expect(page.getByTestId('cash')).toHaveCount(0);
  await page.getByTestId('kg').fill('3');
  await charge(page);
  await tab(page, 'corte');
  await expect(page.getByTestId('r-total')).toContainText('$90.00');
  await expect(page.getByTestId('r-efectivo')).toContainText('$0.00');
});
