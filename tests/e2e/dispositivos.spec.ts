import { expect, test } from '@playwright/test';
import { charge, openApp, sellCash, tab } from './helpers';
import { readDb } from './helpers-android';
import { openFletes, rawFreights, saveFlete } from './helpers-fletes';
import { captureDownload } from './helpers-migracion';

/**
 * AISLAMIENTO ENTRE DISPOSITIVOS Y RED (evidencia de docs/ARQUITECTURA-COMPARTIDA.md, sección 1).
 * Dos «teléfonos» son dos perfiles de navegador distintos (almacenamiento separado) abiertos en la MISMA dirección. Chromium emulando:
 * no es un teléfono físico, pero el aislamiento por perfil/origen es la misma regla que aplican Safari y Chrome en el teléfono.
 */

test.describe('Dispositivos y red', () => {
  test('dos teléfonos abiertos en la misma dirección NO comparten datos, y por eso pueden repetir un folio de flete', async ({ page, browser }) => {
    test.setTimeout(90_000);
    await openApp(page); // teléfono A, con sus variedades
    await sellCash(page, '2', [100]);
    await openFletes(page);
    await saveFlete(page, { folio: 'MISMO-1', origin: 'Apatzingán', destination: 'CDMX', initial: { mode: 'directo', net: '15000' }, final: { mode: 'directo', net: '14760' } });
    const a = await readDb(page);
    expect(a.sales).toHaveLength(1);
    expect(a.products.length).toBeGreaterThan(0);

    const phoneB = await browser.newContext({ baseURL: test.info().project.use.baseURL, serviceWorkers: 'allow' });
    try {
      const b = await phoneB.newPage();
      await b.goto('/');
      await expect(b.getByTestId('caja-vacia')).toBeVisible(); // B no tiene ni las variedades de A
      const dbB = await readDb(b);
      expect([dbB.sales.length, dbB.products.length, dbB.receptions.length, dbB.stockMoves.length, dbB.shifts.length]).toEqual([0, 0, 0, 0, 0]);
      expect(await rawFreights(b)).toEqual([]);
      await openFletes(b);
      await expect(b.getByTestId('fl-row')).toHaveCount(0);

      // B captura el MISMO folio que A: nada se lo impide (la unicidad del folio es solo dentro de un teléfono)
      await saveFlete(b, { folio: 'MISMO-1', origin: 'Uruapan', destination: 'Toluca', initial: { mode: 'directo', net: '9000' } });
      expect((await rawFreights(b)).map((f) => [f.folio, f.origin])).toEqual([['MISMO-1', 'Uruapan']]);
      expect((await rawFreights(page)).map((f) => [f.folio, f.origin])).toEqual([['MISMO-1', 'Apatzingán']]); // A, intacto
      expect((await readDb(page)).sales).toHaveLength(1);
      expect((await readDb(b)).sales).toHaveLength(0);
    } finally {
      await phoneB.close();
    }
  });

  test('la app no habla con ningún servidor: vender, hacer un vale, capturar un flete, respaldar y auditar solo piden archivos estáticos con GET del propio sitio', async ({ page, context }) => {
    test.setTimeout(90_000);
    const seen: Array<{ method: string; url: string; hasBody: boolean }> = [];
    context.on('request', (r) => seen.push({ method: r.method(), url: r.url(), hasBody: r.postData() !== null }));

    await openApp(page);
    await sellCash(page, '2', [100]);
    await page.getByTestId('kg').fill('1');
    await page.getByTestId('exact').click();
    await page.getByTestId('is-vale').check();
    await page.getByTestId('customer').fill('Cliente de prueba');
    await charge(page);
    await openFletes(page);
    await saveFlete(page, { folio: 'RED-1', origin: 'a', destination: 'b', initial: { mode: 'directo', net: '1000' }, final: { mode: 'directo', net: '990' } });
    await tab(page, 'mas');
    const file = await captureDownload(page, () => page.getByTestId('export').click());
    expect(file.json.freights).toHaveLength(1);
    await page.getByTestId('audit').click();
    await expect(page.getByTestId('audit-result')).toContainText('Sin inconsistencias');
    await page.reload();
    await expect(page.getByTestId('caja')).toBeVisible();

    const origin = new URL(page.url()).origin;
    const real = seen.filter((r) => !/^(blob|data):/.test(r.url));
    expect(real.length, 'se registraron peticiones').toBeGreaterThan(3);
    expect(real.filter((r) => !r.url.startsWith(`${origin}/`)), 'ninguna petición sale del sitio').toEqual([]);
    expect(real.filter((r) => r.method !== 'GET'), 'ninguna petición que no sea GET (nada se envía)').toEqual([]);
    expect(real.filter((r) => r.hasBody), 'ninguna petición lleva datos').toEqual([]);
    for (const path of new Set(real.map((r) => new URL(r.url).pathname))) {
      expect(path, `petición inesperada: ${path}`).toMatch(/^\/($|index\.html$|sw\.js$|manifest\.webmanifest$|assets\/[\w.-]+\.(js|css)$|icons\/[\w-]+\.png$)/);
    }
    for (const r of real) expect(new URL(r.url).search, `la dirección no lleva datos en la consulta: ${r.url}`).toBe('');
  });
});
