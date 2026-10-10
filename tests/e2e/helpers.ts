import { expect, type Page } from '@playwright/test';

/** Abre la app, espera a que el service worker controle la página. */
export async function openApp(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('caja')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((r) => navigator.serviceWorker.addEventListener('controllerchange', () => r(), { once: true }));
    }
  });
}

export const tab = (page: Page, name: 'caja' | 'vales' | 'inventario' | 'corte' | 'mas') =>
  page.getByTestId(`tab-${name}`).click();

/** Venta en efectivo con billetes: devuelve tras ver el toast de guardado. */
export async function sellCash(page: Page, kg: string, bills: number[]) {
  await page.getByTestId('kg').fill(kg);
  for (const b of bills) await page.getByTestId(`bill-${b}`).click();
  await charge(page);
}

/** Cobrar: abre la hoja de confirmación y confirma. */
export async function charge(page: Page) {
  await page.getByTestId('confirm').click();
  await expect(page.getByTestId('confirm-sheet')).toBeVisible();
  await page.getByTestId('confirm-yes').click();
  await expect(page.getByTestId('toast')).toContainText('guardada');
}

export async function addStock(page: Page, productIndex: number, kg: string) {
  await tab(page, 'inventario');
  const row = page.getByTestId('inv-row').nth(productIndex);
  await row.getByTestId('move-entrada').click();
  await row.getByTestId('move-qty').fill(kg);
  await row.getByTestId('move-save').click();
  await expect(page.getByTestId('toast')).toContainText('Entrada registrada');
}
