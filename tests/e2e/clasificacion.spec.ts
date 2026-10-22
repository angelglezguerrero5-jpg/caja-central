import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { tab } from './helpers';
import {
  addClass,
  addForm,
  addStock,
  cancelVale,
  chipTexts,
  deliverVale,
  exact as exactText,
  errorToastsSince,
  expectIdentity,
  expectNewToast,
  expectSolidTap,
  expectStock,
  fillForm,
  hideKeyboard,
  invLabels,
  invRow,
  invRows,
  labelOf,
  moveStock,
  newDevice,
  norm,
  open,
  openEdit,
  overflowing,
  patchForm,
  PHONES,
  pickClass,
  pickVariety,
  readRow,
  runAudit,
  selectInCaja,
  sellKg,
  setHidden,
  showKeyboard,
  snapshotInventory,
  toastCount,
  tryAddClass,
  watchTaps,
  chipText as chipTextRe,
  type ClassSpec,
} from './helpers-clasificacion';

/**
 * Catálogo clasificado + inventario/ventas por clasificación (casos 1–7, 14, 15, 16 y 25 del cliente, más: sin campos
 * forzados, sin duplicados accidentales y sin equivalencias inventadas).
 *
 * Todo se hace por la interfaz, en un contexto de Playwright aislado (IndexedDB propia por prueba). La app no trae
 * variedades, precios ni existencias: cada prueba crea las suyas. «Limón con semilla» se muestra como «Con semilla» (nombre
 * canónico, ver docs/DISENO-CLASIFICACION-RECEPCION.md).
 */

const SIN = 'Sin semilla';
const CON = 'Con semilla';

/** Cobra con la forma de pago ya elegida (tarjeta: no hay efectivo que capturar) y devuelve el folio. */
async function cobrarConTarjeta(page: Page): Promise<number> {
  await page.getByTestId('confirm').click();
  await expect(page.getByTestId('confirm-sheet')).toBeVisible();
  const n = await toastCount(page);
  await page.getByTestId('authorize').or(page.getByTestId('confirm-yes')).click();
  const text = await expectNewToast(page, n, /Venta #\d+ guardada/);
  return Number(text.match(/#(\d+)/)![1]);
}

/** Chip de una fila del formulario de alta/edición (la fila se identifica por su `data-testid`). */
const chipIn = (form: Locator, row: 'variety' | 'origin' | 'quality' | 'size' | 'caliber', name: string, prefix = 'new') =>
  form.getByTestId(`${prefix}-chips-${row}`).getByRole('radio', { name, exact: true });

const radioTexts = async (form: Locator, row: string, prefix = 'new') =>
  (await form.getByTestId(`${prefix}-chips-${row}`).getByRole('radio').allInnerTexts()).map(norm);

async function expectNoneChecked(form: Locator, row: string) {
  const radios = form.getByTestId(`new-chips-${row}`).getByRole('radio');
  const n = await radios.count();
  for (let i = 0; i < n; i++) {
    await expect(radios.nth(i), `chip «${norm(await radios.nth(i).innerText())}» de ${row} no debe estar marcado`).toHaveAttribute('aria-checked', 'false');
  }
}

// =============================================================================================================
// A · Alta por la interfaz (casos 1–7)
// =============================================================================================================

test.describe('Catálogo clasificado · alta por la interfaz', () => {
  test('atajos del formulario: solo los confirmados por el negocio, sin «Torreones» ni equivalencias inventadas', async ({ page }) => {
    await open(page);
    await tab(page, 'inventario');
    const form = addForm(page);
    expect(await radioTexts(form, 'variety')).toEqual([SIN, CON]);
    expect(await radioTexts(form, 'origin')).toEqual(['Oaxaca', 'Michoacán', 'No especificada']);
    expect(await radioTexts(form, 'quality')).toEqual(['Primera', 'Segunda', 'Tercera', 'Sin clasificar']);
    expect(await radioTexts(form, 'size')).toEqual(['1X', '2X', '3X']);
    expect(await radioTexts(form, 'caliber')).toEqual(['200', '300', '400', '500', 'No especificado']);
    // Al abrir NO hay nada elegido por sí solo, salvo los «No especificado/a» (campo vacío).
    await expectNoneChecked(form, 'variety');
    await expect(chipIn(form, 'origin', 'No especificada')).toHaveAttribute('aria-checked', 'true');
    await expect(chipIn(form, 'quality', 'Sin clasificar')).toHaveAttribute('aria-checked', 'true');
    await expect(chipIn(form, 'caliber', 'No especificado')).toHaveAttribute('aria-checked', 'true');
    for (const id of ['name', 'origin', 'quality', 'caliber', 'price']) await expect(form.getByTestId(`new-${id}`)).toHaveValue('');
    await expect(form.getByTestId('new-preview')).toHaveCount(0);
    // La ayuda aclara que son listas distintas y no hay equivalencia.
    await expect(form).toContainText('Los tamaños (1X, 2X, 3X) y los calibres (200 a 500) son listas distintas');
    // «Torreones» solo aparece en el texto de ayuda como EJEMPLO de nombre propio; no hay ningún atajo con ese nombre.
    await expect(form.getByRole('radio', { name: /torreones/i })).toHaveCount(0);
    await expect(form.getByRole('button', { name: /torreones/i })).toHaveCount(0);
  });

  test('caso 1 y 2 · alta de «Sin semilla» y «Con semilla» con los chips: etiqueta en vista previa, Inventario y Caja', async ({ page }) => {
    await open(page);
    // Primer arranque: el formulario está en la Caja vacía.
    const empty = page.getByTestId('caja-vacia');
    const first = empty.getByTestId('new-variety');
    await chipIn(first, 'variety', SIN).click();
    await expect(first.getByTestId('new-name')).toHaveValue(SIN);
    await expect(first.getByTestId('new-preview')).toHaveText(`Quedará como: ${SIN}`);
    await first.getByTestId('new-price').fill('28');
    let n = await toastCount(page);
    await first.getByTestId('add-product').click();
    await expectNewToast(page, n, 'Variedad agregada');
    await expect(page.getByTestId('caja-vacia')).toHaveCount(0);
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${SIN}`);
    await expect(page.getByTestId('price')).toHaveValue('28');

    // Segunda variedad desde Inventario.
    await tab(page, 'inventario');
    const form = addForm(page);
    await chipIn(form, 'variety', CON).click();
    await expect(form.getByTestId('new-preview')).toHaveText(`Quedará como: ${CON}`);
    await form.getByTestId('new-price').fill('33');
    n = await toastCount(page);
    await form.getByTestId('add-product').click();
    await expectNewToast(page, n, 'Variedad agregada');

    expect(await invLabels(page)).toEqual([SIN, CON]);
    await expect(invRow(page, SIN).locator('header span')).toHaveText('$28.00/kg');
    await expect(invRow(page, CON).locator('header span')).toHaveText('$33.00/kg');
    await expectStock(invRow(page, SIN), { physical: '0 g', reserved: '0 g', available: '0 g' });

    await tab(page, 'caja');
    expect(await chipTexts(page, 'variety')).toEqual([SIN, CON]);
    await expect(page.getByTestId('quality')).toHaveCount(0); // una sola clasificación por variedad: no hay segundo nivel
    await pickVariety(page, CON);
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${CON}`);
    await expect(page.getByTestId('price')).toHaveValue('33');
  });

  test('caso 3 · procedencia Oaxaca y Michoacán (chips) y otra escrita (Veracruz): no cambian calidad ni precio y cada una conserva el suyo', async ({ page }) => {
    await open(page);
    await tab(page, 'inventario');
    const form = addForm(page);

    // Oaxaca por chip
    await chipIn(form, 'origin', 'Oaxaca').click();
    await form.getByTestId('new-name').fill(CON);
    await expect(form.getByTestId('new-origin')).toHaveValue('Oaxaca');
    await expect(form.getByTestId('new-quality'), 'elegir Oaxaca no debe rellenar la calidad').toHaveValue('');
    await expect(form.getByTestId('new-caliber'), 'elegir Oaxaca no debe rellenar el calibre').toHaveValue('');
    await expect(form.getByTestId('new-preview')).toHaveText(`Quedará como: ${CON} · Oaxaca`);
    await form.getByTestId('new-price').fill('25');
    let n = await toastCount(page);
    await form.getByTestId('add-product').click();
    await expectNewToast(page, n, 'Variedad agregada');

    // Michoacán escrito sin acento y en minúsculas → se guarda con la ortografía del catálogo
    await addClass(page, { name: CON, origin: 'michoacan', price: '28' });
    // Una procedencia que no es preset
    await addClass(page, { name: CON, origin: 'Veracruz', price: '30.5' });

    expect(await invLabels(page)).toEqual([`${CON} · Oaxaca`, `${CON} · Michoacán`, `${CON} · Veracruz`]);
    await expect(invRow(page, `${CON} · Oaxaca`).locator('header span')).toHaveText('$25.00/kg');
    await expect(invRow(page, `${CON} · Michoacán`).locator('header span')).toHaveText('$28.00/kg');
    await expect(invRow(page, `${CON} · Veracruz`).locator('header span')).toHaveText('$30.50/kg');
    // Ninguna lleva calidad ni calibre deducidos de la procedencia.
    for (const l of await invLabels(page)) expect(l.split(' · ')).toHaveLength(2);

    // Caja: una variedad, tres procedencias como segundo nivel; cada una con su precio.
    await tab(page, 'caja');
    expect(await chipTexts(page, 'variety')).toEqual([CON]);
    expect(await chipTexts(page, 'quality')).toEqual(['Oaxaca', 'Michoacán', 'Veracruz']);
    await pickClass(page, 'Michoacán');
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${CON} · Michoacán`);
    await expect(page.getByTestId('price')).toHaveValue('28');
    await pickClass(page, 'Veracruz');
    await expect(page.getByTestId('price')).toHaveValue('30.50');
    await pickClass(page, 'Oaxaca');
    await expect(page.getByTestId('price')).toHaveValue('25');
  });

  test('caso 4 · tamaños 1X, 2X y 3X: cada uno es una clasificación aparte y elegirlo NO rellena ningún calibre numérico', async ({ page }) => {
    await open(page);
    await tab(page, 'inventario');
    const form = addForm(page);
    await form.getByTestId('new-name').fill(SIN);

    await chipIn(form, 'size', '2X').click();
    await expect(form.getByTestId('new-caliber')).toHaveValue('2X');
    await expect(chipIn(form, 'size', '2X')).toHaveAttribute('aria-checked', 'true');
    await expectNoneChecked(form, 'caliber'); // ni 200, 300, 400, 500 ni «No especificado»
    await expect(form.getByTestId('new-preview')).toHaveText(`Quedará como: ${SIN} · 2X`);
    // Escoger un número reemplaza el tamaño (es el MISMO campo de texto) y no marca ningún tamaño.
    await chipIn(form, 'caliber', '300').click();
    await expect(form.getByTestId('new-caliber')).toHaveValue('300');
    await expectNoneChecked(form, 'size');
    // Volver a tocar el chip marcado lo quita.
    await chipIn(form, 'caliber', '300').click();
    await expect(form.getByTestId('new-caliber')).toHaveValue('');
    // Y «No especificado» deja el campo vacío.
    await chipIn(form, 'size', '3X').click();
    await chipIn(form, 'caliber', 'No especificado').click();
    await expect(form.getByTestId('new-caliber')).toHaveValue('');
    for (const f of ['origin', 'quality']) await expect(form.getByTestId(`new-${f}`), `${f} debe seguir vacío`).toHaveValue('');

    // Alta de los tres tamaños, cada uno con su precio.
    await chipIn(form, 'size', '1X').click();
    await form.getByTestId('new-price').fill('18');
    let n = await toastCount(page);
    await form.getByTestId('add-product').click();
    await expectNewToast(page, n, 'Variedad agregada');
    await chipIn(form, 'size', '2X').click();
    await form.getByTestId('new-price').fill('25');
    await form.getByTestId('new-name').fill(SIN);
    n = await toastCount(page);
    await form.getByTestId('add-product').click();
    await expectNewToast(page, n, 'Variedad agregada');
    await addClass(page, { name: SIN, caliber: '3X', price: '32' });

    expect(await invLabels(page)).toEqual([`${SIN} · 1X`, `${SIN} · 2X`, `${SIN} · 3X`]);
    await expect(invRow(page, `${SIN} · 1X`).locator('header span')).toHaveText('$18.00/kg');
    await expect(invRow(page, `${SIN} · 2X`).locator('header span')).toHaveText('$25.00/kg');
    await expect(invRow(page, `${SIN} · 3X`).locator('header span')).toHaveText('$32.00/kg');
    // La etiqueta de un tamaño no contiene ningún calibre numérico (ni al revés).
    for (const l of await invLabels(page)) expect(l).not.toMatch(/\b[2-5]00\b/);

    await tab(page, 'caja');
    expect(await chipTexts(page, 'quality')).toEqual(['1X', '2X', '3X']);
  });

  test('caso 5 · calibres 200, 300, 400 y 500: cada uno es una clasificación aparte y elegirlo NO rellena ningún tamaño 1X–3X', async ({ page }) => {
    await open(page);
    await tab(page, 'inventario');
    const form = addForm(page);
    await form.getByTestId('new-name').fill(SIN);
    await chipIn(form, 'caliber', '400').click();
    await expect(form.getByTestId('new-caliber')).toHaveValue('400');
    await expectNoneChecked(form, 'size'); // ni 1X, 2X, 3X
    await expect(form.getByTestId('new-preview')).toHaveText(`Quedará como: ${SIN} · 400`);

    await chipIn(form, 'caliber', '200').click();
    await form.getByTestId('new-price').fill('40');
    let n = await toastCount(page);
    await form.getByTestId('add-product').click();
    await expectNewToast(page, n, 'Variedad agregada');
    await addClass(page, { name: SIN, caliber: '300', price: '36' });
    await addClass(page, { name: SIN, caliber: '400', price: '30' });
    await addClass(page, { name: SIN, caliber: ' 500 ', price: '24' }); // con espacios: se recorta

    expect(await invLabels(page)).toEqual([`${SIN} · 200`, `${SIN} · 300`, `${SIN} · 400`, `${SIN} · 500`]);
    const prices: Record<string, string> = { '200': '$40.00/kg', '300': '$36.00/kg', '400': '$30.00/kg', '500': '$24.00/kg' };
    for (const [cal, price] of Object.entries(prices)) await expect(invRow(page, `${SIN} · ${cal}`).locator('header span')).toHaveText(price);
    for (const l of await invLabels(page)) expect(l).not.toMatch(/\b[1-3]X\b/i);

    await tab(page, 'caja');
    expect(await chipTexts(page, 'quality')).toEqual(['200', '300', '400', '500']);
    await pickClass(page, '300');
    await expect(page.getByTestId('price')).toHaveValue('36');
    await pickClass(page, '500');
    await expect(page.getByTestId('price')).toHaveValue('24');
  });

  test('caso 6 · calidades Primera, Segunda y Tercera con precio propio, sin tocar procedencia ni calibre', async ({ page }) => {
    await open(page);
    await tab(page, 'inventario');
    const form = addForm(page);
    await form.getByTestId('new-name').fill(SIN);
    await chipIn(form, 'quality', 'Primera').click();
    await expect(form.getByTestId('new-quality')).toHaveValue('Primera');
    for (const f of ['origin', 'caliber']) await expect(form.getByTestId(`new-${f}`), `${f} debe seguir vacío`).toHaveValue('');
    await form.getByTestId('new-price').fill('35');
    const n = await toastCount(page);
    await form.getByTestId('add-product').click();
    await expectNewToast(page, n, 'Variedad agregada');
    await addClass(page, { name: SIN, quality: 'segunda', price: '28' }); // minúscula → ortografía del catálogo
    await addClass(page, { name: SIN, quality: 'TERCERA', price: '20' });

    expect(await invLabels(page)).toEqual([`${SIN} · Primera`, `${SIN} · Segunda`, `${SIN} · Tercera`]);
    await expect(invRow(page, `${SIN} · Primera`).locator('header span')).toHaveText('$35.00/kg');
    await expect(invRow(page, `${SIN} · Segunda`).locator('header span')).toHaveText('$28.00/kg');
    await expect(invRow(page, `${SIN} · Tercera`).locator('header span')).toHaveText('$20.00/kg');

    await tab(page, 'caja');
    expect(await chipTexts(page, 'quality')).toEqual(['Primera', 'Segunda', 'Tercera']);
    for (const [q, price] of [['Segunda', '28'], ['Tercera', '20'], ['Primera', '35']] as const) {
      await pickClass(page, q);
      await expect(page.getByTestId('price')).toHaveValue(price);
      await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${SIN} · ${q}`);
    }
  });
});

test.describe('Catálogo clasificado · valores propios, no especificados y campos opcionales', () => {
  test('caso 7 · valores personalizados: «Torreones» como calidad, «Mini» como calibre y «Veracruz» como procedencia se conservan tal cual', async ({ page }) => {
    await open(page);
    await addClass(page, { name: SIN, quality: 'Torreones', price: '38' }); // «Torreones» lo maneja la persona como CALIDAD
    await addClass(page, { name: SIN, caliber: 'Mini', price: '22' }); // un calibre propio
    await addClass(page, { name: CON, origin: 'Veracruz', quality: '  Mi   calidad  ', caliber: 'Extra grande', price: '27' });

    // Se guardan con la ortografía escrita (espacios recortados y colapsados), sin imponer mayúsculas ni sinónimos.
    expect(await invLabels(page)).toEqual([`${SIN} · Torreones`, `${SIN} · Mini`, `${CON} · Veracruz · Mi calidad · Extra grande`]);
    await expect(invRow(page, `${SIN} · Torreones`).locator('header span')).toHaveText('$38.00/kg');
    await expect(invRow(page, `${SIN} · Mini`).locator('header span')).toHaveText('$22.00/kg');

    await tab(page, 'caja');
    await pickVariety(page, SIN);
    expect(await chipTexts(page, 'quality')).toEqual(['Torreones', 'Mini']);
    await pickClass(page, 'Torreones');
    await expect(page.getByTestId('price')).toHaveValue('38');
    await pickClass(page, 'Mini');
    await expect(page.getByTestId('price')).toHaveValue('22');
    await pickVariety(page, CON);
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${CON} · Veracruz · Mi calidad · Extra grande`);
  });

  test('caso 7 · NO especificados con chips: «No especificada», «Sin clasificar» y «No especificado» dejan el campo vacío y se guarda ausente', async ({ page }) => {
    await open(page);
    await addClass(page, { name: CON, origin: 'Oaxaca', price: '25' });
    await tab(page, 'inventario');
    const form = addForm(page);
    // Se marca Oaxaca y luego «No especificada»: el campo queda vacío y el chip «No especificada» marcado.
    await form.getByTestId('new-name').fill(CON);
    await chipIn(form, 'origin', 'Oaxaca').click();
    await expect(form.getByTestId('new-origin')).toHaveValue('Oaxaca');
    await chipIn(form, 'origin', 'No especificada').click();
    await expect(form.getByTestId('new-origin')).toHaveValue('');
    await expect(chipIn(form, 'origin', 'No especificada')).toHaveAttribute('aria-checked', 'true');
    await chipIn(form, 'quality', 'Primera').click();
    await chipIn(form, 'quality', 'Sin clasificar').click();
    await expect(form.getByTestId('new-quality')).toHaveValue('');
    await chipIn(form, 'size', '2X').click();
    await chipIn(form, 'caliber', 'No especificado').click();
    await expect(form.getByTestId('new-caliber')).toHaveValue('');
    await expect(form.getByTestId('new-preview')).toHaveText(`Quedará como: ${CON}`);
    await form.getByTestId('new-price').fill('31');
    const n = await toastCount(page);
    await form.getByTestId('add-product').click();
    await expectNewToast(page, n, 'Variedad agregada');

    // Es OTRA clasificación (sin procedencia): no pisó a «Con semilla · Oaxaca» y su etiqueta no muestra «No especificada».
    expect(await invLabels(page)).toEqual([`${CON} · Oaxaca`, CON]);
    await expect(invRow(page, `${CON} · Oaxaca`).locator('header span')).toHaveText('$25.00/kg');
    await expect(invRow(page, CON).locator('header span')).toHaveText('$31.00/kg');
    for (const l of await invLabels(page)) expect(l).not.toMatch(/No especificad|Sin clasificar/i);
    // En la Caja la clasificación vacía se presenta como «Única» (no como un texto de relleno guardado).
    await tab(page, 'caja');
    expect(await chipTexts(page, 'quality')).toEqual(['Oaxaca', 'Única']);
    await pickClass(page, 'Única');
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${CON}`);
    await expect(page.getByTestId('price')).toHaveValue('31');
  });

  test('caso 7 · NO especificados escritos a mano («No especificada», «n/a», «Sin especificar») equivalen a vacío: se guardan ausentes y no crean otra clasificación', async ({ page }) => {
    await open(page);
    await addClass(page, { name: SIN, origin: 'No especificada', quality: 'SIN CLASIFICAR', caliber: 'no especificado', price: '29' });
    expect(await invLabels(page)).toEqual([SIN]); // ninguno de los tres textos quedó en la etiqueta
    // Escribir lo mismo con otras formas de «no especificado» es el MISMO producto, no uno nuevo.
    await tryAddClass(page, { name: SIN, origin: 'n/a', quality: 'sin especificar', caliber: '', price: '50' }, /Ya existe esa clasificación/);
    await tryAddClass(page, { name: SIN, price: '51' }, /Ya existe esa clasificación/);
    expect(await invLabels(page)).toEqual([SIN]);
    await expect(invRow(page, SIN).locator('header span')).toHaveText('$29.00/kg');
  });

  test('solo la variedad es obligatoria: sin procedencia, calidad, calibre ni precio se da de alta con «Sin precio todavía»; la Caja no cobra hasta ponerle precio', async ({ page }) => {
    await open(page);
    await tab(page, 'inventario');
    const form = addForm(page);
    await expect(form.getByTestId('add-product')).toBeEnabled();

    // Negativo 1: sin variedad (aunque se marque «Sin precio todavía») no se guarda.
    let n = await toastCount(page);
    await form.getByTestId('new-no-price').check();
    await form.getByTestId('add-product').click();
    await expectNewToast(page, n, /nombre de la variedad es obligatorio/i, 'error');
    // Negativo 2: con variedad pero sin precio y sin marcar «Sin precio todavía» tampoco.
    await form.getByTestId('new-no-price').uncheck();
    await form.getByTestId('new-name').fill(SIN);
    n = await toastCount(page);
    await form.getByTestId('add-product').click();
    await expectNewToast(page, n, /Escribe el precio por unidad/, 'error');
    await expect(invRows(page)).toHaveCount(0);
    await expect(form.getByTestId('new-name'), 'lo escrito no se pierde tras un error').toHaveValue(SIN);

    // Solo variedad + «Sin precio todavía».
    await form.getByTestId('new-no-price').check();
    await expect(form.getByTestId('new-price')).toBeDisabled();
    n = await toastCount(page);
    await form.getByTestId('add-product').click();
    await expectNewToast(page, n, 'Variedad agregada');
    expect(await invLabels(page)).toEqual([SIN]);
    await expect(invRow(page, SIN).locator('header span')).toHaveText('Sin precio');

    // La Caja avisa y NO deja cobrar hasta que se escriba un precio.
    await tab(page, 'caja');
    await expect(page.getByTestId('no-price-hint')).toBeVisible();
    await expect(page.getByTestId('price')).toHaveValue('');
    await expect(page.getByTestId('price')).toHaveAttribute('placeholder', 'Falta precio');
    await page.getByTestId('kg').fill('2');
    await expect(page.getByTestId('total')).toContainText('$0.00');
    await expect(page.getByTestId('confirm')).toBeDisabled();
    await page.getByTestId('price').fill('31');
    n = await toastCount(page);
    await page.getByTestId('price').blur();
    await expectNewToast(page, n, `Precio de ${SIN}: $31.00`);
    await expect(page.getByTestId('no-price-hint')).toHaveCount(0);
    await expect(page.getByTestId('total')).toContainText('$62.00');
    await page.getByTestId('exact').click();
    await expect(page.getByTestId('confirm')).toBeEnabled();
    await tab(page, 'inventario');
    await expect(invRow(page, SIN).locator('header span')).toHaveText('$31.00/kg');
  });

  test('la etiqueta completa «variedad · procedencia · calidad · calibre» es la misma en vista previa, Inventario, Caja, confirmación, Corte, Historial y Vales', async ({ page }) => {
    const c = { name: CON, origin: 'Oaxaca', quality: 'Segunda', caliber: '300', price: '25.5' } as const;
    const label = labelOf(c);
    expect(label).toBe('Con semilla · Oaxaca · Segunda · 300');
    await open(page);
    await tab(page, 'inventario');
    const form = addForm(page);
    await fillForm(form, c);
    await expect(form.getByTestId('new-preview')).toHaveText(`Quedará como: ${label}`);
    const n = await toastCount(page);
    await form.getByTestId('add-product').click();
    await expectNewToast(page, n, 'Variedad agregada');
    await expect(invRow(page, label)).toHaveCount(1);
    await addStock(page, label, '50');

    await selectInCaja(page, c); // «Vendiendo: …» con la etiqueta completa
    await page.getByTestId('kg').fill('2');
    await page.getByTestId('exact').click();
    await page.getByTestId('confirm').click();
    await expect(page.getByTestId('confirm-sheet')).toContainText(`${label} · 2 kg × $25.50`);
    await page.getByTestId('confirm-yes').click();
    await expect(page.getByTestId('last-sale')).toContainText('#1');

    await tab(page, 'corte');
    await expect(page.getByTestId('sale-row')).toContainText(`${label} 2 kg`);
    await expect(page.getByRole('listitem').filter({ hasText: `${label}: 2 kg · $51.00` })).toHaveCount(1);
    await tab(page, 'mas');
    await expect(page.getByTestId('hist-row')).toContainText(`${label} 2 kg`);

    await sellKg(page, '1', { vale: true, customer: 'Doña Mary', authorize: false });
    await tab(page, 'vales');
    await expect(page.getByTestId('vale')).toContainText(`${label} · 1 kg`);
    await tab(page, 'inventario');
    await expect(invRow(page, label)).toHaveCount(1);
  });
});

test.describe('No inventar · sin equivalencias, sin calidades deducidas, sin sugerencias cruzadas', () => {
  test('«Oaxaqueño» y «Michoacano» se escriben como Oaxaca y Michoacán, pero ni ellos ni «Torreones» ni la procedencia asignan solos una calidad, un calibre o un precio', async ({ page }) => {
    await open(page);
    await tab(page, 'inventario');
    const form = addForm(page);

    // Elegir una procedencia NO elige calidad ni calibre ni precio.
    await form.getByTestId('new-name').fill(CON);
    await chipIn(form, 'origin', 'Oaxaca').click();
    await expect(form.getByTestId('new-quality')).toHaveValue('');
    await expect(form.getByTestId('new-caliber')).toHaveValue('');
    await expect(form.getByTestId('new-price')).toHaveValue('');
    await expect(chipIn(form, 'quality', 'Segunda'), 'Oaxaca no debe marcar «Segunda»').toHaveAttribute('aria-checked', 'false');
    await expect(chipIn(form, 'quality', 'Tercera')).toHaveAttribute('aria-checked', 'false');
    await expectNoneChecked(form, 'size');
    // Y al revés: elegir una calidad no elige procedencia.
    await chipIn(form, 'origin', 'No especificada').click();
    await chipIn(form, 'quality', 'Tercera').click();
    await expect(form.getByTestId('new-origin')).toHaveValue('');
    await expect(chipIn(form, 'origin', 'Oaxaca')).toHaveAttribute('aria-checked', 'false');
    await chipIn(form, 'quality', 'Sin clasificar').click();

    // «Oaxaqueño»/«Michoacano» escritos en PROCEDENCIA se guardan como Oaxaca/Michoacán, sin calidad.
    await addClass(page, { name: CON, origin: 'Oaxaqueño', price: '24' });
    await addClass(page, { name: CON, origin: 'MICHOACANA', price: '27' });
    expect(await invLabels(page)).toEqual([`${CON} · Oaxaca`, `${CON} · Michoacán`]);
    // «Torreones» escrito en CALIDAD se queda en calidad: no aparece como procedencia, ni cambia ni hereda otra cosa.
    await addClass(page, { name: SIN, quality: 'Torreones', price: '38' });
    // «Oaxaqueño» escrito en CALIDAD es una calidad propia: no se vuelve procedencia ni se convierte.
    await addClass(page, { name: SIN, quality: 'Oaxaqueño', price: '19' });
    expect(await invLabels(page)).toEqual([`${CON} · Oaxaca`, `${CON} · Michoacán`, `${SIN} · Torreones`, `${SIN} · Oaxaqueño`]);
    // Los precios son los que se escribieron, no los deducidos de la procedencia o la calidad.
    await expect(invRow(page, `${CON} · Oaxaca`).locator('header span')).toHaveText('$24.00/kg');
    await expect(invRow(page, `${CON} · Michoacán`).locator('header span')).toHaveText('$27.00/kg');
    await expect(invRow(page, `${SIN} · Torreones`).locator('header span')).toHaveText('$38.00/kg');
    await expect(invRow(page, `${SIN} · Oaxaqueño`).locator('header span')).toHaveText('$19.00/kg');
  });

  test('NO hay equivalencia 1X↔200: tamaños y números conviven como clasificaciones distintas de la misma variedad, con precio propio', async ({ page }) => {
    await open(page);
    const calibers = [['1X', '10'], ['200', '11'], ['2X', '12'], ['300', '13'], ['3X', '14'], ['400', '15'], ['500', '16']] as const;
    for (const [cal, price] of calibers) await addClass(page, { name: SIN, caliber: cal, price });
    // Siete clasificaciones, ninguna absorbió a otra.
    expect(await invLabels(page)).toEqual(calibers.map(([cal]) => `${SIN} · ${cal}`));
    for (const [cal, price] of calibers) await expect(invRow(page, `${SIN} · ${cal}`).locator('header span')).toHaveText(`$${price}.00/kg`);
    // Una entrada a «2X» NO aparece en «200» ni en ningún otro.
    await addStock(page, `${SIN} · 2X`, '40');
    await expectStock(invRow(page, `${SIN} · 2X`), { physical: '40 kg' });
    for (const [cal] of calibers.filter(([c]) => c !== '2X')) {
      await expect(invRow(page, `${SIN} · ${cal}`).getByTestId('stock-physical')).toHaveText('0 g');
    }
  });

  test('los valores propios solo se sugieren dentro de la variedad donde ya se usaron y ningún valor nuevo cambia otra clasificación', async ({ page }) => {
    await open(page);
    await addClass(page, { name: SIN, quality: 'Torreones', price: '38' });
    await addClass(page, { name: SIN, caliber: 'Mini', price: '22' });
    await addClass(page, { name: CON, origin: 'Veracruz', price: '27' });
    await moveStock(page, `${SIN} · Torreones`, 'entrada', '12.5');
    const before = await snapshotInventory(page);

    await tab(page, 'inventario');
    const form = addForm(page);
    // Con «Sin semilla»: se sugieren SUS valores propios (Torreones, Mini) y no el de «Con semilla» (Veracruz).
    await form.getByTestId('new-name').fill(SIN);
    expect(await radioTexts(form, 'quality')).toEqual(['Primera', 'Segunda', 'Tercera', 'Torreones', 'Sin clasificar']);
    expect(await radioTexts(form, 'caliber')).toEqual(['200', '300', '400', '500', 'Mini', 'No especificado']);
    expect(await radioTexts(form, 'origin')).toEqual(['Oaxaca', 'Michoacán', 'No especificada']);
    // Escribir la variedad con otra ortografía («Limón sin semilla») sigue siendo la misma variedad.
    await form.getByTestId('new-name').fill('Limón sin semilla');
    expect(await radioTexts(form, 'quality')).toContain('Torreones');
    // Con «Con semilla»: aparece Veracruz, y NO Torreones ni Mini.
    await form.getByTestId('new-name').fill(CON);
    expect(await radioTexts(form, 'origin')).toEqual(['Oaxaca', 'Michoacán', 'Veracruz', 'No especificada']);
    expect(await radioTexts(form, 'quality')).toEqual(['Primera', 'Segunda', 'Tercera', 'Sin clasificar']);
    expect(await radioTexts(form, 'caliber')).toEqual(['200', '300', '400', '500', 'No especificado']);
    // Una variedad que aún no existe no hereda ningún valor propio.
    await form.getByTestId('new-name').fill('Persa');
    expect(await radioTexts(form, 'origin')).toEqual(['Oaxaca', 'Michoacán', 'No especificada']);
    expect(await radioTexts(form, 'quality')).toEqual(['Primera', 'Segunda', 'Tercera', 'Sin clasificar']);
    expect(await radioTexts(form, 'caliber')).toEqual(['200', '300', '400', '500', 'No especificado']);

    // Elegir y escribir valores en el formulario sin guardar no cambia nada de lo existente.
    await form.getByTestId('new-name').fill(SIN);
    await chipIn(form, 'quality', 'Torreones').click();
    await chipIn(form, 'caliber', 'Mini').click();
    await form.getByTestId('new-origin').fill('Oaxaca');
    expect(await snapshotInventory(page)).toEqual(before);
    // Guardar una clasificación NUEVA con esos valores deja intactas las demás (etiqueta, precio y existencias).
    await form.getByTestId('new-price').fill('45');
    const n = await toastCount(page);
    await form.getByTestId('add-product').click();
    await expectNewToast(page, n, 'Variedad agregada');
    const after = await snapshotInventory(page);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    expect(after[after.length - 1]).toMatchObject({ label: `${SIN} · Oaxaca · Torreones · Mini`, price: '$45.00/kg', physical: '0 g' });
  });
});

test.describe('Canonización y vista previa de lo escrito', () => {
  test('lo escrito se guarda con la ortografía del catálogo: acentos, mayúsculas, «Limón» inicial, alias de procedencia y valores propios ya usados', async ({ page }) => {
    await open(page);
    await addClass(page, { name: SIN, quality: 'Torreones', price: '38' });
    await addClass(page, { name: 'limón con semilla', origin: 'oaxaqueño', quality: 'primera', price: '25' });
    await addClass(page, { name: 'CON SEMILLA', origin: 'MICHOACAN', quality: 'TERCERA', price: '21' });
    // «torreones» (otra ortografía de un valor propio ya usado) reutiliza la escritura existente.
    await addClass(page, { name: SIN, origin: 'Oaxaca', quality: 'torreones', price: '40' });
    expect(await invLabels(page)).toEqual([
      `${SIN} · Torreones`,
      `${CON} · Oaxaca · Primera`,
      `${CON} · Michoacán · Tercera`,
      `${SIN} · Oaxaca · Torreones`,
    ]);
  });

  test('calibres escritos con espacio, × o prefijo («3 x», «2 X», «3×», «Calibre 300») se guardan con la ortografía de los atajos (3X, 2X, 300), igual que «3x»', async ({ page }) => {
    // La identidad ya los trata como iguales (caliberKey); el diseño dice que lo escrito se canoniza a la escritura conocida.
    await open(page);
    const typed: Array<[string, string]> = [['3 x', '3X'], ['2 X', '2X'], ['1×', '1X'], ['Calibre 300', '300'], ['3x', '3X']];
    const seen: string[] = [];
    for (const [i, [raw]] of typed.entries()) {
      // Cada uno en una variedad distinta para que no choquen entre sí.
      await addClass(page, { name: `Prueba ${i + 1}`, caliber: raw, price: '10' });
      seen.push((await invLabels(page))[i]);
    }
    expect(seen).toEqual(typed.map(([, want], i) => `Prueba ${i + 1} · ${want}`));
  });

  test('la vista previa «Quedará como» muestra lo que realmente se guarda (alias, ortografía del catálogo y «no especificado» escrito a mano)', async ({ page }) => {
    await open(page);
    await addClass(page, { name: CON, quality: 'Primera', price: '30' }); // fija la escritura «Primera» y «Con semilla»
    await tab(page, 'inventario');
    const form = addForm(page);
    const cases: Array<{ typed: ClassSpec; stored: string }> = [
      { typed: { name: 'limón con semilla', origin: 'oaxaqueño', quality: 'primera', price: '25' }, stored: `${CON} · Oaxaca · Primera` },
      { typed: { name: SIN, origin: 'MICHOACAN', quality: 'TERCERA', price: '21' }, stored: `${SIN} · Michoacán · Tercera` },
      { typed: { name: SIN, origin: 'No especificada', quality: 'sin clasificar', caliber: 'N/A', price: '22' }, stored: SIN },
    ];
    for (const { typed, stored } of cases) {
      await fillForm(form, typed);
      const preview = norm(await form.getByTestId('new-preview').innerText());
      const n = await toastCount(page);
      await form.getByTestId('add-product').click();
      await expectNewToast(page, n, 'Variedad agregada');
      const label = (await invLabels(page)).at(-1);
      expect(label, 'lo guardado').toBe(stored);
      expect(preview, `la vista previa de «${typed.name} · ${typed.origin ?? ''} · ${typed.quality ?? ''} · ${typed.caliber ?? ''}»`).toBe(`Quedará como: ${stored}`);
    }
  });
});

test.describe('Sin duplicados accidentales', () => {
  test('el aviso previo «Ya existe esta clasificación» también reconoce los alias «oaxaqueño», «michoacano» y «michoacana»', async ({ page }) => {
    // Al guardar, la app ya los trata como Oaxaca/Michoacán (y rechaza el duplicado); el aviso de ANTES de guardar debe coincidir.
    await open(page);
    await addClass(page, { name: CON, origin: 'Oaxaca', price: '25' });
    await addClass(page, { name: CON, origin: 'Michoacán', price: '28' });
    await tab(page, 'inventario');
    const form = addForm(page);
    for (const [alias, existing] of [['oaxaqueño', 'Oaxaca'], ['Michoacano', 'Michoacán'], ['MICHOACANA', 'Michoacán']] as const) {
      await fillForm(form, { name: CON, origin: alias, price: '10' });
      await expect(form.getByTestId('new-dup'), `«${alias}» es ${existing}`).toContainText(`Ya existe esta clasificación: «${CON} · ${existing}»`);
    }
  });

  test('duplicado exacto · avisa «Ya existe esta clasificación», el botón no crea otra y se conservan precio y existencias del existente', async ({ page }) => {
    await open(page);
    const base = { name: CON, origin: 'Oaxaca', quality: 'Primera', caliber: '2X', price: '30' } as const;
    const label = labelOf(base);
    await addClass(page, base);
    await addStock(page, label, '40');
    await addClass(page, { name: SIN, price: '20' });
    const before = await snapshotInventory(page);
    expect(before.find((r) => r.label === label)).toMatchObject({ price: '$30.00/kg', physical: '40 kg', available: '40 kg' });

    await tab(page, 'inventario');
    const form = addForm(page);
    await fillForm(form, { ...base, price: '99' });
    // Aviso inmediato, ANTES de guardar, con la etiqueta y el precio del que ya existe.
    await expect(form.getByTestId('new-dup')).toContainText(`Ya existe esta clasificación: «${label}» ($30.00/kg)`);
    // Comportamiento real del botón: se puede tocar, pero NO crea otra y avisa con un error.
    const n = await toastCount(page);
    await form.getByTestId('add-product').click();
    await expectNewToast(page, n, `Ya existe esa clasificación: ${label}`, 'error');
    expect(await snapshotInventory(page), 'no cambió ninguna fila, precio ni existencia').toEqual(before);
    await expect(page.getByTestId('class-edits')).toHaveCount(0);
    await expect(form.getByTestId('new-name'), 'lo escrito no se pierde para poder corregirlo').toHaveValue(CON);
    await expect(form.getByTestId('new-price')).toHaveValue('99');

    // Y en la Caja sigue habiendo una sola, con su precio de siempre.
    await tab(page, 'caja');
    expect(await chipTexts(page, 'variety')).toEqual([CON, SIN]);
    await pickVariety(page, CON);
    await expect(page.getByTestId('price')).toHaveValue('30');
    await expect(page.getByTestId('stock-hint')).toContainText('Disponible: 40 kg');
  });

  test('duplicado con otra ortografía (mayúsculas, acentos, espacios, «Limón» inicial, «3 X», «3×», «Calibre 3X», alias) avisa y no crea otra; 3X y 300 NO son duplicados', async ({ page }) => {
    await open(page);
    const base = { name: SIN, origin: 'Michoacán', quality: 'Primera', caliber: '3X', price: '30' } as const;
    const label = labelOf(base);
    await addClass(page, base);
    await addStock(page, label, '25');
    const before = await snapshotInventory(page);
    expect(before).toHaveLength(1);

    // `notice: false` = el aviso previo no se exige (ver la prueba aparte de alias): lo que SIEMPRE se exige es que al guardar no se cree otra.
    const variants: Array<[string, Partial<ClassSpec>, { notice: boolean }?]> = [
      ['mayúsculas', { name: 'SIN SEMILLA', origin: 'MICHOACÁN', quality: 'PRIMERA', caliber: '3x' }],
      ['sin acentos', { origin: 'michoacan' }],
      ['espacios sobrantes', { name: '  Sin    semilla  ', origin: ' Michoacán ', quality: '  Primera', caliber: '3X  ' }],
      ['«Limón» inicial', { name: 'Limón sin semilla' }],
      ['«Limones-» con guion', { name: 'limones-sin semilla' }],
      ['calibre «3 X»', { caliber: '3 X' }],
      ['calibre «3 x»', { caliber: '3 x' }],
      ['calibre «3×»', { caliber: '3×' }],
      ['calibre «Calibre 3X»', { caliber: 'Calibre 3X' }],
      ['calibre «#3X»', { caliber: '#3X' }],
      ['alias «michoacana»', { origin: 'michoacana' }, { notice: false }],
    ];
    await tab(page, 'inventario');
    for (const [why, patch, opts] of variants) {
      const typed = { ...base, ...patch, price: '77' };
      const form = addForm(page);
      await fillForm(form, typed);
      if (opts?.notice !== false) {
        await expect(form.getByTestId('new-dup'), `aviso previo (${why})`).toContainText(`Ya existe esta clasificación: «${label}»`);
      }
      const n = await toastCount(page);
      await form.getByTestId('add-product').click();
      await expectNewToast(page, n, `Ya existe esa clasificación: ${label}`, 'error');
      expect(await snapshotInventory(page), `no debe crear ni cambiar nada (${why})`).toEqual(before);
    }

    // Controles negativos: un dato realmente distinto SÍ es otra clasificación.
    const form = addForm(page);
    await fillForm(form, { ...base, caliber: '300', price: '31' }); // 3X y 300 son valores distintos: sin equivalencia
    await expect(form.getByTestId('new-dup')).toHaveCount(0);
    let n = await toastCount(page);
    await form.getByTestId('add-product').click();
    await expectNewToast(page, n, 'Variedad agregada');
    await fillForm(form, { ...base, quality: 'Segunda', price: '24' });
    await expect(form.getByTestId('new-dup')).toHaveCount(0);
    n = await toastCount(page);
    await form.getByTestId('add-product').click();
    await expectNewToast(page, n, 'Variedad agregada');
    const after = await snapshotInventory(page);
    expect(after).toHaveLength(3);
    expect(after[0]).toEqual(before[0]); // la original sigue igual: precio $30.00 y 25 kg
    expect(after.map((r) => r.label)).toEqual([label, `${SIN} · Michoacán · Primera · 300`, `${SIN} · Michoacán · Segunda · 3X`]);
  });

  test('doble toque en «Agregar variedad» crea UNA sola clasificación', async ({ page }) => {
    await open(page);
    await tab(page, 'inventario');
    const form = addForm(page);
    await fillForm(form, { name: SIN, quality: 'Primera', price: '30' });
    const n = await toastCount(page);
    await form.getByTestId('add-product').dblclick();
    await expectNewToast(page, n, 'Variedad agregada');
    // Viaje de ida y vuelta a la base: lo que se lee ya incluye cualquier segundo intento.
    await tab(page, 'caja');
    await tab(page, 'inventario');
    expect(await invLabels(page)).toEqual([`${SIN} · Primera`]);
    expect((await toastCount(page)) - n, 'solo debe salir UN aviso (un segundo intento habría avisado «Ya existe»)').toBe(1);
  });
});

test.describe('Alta y elección de clasificaciones desde Recepción', () => {
  test('alta desde Recepción («Nueva clasificación»): unidad fija en kg, «Sin precio todavía» por defecto, el duplicado se rechaza y la nueva queda elegida', async ({ page }) => {
    await open(page);
    await tab(page, 'recepcion');
    await expect(page.getByTestId('rec-sin-productos')).toBeVisible();
    await page.getByTestId('rec-new-class-toggle').click();
    const sheet = page.getByTestId('rec-newclass-sheet');
    await expect(sheet.getByTestId('recnew-unit'), 'la recepción suma kilos: la unidad no se pregunta').toHaveCount(0);
    await expect(sheet.getByTestId('recnew-no-price')).toBeChecked();
    await expect(sheet.getByTestId('recnew-price')).toBeDisabled();
    await chipIn(sheet, 'variety', SIN, 'recnew').click();
    await chipIn(sheet, 'size', '2X', 'recnew').click();
    await expect(sheet.getByTestId('recnew-preview')).toHaveText(`Quedará como: ${SIN} · 2X`);
    let n = await toastCount(page);
    await sheet.getByTestId('recnew-add').click();
    await expectNewToast(page, n, 'Variedad agregada');
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId('rec-selected')).toContainText(`${SIN} · 2X`);
    await expect(page.getByTestId('rec-selected')).toContainText('sin precio todavía');

    // La misma clasificación, escrita distinto, se rechaza y la hoja sigue abierta para corregir.
    await page.getByTestId('rec-new-class-toggle').click();
    await sheet.getByTestId('recnew-name').fill('limón SIN semilla');
    await sheet.getByTestId('recnew-caliber').fill('2x');
    await expect(sheet.getByTestId('recnew-dup')).toContainText(`Ya existe esta clasificación: «${SIN} · 2X»`);
    n = await toastCount(page);
    await sheet.getByTestId('recnew-add').click();
    await expectNewToast(page, n, `Ya existe esa clasificación: ${SIN} · 2X`, 'error');
    await expect(sheet).toBeVisible();
    await sheet.getByTestId('rec-newclass-close').click();

    // Se ve igual en Inventario y en Caja (sin precio).
    expect(await invLabels(page)).toEqual([`${SIN} · 2X`]);
    await expect(invRow(page, `${SIN} · 2X`).locator('header span')).toHaveText('Sin precio');
    await tab(page, 'caja');
    await expect(page.getByTestId('no-price-hint')).toBeVisible();
  });

  test('Recepción · variedad → clasificación: con varias clasificaciones no elige ninguna sola y pide tocar una; en la Caja, en cambio, ya viene una elegida', async ({ page }) => {
    await open(page);
    await addClass(page, { name: SIN, caliber: '2X', price: '30' });
    await addClass(page, { name: SIN, caliber: '3X', price: '38' });
    await addClass(page, { name: CON, price: '27' }); // una sola clasificación
    await tab(page, 'recepcion');
    await page.getByTestId('rec-variety').filter({ hasText: exactText(SIN) }).click();
    await expect(page.getByTestId('rec-class-hint')).toContainText(`Elige la clasificación de «${SIN}»`);
    await expect(page.getByTestId('rec-selected'), 'no debe elegir una por su cuenta').toHaveCount(0);
    expect(await chipTexts(page, 'rec-class')).toEqual(['2X', '3X']);
    await page.getByTestId('rec-class').filter({ hasText: exactText('3X') }).click();
    await expect(page.getByTestId('rec-selected')).toContainText(`${SIN} · 3X`);
    await expect(page.getByTestId('rec-class-hint')).toHaveCount(0);
    // Cambiar a otra variedad con varias vuelve a dejar la elección vacía; con una sola la elige de una vez.
    await page.getByTestId('rec-variety').filter({ hasText: exactText(CON) }).click();
    await expect(page.getByTestId('rec-selected')).toContainText(CON);
    await page.getByTestId('rec-variety').filter({ hasText: exactText(SIN) }).click();
    await expect(page.getByTestId('rec-selected')).toHaveCount(0);
    await expect(page.getByTestId('rec-class-hint')).toBeVisible();
    // En la Caja ya hay una elegida (la primera) y nunca se pide elegir.
    await pickVariety(page, SIN);
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${SIN} · 2X`);
    await expect(page.getByTestId('quality-hint')).toHaveCount(0);
  });
});

test.describe('Edición y ocultar/activar', () => {
  test('edición · conserva ventas y vales anteriores (nombre y precio históricos) y la existencia, y deja registro en class-edits', async ({ page }) => {
    await open(page);
    const old = `${SIN} · Segunda`;
    const cur = `${SIN} · Tercera`;
    await addClass(page, { name: SIN, quality: 'Segunda', price: '20' });
    await addStock(page, old, '50');
    expect(await sellKg(page, '5', { authorize: false })).toBe(1); // $100.00
    expect(await sellKg(page, '3', { vale: true, customer: 'Don Beto', authorize: false })).toBe(2); // vale V-1, $60.00

    const { row, form } = await openEdit(page, old);
    await expect(row.getByTestId('edit-moves-warning'), 'avisa que el producto ya tiene movimientos').toBeVisible();
    await patchForm(form, { quality: 'Tercera', price: '22' });
    await expect(form.getByTestId('edit-preview')).toHaveText(`Quedará como: ${cur}`);
    let n = await toastCount(page);
    await form.getByTestId('edit-add').click();
    await expectNewToast(page, n, 'Clasificación actualizada');

    // La existencia viaja con el producto; el precio nuevo es solo para lo que se venda de aquí en adelante.
    expect(await invLabels(page)).toEqual([cur]);
    const now = invRow(page, cur);
    await expectStock(now, { physical: '45 kg', reserved: '3 kg', available: '42 kg', vendido: '5 kg', manual: '50 kg' });
    await expect(now.locator('header span')).toHaveText('$22.00/kg');
    await expect(now.getByTestId('class-edits')).toContainText(`«${old}» → «${cur}»`);
    await expect(now.getByTestId('class-edits').locator('li')).toHaveCount(1);

    // Lo ya vendido conserva el nombre y el precio de entonces (Corte, Historial y Vales).
    await tab(page, 'corte');
    await expect(page.getByTestId('sale-row')).toHaveCount(2);
    const sale1 = page.getByTestId('sale-row').filter({ has: page.locator('header strong').filter({ hasText: /^#1$/ }) });
    const sale2 = page.getByTestId('sale-row').filter({ has: page.locator('header strong').filter({ hasText: /^#2$/ }) });
    await expect(sale1).toContainText(`${old} 5 kg`);
    await expect(sale1).toContainText('$100.00');
    await expect(sale2).toContainText(`${old} 3 kg`);
    await expect(sale2).toContainText('$60.00');
    await expect(page.getByTestId('r-total')).toContainText('$160.00');
    await tab(page, 'mas');
    await expect(page.getByTestId('hist-row')).toHaveCount(2);
    for (const r of await page.getByTestId('hist-row').allInnerTexts()) {
      expect(r).toContain(old);
      expect(r).not.toContain('Tercera');
    }
    await tab(page, 'vales');
    await expect(page.getByTestId('vale')).toContainText(`${old} · 3 kg`);

    // Una venta NUEVA usa el nombre y el precio nuevos; las anteriores siguen igual.
    await tab(page, 'caja');
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${cur}`);
    await expect(page.getByTestId('price')).toHaveValue('22');
    expect(await sellKg(page, '1', { authorize: false })).toBe(3);
    await tab(page, 'corte');
    await expect(page.getByTestId('sale-row').first()).toContainText(`${cur} 1 kg`);
    await expect(page.getByTestId('sale-row').first()).toContainText('$22.00');
    await expect(sale1).toContainText(`${old} 5 kg`);
    await expect(page.getByTestId('r-total')).toContainText('$182.00');

    // Una segunda edición de nombre suma otra línea a la bitácora; cambiar SOLO el precio no suma ninguna.
    const second = await openEdit(page, cur);
    await patchForm(second.form, { caliber: '2X' });
    n = await toastCount(page);
    await second.form.getByTestId('edit-add').click();
    await expectNewToast(page, n, 'Clasificación actualizada');
    const cur2 = `${cur} · 2X`;
    await expect(invRow(page, cur2).getByTestId('class-edits').locator('li')).toHaveCount(2);
    const third = await openEdit(page, cur2);
    await patchForm(third.form, { price: '23.5' });
    n = await toastCount(page);
    await third.form.getByTestId('edit-add').click();
    await expectNewToast(page, n, 'Clasificación actualizada');
    await expect(invRow(page, cur2).getByTestId('class-edits').locator('li')).toHaveCount(2);
    await expect(invRow(page, cur2).locator('header span')).toHaveText('$23.50/kg');

    // Entregar el vale descuenta lo suyo del producto renombrado; la auditoría sigue limpia.
    await deliverVale(page, 1);
    await tab(page, 'inventario');
    await expectStock(invRow(page, cur2), { physical: '41 kg', reserved: '0 g', available: '41 kg' });
    await expectIdentity(page);
    const audit = await runAudit(page);
    expect(audit.text).toContain('Sin inconsistencias');
    expect(audit.text).toContain('3 ventas, 1 vale,'); // singular cuando es 1
  });

  test('edición · los errores no alteran el producto: duplicado, variedad vacía, precio inválido y unidad con movimientos; Cancelar no cambia nada', async ({ page }) => {
    await open(page);
    const a = `${SIN} · Primera`;
    const b = `${SIN} · Segunda`;
    await addClass(page, { name: SIN, quality: 'Primera', price: '30' });
    await addClass(page, { name: SIN, quality: 'Segunda', price: '20' });
    await addStock(page, a, '10');
    await moveStock(page, a, 'merma', '10', 'se acabó'); // A: 0 kg físicos pero CON movimientos
    await addStock(page, b, '15');
    const before = await snapshotInventory(page);

    const { row, form } = await openEdit(page, a);
    const attempt = async (patch: Partial<ClassSpec>, error: RegExp | string, why: string) => {
      await patchForm(form, patch);
      const n = await toastCount(page);
      await form.getByTestId('edit-add').click();
      await expectNewToast(page, n, error, 'error');
      expect(await snapshotInventory(page), `no debe cambiar nada (${why})`).toEqual(before);
      await expect(form, 'el formulario sigue abierto para corregir').toBeVisible();
    };

    // Chocar con otra clasificación: aviso previo y rechazo al guardar.
    await patchForm(form, { quality: 'segunda' });
    await expect(form.getByTestId('edit-dup')).toContainText(`Ya existe esta clasificación: «${b}»`);
    await attempt({ quality: 'segunda' }, `Ya existe esa clasificación: ${b}`, 'duplicado');
    await patchForm(form, { quality: 'Primera' });
    await expect(form.getByTestId('edit-dup')).toHaveCount(0);
    // Variedad vacía.
    await attempt({ name: '   ' }, /nombre de la variedad es obligatorio/i, 'variedad vacía');
    await patchForm(form, { name: SIN });
    // Precio vacío, cero o negativo.
    for (const bad of ['', '0', '-4']) await attempt({ price: bad }, /Escribe el precio por unidad/, `precio «${bad}»`);
    await patchForm(form, { price: '30' });
    // Unidad: A tuvo movimientos aunque hoy tenga 0 kg → el cambio se rechaza al guardar.
    await attempt({ unit: 'caja' }, /No se puede cambiar la unidad de un producto que ya tiene movimientos/, 'cambio de unidad');
    await expect(row.locator('header span')).toHaveText('$30.00/kg');
    // Cancelar descarta lo escrito.
    await patchForm(form, { name: 'Otra cosa', unit: 'kg' });
    await form.getByTestId('edit-cancel').click();
    await expect(form).toHaveCount(0);
    expect(await snapshotInventory(page)).toEqual(before);
    // Con existencia distinta de cero el selector de unidad ni se ofrece.
    const other = await openEdit(page, b);
    await expect(other.form.getByTestId('edit-unit')).toBeDisabled();
    await other.form.getByTestId('edit-cancel').click();

    // Cambiar SOLO el precio no toca nombre ni existencia ni deja bitácora de nombre.
    const again = await openEdit(page, a);
    await patchForm(again.form, { price: '31' });
    const n = await toastCount(page);
    await again.form.getByTestId('edit-add').click();
    await expectNewToast(page, n, 'Clasificación actualizada');
    await expect(invRow(page, a).locator('header span')).toHaveText('$31.00/kg');
    await expect(invRow(page, a).getByTestId('class-edits')).toHaveCount(0);
    await expect(invRow(page, b).locator('header span')).toHaveText('$20.00/kg');
  });

  test('ocultar y activar · la clasificación oculta no aparece en Caja ni en Recepción, conserva precio y existencias, y su duplicado se sigue rechazando', async ({ page }) => {
    await open(page);
    const A = `${SIN} · 2X`;
    const B = `${SIN} · 3X`;
    const C = `${SIN} · 500`;
    for (const [cal, price] of [['2X', '30'], ['3X', '38'], ['500', '20']] as const) await addClass(page, { name: SIN, caliber: cal, price });
    await addStock(page, B, '60');
    await tab(page, 'caja');
    await pickClass(page, '3X'); // B queda elegida
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${B}`);

    // Se oculta la elegida: la Caja no se rompe, deja de ofrecerla y pasa a otra activa.
    await setHidden(page, B, true);
    await expectStock(invRow(page, B), { physical: '60 kg' }); // oculto ≠ borrado: conserva existencias
    await expect(invRow(page, B).locator('header span')).toHaveText('$38.00/kg');
    await tab(page, 'caja');
    expect(await chipTexts(page, 'quality')).toEqual(['2X', '500']);
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${A}`);
    await expect(page.getByTestId('price')).toHaveValue('30');
    // Recepción tampoco la ofrece.
    await tab(page, 'recepcion');
    await page.getByTestId('rec-variety').filter({ hasText: exactText(SIN) }).click();
    expect(await chipTexts(page, 'rec-class')).toEqual(['2X', '500']);

    // El duplicado de una oculta se rechaza igual (hay que activar la que ya existe).
    await tryAddClass(page, { name: SIN, caliber: '3X', price: '99' }, `Ya existe esa clasificación: ${B}`);
    await expect(addForm(page).getByTestId('new-dup')).toContainText(`«${B}»`);

    // Si queda UNA sola activa, ya no hay segundo nivel de chips.
    await setHidden(page, C, true);
    await tab(page, 'caja');
    await expect(page.getByTestId('quality')).toHaveCount(0);
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${A}`);

    // Activar la devuelve con su precio y sus existencias.
    await setHidden(page, B, false);
    await tab(page, 'caja');
    expect(await chipTexts(page, 'quality')).toEqual(['2X', '3X']);
    await pickClass(page, '3X');
    await expect(page.getByTestId('price')).toHaveValue('38');
    await expect(page.getByTestId('stock-hint')).toContainText('Disponible: 60 kg');
    await tab(page, 'recepcion');
    await page.getByTestId('rec-variety').filter({ hasText: exactText(SIN) }).click();
    expect(await chipTexts(page, 'rec-class')).toEqual(['2X', '3X']);
    expect(await snapshotInventory(page)).toEqual([
      { label: A, price: '$30.00/kg', physical: '0 g', reserved: '0 g', available: '0 g', hidden: false },
      { label: B, price: '$38.00/kg', physical: '60 kg', reserved: '0 g', available: '60 kg', hidden: false },
      { label: C, price: '$20.00/kg', physical: '0 g', reserved: '0 g', available: '0 g', hidden: true },
    ]);
  });
});

test.describe('Precio independiente por clasificación (caso 16)', () => {
  test('caso 16 · precio independiente por clasificación: dos calibres de la misma variedad con precios distintos; cambiar uno no cambia el otro ni las ventas ya hechas; cada venta usa su precio', async ({ page }) => {
    await open(page);
    const c2 = { name: SIN, caliber: '2X' };
    const c3 = { name: SIN, caliber: '3X' };
    const other = { name: CON, caliber: '2X' }; // mismo calibre, OTRA variedad
    await addClass(page, { ...c2, price: '30' });
    await addClass(page, { ...c3, price: '38' });
    await addClass(page, { ...other, price: '27' });
    for (const c of [c2, c3, other]) await addStock(page, labelOf(c), '100');

    // Cada una se vende con SU precio.
    await selectInCaja(page, c2);
    await expect(page.getByTestId('price')).toHaveValue('30');
    expect(await sellKg(page, '2', { authorize: false })).toBe(1); // $60.00
    await selectInCaja(page, c3);
    await expect(page.getByTestId('price')).toHaveValue('38');
    expect(await sellKg(page, '2', { authorize: false })).toBe(2); // $76.00

    // Se cambia el precio de 2X desde la Caja.
    await selectInCaja(page, c2);
    await page.getByTestId('price').fill('33');
    const n = await toastCount(page);
    await page.getByTestId('price').blur();
    await expectNewToast(page, n, `Precio de ${labelOf(c2)}: $33.00`);
    // 3X y la otra variedad NO cambiaron; Inventario lo confirma.
    await selectInCaja(page, c3);
    await expect(page.getByTestId('price')).toHaveValue('38');
    await selectInCaja(page, other);
    await expect(page.getByTestId('price')).toHaveValue('27');
    await tab(page, 'inventario');
    await expect(invRow(page, labelOf(c2)).locator('header span')).toHaveText('$33.00/kg');
    await expect(invRow(page, labelOf(c3)).locator('header span')).toHaveText('$38.00/kg');
    await expect(invRow(page, labelOf(other)).locator('header span')).toHaveText('$27.00/kg');

    // Las ventas ya hechas conservan el precio de entonces.
    await tab(page, 'corte');
    const sale = (folio: number) => page.getByTestId('sale-row').filter({ has: page.locator('header strong').filter({ hasText: new RegExp(`^#${folio}$`) }) });
    await expect(sale(1).locator('header span')).toHaveText('$60.00');
    await expect(sale(2).locator('header span')).toHaveText('$76.00');
    await tab(page, 'mas');
    await expect(page.getByTestId('hist-summary')).toContainText('2 ventas · $136.00');

    // Las nuevas usan el precio vigente de CADA una.
    await selectInCaja(page, c2);
    expect(await sellKg(page, '1', { authorize: false })).toBe(3); // $33.00
    await selectInCaja(page, c3);
    expect(await sellKg(page, '1', { authorize: false })).toBe(4); // $38.00
    await tab(page, 'corte');
    await expect(sale(3).locator('header span')).toHaveText('$33.00');
    await expect(sale(4).locator('header span')).toHaveText('$38.00');
    await expect(sale(1).locator('header span')).toHaveText('$60.00');
    await expect(page.getByTestId('r-total')).toContainText('$207.00'); // 60 + 76 + 33 + 38
    await expect(page.getByRole('listitem').filter({ hasText: `${labelOf(c2)}: 3 kg · $93.00` })).toHaveCount(1);
    await expect(page.getByRole('listitem').filter({ hasText: `${labelOf(c3)}: 3 kg · $114.00` })).toHaveCount(1);

    // Los precios sobreviven a recargar.
    await page.reload();
    await expect(page.getByTestId('caja')).toBeVisible();
    await tab(page, 'inventario');
    await expect(invRow(page, labelOf(c2)).locator('header span')).toHaveText('$33.00/kg');
    await expect(invRow(page, labelOf(c3)).locator('header span')).toHaveText('$38.00/kg');
    await expect(invRow(page, labelOf(other)).locator('header span')).toHaveText('$27.00/kg');
  });

  test('Caja · precio tecleado y toque inmediato en OTRA clasificación: el precio se guarda en la que se estaba editando y la nueva conserva el suyo', async ({ page }) => {
    await open(page);
    await addClass(page, { name: SIN, caliber: '2X', price: '30' });
    await addClass(page, { name: SIN, caliber: '3X', price: '38' });
    await tab(page, 'caja');
    await page.getByTestId('price').fill('34'); // el campo sigue enfocado
    await expect(page.getByTestId('price')).toBeFocused();
    const n = await toastCount(page);
    await watchTaps(page);
    await page.getByTestId('quality').filter({ hasText: chipTextRe('3X') }).tap(); // al tocar, el campo pierde el foco
    await expectSolidTap(page, 'quality');
    await expectNewToast(page, n, `Precio de ${SIN} · 2X: $34.00`);
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${SIN} · 3X`);
    await expect(page.getByTestId('price')).toHaveValue('38');
    await tab(page, 'inventario');
    await expect(invRow(page, `${SIN} · 2X`).locator('header span')).toHaveText('$34.00/kg');
    await expect(invRow(page, `${SIN} · 3X`).locator('header span')).toHaveText('$38.00/kg');
  });

  test('Caja · precio inválido (0, negativo, ambiguo «1,500», letras, 3 decimales, sobre $100,000) no cambia el precio guardado ni deja cobrar; el máximo exacto y la coma decimal sí', async ({ page }) => {
    await open(page);
    await addClass(page, { name: SIN, caliber: '2X', price: '30' });
    await addStock(page, `${SIN} · 2X`, '10');
    await tab(page, 'caja');
    await page.getByTestId('kg').fill('1');
    await page.getByTestId('bill-100').click();
    await expect(page.getByTestId('confirm')).toBeEnabled(); // con el precio bueno sí se puede cobrar

    for (const bad of ['0', '-5', '1,500', 'abc', '30.999', '100000.01', '1e2', '$30', '']) {
      await page.getByTestId('price').fill(bad);
      const n = await toastCount(page);
      await page.getByTestId('price').blur();
      await expect(page.getByTestId('confirm'), `con precio «${bad}» no debe poder cobrarse`).toBeDisabled();
      await expect(page.getByTestId('total')).toContainText('$0.00');
      expect(await toastCount(page), `con precio «${bad}» no debe guardarse ni avisar un precio nuevo`).toBe(n);
    }
    // El ambiguo se explica en lenguaje llano.
    await page.getByTestId('price').fill('1,500');
    await expect(page.getByTestId('ambiguous')).toContainText('1,500');
    await expect(page.getByTestId('ambiguous')).toContainText('Escribe 1500 o 1.5');

    // El precio guardado sigue siendo $30 tras todo lo anterior (incluso recargando).
    await page.reload();
    await expect(page.getByTestId('price')).toHaveValue('30');
    await tab(page, 'inventario');
    await expect(invRow(page, `${SIN} · 2X`).locator('header span')).toHaveText('$30.00/kg');

    // Válidos: coma decimal y el máximo exacto ($100,000).
    await tab(page, 'caja');
    await page.getByTestId('price').fill('27,5');
    let n = await toastCount(page);
    await page.getByTestId('price').blur();
    await expectNewToast(page, n, `Precio de ${SIN} · 2X: $27.50`);
    await page.getByTestId('price').fill('100000');
    n = await toastCount(page);
    await page.getByTestId('price').blur();
    await expectNewToast(page, n, /Precio de Sin semilla · 2X: \$100,000\.00/);
    await page.getByTestId('kg').fill('1');
    await expect(page.getByTestId('total')).toContainText('$100,000.00');
    // Nada de esto fue una venta.
    await tab(page, 'corte');
    await expect(page.getByTestId('sale-row')).toHaveCount(0);
  });
});

test.describe('Caja · ventas por clasificación (caso 14)', () => {
  test('caso 14 · una venta de 20 kg descuenta EXACTAMENTE 20 kg de ESA clasificación y de ninguna otra; los decimales son exactos al gramo', async ({ page }) => {
    await open(page);
    const a = { name: CON, origin: 'Oaxaca', quality: 'Primera' };
    const b = { name: CON, origin: 'Oaxaca', quality: 'Segunda' };
    const c = { name: CON, origin: 'Michoacán', quality: 'Primera' };
    await addClass(page, { ...a, price: '30' });
    await addClass(page, { ...b, price: '24' });
    await addClass(page, { ...c, price: '33' });
    await addStock(page, labelOf(a), '100');
    await addStock(page, labelOf(b), '60');
    await addStock(page, labelOf(c), '80');

    await selectInCaja(page, b);
    expect(await sellKg(page, '20', { authorize: false })).toBe(1);
    await tab(page, 'inventario');
    await expectStock(invRow(page, labelOf(b)), { physical: '40 kg', reserved: '0 g', available: '40 kg', vendido: '20 kg', manual: '60 kg' });
    await expectStock(invRow(page, labelOf(a)), { physical: '100 kg', available: '100 kg', vendido: '0 g' });
    await expectStock(invRow(page, labelOf(c)), { physical: '80 kg', available: '80 kg', vendido: '0 g' });
    // El historial de movimientos de B tiene la venta; el de A y C no.
    await invRow(page, labelOf(b)).getByTestId('show-moves').click();
    await expect(invRow(page, labelOf(b)).getByTestId('moves-list')).toContainText('venta · -20 kg físico');
    for (const other of [a, c]) {
      await invRow(page, labelOf(other)).getByTestId('show-moves').click();
      const list = invRow(page, labelOf(other)).getByTestId('moves-list');
      await expect(list).toContainText('entrada manual');
      await expect(list).not.toContainText('venta');
    }

    // Decimales: 2.5 kg y 0.125 kg (125 g) → 22.625 kg vendidos, quedan 37.375 kg, al gramo.
    await selectInCaja(page, b);
    expect(await sellKg(page, '2.5', { authorize: false })).toBe(2);
    expect(await sellKg(page, '0.125', { authorize: false })).toBe(3);
    await tab(page, 'inventario');
    await expectStock(invRow(page, labelOf(b)), { physical: '37.375 kg', available: '37.375 kg', vendido: '22.625 kg' });
    await expectStock(invRow(page, labelOf(a)), { physical: '100 kg', vendido: '0 g' });
    await expectStock(invRow(page, labelOf(c)), { physical: '80 kg', vendido: '0 g' });
    await expectIdentity(page);

    // Importes: 20 kg × $24 = $480, 2.5 × 24 = $60, 0.125 × 24 = $3.
    await tab(page, 'corte');
    const sale = (folio: number) => page.getByTestId('sale-row').filter({ has: page.locator('header strong').filter({ hasText: new RegExp(`^#${folio}$`) }) });
    await expect(sale(1).locator('header span')).toHaveText('$480.00');
    await expect(sale(2).locator('header span')).toHaveText('$60.00');
    await expect(sale(3).locator('header span')).toHaveText('$3.00');
    await expect(sale(3)).toContainText(`${labelOf(b)} 125 g`);
    await expect(page.getByTestId('r-total')).toContainText('$543.00');
  });

  test('venta con existencia insuficiente exige autorización explícita y registra el negativo autorizado; con existencia suficiente no la pide', async ({ page }) => {
    await open(page);
    const a = { name: SIN, quality: 'Primera' };
    const b = { name: SIN, quality: 'Segunda' };
    await addClass(page, { ...a, price: '30' });
    await addClass(page, { ...b, price: '20' });
    await addStock(page, labelOf(a), '50');
    await addStock(page, labelOf(b), '5');

    // Segunda: hay 5 kg y se piden 8 → hoja de autorización; «Volver» no vende nada.
    await selectInCaja(page, b);
    await page.getByTestId('kg').fill('8');
    await page.getByTestId('exact').click();
    await page.getByTestId('confirm').click();
    await expect(page.getByTestId('stock-warning')).toContainText('hay 5 kg y vendes 8 kg');
    await expect(page.getByTestId('confirm-yes')).toHaveCount(0);
    await page.getByTestId('confirm-no').click();
    await tab(page, 'corte');
    await expect(page.getByTestId('sale-row')).toHaveCount(0);
    await tab(page, 'inventario');
    await expectStock(invRow(page, labelOf(b)), { physical: '5 kg', available: '5 kg' });

    // Con la clasificación que SÍ tiene existencia (50 kg) no se pide autorización, aunque la otra esté corta.
    await selectInCaja(page, a);
    expect(await sellKg(page, '10', { authorize: false })).toBe(1);

    // Se autoriza la venta de la corta: queda en negativo, visible y registrado.
    await selectInCaja(page, b);
    expect(await sellKg(page, '8', { authorize: true })).toBe(2);
    await tab(page, 'inventario');
    const rowB = invRow(page, labelOf(b));
    await expectStock(rowB, { physical: '-3 kg', reserved: '0 g', available: '-3 kg', vendido: '8 kg' });
    await expect(rowB.getByTestId('stock-available')).toHaveClass(/neg/);
    await expect(rowB.getByTestId('stock-negative')).toBeVisible();
    // La otra clasificación no se contagió.
    await expectStock(invRow(page, labelOf(a)), { physical: '40 kg', available: '40 kg', vendido: '10 kg' });
    await expect(invRow(page, labelOf(a)).getByTestId('stock-negative')).toHaveCount(0);
    await rowB.getByTestId('show-moves').click();
    await expect(rowB.getByTestId('moves-list')).toContainText('venta · -8 kg físico');
    // Queda marcada en el historial y la auditoría la reconoce como autorizada (no es una inconsistencia).
    await tab(page, 'mas');
    await expect(page.getByTestId('hist-row').first()).toContainText('existencia autorizada');
    const audit = await runAudit(page);
    expect(audit.ok, audit.text).toBe(true);
    expect(audit.warnings).toContain(`«${labelOf(b)}» tiene existencia disponible negativa (-3 kg), con autorizaciones registradas`);
    expect(audit.warnings).not.toContain('SIN ninguna autorización');
    await expect(page.getByTestId('audit-warnings')).not.toContainText(labelOf(a));
  });

  test('Caja · variedad → clasificación: lo elegido se conserva entre ventas y recargas, no se vuelve a pedir, y al volver a una variedad se retoma la última clasificación vendida', async ({ page }) => {
    await open(page);
    const oax = { name: CON, origin: 'Oaxaca' };
    const mich = { name: CON, origin: 'Michoacán' };
    const s2 = { name: SIN, caliber: '2X' };
    const s3 = { name: SIN, caliber: '3X' };
    for (const [c, price] of [[oax, '25'], [mich, '28'], [s2, '30'], [s3, '38']] as const) {
      await addClass(page, { ...c, price });
      await addStock(page, labelOf(c), '100');
    }
    await tab(page, 'caja');
    // Primer nivel: variedades; segundo nivel: clasificaciones de la elegida. Nunca se pide nada más.
    expect(await chipTexts(page, 'variety')).toEqual([CON, SIN]);
    expect(await chipTexts(page, 'quality')).toEqual(['Oaxaca', 'Michoacán']);
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${labelOf(oax)}`);
    await expect(page.getByTestId('quality-hint'), 'en la Caja ya hay una clasificación elegida: no se pide elegir').toHaveCount(0);

    await pickClass(page, 'Michoacán');
    await expect(page.getByTestId('price')).toHaveValue('28');
    expect(await sellKg(page, '1', { authorize: false })).toBe(1);
    // Tras vender, la clasificación y el precio siguen puestos: se vende la siguiente sin volver a elegir.
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${labelOf(mich)}`);
    await expect(page.getByTestId('price')).toHaveValue('28');
    expect(await sellKg(page, '2', { authorize: false })).toBe(2);
    // ...y tras recargar (también se recuerda la última por variedad).
    await page.reload();
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${labelOf(mich)}`);

    // Otra variedad: arranca en su primera clasificación (no se vendió aún nada de ella).
    await pickVariety(page, SIN);
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${labelOf(s2)}`);
    await pickClass(page, '3X');
    expect(await sellKg(page, '1', { authorize: false })).toBe(3);
    // Al volver a «Con semilla» se retoma Michoacán (la última vendida), no la primera de la lista (Oaxaca).
    await pickVariety(page, CON);
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${labelOf(mich)}`);
    await pickVariety(page, SIN);
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${labelOf(s3)}`);

    await tab(page, 'inventario');
    await expectStock(invRow(page, labelOf(mich)), { physical: '97 kg', vendido: '3 kg' });
    await expectStock(invRow(page, labelOf(s3)), { physical: '99 kg', vendido: '1 kg' });
    await expectStock(invRow(page, labelOf(oax)), { physical: '100 kg', vendido: '0 g' });
    await expectStock(invRow(page, labelOf(s2)), { physical: '100 kg', vendido: '0 g' });
  });

  test('Caja · con más de 6 clasificaciones de una variedad se ofrece «Ver las N clasificaciones» (hoja con precios) y, tras vender distintas, aparecen los chips Recientes', async ({ page }) => {
    await open(page);
    const calibers = [['1X', '10'], ['2X', '11'], ['3X', '12'], ['200', '13'], ['300', '14'], ['400', '15'], ['500', '16']] as const;
    for (const [cal, price] of calibers) await addClass(page, { name: SIN, caliber: cal, price });
    for (const cal of ['2X', '300', '500']) await addStock(page, `${SIN} · ${cal}`, '20');

    await tab(page, 'caja');
    await expect(page.getByTestId('quality-all')).toHaveText('Ver las 7 clasificaciones');
    await expect(page.getByTestId('quality'), 'con tantas solo se muestra la elegida').toHaveCount(1);
    await expect(page.getByTestId('recent-chip'), 'sin ventas todavía no hay recientes').toHaveCount(0);
    // La hoja lista TODAS, con su precio.
    await page.getByTestId('quality-all').click();
    await expect(page.getByTestId('quality-sheet')).toBeVisible();
    const items = (await page.getByTestId('quality-sheet-item').allInnerTexts()).map(norm);
    expect(items).toEqual(calibers.map(([cal, price]) => `${cal} $${price}.00/kg`));
    await page.getByTestId('quality-sheet-close').click();
    await expect(page.getByTestId('quality-sheet')).toHaveCount(0);

    await pickClass(page, '300');
    await expect(page.getByTestId('price')).toHaveValue('14');
    expect(await sellKg(page, '1', { authorize: false })).toBe(1);
    await expect(page.getByTestId('recent-chip'), 'una sola clasificación vendida: aún no hay recientes').toHaveCount(0);
    await pickClass(page, '2X');
    expect(await sellKg(page, '1', { authorize: false })).toBe(2);
    expect(await chipTexts(page, 'recent-chip')).toEqual([`${SIN} · 2X`, `${SIN} · 300`]); // la más reciente primero
    await pickClass(page, '500');
    expect(await sellKg(page, '1', { authorize: false })).toBe(3);
    expect(await chipTexts(page, 'recent-chip')).toEqual([`${SIN} · 500`, `${SIN} · 2X`, `${SIN} · 300`]);

    // Tocar un reciente elige esa clasificación (y su precio) de un toque.
    await page.getByTestId('recent-chip').filter({ hasText: exactText(`${SIN} · 300`) }).click();
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${SIN} · 300`);
    await expect(page.getByTestId('price')).toHaveValue('14');
    await tab(page, 'inventario');
    for (const cal of ['2X', '300', '500']) await expectStock(invRow(page, `${SIN} · ${cal}`), { physical: '19 kg', vendido: '1 kg' });

    // Los recientes se recuerdan al recargar (viven en el teléfono, no en la pantalla).
    await page.reload();
    await expect(page.getByTestId('caja')).toBeVisible();
    expect(await chipTexts(page, 'recent-chip')).toEqual([`${SIN} · 500`, `${SIN} · 2X`, `${SIN} · 300`]);

    // Se oculta una clasificación: con 6 activas ya caben todas como chips (sin «Ver las N») y «Recientes» (solo con más de 6)
    // se retira; la Caja pasa a otra activa y la oculta no aparece en ningún lado.
    await setHidden(page, `${SIN} · 300`, true);
    await tab(page, 'caja');
    await expect(page.getByTestId('quality-all')).toHaveCount(0);
    expect(await chipTexts(page, 'quality')).toEqual(['1X', '2X', '3X', '200', '400', '500']);
    await expect(page.getByTestId('recent-chip')).toHaveCount(0);
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${SIN} · 1X`); // la primera activa
  });

  test('Caja · kilos vacíos, cero, negativos, ambiguos «1,500», con letras, científicos o por encima del máximo no se pueden cobrar ni mueven inventario; el máximo exacto y la coma decimal sí', async ({ page }) => {
    await open(page);
    await addClass(page, { name: SIN, caliber: '2X', price: '30' });
    await addStock(page, `${SIN} · 2X`, '10');
    await tab(page, 'caja');
    await page.getByTestId('bill-1000').click();
    for (const bad of ['', '0', '-1', 'abc', '1,500', '1e3', '2.5kg', '0.0001', '1.2345', '200000.001', '200001']) {
      await page.getByTestId('kg').fill(bad);
      await expect(page.getByTestId('confirm'), `kilos «${bad}» no deben poder cobrarse`).toBeDisabled();
    }
    await page.getByTestId('kg').fill('1,500');
    await expect(page.getByTestId('ambiguous')).toContainText('Escribe 1500 o 1.5');
    // Frontera: 200 000 kg se aceptan (otra cosa es que haya existencia: pediría autorización) y 1 g también.
    await page.getByTestId('kg').fill('200000');
    await page.getByTestId('exact').click();
    await expect(page.getByTestId('confirm')).toBeEnabled();
    await page.getByTestId('kg').fill('0.001');
    await page.getByTestId('exact').click();
    await expect(page.getByTestId('total')).toContainText('$0.03');
    // Nada se movió.
    await tab(page, 'corte');
    await expect(page.getByTestId('sale-row')).toHaveCount(0);
    await tab(page, 'inventario');
    await expectStock(invRow(page, `${SIN} · 2X`), { physical: '10 kg', available: '10 kg', vendido: '0 g' });
    // Coma decimal: «1,5» son 1.5 kg.
    await tab(page, 'caja');
    await page.getByTestId('kg').fill('1,5');
    await page.getByTestId('exact').click();
    await page.getByTestId('confirm').click();
    await page.getByTestId('confirm-yes').click();
    await expect(page.getByTestId('last-sale')).toContainText('#1');
    await tab(page, 'inventario');
    await expectStock(invRow(page, `${SIN} · 2X`), { physical: '8.5 kg', vendido: '1.5 kg' });
  });
});

test.describe('Caja · importes excesivos', () => {
  test('Caja · un importe por encima de $1,000,000,000 (200 000 kg a $100 000 con tarjeta) se avisa ANTES y no deja cobrar, sin vender; el máximo exacto sí se cobra y cuadra en Corte y auditoría', async ({ page }) => {
    await open(page);
    const a = { name: SIN, caliber: '2X' };
    const label = labelOf(a);
    await addClass(page, { ...a, price: '100000' }); // el precio máximo permitido por unidad
    await addStock(page, label, '200000'); // la existencia máxima por operación
    await tab(page, 'caja');
    await page.getByTestId('method-tarjeta').click();

    // 200 000 kg × $100 000 = $20,000,000,000: pasa el tope de importe (el tope es $1,000,000,000). La Caja lo dice antes
    // de abrir la hoja de cobro y el botón no deja cobrar; la base tampoco lo aceptaría.
    await page.getByTestId('kg').fill('200000');
    await expect(page.getByTestId('total-too-big')).toContainText('rebasa el máximo');
    await expect(page.getByTestId('confirm')).toBeDisabled();
    await page.getByTestId('confirm').click({ force: true });
    await expect(page.getByTestId('confirm-sheet')).toHaveCount(0);
    await tab(page, 'inventario');
    await expectStock(invRow(page, label), { physical: '200,000 kg', reserved: '0 g', vendido: '0 g' });
    await tab(page, 'corte');
    await expect(page.getByTestId('sale-row')).toHaveCount(0);

    // 10 000 kg × $100 000 = $1,000,000,000 exactos: es el máximo y SÍ se cobra (sin aviso).
    await tab(page, 'caja');
    await page.getByTestId('kg').fill('10000');
    await expect(page.getByTestId('total-too-big')).toHaveCount(0);
    expect(await cobrarConTarjeta(page)).toBe(1);
    await tab(page, 'inventario');
    await expectStock(invRow(page, label), { physical: '190,000 kg', vendido: '10,000 kg' });
    await tab(page, 'corte');
    await expect(page.getByTestId('r-total')).toContainText('$1,000,000,000.00');
    expect((await runAudit(page)).ok).toBe(true);
  });
});

test.describe('Caja · preferencias y precio pendiente', () => {
  test('Caja · preferencias guardadas dañadas o de clasificaciones que ya no existen no rompen la pantalla: se elige la primera activa y se puede vender', async ({ page }) => {
    await open(page);
    await addClass(page, { name: SIN, caliber: '2X', price: '30' });
    await addClass(page, { name: SIN, caliber: '3X', price: '38' });
    await addStock(page, `${SIN} · 2X`, '10');
    const damaged: Array<Record<string, string>> = [
      { 'cc.variety': 'id-que-ya-no-existe', 'cc.recent': '{"a":1}', 'cc.lastByVariety': '[1,2,3]' },
      { 'cc.variety': '', 'cc.recent': 'esto no es json', 'cc.lastByVariety': 'tampoco' },
      { 'cc.variety': 'x', 'cc.recent': '[1,null,{"a":2}]', 'cc.lastByVariety': '{"sin semilla":"otro-id-inexistente"}' },
    ];
    for (const prefs of damaged) {
      await page.evaluate((p) => Object.entries(p).forEach(([k, v]) => localStorage.setItem(k, v)), prefs);
      await page.reload();
      await expect(page.getByTestId('caja'), `con preferencias ${JSON.stringify(prefs)}`).toBeVisible();
      await expect(page.getByTestId('fatal')).toHaveCount(0);
      await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${SIN} · 2X`);
      await pickVariety(page, SIN);
      await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${SIN} · 2X`); // sin «última vendida» válida: la primera
      expect(await chipTexts(page, 'quality')).toEqual(['2X', '3X']);
    }
    expect(await sellKg(page, '1', { authorize: false })).toBe(1);
    await tab(page, 'inventario');
    await expectStock(invRow(page, `${SIN} · 2X`), { physical: '9 kg', vendido: '1 kg' });
  });

  test('precio pendiente · la Caja marca la clasificación «sin precio» y no cobra; ponerle precio en «Editar» la habilita y volver a «Sin precio todavía» la bloquea otra vez', async ({ page }) => {
    await open(page);
    const a = `${SIN} · 2X`;
    const b = `${SIN} · 3X`;
    await addClass(page, { name: SIN, caliber: '2X', price: '30' });
    await addClass(page, { name: SIN, caliber: '3X', price: null });
    await addStock(page, b, '20');
    await tab(page, 'caja');
    // Solo la que no tiene precio lleva la marca; la otra no.
    const marked = page.getByTestId('quality').filter({ hasText: 'sin precio' });
    await expect(marked).toHaveCount(1);
    await expect(marked).toHaveText(/^\s*3X\s*·\s*sin precio\s*$/);
    await pickClass(page, '3X');
    await expect(page.getByTestId('no-price-hint')).toBeVisible();
    await page.getByTestId('kg').fill('2');
    await page.getByTestId('bill-100').click();
    await expect(page.getByTestId('confirm')).toBeDisabled();

    // Se le pone precio desde Inventario → Editar: la Caja ya cobra, a SU precio.
    const edit = await openEdit(page, b);
    await expect(edit.form.getByTestId('edit-no-price')).toBeChecked();
    await patchForm(edit.form, { price: '36' });
    let n = await toastCount(page);
    await edit.form.getByTestId('edit-add').click();
    await expectNewToast(page, n, 'Clasificación actualizada');
    await expect(invRow(page, b).locator('header span')).toHaveText('$36.00/kg');
    await tab(page, 'caja');
    await expect(page.getByTestId('no-price-hint')).toHaveCount(0);
    await expect(page.getByTestId('price')).toHaveValue('36');
    await expect(page.getByTestId('quality').filter({ hasText: 'sin precio' })).toHaveCount(0);
    expect(await sellKg(page, '2', { authorize: false })).toBe(1); // $72.00
    await tab(page, 'corte');
    await expect(page.getByTestId('sale-row')).toContainText('$72.00');

    // Volver a «Sin precio todavía»: se bloquea de nuevo, la venta anterior conserva su precio y la otra clasificación no se toca.
    const again = await openEdit(page, b);
    await patchForm(again.form, { price: null });
    n = await toastCount(page);
    await again.form.getByTestId('edit-add').click();
    await expectNewToast(page, n, 'Clasificación actualizada');
    await expect(invRow(page, b).locator('header span')).toHaveText('Sin precio');
    await expect(invRow(page, a).locator('header span')).toHaveText('$30.00/kg');
    await tab(page, 'caja');
    await expect(page.getByTestId('no-price-hint')).toBeVisible();
    await page.getByTestId('kg').fill('1');
    await page.getByTestId('bill-100').click();
    await expect(page.getByTestId('confirm')).toBeDisabled();
    await tab(page, 'corte');
    await expect(page.getByTestId('sale-row')).toContainText('$72.00');
  });
});

test.describe('Vales por clasificación (caso 15)', () => {
  test('caso 15 · vale: reserva sin descontar el físico, entregar descuenta UNA sola vez y libera la reserva; la otra clasificación no cambia', async ({ page }) => {
    await open(page);
    const a = { name: CON, origin: 'Oaxaca' };
    const b = { name: CON, origin: 'Michoacán' };
    await addClass(page, { ...a, price: '25' });
    await addClass(page, { ...b, price: '25' });
    await addStock(page, labelOf(a), '100');
    await addStock(page, labelOf(b), '100');

    await selectInCaja(page, a);
    expect(await sellKg(page, '20', { vale: true, customer: 'Doña Mary', authorize: false })).toBe(1);
    await expect(page.getByTestId('last-sale')).toContainText('VALE V-1 pendiente de entrega');
    await expect(page.getByTestId('stock-hint')).toContainText('Disponible: 80 kg · Reservado: 20 kg');

    // Reservar NO descuenta el físico: sigue en 100 kg; lo apartado baja el disponible; nada se ha vendido todavía.
    await tab(page, 'inventario');
    await expectStock(invRow(page, labelOf(a)), { physical: '100 kg', reserved: '20 kg', available: '80 kg', vendido: '0 g', manual: '100 kg' });
    await expectStock(invRow(page, labelOf(b)), { physical: '100 kg', reserved: '0 g', available: '100 kg' });
    await invRow(page, labelOf(a)).getByTestId('show-moves').click();
    await expect(invRow(page, labelOf(a)).getByTestId('moves-list')).toContainText('reserva por vale · +20 reservado');
    await expect(invRow(page, labelOf(a)).getByTestId('moves-list')).not.toContainText('entrega de vale');
    await tab(page, 'corte');
    await expect(page.getByTestId('r-total')).toContainText('$500.00');
    await expect(page.getByTestId('r-expected')).toContainText('$500.00');

    // Entregar (con doble toque): el físico baja UNA vez y la reserva se libera.
    await tab(page, 'vales');
    await expect(page.getByTestId('vale')).toHaveCount(1);
    await expect(page.getByTestId('vale')).toContainText(`${labelOf(a)} · 20 kg`);
    await expect(page.getByTestId('vale')).toContainText('Doña Mary');
    await page.getByTestId('deliver').dblclick();
    await expect(page.getByTestId('vale')).toHaveCount(0);
    await tab(page, 'inventario');
    await expectStock(invRow(page, labelOf(a)), { physical: '80 kg', reserved: '0 g', available: '80 kg', vendido: '20 kg' });
    await expectStock(invRow(page, labelOf(b)), { physical: '100 kg', reserved: '0 g', available: '100 kg' });
    await invRow(page, labelOf(a)).getByTestId('show-moves').click();
    await expect(invRow(page, labelOf(a)).getByTestId('moves-list')).toContainText('entrega de vale · -20 kg físico -20 reservado');
    await expect(invRow(page, labelOf(a)).getByTestId('moves-list').locator('li')).toHaveCount(3); // entrada, reserva y UNA entrega
    // Entregar no es dinero nuevo.
    await tab(page, 'corte');
    await expect(page.getByTestId('r-total')).toContainText('$500.00');
    await expect(page.getByTestId('r-expected')).toContainText('$500.00');
    await tab(page, 'vales');
    await page.getByTestId('vales-entregado').click();
    await expect(page.getByTestId('vale')).toHaveCount(1);
    await expect(page.getByTestId('deliver')).toHaveCount(0);
    await tab(page, 'inventario');
    await expectIdentity(page);
    expect((await runAudit(page)).ok).toBe(true);
  });

  test('caso 15 · cancelar un vale (con devolución en efectivo y sin devolución) libera la reserva sin tocar el físico ni a las demás clasificaciones', async ({ page }) => {
    await open(page);
    const a = { name: SIN, quality: 'Primera' };
    const b = { name: SIN, quality: 'Segunda' };
    await addClass(page, { ...a, price: '25' });
    await addClass(page, { ...b, price: '25' });
    await addStock(page, labelOf(a), '100');
    await addStock(page, labelOf(b), '50');
    await selectInCaja(page, a);
    expect(await sellKg(page, '10', { vale: true, authorize: false })).toBe(1); // V-1 · $250.00
    await selectInCaja(page, b);
    expect(await sellKg(page, '5', { vale: true, authorize: false })).toBe(2); // V-2 · $125.00
    await tab(page, 'inventario');
    await expectStock(invRow(page, labelOf(a)), { physical: '100 kg', reserved: '10 kg', available: '90 kg' });
    await expectStock(invRow(page, labelOf(b)), { physical: '50 kg', reserved: '5 kg', available: '45 kg' });

    // V-1 (de Primera) se cancela devolviendo efectivo: libera SOLO lo de Primera.
    await cancelVale(page, 1, 'el cliente no vino', 'efectivo');
    await tab(page, 'inventario');
    await expectStock(invRow(page, labelOf(a)), { physical: '100 kg', reserved: '0 g', available: '100 kg', vendido: '0 g' });
    await expectStock(invRow(page, labelOf(b)), { physical: '50 kg', reserved: '5 kg', available: '45 kg' });
    await tab(page, 'corte');
    await expect(page.getByTestId('r-refunds')).toContainText('$250.00');
    await expect(page.getByTestId('r-expected')).toContainText('$125.00'); // 375 cobrados − 250 devueltos

    // V-2 (de Segunda) se cancela sin devolver dinero: libera su reserva y no cambia el efectivo.
    await cancelVale(page, 2, 'error de captura', 'ninguna');
    await tab(page, 'inventario');
    await expectStock(invRow(page, labelOf(b)), { physical: '50 kg', reserved: '0 g', available: '50 kg', vendido: '0 g' });
    await expectStock(invRow(page, labelOf(a)), { physical: '100 kg', reserved: '0 g', available: '100 kg' });
    await tab(page, 'corte');
    await expect(page.getByTestId('r-refunds')).toContainText('$250.00');
    await expect(page.getByTestId('r-expected')).toContainText('$125.00');
    await tab(page, 'vales');
    await page.getByTestId('vales-cancelado').click();
    await expect(page.getByTestId('vale')).toHaveCount(2);
    await expect(page.getByTestId('cancel-info').first()).toContainText('NO se devolvió dinero');
    await expect(page.getByTestId('deliver')).toHaveCount(0);
    await tab(page, 'inventario');
    await expectIdentity(page);
    expect((await runAudit(page)).ok).toBe(true);
  });

  test('caso 15 · lo apartado por un vale NO se puede vender: el disponible es físico − apartado y pide autorización aunque haya físico', async ({ page }) => {
    await open(page);
    const a = { name: CON, origin: 'Oaxaca' };
    const label = labelOf(a);
    await addClass(page, { ...a, price: '25' });
    await addStock(page, label, '30');
    await selectInCaja(page, a);
    expect(await sellKg(page, '20', { vale: true, authorize: false })).toBe(1); // reserva 20 de 30
    await expect(page.getByTestId('stock-hint')).toContainText('Disponible: 10 kg · Reservado: 20 kg');

    // Quedan 10 kg DISPONIBLES (aunque haya 30 físicos): 15 kg requieren autorización; «Volver» no vende.
    await page.getByTestId('kg').fill('15');
    await page.getByTestId('exact').click();
    await page.getByTestId('confirm').click();
    await expect(page.getByTestId('stock-warning')).toContainText('hay 10 kg y vendes 15 kg');
    await expect(page.getByTestId('confirm-yes')).toHaveCount(0);
    await page.getByTestId('confirm-no').click();
    await tab(page, 'inventario');
    await expectStock(invRow(page, label), { physical: '30 kg', reserved: '20 kg', available: '10 kg' });

    // Exactamente los 10 disponibles sí se venden sin autorización.
    expect(await sellKg(page, '10', { authorize: false })).toBe(2);
    await tab(page, 'inventario');
    await expectStock(invRow(page, label), { physical: '20 kg', reserved: '20 kg', available: '0 g', vendido: '10 kg' });
    // Y ya no queda nada vendible: 1 kg más exige autorización.
    await tab(page, 'caja');
    await page.getByTestId('kg').fill('1');
    await page.getByTestId('exact').click();
    await page.getByTestId('confirm').click();
    await expect(page.getByTestId('stock-warning')).toContainText('hay 0 g y vendes 1 kg');
    await page.getByTestId('confirm-no').click();
    // Entregar el vale deja físico 0 y reservado 0: nada se descontó dos veces.
    await deliverVale(page, 1);
    await tab(page, 'inventario');
    await expectStock(invRow(page, label), { physical: '0 g', reserved: '0 g', available: '0 g', vendido: '30 kg' });
    await expectIdentity(page);
    expect((await runAudit(page)).ok).toBe(true);
  });
});

test.describe('Vales con existencia insuficiente y anulaciones', () => {
  test('caso 15 · un vale con existencia insuficiente exige autorización explícita; el negativo se ve, entregarlo no lo cambia y se regulariza con una entrada', async ({ page }) => {
    await open(page);
    const a = { name: SIN, quality: 'Primera' };
    const label = labelOf(a);
    await addClass(page, { ...a, price: '25' });
    await addStock(page, label, '5');
    await selectInCaja(page, a);
    expect(await sellKg(page, '8', { vale: true, authorize: true })).toBe(1); // 5 kg de existencia, vale de 8
    await expect(page.getByTestId('stock-hint')).toContainText('Disponible: -3 kg · Reservado: 8 kg');
    await expect(page.getByTestId('stock-hint')).toContainText('quedan -3 kg: revisa inventario');
    await tab(page, 'inventario');
    await expectStock(invRow(page, label), { physical: '5 kg', reserved: '8 kg', available: '-3 kg' });
    await expect(invRow(page, label).getByTestId('stock-negative')).toBeVisible();

    // Entregar libera el apartado y descuenta el físico: el disponible negativo no cambia.
    await deliverVale(page, 1);
    await tab(page, 'inventario');
    await expectStock(invRow(page, label), { physical: '-3 kg', reserved: '0 g', available: '-3 kg', vendido: '8 kg' });
    let audit = await runAudit(page);
    expect(audit.ok, audit.text).toBe(true);
    expect(audit.warnings).toContain(`«${label}» tiene existencia disponible negativa (-3 kg), con autorizaciones registradas`);

    // Se regulariza con una entrada: desaparece el negativo y el aviso de la auditoría.
    await moveStock(page, label, 'entrada', '10', 'llegó mercancía');
    await expectStock(invRow(page, label), { physical: '7 kg', available: '7 kg', manual: '15 kg' });
    await expect(invRow(page, label).getByTestId('stock-negative')).toHaveCount(0);
    await expectIdentity(page);
    audit = await runAudit(page);
    expect(audit.ok).toBe(true);
    expect(audit.warnings).not.toContain(label);
  });

  test('anular una venta de una clasificación renombrada y oculta devuelve los kilos a ESA clasificación y a ninguna otra', async ({ page }) => {
    await open(page);
    const a = { name: SIN, caliber: '2X' };
    const b = { name: SIN, caliber: '3X' };
    await addClass(page, { ...a, price: '30' });
    await addClass(page, { ...b, price: '38' });
    await addStock(page, labelOf(a), '50');
    await addStock(page, labelOf(b), '50');
    await selectInCaja(page, a);
    expect(await sellKg(page, '5', { authorize: false })).toBe(1); // $150.00
    await selectInCaja(page, b);
    expect(await sellKg(page, '4', { authorize: false })).toBe(2); // $152.00
    const renamed = `${SIN} · Primera · 2X`;
    const edit = await openEdit(page, labelOf(a));
    await patchForm(edit.form, { quality: 'Primera' });
    await edit.form.getByTestId('edit-add').click();
    await expect(page.getByTestId('toast')).toContainText('Clasificación actualizada');
    await setHidden(page, renamed, true);

    // Se anula la venta #1 (de la que hoy se llama distinto y está oculta).
    await tab(page, 'corte');
    page.once('dialog', (d) => d.accept('error de captura'));
    const n = await toastCount(page);
    const sale1 = page.getByTestId('sale-row').filter({ has: page.locator('header strong').filter({ hasText: /^#1$/ }) });
    await sale1.getByRole('button', { name: 'Anular' }).click();
    await expectNewToast(page, n, 'Venta #1 anulada');
    await expect(sale1).toContainText('ANULADA');
    await expect(sale1.getByRole('button', { name: 'Anular' }), 'ya anulada: no se ofrece otra vez').toHaveCount(0);
    await expect(page.getByTestId('r-total')).toContainText('$152.00');
    await expect(page.getByRole('listitem').filter({ hasText: labelOf(a) })).toHaveCount(0); // la anulada ya no cuenta en «Por variedad»
    await expect(page.getByRole('listitem').filter({ hasText: `${labelOf(b)}: 4 kg · $152.00` })).toHaveCount(1);

    await tab(page, 'inventario');
    await expectStock(invRow(page, renamed), { physical: '50 kg', available: '50 kg', vendido: '0 g', manual: '50 kg' }); // volvieron los 5 kg
    await expect(invRow(page, renamed)).toHaveClass(/inactive/);
    await expectStock(invRow(page, labelOf(b)), { physical: '46 kg', vendido: '4 kg' }); // la otra no se tocó
    await expectIdentity(page);
    await tab(page, 'mas');
    await expect(page.getByTestId('hist-summary')).toContainText('1 ventas · $152.00 · 1 anuladas');
    expect((await runAudit(page)).ok).toBe(true);
  });
});

test.describe('Vales · confirmaciones repetidas', () => {
  test('doble toque en «Entregar» entrega el vale UNA sola vez y no asusta con un error', async ({ page }) => {
    await open(page);
    const a = { name: CON, origin: 'Oaxaca' };
    const label = labelOf(a);
    await addClass(page, { ...a, price: '25' });
    await addStock(page, label, '30');
    await selectInCaja(page, a);
    expect(await sellKg(page, '3', { vale: true, authorize: false })).toBe(1);
    expect(await sellKg(page, '2', { vale: true, authorize: false })).toBe(2);

    await tab(page, 'vales');
    const n = await toastCount(page);
    await page.getByTestId('vale').filter({ hasText: 'Vale V-1' }).getByTestId('deliver').dblclick();
    await expect(page.getByTestId('vale')).toHaveCount(1); // queda solo V-2
    // Viaje de ida y vuelta a la base: cualquier segundo intento ya terminó.
    await tab(page, 'inventario');
    await expectStock(invRow(page, label), { physical: '27 kg', reserved: '2 kg', available: '25 kg', vendido: '3 kg' }); // 30 − 3 (una vez)
    expect(await errorToastsSince(page, n), 'el segundo toque no debe mostrar un error: la entrega ya se hizo bien').toEqual([]);
    await invRow(page, label).getByTestId('show-moves').click();
    await expect(invRow(page, label).getByTestId('moves-list').locator('li').filter({ hasText: 'entrega de vale' })).toHaveCount(1);
  });

  test('doble toque en «Cancelar vale» cancela UNA sola vez, libera la reserva una vez y no asusta con un error', async ({ page }) => {
    await open(page);
    const a = { name: CON, origin: 'Oaxaca' };
    const label = labelOf(a);
    await addClass(page, { ...a, price: '25' });
    await addStock(page, label, '30');
    await selectInCaja(page, a);
    expect(await sellKg(page, '4', { vale: true, authorize: false })).toBe(1);
    expect(await sellKg(page, '6', { vale: true, authorize: false })).toBe(2);

    await tab(page, 'vales');
    await page.getByTestId('vale').filter({ hasText: 'Vale V-1' }).getByTestId('cancel-vale').click();
    await page.getByTestId('cancel-reason').fill('el cliente no vino');
    await page.getByTestId('refund-efectivo').check();
    const n = await toastCount(page);
    await page.getByTestId('cancel-confirm').dblclick();
    await expect(page.getByTestId('cancel-sheet')).toHaveCount(0);
    await tab(page, 'inventario');
    await expectStock(invRow(page, label), { physical: '30 kg', reserved: '6 kg', available: '24 kg' }); // solo se liberaron los 4 kg de V-1
    expect(await errorToastsSince(page, n), 'el segundo toque no debe mostrar un error: la cancelación ya se hizo bien').toEqual([]);
    await tab(page, 'corte');
    await expect(page.getByTestId('r-refunds')).toContainText('$100.00'); // la devolución en efectivo salió UNA vez
  });
});

test.describe('Vales · datos inválidos', () => {
  test('caso 15 · un vale con nombre de cliente demasiado largo o con caracteres invisibles se rechaza: no reserva, no vende y no gasta folio', async ({ page }) => {
    await open(page);
    const a = { name: CON, origin: 'Oaxaca' };
    const label = labelOf(a);
    await addClass(page, { ...a, price: '25' });
    await addStock(page, label, '30');
    await selectInCaja(page, a);
    await page.getByTestId('kg').fill('5');
    await page.getByTestId('exact').click();
    await page.getByTestId('is-vale').check();

    const attempt = async (customer: string, error: RegExp) => {
      await page.getByTestId('customer').fill(customer);
      await page.getByTestId('confirm').click();
      await expect(page.getByTestId('confirm-sheet')).toBeVisible();
      const n = await toastCount(page);
      await page.getByTestId('confirm-yes').click();
      await expectNewToast(page, n, error, 'error');
      await expect(page.getByTestId('confirm-sheet')).toHaveCount(0);
      await expect(page.getByTestId('kg'), 'lo capturado no se pierde tras el error').toHaveValue('5');
    };
    await attempt('x'.repeat(121), /Cliente: máximo 120 caracteres \(llevas 121\)/);
    await attempt(`Do${String.fromCharCode(0x200b)}ña Mary`, /Cliente: contiene caracteres no permitidos/);
    await tab(page, 'inventario');
    await expectStock(invRow(page, label), { physical: '30 kg', reserved: '0 g', available: '30 kg' });
    await tab(page, 'vales');
    await expect(page.getByTestId('vale')).toHaveCount(0);
    await tab(page, 'corte');
    await expect(page.getByTestId('sale-row')).toHaveCount(0);

    // Con 120 caracteres exactos sí se guarda, y es la venta #1 / vale V-1 (los intentos fallidos no gastaron folio).
    await tab(page, 'caja');
    await page.getByTestId('customer').fill('x'.repeat(120));
    await page.getByTestId('confirm').click();
    const n = await toastCount(page);
    await page.getByTestId('confirm-yes').click();
    await expectNewToast(page, n, 'Venta #1 guardada');
    await expect(page.getByTestId('last-sale')).toContainText('VALE V-1 pendiente de entrega');
    await tab(page, 'inventario');
    await expectStock(invRow(page, label), { physical: '30 kg', reserved: '5 kg', available: '25 kg' });
  });
});

test.describe('Inventario por clasificación', () => {
  test('inventario · cada clasificación tiene su fila con físico, apartado, disponible, entradas, vendido, mermas y conteos, coherentes con «Movimientos»', async ({ page }) => {
    await open(page);
    const a = `${SIN} · Primera`;
    const b = `${SIN} · Segunda`;
    await addClass(page, { name: SIN, quality: 'Primera', price: '30' });
    await addClass(page, { name: SIN, quality: 'Segunda', price: '20' });
    // Sin movimientos todavía: solo existencias en cero, sin acumulados.
    await expectStock(invRow(page, a), { physical: '0 g', reserved: '0 g', available: '0 g' });
    await expect(invRow(page, a).getByTestId('stock-manual')).toHaveCount(0);

    await moveStock(page, a, 'entrada', '100', 'inventario inicial');
    await selectInCaja(page, { name: SIN, quality: 'Primera' });
    expect(await sellKg(page, '10', { authorize: false })).toBe(1);
    expect(await sellKg(page, '15', { vale: true, customer: 'Don Beto', authorize: false })).toBe(2);
    await moveStock(page, a, 'merma', '3', 'se echó a perder');
    await moveStock(page, a, 'ajuste', '85', 'conteo del lunes'); // contado 85; el sistema decía 87 → ajuste de −2

    const rowA = invRow(page, a);
    await expectStock(rowA, { physical: '85 kg', reserved: '15 kg', available: '70 kg', manual: '100 kg', vendido: '10 kg', merma: '3 kg', ajuste: '-2 kg' });
    // «Segunda» no se enteró de nada.
    await expectStock(invRow(page, b), { physical: '0 g', reserved: '0 g', available: '0 g' });
    await expect(invRow(page, b).getByTestId('stock-manual')).toHaveCount(0);
    await expectIdentity(page);

    // Historial «Movimientos» de la fila: exactamente lo que se hizo, con sus motivos.
    await rowA.getByTestId('show-moves').click();
    const list = rowA.getByTestId('moves-list');
    await expect(list.locator('li')).toHaveCount(5);
    const lines = (await list.locator('li').allInnerTexts()).map(norm);
    const has = (frag: string) => lines.filter((l) => l.includes(frag));
    expect(has('entrada manual · +100 kg físico · inventario inicial')).toHaveLength(1);
    expect(has('venta · -10 kg físico · Folio 1')).toHaveLength(1);
    expect(has('reserva por vale · +15 reservado · Vale V-1')).toHaveLength(1);
    expect(has('merma · -3 kg físico · se echó a perder')).toHaveLength(1);
    expect(has('conteo físico (ajuste) · -2 kg físico · conteo del lunes')).toHaveLength(1);
    // Cerrar el historial: se vuelve a tocar «Movimientos».
    await rowA.getByTestId('show-moves').click();
    await expect(list).toHaveCount(0);

    // La entrega del vale mueve físico y apartado juntos.
    await deliverVale(page, 1);
    await tab(page, 'inventario');
    await expectStock(rowA, { physical: '70 kg', reserved: '0 g', available: '70 kg', vendido: '25 kg' });
    await expectIdentity(page);
  });

  test('inventario · «Movimientos» muestra todos los movimientos de la clasificación o avisa que hay más (no los recorta en silencio)', async ({ page }) => {
    test.setTimeout(90_000); // 17 entradas seguidas por la interfaz
    await open(page);
    const a = `${SIN} · Primera`;
    await addClass(page, { name: SIN, quality: 'Primera', price: '30' });
    for (let i = 1; i <= 17; i++) await addStock(page, a, String(i));
    const row = invRow(page, a);
    await expectStock(row, { physical: '153 kg', manual: '153 kg' }); // 1 + 2 + … + 17
    await row.getByTestId('show-moves').click();
    const list = row.getByTestId('moves-list');
    await expect(list).toBeVisible();
    const shown = await list.locator('li').count();
    const rowText = norm(await row.innerText());
    const disclosed = /(últimos|más antiguos|más movimientos|ver (todos|más)|\b15 de 17\b|mostrando)/i.test(rowText);
    expect(shown === 17 || disclosed, `se ven ${shown} de 17 movimientos y no hay ningún aviso de que faltan`).toBe(true);
  });

  test('inventario · una recepción suma a UNA clasificación (columna Recepciones) y una entrada manual de esa misma clasificación avisa del posible doble conteo', async ({ page }) => {
    await open(page);
    const two = `${SIN} · 2X`;
    const three = `${SIN} · 3X`;
    await addClass(page, { name: SIN, caliber: '2X', price: '30' });
    await addClass(page, { name: SIN, caliber: '3X', price: '38' });

    // Recepción de 120 kg netos a granel de la clasificación 3X.
    await tab(page, 'recepcion');
    await page.getByTestId('rec-variety').filter({ hasText: exactText(SIN) }).click();
    await page.getByTestId('rec-class').filter({ hasText: exactText('3X') }).click();
    await page.getByTestId('rec-net-direct').fill('120');
    await page.getByTestId('rec-confirm').click();
    await expect(page.getByTestId('rec-sheet-net')).toHaveAttribute('data-milli', '120000');
    const n = await toastCount(page);
    await page.getByTestId('rec-confirm-yes').click();
    await expectNewToast(page, n, 'Recepción R-1 registrada: +120 kg');

    await tab(page, 'inventario');
    await expectStock(invRow(page, three), { physical: '120 kg', available: '120 kg', recibido: '120 kg', manual: '0 g', vendido: '0 g' });
    await expectStock(invRow(page, two), { physical: '0 g', available: '0 g' });
    await expect(invRow(page, two).getByTestId('stock-recibido')).toHaveCount(0); // 2X no se enteró
    await invRow(page, three).getByTestId('show-moves').click();
    await expect(invRow(page, three).getByTestId('moves-list')).toContainText('recepción de mercancía R-1 · +120 kg físico');

    // Entrada manual de la MISMA clasificación: avisa «ya se recibió en Recepción»; Cancelar no cambia nada.
    const row = invRow(page, three);
    await row.getByTestId('move-entrada').click();
    await row.getByTestId('move-qty').fill('5');
    await row.getByTestId('move-save').click();
    await expect(page.getByTestId('warnings-sheet')).toBeVisible();
    await expect(page.getByTestId('warnings-text')).toContainText('Hace poco se registró en Recepción mercancía de esta misma clasificación (R-1)');
    await page.getByTestId('warnings-no').click();
    await expect(page.getByTestId('warnings-sheet')).toHaveCount(0);
    await expectStock(row, { physical: '120 kg', manual: '0 g' });
    // Reconocido el aviso, se registra aparte de lo recibido.
    await row.getByTestId('move-save').click();
    await expect(page.getByTestId('warnings-sheet')).toBeVisible();
    const n2 = await toastCount(page);
    await page.getByTestId('warnings-yes').click();
    await expectNewToast(page, n2, 'Entrada manual registrada');
    await expectStock(row, { physical: '125 kg', recibido: '120 kg', manual: '5 kg' });
    // La otra clasificación no tuvo recepción: su entrada manual NO avisa.
    await addStock(page, two, '10');
    await expectStock(invRow(page, two), { physical: '10 kg', manual: '10 kg' });
    await expectIdentity(page);
    const audit = await runAudit(page);
    expect(audit.text).toContain('Sin inconsistencias (0 ventas, 0 vales, 1 recepción, 3 movimientos)');
  });

  test('inventario · cambiar la unidad de una clasificación SIN movimientos sí se permite (y su precio y su etiqueta se conservan)', async ({ page }) => {
    await open(page);
    await addClass(page, { name: SIN, quality: 'Primera', price: '30' });
    const { form } = await openEdit(page, `${SIN} · Primera`);
    await expect(form.getByTestId('edit-unit')).toBeEnabled(); // nunca tuvo existencias ni movimientos
    await patchForm(form, { unit: 'caja', price: '450' });
    const n = await toastCount(page);
    await form.getByTestId('edit-add').click();
    await expectNewToast(page, n, 'Clasificación actualizada');
    await expect(invRow(page, `${SIN} · Primera`).locator('header span')).toHaveText('$450.00/caja');
    await expect(invRow(page, `${SIN} · Primera`).getByTestId('class-edits'), 'cambiar solo unidad y precio no cambia el nombre').toHaveCount(0);

    // Pero si al cambiar la unidad chocara con otra clasificación igual, se rechaza y no cambia nada.
    await addClass(page, { name: SIN, quality: 'Primera', price: '30' }); // la misma clasificación, ahora en kg
    const before = await snapshotInventory(page);
    // Las dos filas se llaman igual: se distinguen por la unidad de su precio.
    const cajaRow = invRows(page).filter({ has: page.locator('header > span').filter({ hasText: /\/caja$/ }) });
    await cajaRow.getByTestId('edit-product').click();
    const backForm = cajaRow.getByTestId('edit-variety');
    await expect(backForm.getByTestId('edit-unit')).toHaveValue('caja');
    await patchForm(backForm, { unit: 'kg', price: '30' });
    await expect(backForm.getByTestId('edit-dup')).toContainText(`Ya existe esta clasificación: «${SIN} · Primera»`);
    const n2 = await toastCount(page);
    await backForm.getByTestId('edit-add').click();
    await expectNewToast(page, n2, /Ya existe esa clasificación/, 'error');
    expect(await snapshotInventory(page)).toEqual(before);
  });

  test('avisos · dos avisos iguales seguidos: el segundo se queda en pantalla el mismo tiempo que el primero (no lo borra el temporizador del anterior)', async ({ page }) => {
    await open(page);
    const a = `${SIN} · Primera`;
    await addClass(page, { name: SIN, quality: 'Primera', price: '30' });
    await tab(page, 'inventario');
    const row = invRow(page, a);
    const registrar = async () => {
      await row.getByTestId('move-entrada').click();
      await row.getByTestId('move-qty').fill('1');
      await row.getByTestId('move-save').click();
    };
    await registrar(); // aviso A: «Entrada manual registrada» (dura unos 2.4 s)
    await expect(page.getByTestId('toast')).toHaveText('Entrada manual registrada');
    const n = await toastCount(page);
    // Espera fija A PROPÓSITO (justificada): lo que se prueba es el tiempo. El aviso B sale con A todavía en pantalla.
    await page.waitForTimeout(1500);
    // Se mide DENTRO de la página (sin viajes de ida y vuelta): desde que sale B hasta que ya no hay aviso en pantalla.
    await page.evaluate((before) => {
      const w = window as unknown as { __vidaB: Promise<number>; __toastLog: unknown[] };
      w.__vidaB = new Promise<number>((resolve) => {
        const esperarB = () => {
          if (w.__toastLog.length <= before) return void requestAnimationFrame(esperarB);
          const inicio = performance.now();
          const hastaQueSeVaya = () =>
            document.querySelector('[data-testid="toast"]') ? void requestAnimationFrame(hastaQueSeVaya) : resolve(performance.now() - inicio);
          requestAnimationFrame(hastaQueSeVaya);
        };
        esperarB();
      });
    }, n);
    await registrar(); // aviso B: el MISMO texto
    const vidaDeB = await page.evaluate(() => (window as unknown as { __vidaB: Promise<number> }).__vidaB);
    expect(vidaDeB, `el segundo aviso igual duró solo ${Math.round(vidaDeB)} ms (debería durar unos 2400 ms como el primero)`).toBeGreaterThan(1800);
  });

  test('inventario · «Cancelar» no deja la cantidad ni el motivo escritos precargados para el siguiente movimiento ni para otra clasificación', async ({ page }) => {
    await open(page);
    const a = `${SIN} · Primera`;
    const b = `${SIN} · Segunda`;
    await addClass(page, { name: SIN, quality: 'Primera', price: '30' });
    await addClass(page, { name: SIN, quality: 'Segunda', price: '20' });
    await addStock(page, a, '20');
    await addStock(page, b, '20');
    const rowA = invRow(page, a);
    const rowB = invRow(page, b);
    await rowA.getByTestId('move-merma').click();
    await rowA.getByTestId('move-qty').fill('5');
    await rowA.getByTestId('move-note').fill('motivo de A');
    await rowA.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(rowA.getByTestId('move-form')).toHaveCount(0);
    // Otra clasificación: el formulario debe abrir vacío (si no, un toque a «Guardar» mermaría 5 kg de la equivocada).
    await rowB.getByTestId('move-merma').click();
    await expect(rowB.getByTestId('move-qty'), 'la cantidad de la merma cancelada de otra clasificación').toHaveValue('');
    await expect(rowB.getByTestId('move-note'), 'el motivo de la merma cancelada de otra clasificación').toHaveValue('');
    await rowB.getByRole('button', { name: 'Cancelar', exact: true }).click();
    // La misma clasificación, otro tipo de movimiento.
    await rowA.getByTestId('move-ajuste').click();
    await expect(rowA.getByTestId('move-qty')).toHaveValue('');
    await expect(rowA.getByTestId('move-note')).toHaveValue('');
  });

  test('inventario · merma y conteo exigen motivo; cantidades inválidas se rechazan; lo que dejaría el disponible negativo pide autorización', async ({ page }) => {
    await open(page);
    const a = `${SIN} · Primera`;
    await addClass(page, { name: SIN, quality: 'Primera', price: '30' });
    await addStock(page, a, '30');
    await selectInCaja(page, { name: SIN, quality: 'Primera' });
    expect(await sellKg(page, '20', { vale: true, authorize: false })).toBe(1); // físico 30, apartado 20, disponible 10
    await tab(page, 'inventario');
    const row = invRow(page, a);
    const before = await snapshotInventory(page);

    // Sin motivo (vacío o solo espacios) el botón de merma y de conteo está apagado.
    for (const kind of ['merma', 'ajuste'] as const) {
      await row.getByTestId(`move-${kind}`).click();
      await row.getByTestId('move-qty').fill('2');
      await row.getByTestId('move-note').fill(''); // (se escribe vacío a propósito: ver la prueba de «Cancelar» sobre valores que se quedan)
      await expect(row.getByTestId('move-save')).toBeDisabled();
      await row.getByTestId('move-note').fill('    ');
      await expect(row.getByTestId('move-save')).toBeDisabled();
      await row.getByTestId('move-note').fill('motivo');
      await expect(row.getByTestId('move-save')).toBeEnabled();
      await row.getByRole('button', { name: 'Cancelar', exact: true }).click();
    }
    // La entrada manual no necesita motivo.
    await row.getByTestId('move-entrada').click();
    await expect(row.getByTestId('move-save')).toBeEnabled();
    await expect(row.getByTestId('move-entrada-hint')).toContainText('Recepción');
    await row.getByRole('button', { name: 'Cancelar', exact: true }).click();

    // Cantidades inválidas: ceros, negativos, letras, ambiguas, científicas, con más de 3 decimales o excesivas.
    const tryMove = async (kind: 'entrada' | 'merma' | 'ajuste', qty: string, note: string, error: RegExp) => {
      await row.getByTestId(`move-${kind}`).click();
      await row.getByTestId('move-qty').fill(qty);
      await row.getByTestId('move-note').fill(note);
      const n = await toastCount(page);
      await row.getByTestId('move-save').click();
      await expectNewToast(page, n, error, 'error');
      await row.getByRole('button', { name: 'Cancelar', exact: true }).click();
      expect(await snapshotInventory(page), `«${kind} ${qty}» no debe cambiar nada`).toEqual(before);
    };
    for (const kind of ['entrada', 'merma'] as const) {
      await tryMove(kind, '0', 'x', /La cantidad debe ser mayor a cero/);
      for (const bad of ['-2', 'abc', '', '1e3', '1.2345', '200001']) await tryMove(kind, bad, 'x', /Escribe cuántos kilos/);
      await tryMove(kind, '1,500', 'x', /Escribe 1500 o 1.5/);
    }
    await tryMove('ajuste', '-3', 'x', /Escribe cuántos kilos/);
    await tryMove('ajuste', 'abc', 'x', /Escribe cuántos kilos/);
    // Motivo demasiado largo o con caracteres invisibles.
    await tryMove('merma', '1', 'm'.repeat(301), /Motivo: máximo 300 caracteres/);
    await tryMove('merma', '1', `mo${String.fromCharCode(0x200b)}tivo`, /Motivo: contiene caracteres no permitidos/);

    // Merma de 15 kg: quedarían 15 físicos con 20 apartados → disponible −5 → pide autorización; Cancelar no cambia nada.
    await row.getByTestId('move-merma').click();
    await row.getByTestId('move-qty').fill('15');
    await row.getByTestId('move-note').fill('se mojó');
    await row.getByTestId('move-save').click();
    await expect(page.getByTestId('authorize-sheet')).toBeVisible();
    await expect(page.getByTestId('authorize-text')).toContainText(`«${a}» quedaría con -5 kg disponibles`);
    await expect(page.getByTestId('authorize-text')).toContainText('Hay 20 kg apartados por vales');
    await page.getByTestId('authorize-no').click();
    await expect(page.getByTestId('authorize-sheet')).toHaveCount(0);
    await row.getByRole('button', { name: 'Cancelar', exact: true }).click();
    expect(await snapshotInventory(page)).toEqual(before);

    // Autorizada: queda el negativo visible y la merma en el historial.
    await moveStock(page, a, 'merma', '15', 'se mojó', { authorize: true });
    await expectStock(row, { physical: '15 kg', reserved: '20 kg', available: '-5 kg', merma: '15 kg' });
    await expect(row.getByTestId('stock-negative')).toBeVisible();
    // Un conteo menor que lo apartado también pide autorización; con 0 contado el sistema lo acepta como un número válido.
    await row.getByTestId('move-ajuste').click();
    await row.getByTestId('move-qty').fill('0');
    await row.getByTestId('move-note').fill('bodega vacía');
    await row.getByTestId('move-save').click();
    await expect(page.getByTestId('authorize-sheet')).toBeVisible();
    await expect(page.getByTestId('authorize-text')).toContainText('quedaría con -20 kg disponibles');
    const n = await toastCount(page);
    await page.getByTestId('authorize-yes').click();
    await expectNewToast(page, n, 'Conteo físico registrado');
    await expectStock(row, { physical: '0 g', reserved: '20 kg', available: '-20 kg', ajuste: '-15 kg' });
    await expectIdentity(page);
    // Todo lo autorizado queda registrado: la auditoría lo reconoce.
    const audit = await runAudit(page);
    expect(audit.ok, audit.text).toBe(true);
    expect(audit.warnings).toContain('con autorizaciones registradas');
  });
});

test.describe('Negativos · lo que no debe guardarse', () => {
  test('variedad vacía o solo espacios, caracteres de control o invisibles y textos demasiado largos no guardan nada ni rompen la pantalla; 40 caracteres exactos sí', async ({ page }) => {
    await open(page);
    await tab(page, 'inventario');
    const form = addForm(page);
    const bell = String.fromCharCode(7);
    const zeroWidth = String.fromCharCode(0x200b);
    const rtl = String.fromCharCode(0x202e);
    const lineSep = String.fromCharCode(0x2028);
    const attempt = async (c: ClassSpec, error: RegExp, why: string) => {
      await fillForm(form, { price: null, ...c });
      const n = await toastCount(page);
      await form.getByTestId('add-product').click();
      await expectNewToast(page, n, error, 'error');
      await expect(invRows(page), `${why}: no debe haber guardado nada`).toHaveCount(0);
    };
    await attempt({ name: '' }, /nombre de la variedad es obligatorio/i, 'variedad vacía');
    await attempt({ name: '     ' }, /nombre de la variedad es obligatorio/i, 'variedad de solo espacios');
    await attempt({ name: `Sin${bell}semilla` }, /Variedad: contiene caracteres no permitidos/, 'campana (control) en variedad');
    await attempt({ name: 'Sin\tsemilla' }, /Variedad: contiene caracteres no permitidos/, 'tabulador en variedad');
    await attempt({ name: SIN, origin: `Oax${zeroWidth}aca` }, /Procedencia: contiene caracteres no permitidos/, 'espacio de ancho cero en procedencia');
    await attempt({ name: SIN, quality: `Pri${rtl}mera` }, /Calidad: contiene caracteres no permitidos/, 'inversión de texto en calidad');
    await attempt({ name: SIN, caliber: `2${lineSep}X` }, /Calibre: contiene caracteres no permitidos/, 'separador de línea en calibre');
    await attempt({ name: 'v'.repeat(41) }, /Variedad: máximo 40 caracteres/, 'variedad de 41');
    await attempt({ name: SIN, origin: 'o'.repeat(41) }, /Procedencia: máximo 40 caracteres/, 'procedencia de 41');
    await attempt({ name: SIN, quality: 'q'.repeat(41) }, /Calidad: máximo 40 caracteres/, 'calidad de 41');
    await attempt({ name: SIN, caliber: 'c'.repeat(41) }, /Calibre: máximo 40 caracteres/, 'calibre de 41');
    // Texto larguísimo: se rechaza y la pantalla no se desborda ni se rompe (vista previa incluida).
    await attempt({ name: 'x'.repeat(5000) }, /Variedad: máximo 40 caracteres/, 'variedad de 5000');
    expect(await overflowing(page)).toEqual([]);
    await expect(page.getByTestId('fatal')).toHaveCount(0);
    await expect(page.getByText('Aún no hay variedades')).toBeVisible();
    await tab(page, 'caja');
    await expect(page.getByTestId('caja-vacia')).toBeVisible(); // la Caja sigue sin nada que vender

    // Frontera: exactamente 40 caracteres en cada campo SÍ se guarda.
    const c40 = { name: 'v'.repeat(40), origin: 'o'.repeat(40), quality: 'q'.repeat(40), caliber: 'c'.repeat(40) };
    await addClass(page, { ...c40, price: '10' });
    expect(await invLabels(page)).toEqual([labelOf(c40)]);
    expect(await overflowing(page), 'una etiqueta de 160 caracteres no debe desbordar Inventario').toEqual([]);
  });

  test('un nombre con etiquetas HTML se guarda y se muestra como texto, sin interpretarse', async ({ page }) => {
    await open(page);
    const c = { name: '<img src=x onerror=alert(1)>', origin: '<b>negrita</b>' };
    await addClass(page, { ...c, price: '10' });
    expect(await invLabels(page)).toEqual([labelOf(c)]);
    await expect(page.locator('main b')).toHaveCount(0);
    await expect(page.locator('main img')).toHaveCount(0);
    await tab(page, 'caja');
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${labelOf(c)}`);
    await expect(page.locator('main b')).toHaveCount(0);
    await expect(page.locator('main img')).toHaveCount(0);
    expect(await overflowing(page)).toEqual([]);
  });

  test('precios 0, negativo, ambiguo «1,500», con letras, con 3 decimales o sobre $100,000 no guardan nada; $100,000 exactos, 1 centavo y la coma decimal sí', async ({ page }) => {
    await open(page);
    await tab(page, 'inventario');
    const form = addForm(page);
    for (const bad of ['0', '0.00', '-1', '1,500', 'abc', '12.345', '100000.01', '1e3', '$30', '30 pesos', '   ', '']) {
      await fillForm(form, { name: SIN, price: bad });
      const n = await toastCount(page);
      await form.getByTestId('add-product').click();
      await expectNewToast(page, n, /Escribe el precio por unidad \(mayor a cero\)/, 'error');
      await expect(invRows(page), `precio «${bad}»: no debe haber guardado nada`).toHaveCount(0);
    }
    for (const [cal, typed, shown] of [['1X', '100000', '$100,000.00'], ['2X', '0.01', '$0.01'], ['3X', '27,5', '$27.50'], ['200', '  31  ', '$31.00']] as const) {
      await addClass(page, { name: SIN, caliber: cal, price: typed });
      await expect(invRow(page, `${SIN} · ${cal}`).locator('header span')).toHaveText(`${shown}/kg`);
    }
    // Un precio de 1 centavo por kg es válido: 1 kg cuesta $0.01.
    await tab(page, 'caja');
    await pickClass(page, '2X');
    await page.getByTestId('kg').fill('1');
    await expect(page.getByTestId('total')).toContainText('$0.01');
  });

  test('unidad distinta de kg · caja, pieza y arpilla: etiqueta de cantidad, venta, existencia propia y duplicado por unidad', async ({ page }) => {
    await open(page);
    await tab(page, 'inventario');
    const form = addForm(page);
    await fillForm(form, { name: SIN, quality: 'Primera', price: '450', unit: 'caja' });
    await expect(form.getByTestId('new-preview')).toHaveText(`Quedará como: ${SIN} · Primera (por caja)`);
    let n = await toastCount(page);
    await form.getByTestId('add-product').click();
    await expectNewToast(page, n, 'Variedad agregada');
    // La MISMA clasificación en kg es otro producto (la unidad forma parte de la identidad).
    await addClass(page, { name: SIN, quality: 'Primera', price: '30' });
    // Pero repetir la misma clasificación en la misma unidad sí es un duplicado.
    await tryAddClass(page, { name: SIN, quality: 'primera', price: '460', unit: 'caja' }, /Ya existe esa clasificación/);
    await addClass(page, { name: SIN, quality: 'Segunda', price: '12', unit: 'pieza' });
    await addClass(page, { name: SIN, quality: 'Tercera', price: '300', unit: 'arpilla' });
    const rowOf = (suffix: string) => invRows(page).filter({ has: page.locator('header > span').filter({ hasText: new RegExp(`/${suffix}$`) }) });
    await expect(rowOf('caja')).toHaveCount(1);
    await expect(rowOf('kg')).toHaveCount(1);
    await expect(rowOf('pieza')).toHaveCount(1);
    await expect(rowOf('arpilla')).toHaveCount(1);

    // Existencia propia en su unidad: 10 cajas no son 10 kg.
    const caja = rowOf('caja');
    await caja.getByTestId('move-entrada').click();
    await expect(caja.getByTestId('move-form')).toContainText('Cantidad (caja)');
    await caja.getByTestId('move-qty').fill('10');
    n = await toastCount(page);
    await caja.getByTestId('move-save').click();
    await expectNewToast(page, n, 'Entrada manual registrada');
    await expect(caja.getByTestId('stock-physical')).toHaveText('10 caja');
    await expect(rowOf('kg').getByTestId('stock-physical')).toHaveText('0 g');

    // Caja: variedad → clasificación (la de cajas lleva su unidad) → venta en cajas.
    await tab(page, 'caja');
    expect(await chipTexts(page, 'quality')).toEqual(['Primera · caja', 'Primera', 'Segunda · pieza', 'Tercera · arpilla']);
    await pickClass(page, 'Primera · caja');
    await expect(page.getByText('Precio por caja')).toBeVisible();
    await expect(page.getByTestId('kg').locator('xpath=ancestor::label').getByText('Cajas', { exact: true })).toBeVisible();
    await expect(page.getByTestId('price')).toHaveValue('450');
    await expect(page.getByTestId('stock-hint')).toContainText('Disponible: 10 caja');
    expect(await sellKg(page, '2', { authorize: false })).toBe(1);
    await tab(page, 'corte');
    await expect(page.getByTestId('sale-row')).toContainText('2 caja');
    await expect(page.getByTestId('r-total')).toContainText('$900.00');
    await tab(page, 'inventario');
    await expect(rowOf('caja').getByTestId('stock-physical')).toHaveText('8 caja');
    await expect(rowOf('kg').getByTestId('stock-physical')).toHaveText('0 g');

    // Recepción solo suma kilos: no ofrece las que no se venden por kg.
    await tab(page, 'recepcion');
    await page.getByTestId('rec-variety').filter({ hasText: exactText(SIN) }).click();
    await expect(page.getByTestId('rec-selected')).toContainText(`${SIN} · Primera`);
    await expect(page.getByTestId('rec-class')).toHaveCount(0); // solo una clasificación vendible por kg
  });
});

// =============================================================================================================
// Auditoría (caso 25), persistencia y respaldo
// =============================================================================================================

/** "12.5" kg → 12500 milésimas. */
const kgm = (kg: string) => Math.round(Number(kg) * 1000);

test.describe('Auditoría de integridad (caso 25)', () => {
  test('caso 25 · flujo largo (altas, entradas, ventas, vales entregados y cancelados, anulación, mermas, conteo, edición, ocultar y negativo autorizado): la auditoría no encuentra problemas y los números de cada clasificación cuadran con un modelo independiente', async ({ page }) => {
    // Flujo largo con muchas pantallas: se le da más tiempo (no se omite ni se debilita ninguna comprobación).
    test.setTimeout(150_000);
    await open(page);

    // Modelo independiente (en milésimas) de lo que DEBE haber en cada clasificación.
    interface Led { phys: number; res: number; manual: number; vendido: number; merma: number; ajuste: number }
    const led = new Map<string, Led>();
    const L = (label: string): Led => {
      if (!led.has(label)) led.set(label, { phys: 0, res: 0, manual: 0, vendido: 0, merma: 0, ajuste: 0 });
      return led.get(label)!;
    };
    let moves = 0;

    type Cls = Pick<ClassSpec, 'name' | 'origin' | 'quality' | 'caliber'>;
    const P1: Cls = { name: CON, origin: 'Oaxaca', quality: 'Primera' };
    const P2: Cls = { name: CON, origin: 'Michoacán', quality: 'Segunda' };
    const P3: Cls = { name: SIN, caliber: '2X' };
    const P4: Cls = { name: SIN, caliber: '300' };
    const P5: Cls = { name: SIN, quality: 'Torreones' };
    const prices: Array<[Cls, string]> = [[P1, '30'], [P2, '24'], [P3, '33'], [P4, '36'], [P5, '40']];
    for (const [c, price] of prices) await addClass(page, { ...c, price });
    for (const [c, kg] of [[P1, '200'], [P2, '120'], [P3, '80'], [P4, '60'], [P5, '30']] as Array<[Cls, string]>) {
      await addStock(page, labelOf(c), kg);
      L(labelOf(c)).phys += kgm(kg);
      L(labelOf(c)).manual += kgm(kg);
      moves++;
    }

    const sale = async (c: Cls, kg: string, o: { vale?: boolean; customer?: string; authorize?: boolean } = {}) => {
      await selectInCaja(page, c);
      const folio = await sellKg(page, kg, { vale: o.vale, customer: o.customer, authorize: !!o.authorize });
      const l = L(labelOf(c));
      if (o.vale) l.res += kgm(kg);
      else {
        l.phys -= kgm(kg);
        l.vendido += kgm(kg);
      }
      moves++;
      return folio;
    };
    expect(await sale(P1, '20')).toBe(1);
    expect(await sale(P2, '7.5')).toBe(2);
    expect(await sale(P3, '5')).toBe(3); // se anulará después
    expect(await sale(P4, '12.25')).toBe(4);
    expect(await sale(P1, '15', { vale: true, customer: 'Doña Mary' })).toBe(5); // V-1
    expect(await sale(P3, '10', { vale: true })).toBe(6); // V-2
    expect(await sale(P4, '8', { vale: true })).toBe(7); // V-3
    expect(await sale(P5, '5', { vale: true, customer: 'Don Beto' })).toBe(8); // V-4 (queda pendiente)

    // V-1 se entrega; V-2 se cancela devolviendo efectivo; V-3 se cancela sin devolver dinero.
    await deliverVale(page, 1);
    L(labelOf(P1)).phys -= kgm('15');
    L(labelOf(P1)).res -= kgm('15');
    L(labelOf(P1)).vendido += kgm('15');
    moves++;
    await cancelVale(page, 2, 'cliente no vino', 'efectivo');
    L(labelOf(P3)).res -= kgm('10');
    moves++;
    await cancelVale(page, 3, 'error de captura', 'ninguna');
    L(labelOf(P4)).res -= kgm('8');
    moves++;

    // Se anula la venta #3 (5 kg de P3 regresan a bodega).
    await tab(page, 'corte');
    page.once('dialog', (d) => d.accept('error de captura'));
    const n = await toastCount(page);
    await page
      .getByTestId('sale-row')
      .filter({ has: page.locator('header strong').filter({ hasText: /^#3$/ }) })
      .getByRole('button', { name: 'Anular' })
      .click();
    await expectNewToast(page, n, 'Venta #3 anulada');
    L(labelOf(P3)).phys += kgm('5');
    L(labelOf(P3)).vendido -= kgm('5');
    moves++;

    // Mermas y un conteo físico (80 → 78 en P3).
    await moveStock(page, labelOf(P1), 'merma', '3', 'merma 1');
    L(labelOf(P1)).phys -= kgm('3');
    L(labelOf(P1)).merma += kgm('3');
    await moveStock(page, labelOf(P2), 'merma', '2.5', 'merma 2');
    L(labelOf(P2)).phys -= kgm('2.5');
    L(labelOf(P2)).merma += kgm('2.5');
    await moveStock(page, labelOf(P3), 'ajuste', '78', 'conteo');
    L(labelOf(P3)).ajuste += kgm('78') - L(labelOf(P3)).phys;
    L(labelOf(P3)).phys = kgm('78');
    moves += 3;

    // Se renombra P5 (conserva su existencia y su vale) y se oculta P2.
    const oldP5 = labelOf(P5);
    const newP5 = `${SIN} · Torreones Extra`;
    const edit = await openEdit(page, oldP5);
    await patchForm(edit.form, { quality: 'Torreones Extra' });
    const n2 = await toastCount(page);
    await edit.form.getByTestId('edit-add').click();
    await expectNewToast(page, n2, 'Clasificación actualizada');
    led.set(newP5, L(oldP5));
    led.delete(oldP5);
    await setHidden(page, labelOf(P2), true);

    // Venta de 30 kg de P5 con 25 disponibles (30 físicos − 5 apartados): requiere autorización.
    await selectInCaja(page, { name: SIN, quality: 'Torreones Extra' });
    expect(await sellKg(page, '30', { authorize: true })).toBe(9);
    L(newP5).phys -= kgm('30');
    L(newP5).vendido += kgm('30');
    moves++;

    // --- Verificación: lo que muestra la pantalla == el modelo independiente, fila por fila.
    await tab(page, 'inventario');
    await expect(invRows(page)).toHaveCount(5);
    for (const [label, l] of led) {
      const r = await readRow(invRow(page, label));
      expect(r.physical, `${label}: físico`).toBe(l.phys);
      expect(r.reserved, `${label}: apartado`).toBe(l.res);
      expect(r.available, `${label}: disponible`).toBe(l.phys - l.res);
      expect(r.manual, `${label}: entradas manuales`).toBe(l.manual);
      expect(r.vendido, `${label}: vendido`).toBe(l.vendido);
      expect(r.merma, `${label}: mermas`).toBe(l.merma);
      expect(r.ajuste, `${label}: conteos`).toBe(l.ajuste);
    }
    await expectIdentity(page);
    // Valores concretos a mano (por si el modelo y la pantalla se equivocaran igual).
    await expectStock(invRow(page, labelOf(P1)), { physical: '162 kg', reserved: '0 g', vendido: '35 kg', merma: '3 kg' });
    await expectStock(invRow(page, labelOf(P3)), { physical: '78 kg', reserved: '0 g', vendido: '0 g', ajuste: '-2 kg' });
    await expectStock(invRow(page, labelOf(P4)), { physical: '47.75 kg', reserved: '0 g', vendido: '12.25 kg' });
    await expectStock(invRow(page, newP5), { physical: '0 g', reserved: '5 kg', available: '-5 kg', vendido: '30 kg' });
    await expect(invRow(page, labelOf(P2))).toHaveClass(/inactive/);

    // Dinero: el Corte no se alteró por entregar, renombrar ni ocultar.
    await tab(page, 'corte');
    await expect(page.getByTestId('r-total')).toContainText('$3,689.00');
    await expect(page.getByTestId('r-refunds')).toContainText('$330.00');
    await expect(page.getByTestId('r-expected')).toContainText('$3,359.00');
    await tab(page, 'mas');
    await expect(page.getByTestId('hist-summary')).toContainText('8 ventas · $3,689.00 · 1 anuladas');

    // Auditoría: sin inconsistencias, con el conteo exacto de lo hecho, y el negativo reconocido como autorizado.
    const audit = await runAudit(page);
    expect(audit.ok, audit.text).toBe(true);
    expect(moves).toBe(21);
    expect(audit.text).toContain(`Sin inconsistencias (9 ventas, 4 vales, 0 recepciones, ${moves} movimientos)`);
    expect(audit.warnings).toContain(`«${newP5}» tiene existencia disponible negativa (-5 kg), con autorizaciones registradas`);
    expect(audit.warnings).not.toContain('SIN ninguna autorización');
    // La Caja no ofrece la oculta: de «Con semilla» solo queda Oaxaca·Primera (una sola → ya no hay segundo nivel).
    await tab(page, 'caja');
    expect(await chipTexts(page, 'variety')).toEqual([CON, SIN]);
    await pickVariety(page, CON);
    await expect(page.getByTestId('quality')).toHaveCount(0);
    await expect(page.getByTestId('selling')).toHaveText(`Vendiendo: ${labelOf(P1)}`);
    await pickVariety(page, SIN);
    expect(await chipTexts(page, 'quality')).toEqual(['2X', '300', 'Torreones Extra']);
  });
});

test.describe('Auditoría · datos heredados', () => {
  test('auditoría · dos productos con la MISMA clasificación (datos de antes de la regla de duplicados) se restauran, se avisan, no se pueden crear de nuevo y, al ocultar uno como aconseja el aviso, el aviso se va', async ({ page }) => {
    await open(page);
    const label = `${SIN} · 2X`;
    await addClass(page, { name: SIN, caliber: '2X', price: '30' });
    await addStock(page, label, '10');
    await tab(page, 'mas');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export').click()]);
    const backup = JSON.parse(readFileSync(await dl.path(), 'utf8'));
    expect(backup.products).toHaveLength(1);
    // Se fabrica el caso heredado: un segundo producto con la misma clasificación (sin existencias, otro precio).
    backup.products.push({ ...backup.products[0], id: 'duplicado-heredado-0001', sort: 1, priceCents: 2800, physicalMilli: 0, reservedMilli: 0 });
    // (el archivo va en memoria: una ruta con acentos en el nombre de la prueba no la lee este Chromium)
    await page.getByTestId('import-file').setInputFiles({
      name: 'respaldo-con-duplicado.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(backup)),
    });
    await expect(page.getByTestId('restore-sheet')).toBeVisible();
    if (await page.getByTestId('restore-understood').count()) await page.getByTestId('restore-understood').check();
    const n = await toastCount(page);
    await page.getByTestId('restore-confirm').click();
    await expectNewToast(page, n, 'Respaldo restaurado');

    // Los dos existen, cada uno con su precio y su existencia; la Caja los ofrece como dos chips.
    await tab(page, 'inventario');
    expect((await snapshotInventory(page)).map((r) => [r.label, r.price, r.physical])).toEqual([
      [label, '$30.00/kg', '10 kg'],
      [label, '$28.00/kg', '0 g'],
    ]);
    // La auditoría NO lo marca como inconsistencia (no impide operar) pero SÍ lo avisa.
    let audit = await runAudit(page);
    expect(audit.ok, audit.text).toBe(true);
    expect(audit.warnings).toContain(`Hay 2 productos con la misma clasificación («${label}»)`);
    expect(audit.warnings).toContain('conviene ocultar uno de ellos');
    // No se puede crear un tercero igual.
    await tryAddClass(page, { name: SIN, caliber: '2X', price: '31' }, /Ya existe esa clasificación/);
    // Se hace caso al aviso: se oculta el que no tiene existencias → el aviso ya no debe seguir pidiendo lo mismo.
    const empty = invRows(page).filter({ has: page.locator('header > span').filter({ hasText: '$28.00/kg' }) });
    await empty.getByRole('button', { name: 'Ocultar', exact: true }).click();
    await expect(empty).toHaveClass(/inactive/);
    audit = await runAudit(page);
    expect(audit.ok).toBe(true);
    expect(audit.warnings, 'tras ocultar uno, el aviso de duplicado debería desaparecer (o decir que ya está oculto)').not.toContain('conviene ocultar uno de ellos');
  });
});

test.describe('Persistencia y respaldo del catálogo clasificado', () => {
  test('catálogo, precios, existencias, bitácora de ediciones y ventas sobreviven a recargar y a cerrar y reabrir la app (mismo perfil)', async ({ browser, baseURL }) => {
    const ctx = await newDevice(browser, baseURL);
    const p1 = await ctx.newPage();
    await open(p1);
    const a = { name: CON, origin: 'Oaxaca', quality: 'Segunda', caliber: '300' };
    const b = { name: SIN, caliber: '2X' };
    await addClass(p1, { ...a, price: '25.5' });
    await addClass(p1, { ...b, price: '31' });
    await addStock(p1, labelOf(a), '60');
    await addStock(p1, labelOf(b), '40');
    await selectInCaja(p1, a);
    expect(await sellKg(p1, '10', { authorize: false })).toBe(1);
    expect(await sellKg(p1, '5', { vale: true, customer: 'Doña Mary', authorize: false })).toBe(2);
    const edit = await openEdit(p1, labelOf(b));
    await patchForm(edit.form, { quality: 'Primera' });
    await edit.form.getByTestId('edit-add').click();
    await expect(p1.getByTestId('toast')).toContainText('Clasificación actualizada');
    await setHidden(p1, labelOf(a), true);
    const before = await snapshotInventory(p1);
    expect(before).toHaveLength(2);

    await p1.reload();
    await expect(p1.getByTestId('caja')).toBeVisible();
    expect(await snapshotInventory(p1)).toEqual(before);
    await p1.close(); // equivale a cerrar la app

    const p2 = await ctx.newPage();
    await p2.goto('/');
    await expect(p2.getByTestId('caja')).toBeVisible();
    expect(await snapshotInventory(p2)).toEqual(before);
    await expect(invRow(p2, `${SIN} · Primera · 2X`).getByTestId('class-edits')).toContainText(`«${labelOf(b)}» → «${SIN} · Primera · 2X»`);
    await expect(invRow(p2, labelOf(a))).toHaveClass(/inactive/);
    await tab(p2, 'corte');
    await expect(p2.getByTestId('sale-row')).toHaveCount(2);
    await expect(p2.getByTestId('r-total')).toContainText('$382.50'); // 10 × 25.50 + 5 × 25.50
    await tab(p2, 'vales');
    await expect(p2.getByTestId('vale')).toContainText(`${labelOf(a)} · 5 kg`);
    expect((await runAudit(p2)).ok).toBe(true);
    await ctx.close();
  });

  test('dos ventanas de la app (la instalada y una pestaña del navegador) comparten la base: una clasificación, un precio y una venta hechos en una se ven en la otra sin recargar', async ({ browser, baseURL }) => {
    const ctx = await newDevice(browser, baseURL);
    const w1 = await ctx.newPage();
    await open(w1);
    const w2 = await ctx.newPage();
    await open(w2);
    const a = { name: SIN, caliber: '2X' };
    const label = labelOf(a);
    await expect(w2.getByTestId('caja-vacia')).toBeVisible();

    await addClass(w1, { ...a, price: '30' }); // en la ventana 1
    await expect(w2.getByTestId('caja-vacia')).toHaveCount(0); // la ventana 2 ya no está vacía, sin recargar
    await expect(w2.getByTestId('selling')).toHaveText(`Vendiendo: ${label}`);
    await expect(w2.getByTestId('price')).toHaveValue('30');
    await addStock(w1, label, '10');
    await expect(w2.getByTestId('stock-hint')).toContainText('Disponible: 10 kg');

    expect(await sellKg(w2, '4', { authorize: false })).toBe(1); // vende en la ventana 2
    await expectStock(invRow(w1, label), { physical: '6 kg', vendido: '4 kg' }); // la ventana 1 lo ve sin recargar

    const edit = await openEdit(w1, label); // cambia el precio en la ventana 1
    await patchForm(edit.form, { price: '35' });
    await edit.form.getByTestId('edit-add').click();
    await expect(w2.getByTestId('price')).toHaveValue('35');
    expect(await sellKg(w2, '1', { authorize: false })).toBe(2);
    await tab(w1, 'corte');
    await expect(w1.getByTestId('r-total')).toContainText('$155.00'); // 4 × 30 + 1 × 35
    const seen1 = await snapshotInventory(w1); // (lleva la ventana 1 a Inventario)
    await expectStock(invRow(w1, label), { physical: '5 kg', vendido: '5 kg' });
    expect(seen1).toEqual(await snapshotInventory(w2)); // las dos ventanas muestran exactamente lo mismo
    expect((await runAudit(w2)).ok).toBe(true);
    await ctx.close();
  });

  test('respaldo · exportar y restaurar en otro dispositivo conserva procedencia, calidad, calibre, precios, existencias, ediciones, ocultas y la clasificación de cada venta', async ({ page, browser, baseURL }) => {
    await open(page);
    const a = { name: CON, origin: 'Oaxaca', quality: 'Segunda', caliber: '300' };
    const b = { name: SIN, quality: 'Torreones' };
    const c = { name: SIN, caliber: '500' };
    await addClass(page, { ...a, price: '25.5' });
    await addClass(page, { ...b, price: '38' });
    await addClass(page, { ...c, price: null });
    await addStock(page, labelOf(a), '60');
    await addStock(page, labelOf(b), '40');
    await selectInCaja(page, a);
    expect(await sellKg(page, '10', { authorize: false })).toBe(1);
    await selectInCaja(page, b);
    expect(await sellKg(page, '1', { authorize: false })).toBe(2); // se vende ANTES de renombrar
    await selectInCaja(page, a);
    expect(await sellKg(page, '5', { vale: true, customer: 'Doña Mary', authorize: false })).toBe(3);
    const edit = await openEdit(page, labelOf(b));
    await patchForm(edit.form, { quality: 'Torreones Extra' });
    await edit.form.getByTestId('edit-add').click();
    await expect(page.getByTestId('toast')).toContainText('Clasificación actualizada');
    await setHidden(page, labelOf(c), true);
    const before = await snapshotInventory(page);

    await tab(page, 'mas');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export').click()]);
    const file = await dl.path();
    const backup = JSON.parse(readFileSync(file, 'utf8'));
    // El archivo trae los campos nuevos de verdad (no solo el nombre).
    const pa = backup.products.find((p: { origin?: string }) => p.origin === 'Oaxaca');
    expect(pa).toMatchObject({ name: CON, origin: 'Oaxaca', quality: 'Segunda', caliber: '300', priceCents: 2550, physicalMilli: 50000, reservedMilli: 5000, active: true });
    expect(backup.products.find((p: { caliber?: string }) => p.caliber === '500')).toMatchObject({ priceCents: 0, active: false });
    const pb = backup.products.find((p: { quality?: string }) => p.quality === 'Torreones Extra');
    expect(pb.classEdits).toHaveLength(1);
    expect(pb.classEdits[0]).toMatchObject({ before: { variety: SIN, quality: 'Torreones' }, after: { variety: SIN, quality: 'Torreones Extra' } });
    // Cada venta lleva la foto de la clasificación que tenía al venderse (la #2 se hizo antes de renombrar).
    const saleByFolio = (f: number) => backup.sales.find((s: { folio: number }) => s.folio === f);
    expect(saleByFolio(1).items[0].cls).toEqual({ variety: CON, origin: 'Oaxaca', quality: 'Segunda', caliber: '300' });
    expect(saleByFolio(2).items[0].cls).toEqual({ variety: SIN, quality: 'Torreones' });
    expect(saleByFolio(2).items[0].name).toBe(labelOf(b));

    // Otro dispositivo, vacío: restaura y ve exactamente lo mismo.
    const ctx = await newDevice(browser, baseURL);
    const p2 = await ctx.newPage();
    await open(p2);
    await tab(p2, 'mas');
    await p2.getByTestId('import-file').setInputFiles(file);
    await expect(p2.getByTestId('restore-sheet')).toBeVisible();
    await expect(p2.getByTestId('restore-summary')).toContainText('3 ventas');
    await expect(p2.getByTestId('restore-summary')).toContainText('3 variedades');
    const n = await toastCount(p2);
    await p2.getByTestId('restore-confirm').click();
    await expectNewToast(p2, n, 'Respaldo restaurado');
    expect(await snapshotInventory(p2)).toEqual(before);
    await expect(invRow(p2, `${SIN} · Torreones Extra`).getByTestId('class-edits')).toContainText(`«${labelOf(b)}» → «${SIN} · Torreones Extra»`);
    await expect(invRow(p2, labelOf(c))).toHaveClass(/inactive/);
    await expect(invRow(p2, labelOf(c)).locator('header span')).toHaveText('Sin precio');
    await tab(p2, 'corte');
    await expect(p2.getByTestId('sale-row')).toHaveCount(3);
    await expect(p2.getByTestId('sale-row').first()).toContainText(`${labelOf(a)} 5 kg`);
    // La venta hecha antes de renombrar sigue con su nombre de entonces en el dispositivo nuevo.
    await expect(p2.getByTestId('sale-row').filter({ has: p2.locator('header strong').filter({ hasText: /^#2$/ }) })).toContainText(`${labelOf(b)} 1 kg`);
    // Sigue operando con lo restaurado: vender de la clasificación restaurada usa su precio y descuenta de SU existencia.
    await selectInCaja(p2, a);
    await expect(p2.getByTestId('price')).toHaveValue('25.50');
    expect(await sellKg(p2, '2', { authorize: false })).toBe(4); // los folios continúan, no se repiten
    await tab(p2, 'inventario');
    await expectStock(invRow(p2, labelOf(a)), { physical: '48 kg', reserved: '5 kg', available: '43 kg' });
    await expectStock(invRow(p2, `${SIN} · Torreones Extra`), { physical: '39 kg' });
    expect((await runAudit(p2)).ok).toBe(true);
    await ctx.close();
  });
});

test.describe('Sin conexión (SIMULADA)', () => {
  // `context.setOffline(true)` corta la red del navegador de pruebas: NO equivale al modo avión real de un teléfono Android
  // (política de energía, almacenamiento no persistente...). Esa prueba física sigue pendiente (docs/ANDROID.md).
  test('sin red (simulada): alta, entrada, venta, vale, edición y ocultar funcionan y persisten tras recargar', async ({ page, context }) => {
    await open(page);
    await addClass(page, { name: SIN, caliber: '2X', price: '30' }); // con red, para que el service worker ya tenga todo
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('caja')).toBeVisible();
    await expect(page.getByTestId('net')).toContainText('Sin internet');

    await addClass(page, { name: CON, origin: 'Oaxaca', quality: 'Segunda', price: '25' });
    await addStock(page, `${CON} · Oaxaca · Segunda`, '40');
    await selectInCaja(page, { name: CON, origin: 'Oaxaca', quality: 'Segunda' });
    expect(await sellKg(page, '5', { authorize: false })).toBe(1);
    expect(await sellKg(page, '3', { vale: true, authorize: false })).toBe(2);
    const edit = await openEdit(page, `${CON} · Oaxaca · Segunda`);
    await patchForm(edit.form, { caliber: '300' });
    await edit.form.getByTestId('edit-add').click();
    await expect(page.getByTestId('toast')).toContainText('Clasificación actualizada');
    await setHidden(page, `${SIN} · 2X`, true);
    const before = await snapshotInventory(page);

    await page.reload(); // sigue sin red
    await expect(page.getByTestId('caja')).toBeVisible();
    expect(await snapshotInventory(page)).toEqual(before);
    await expectStock(invRow(page, `${CON} · Oaxaca · Segunda · 300`), { physical: '35 kg', reserved: '3 kg', available: '32 kg' });
    await expect(invRow(page, `${SIN} · 2X`)).toHaveClass(/inactive/);
    await context.setOffline(false);
    await page.reload();
    expect(await snapshotInventory(page)).toEqual(before);
    expect((await runAudit(page)).ok).toBe(true);
  });
});

// =============================================================================================================
// Pantalla Android (360 y 412 px) con teclado abierto y cerrado · regresión del «toque perdido» al soltar el foco
// =============================================================================================================

for (const phone of PHONES) {
  test.describe(`Formularios de clasificación y Caja · ${phone.name}`, () => {
    test.use({ viewport: { width: phone.width, height: phone.height } });
    const html = (page: Page) => page.locator('html');

    test('alta con TECLADO ABIERTO: los chips y «Agregar variedad» responden al PRIMER toque con el campo aún enfocado y nada se desborda', async ({ page }) => {
      await open(page);
      await tab(page, 'inventario');
      const form = addForm(page);
      await form.getByTestId('new-name').fill(CON);
      await form.getByTestId('new-quality').fill('Segunda');
      await form.getByTestId('new-price').fill('25');
      await expect(form.getByTestId('new-price')).toBeFocused();
      await showKeyboard(page, phone);
      await expect(html(page)).toHaveClass(/kbd/);
      await expect(page.getByTestId('tab-inventario')).toBeHidden();
      expect(await overflowing(page), 'con el teclado abierto').toEqual([]);

      // Un chip tocado con el precio enfocado: el campo pierde el foco en ese toque y el chip NO debe moverse.
      await watchTaps(page);
      await chipIn(form, 'origin', 'Oaxaca').tap();
      await expectSolidTap(page, null);
      await expect(form.getByTestId('new-origin')).toHaveValue('Oaxaca');
      await form.getByTestId('new-caliber').focus();
      await chipIn(form, 'size', '3X').tap();
      await expectSolidTap(page, null);
      await expect(form.getByTestId('new-caliber')).toHaveValue('3X');

      // «Agregar variedad» con otro campo enfocado.
      await form.getByTestId('new-price').focus();
      await watchTaps(page);
      await form.getByTestId('add-product').tap();
      await expectSolidTap(page, 'add-product');
      await expect(page.getByTestId('toast')).toContainText('Variedad agregada');
      await hideKeyboard(page, phone);
      await expect(html(page)).not.toHaveClass(/kbd/);
      await expect(page.getByTestId('tab-inventario')).toBeVisible();
      expect(await invLabels(page)).toEqual([`${CON} · Oaxaca · Segunda · 3X`]);
      expect(await overflowing(page), 'con el teclado cerrado').toEqual([]);
    });

    test('edición con TECLADO ABIERTO: «Guardar cambios» responde al primer toque y la clasificación queda cambiada', async ({ page }) => {
      await open(page);
      await addClass(page, { name: SIN, quality: 'Primera', price: '30' });
      const { form } = await openEdit(page, `${SIN} · Primera`);
      await form.getByTestId('edit-price').fill('32');
      await form.getByTestId('edit-caliber').fill('2X');
      await expect(form.getByTestId('edit-caliber')).toBeFocused();
      await showKeyboard(page, phone);
      await expect(html(page)).toHaveClass(/kbd/);
      expect(await overflowing(page)).toEqual([]);
      await watchTaps(page);
      await form.getByTestId('edit-add').tap();
      await expectSolidTap(page, 'edit-add');
      await expect(page.getByTestId('toast')).toContainText('Clasificación actualizada');
      await hideKeyboard(page, phone);
      await expect(invRow(page, `${SIN} · Primera · 2X`).locator('header span')).toHaveText('$32.00/kg');
      await expect(invRow(page, `${SIN} · Primera · 2X`).getByTestId('class-edits')).toContainText(`«${SIN} · Primera» → «${SIN} · Primera · 2X»`);
    });

    test('entrada y merma con TECLADO ABIERTO sobre una clasificación con etiqueta larga: «Guardar» responde al primer toque y no se desborda', async ({ page }) => {
      await open(page);
      const long = { name: 'v'.repeat(40), origin: 'o'.repeat(40), quality: 'q'.repeat(40), caliber: 'c'.repeat(40) };
      await addClass(page, { ...long, price: '10' });
      await tab(page, 'inventario');
      const row = invRow(page, labelOf(long));
      await row.getByTestId('move-entrada').tap();
      await row.getByTestId('move-qty').fill('100');
      await showKeyboard(page, phone);
      expect(await overflowing(page), 'formulario de entrada con etiqueta de 160 caracteres').toEqual([]);
      await watchTaps(page);
      await row.getByTestId('move-save').tap();
      await expectSolidTap(page, 'move-save');
      await expect(page.getByTestId('toast')).toContainText('Entrada manual registrada');
      await expect(row.getByTestId('stock-physical')).toHaveText('100 kg');
      await hideKeyboard(page, phone);
      await row.getByTestId('move-merma').tap();
      await row.getByTestId('move-qty').fill('4');
      await row.getByTestId('move-note').fill('motivo');
      await showKeyboard(page, phone);
      await watchTaps(page);
      await row.getByTestId('move-save').tap();
      await expectSolidTap(page, 'move-save');
      await expect(row.getByTestId('stock-physical')).toHaveText('96 kg');
      await hideKeyboard(page, phone);
      expect(await overflowing(page)).toEqual([]);
    });

    test('vale: cancelar con TECLADO ABIERTO: el motivo escrito, la opción del dinero y «Cancelar vale» responden al primer toque', async ({ page }) => {
      await open(page);
      const a = { name: CON, origin: 'Oaxaca' };
      const label = labelOf(a);
      await addClass(page, { ...a, price: '25' });
      await addStock(page, label, '30');
      await selectInCaja(page, a);
      expect(await sellKg(page, '5', { vale: true, authorize: false })).toBe(1);
      await tab(page, 'vales');
      await page.getByTestId('cancel-vale').tap();
      await page.getByTestId('cancel-reason').fill('el cliente no vino');
      await expect(page.getByTestId('cancel-reason')).toBeFocused();
      await showKeyboard(page, phone);
      expect(await overflowing(page), 'hoja de cancelar vale con teclado abierto').toEqual([]);
      await page.getByTestId('refund-efectivo').tap(); // el campo de texto pierde el foco con este toque
      await expect(page.getByTestId('refund-efectivo')).toBeChecked();
      await expect(page.getByTestId('cancel-confirm')).toBeEnabled();
      await watchTaps(page);
      await page.getByTestId('cancel-confirm').tap();
      await expectSolidTap(page, 'cancel-confirm');
      await expect(page.getByTestId('toast')).toContainText('Vale V-1 cancelado');
      await hideKeyboard(page, phone);
      await tab(page, 'inventario');
      await expectStock(invRow(page, label), { physical: '30 kg', reserved: '0 g', available: '30 kg' });
    });

    test('merma que pide autorización con TECLADO ABIERTO: «Guardar» y «Autorizar y continuar» responden al primer toque', async ({ page }) => {
      await open(page);
      const label = `${SIN} · Primera`;
      await addClass(page, { name: SIN, quality: 'Primera', price: '30' });
      await addStock(page, label, '30');
      await tab(page, 'inventario');
      const row = invRow(page, label);
      await row.getByTestId('move-merma').tap();
      await row.getByTestId('move-qty').fill('50');
      await row.getByTestId('move-note').fill('se mojó');
      await expect(row.getByTestId('move-note')).toBeFocused();
      await showKeyboard(page, phone);
      await watchTaps(page);
      await row.getByTestId('move-save').tap();
      await expectSolidTap(page, 'move-save');
      await expect(page.getByTestId('authorize-sheet')).toBeVisible();
      await expect(page.getByTestId('authorize-text')).toContainText(`«${label}» quedaría con -20 kg disponibles`);
      expect(await overflowing(page), 'hoja de autorización').toEqual([]);
      await watchTaps(page);
      await page.getByTestId('authorize-yes').tap();
      await expectSolidTap(page, 'authorize-yes');
      await expect(page.getByTestId('toast')).toContainText('Merma registrada');
      await hideKeyboard(page, phone);
      await expectStock(row, { physical: '-20 kg', available: '-20 kg', merma: '50 kg' });
    });

    test('Caja con etiquetas largas (40 caracteres por campo): chips, «Vendiendo», disponible, hoja de confirmación, Corte, Vales e Historial no se desbordan, con teclado cerrado y abierto', async ({ page }) => {
      await open(page);
      const l1 = { name: 'Variedad ' + 'v'.repeat(31), origin: 'Procedencia ' + 'o'.repeat(28), quality: 'Calidad ' + 'q'.repeat(32), caliber: 'Calibre ' + 'c'.repeat(32) };
      const l2 = { ...l1, caliber: 'Otro ' + 'k'.repeat(35) };
      await addClass(page, { ...l1, price: '10' });
      await addClass(page, { ...l2, price: '12' });
      await addStock(page, labelOf(l1), '50');
      await addStock(page, labelOf(l2), '50');
      expect(await overflowing(page), 'Inventario con etiquetas largas').toEqual([]);

      await tab(page, 'caja');
      expect(await overflowing(page), 'Caja con etiquetas largas').toEqual([]);
      await pickClass(page, [l2.origin, l2.quality, l2.caliber].join(' · '));
      await page.getByTestId('kg').fill('3');
      await page.getByTestId('exact').click();
      await page.getByTestId('is-vale').check();
      await page.getByTestId('customer').fill('Cliente con un nombre larguísimo '.repeat(3));
      await page.getByTestId('confirm').click();
      await expect(page.getByTestId('confirm-sheet')).toContainText(labelOf(l2));
      expect(await overflowing(page), 'hoja de confirmación').toEqual([]);
      await page.getByTestId('confirm-yes').tap();
      await expect(page.getByTestId('toast')).toContainText('guardada');

      for (const name of ['corte', 'vales', 'mas'] as const) {
        await tab(page, name);
        expect(await overflowing(page), `${name} con etiquetas largas`).toEqual([]);
      }
      // Con el teclado abierto en un campo de la Caja (las pestañas se quedan a la vista ahí).
      await tab(page, 'caja');
      await page.getByTestId('kg').fill('1');
      await showKeyboard(page, phone);
      expect(await overflowing(page), 'Caja con teclado abierto').toEqual([]);
      await hideKeyboard(page, phone);
    });
  });
}
