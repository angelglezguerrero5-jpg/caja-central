import { expect, test } from '@playwright/test';
import { openApp, sellCash, tab } from './helpers';

test('PWA instalable: manifest, íconos y service worker activo', async ({ page, request }) => {
  await openApp(page);
  const res = await request.get('/manifest.webmanifest');
  expect(res.ok()).toBeTruthy();
  const m = await res.json();
  expect(m.display).toBe('standalone');
  expect(m.start_url).toBe('/');
  const sizes = m.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes}/${i.purpose}`);
  expect(sizes).toEqual(expect.arrayContaining(['192x192/any', '512x512/any', '512x512/maskable']));
  for (const i of m.icons) expect((await request.get(i.src)).ok()).toBeTruthy();
  await expect(page.locator('link[rel=manifest]')).toHaveCount(1);
  const active = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state);
  expect(active).toBe('activated');
});

test('modo avión: abre, vende, recarga y recupera registros sin internet', async ({ page, context }) => {
  await openApp(page);
  await sellCash(page, '1', [50]); // venta #1 con red

  await context.setOffline(true);
  await page.reload(); // la app debe cargar desde caché
  await expect(page.getByTestId('caja')).toBeVisible();
  await expect(page.getByTestId('net')).toContainText('Sin internet');

  await sellCash(page, '2', [100]); // venta #2 sin red
  await page.reload();
  await sellCash(page, '1.5', [50]); // venta #3 tras recargar sin red

  await tab(page, 'corte');
  await expect(page.getByTestId('sale-row')).toHaveCount(3);
  await expect(page.getByTestId('r-total')).toContainText('$135.00'); // 30 + 60 + 45

  await context.setOffline(false);
  await page.reload();
  await tab(page, 'corte');
  await expect(page.getByTestId('sale-row')).toHaveCount(3); // persisten al volver la red
});

test('los registros sobreviven al cerrar y reabrir la app (mismo perfil)', async ({ browser }) => {
  const ctx = await browser.newContext({ serviceWorkers: 'allow' });
  const p1 = await ctx.newPage();
  await openApp(p1);
  await sellCash(p1, '1', [50]);
  await p1.close(); // equivale a cerrar la pestaña/app

  const p2 = await ctx.newPage();
  await p2.goto('/');
  await tab(p2, 'corte');
  await expect(p2.getByTestId('sale-row')).toHaveCount(1);
  await expect(p2.getByTestId('r-total')).toContainText('$30.00');
  await ctx.close();
});
