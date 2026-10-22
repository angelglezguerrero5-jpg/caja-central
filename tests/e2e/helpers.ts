import { expect, type Page } from '@playwright/test';

/** Variedades de prueba. La app NO trae ninguna: cada prueba las da de alta por la interfaz. */
export const TEST_VARIETIES = [
  { name: 'Limón persa', quality: 'Primera', price: '30' },
  { name: 'Limón persa', quality: 'Segunda', price: '20' },
  { name: 'Limón con semilla', quality: '', price: '35' },
];

async function addVariety(page: Page, v: { name: string; quality: string; price: string }) {
  const form = page.locator('[data-testid="new-variety"]:visible');
  await form.getByTestId('new-name').fill(v.name);
  await form.getByTestId('new-quality').fill(v.quality);
  await form.getByTestId('new-price').fill(v.price);
  await form.getByTestId('add-product').click();
  await expect(page.getByTestId('toast')).toContainText('Producto agregado');
}

/** Primera variedad desde el estado vacío de la caja; el resto desde Inventario. */
export async function seedVarieties(page: Page) {
  await expect(page.getByTestId('caja-vacia')).toBeVisible();
  await addVariety(page, TEST_VARIETIES[0]);
  await page.getByTestId('tab-inventario').click();
  for (const v of TEST_VARIETIES.slice(1)) await addVariety(page, v);
  await page.getByTestId('tab-caja').click();
  await expect(page.getByTestId('kg')).toBeVisible();
}

/** Abre la app, espera a que el service worker controle la página y (por defecto) da de alta las variedades de prueba. */
export async function openApp(page: Page, opts: { seed?: boolean } = {}) {
  await page.goto('/');
  await expect(page.getByTestId('caja')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((r) => navigator.serviceWorker.addEventListener('controllerchange', () => r(), { once: true }));
    }
  });
  if (opts.seed ?? true) await seedVarieties(page);
}

/** Pestañas de arriba (caja, vales, inventario, corte) y opciones del menú de los tres puntos (recepción, más). */
export const tab = async (page: Page, name: 'caja' | 'vales' | 'recepcion' | 'inventario' | 'corte' | 'mas') => {
  if (name === 'recepcion' || name === 'mas') {
    await page.getByTestId('menu-btn').click();
    await page.getByTestId(`menu-${name}`).click();
    return;
  }
  await page.getByTestId(`tab-${name}`).click();
};

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
  // Sin inventario cargado la hoja pide autorización explícita en vez de "Confirmar".
  const authorize = page.getByTestId('authorize');
  if (await authorize.count()) await authorize.click();
  else await page.getByTestId('confirm-yes').click();
  await expect(page.getByTestId('toast')).toContainText('guardada');
}

export async function addStock(page: Page, productIndex: number, kg: string) {
  await tab(page, 'inventario');
  const row = page.getByTestId('inv-row').nth(productIndex);
  await row.getByTestId('move-entrada').click();
  await row.getByTestId('move-qty').fill(kg);
  await row.getByTestId('move-save').click();
  await expect(page.getByTestId('toast')).toContainText('Entrada manual registrada');
}
