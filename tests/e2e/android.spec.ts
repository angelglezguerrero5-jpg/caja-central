import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openApp, tab } from './helpers';
import {
  CATALOG,
  FIXED_NOW,
  LONG_CUSTOMER,
  PHONES,
  bottomReachReport,
  buildMarket,
  clippedTextReport,
  controlNameReport,
  dialogReport,
  disableStrictOffline,
  duplicateIds,
  enableStrictOffline,
  expectSolidTap,
  focusInfo,
  goOffline,
  goOnline,
  hideKeyboard,
  html,
  inertLeft,
  innerHeight,
  invariants,
  mxDay,
  overflowReport,
  overlapArea,
  reachReport,
  readDb,
  rectOf,
  reopenOffline,
  restoreBackup,
  sentence,
  sheetReport,
  showKeyboard,
  touchTargetReport,
  uncachedResources,
  unbroken,
  watchTaps,
  type Market,
  type MarketOptions,
  type Phone,
} from './helpers-android';

/**
 * PANTALLAS ANDROID (360×640 y 412×915) y SIN CONEXIÓN SIMULADA de todas las secciones.
 *
 * Casos oficiales: 21 (visualización y operación en pantalla Android), 22 (funcionamiento offline simulado) y 23 (corte de
 * caja sin alteraciones indebidas, también al reabrir la app sin red).
 *
 * Cómo se prueba (ver helpers-android.ts):
 *  - Las pantallas se prueban POBLADAS: un «mercado» realista y consistente (16 clasificaciones, 63 recepciones, 45 ventas,
 *    vales en todos los estados, borradores, correcciones, anulaciones) se carga por la propia interfaz (Más → Restaurar).
 *  - En cada estado de pantalla se barre: desbordamiento horizontal (incluye ancestros con overflow), texto recortado en
 *    botones/chips, final del contenido alcanzable sobre las pestañas, y —aparte— objetivos táctiles de al menos 44×44 px.
 *  - Las pruebas verifican EFECTOS (kilos exactos con data-milli, folios, conteos, movimientos leídos de IndexedDB), no solo
 *    que algo «se vea». También se prueba el camino negativo.
 *  - «Sin conexión» es SIMULADA: context.setOffline(true) más un bloqueo de TODA petición de red, incluida la del service worker
 *    (goOffline en helpers-android.ts: setOffline por sí solo NO frena al service worker, lo comprobamos con una sonda). NO
 *    equivale al modo avión real de Android: no corta la radio, ni el DNS del sistema, ni dispara el ahorro de datos.
 *    Con esa simulación estricta aparece un defecto real: REABRIR la app sin red falla si el servidor responde `Vary: Origin`
 *    (ver reopenOffline). Las pruebas de «la red se corta con la app abierta» pasan; la de «arranque en frío» falla a propósito.
 *  - El teclado del teléfono se emula encogiendo la ventana (como Android con interactive-widget=resizes-content). No es lo
 *    mismo que un teléfono real: la prueba física en Android sigue pendiente.
 */

test.use({ actionTimeout: 10_000 });

// =====================================================================================================================
// Ayudas de la especificación
// =====================================================================================================================

/** Kilos como los escribe la app (formatQty): menos de 1 kg se muestra en gramos. Reescrito a propósito: es el oráculo. */
const kg = (milli: number): string =>
  Math.abs(milli) < 1000 ? `${milli} g` : `${(milli / 1000).toLocaleString('es-MX', { maximumFractionDigits: 3 })} kg`;
const money = (cents: number): string => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 }).format(cents / 100);

type Visit = (where: string) => Promise<void>;

/**
 * Recolecta, por estado de pantalla, lo que falla en el diseño: así UN fallo lista TODOS los estados defectuosos y no solo el
 * primero. Cada categoría es un barrido de helpers-android.ts.
 */
class Layout {
  readonly bad: Record<string, Record<string, string[]>> = {};
  constructor(
    private readonly page: Page,
    private readonly kinds: Array<'desbordamiento' | 'textoRecortado' | 'finalAlcanzable' | 'objetivosTactiles'> = ['desbordamiento', 'textoRecortado', 'finalAlcanzable'],
  ) {}
  check: Visit = async (where) => {
    const found: Record<string, string[]> = {};
    const add = (k: string, r: string[]) => r.length && (found[k] = r);
    if (this.kinds.includes('desbordamiento')) add('desbordamiento', await overflowReport(this.page));
    if (this.kinds.includes('textoRecortado')) add('textoRecortado', await clippedTextReport(this.page));
    if (this.kinds.includes('objetivosTactiles')) add('objetivosTactiles', await touchTargetReport(this.page));
    if (this.kinds.includes('finalAlcanzable')) add('finalAlcanzable', await bottomReachReport(this.page));
    if (Object.keys(found).length) this.bad[where] = found;
  };
  expectClean(what: string) {
    expect(this.bad, `${what}: estados con defectos de diseño`).toEqual({});
  }
}

/** Mercado de prueba cargado por la interfaz. Por omisión con el reloj fijo (sábado 10 oct 2026, 14:00). */
async function boot(page: Page, opts: MarketOptions & { realTime?: boolean } = {}): Promise<Market> {
  const { realTime = false, ...mo } = opts;
  const market = buildMarket(realTime ? { ...mo, now: new Date() } : mo);
  if (!realTime) await page.clock.setFixedTime(FIXED_NOW);
  await openApp(page, { seed: false });
  await restoreBackup(page, market.backup);
  return market;
}

const KEYS = CATALOG.map((c) => c.key);
const invRow = (page: Page, key: string): Locator => page.getByTestId('inv-row').nth(KEYS.indexOf(key));

/**
 * Con el teclado abierto (ventana encogida): el modo «teclado» se pone (salvo en la caja, que conserva las pestañas), nada se
 * desborda, el campo enfocado cabe en la ventana y no lo tapa la barra de registro, y la acción principal sigue alcanzable.
 */
async function expectKeyboardLayout(page: Page, phone: Phone, field: Locator, opts: { keepTabs?: boolean; primary?: Locator } = {}) {
  await showKeyboard(page, phone);
  // Android vuelve a llevar a la vista el campo enfocado cuando el teclado achica la ventana: se suelta y se enfoca de nuevo
  // para que el navegador haga ese desplazamiento (respetando el scroll-padding de la página).
  await field.evaluate((el) => (el as HTMLElement).blur());
  await field.focus();
  if (opts.keepTabs) {
    await expect(html(page)).not.toHaveClass(/kbd/);
    await expect(page.getByTestId('tab-caja')).toBeVisible();
  } else {
    await expect(html(page)).toHaveClass(/kbd/);
    await expect(page.getByTestId('tab-caja')).toBeHidden();
  }
  const issues: string[] = [...(await overflowReport(page)), ...(await clippedTextReport(page))];
  const f = await rectOf(field);
  const vh = await innerHeight(page);
  if (f.top < -1 || f.bottom > vh + 1) issues.push(`el campo enfocado no cabe en la ventana (${Math.round(f.top)}..${Math.round(f.bottom)} de ${vh})`);
  const dock = page.getByTestId('rec-dock');
  if ((await dock.count()) && (await dock.isVisible()) && (await overlapArea(field, dock)) > 0) issues.push('la barra de registro tapa el campo enfocado');
  if (opts.primary) issues.push(...(await reachReport(opts.primary)));
  expect(issues, `con el teclado abierto (${phone.name})`).toEqual([]);
}
async function closeKeyboard(page: Page, phone: Phone) {
  await hideKeyboard(page, phone);
  await expect(html(page)).not.toHaveClass(/kbd/);
}

// ---- Modos de peso de Recepción: cada combinación con sus datos y los kilos netos esperados (en milésimas) -------------

interface Combo {
  name: string;
  pack: 'granel' | 'caja' | 'arpilla';
  mode: 'directo' | 'por_envase' | 'bruto_tara';
  fill: Record<string, string>;
  net: number;
}
const COMBOS: Combo[] = [
  { name: 'a granel · kilos netos', pack: 'granel', mode: 'directo', fill: { 'rec-net-direct': '120.5' }, net: 120_500 },
  { name: 'a granel · bruto − tara', pack: 'granel', mode: 'bruto_tara', fill: { 'rec-gross': '1250', 'rec-tare': '80.25' }, net: 1_169_750 },
  { name: 'cajas · kilos netos con cuenta de cajas', pack: 'caja', mode: 'directo', fill: { 'rec-net-direct': '600', 'rec-containers': '40' }, net: 600_000 },
  { name: 'cajas × kilos de cada una', pack: 'caja', mode: 'por_envase', fill: { 'rec-containers': '37', 'rec-unit-net': '15.5' }, net: 573_500 },
  { name: 'cajas · bruto − tara', pack: 'caja', mode: 'bruto_tara', fill: { 'rec-gross': '655.5', 'rec-tare': '42' }, net: 613_500 },
  { name: 'arpillas · kilos netos con cuenta de arpillas', pack: 'arpilla', mode: 'directo', fill: { 'rec-net-direct': '350.25', 'rec-containers': '25' }, net: 350_250 },
  { name: 'arpillas × kilos de cada una', pack: 'arpilla', mode: 'por_envase', fill: { 'rec-containers': '48', 'rec-unit-net': '14.75' }, net: 708_000 },
  { name: 'arpillas · bruto − tara', pack: 'arpilla', mode: 'bruto_tara', fill: { 'rec-gross': '702.4', 'rec-tare': '31.9' }, net: 670_500 },
];

// =====================================================================================================================
// Recorridos de pantalla: cada estado interesante de cada sección. Los reutilizan los barridos de diseño, de objetivos
// táctiles y de accesibilidad: así hay UNA sola definición de «qué estados tiene la app».
// =====================================================================================================================

const WALK = {
  async caja(page: Page, visit: Visit) {
    await tab(page, 'caja');
    await expect(page.getByTestId('kg')).toBeVisible();
    await visit('Caja · inicio');
    // «Con semilla» tiene 7 clasificaciones: se muestra la elegida y «Ver las 7 clasificaciones»
    await page.getByTestId('variety').filter({ hasText: 'Con semilla' }).tap();
    await expect(page.getByTestId('quality-all')).toHaveText('Ver las 7 clasificaciones');
    await visit('Caja · Con semilla (7 clasificaciones)');
    await page.getByTestId('quality-all').tap();
    await expect(page.getByTestId('quality-sheet')).toBeVisible();
    await visit('Caja · hoja «Ver las 7 clasificaciones»');
    await page.getByTestId('quality-sheet-close').tap();
    await expect(page.getByTestId('quality-sheet')).toHaveCount(0);
    // «Sin semilla»: 6 clasificaciones en cuadrícula, una sin precio
    await page.getByTestId('variety').filter({ hasText: 'Sin semilla' }).tap();
    await expect(page.getByTestId('quality')).toHaveCount(6);
    await page.getByTestId('quality').filter({ hasText: 'sin precio' }).tap();
    await expect(page.getByTestId('no-price-hint')).toBeVisible();
    await visit('Caja · clasificación sin precio');
    await page.getByTestId('quality').filter({ hasText: 'Primera · 2X' }).tap();
    await page.getByTestId('kg').fill('12.5');
    await page.getByTestId('bill-500').tap();
    await expect(page.getByTestId('change')).toContainText('$100.00');
    await visit('Caja · venta lista para cobrar');
    await page.getByTestId('is-vale').tap();
    await page.getByTestId('customer').fill(LONG_CUSTOMER);
    await visit('Caja · vale con cliente de nombre largo');
    await page.getByTestId('method-transferencia').tap();
    await expect(page.getByTestId('cash')).toHaveCount(0);
    await visit('Caja · pago por transferencia');
    await page.getByTestId('method-efectivo').tap();
    await page.getByTestId('kg').fill('1,500');
    await expect(page.getByTestId('ambiguous').first()).toBeVisible();
    await visit('Caja · número ambiguo «1,500»');
    await page.getByTestId('kg').fill('12.5');
    await page.getByTestId('bill-500').tap();
    await page.getByTestId('confirm').tap();
    await expect(page.getByTestId('confirm-sheet')).toBeVisible();
    await visit('Caja · hoja de confirmar cobro');
    await page.getByTestId('confirm-no').tap();
    await expect(page.getByTestId('confirm-sheet')).toHaveCount(0);
  },

  async vales(page: Page, visit: Visit) {
    await tab(page, 'vales');
    await expect(page.getByTestId('vale')).toHaveCount(4);
    await visit('Vales · pendientes');
    await page.getByTestId('cancel-vale').first().tap();
    await expect(page.getByTestId('cancel-sheet')).toBeVisible();
    await visit('Vales · hoja de cancelar');
    await page.getByTestId('cancel-back').tap();
    await expect(page.getByTestId('cancel-sheet')).toHaveCount(0);
    await page.getByTestId('vales-entregado').tap();
    await expect(page.getByTestId('vale')).toHaveCount(2);
    await visit('Vales · entregados');
    await page.getByTestId('vales-cancelado').tap();
    await expect(page.getByTestId('vale')).toHaveCount(2);
    await visit('Vales · cancelados');
    await page.getByTestId('vales-pendiente').tap();
  },

  async recNueva(page: Page, visit: Visit) {
    await tab(page, 'recepcion');
    await page.getByTestId('rec-sub-nueva').tap();
    await expect(page.getByTestId('rec-pick-hint')).toBeVisible();
    await visit('Recepción › Nueva · vacía');
    await page.getByTestId('rec-variety').filter({ hasText: 'Sin semilla' }).tap();
    await expect(page.getByTestId('rec-class-hint')).toBeVisible();
    await visit('Recepción › Nueva · falta elegir la clasificación');
    await page.getByTestId('rec-class').filter({ hasText: 'Primera · 2X' }).tap();
    await expect(page.getByTestId('rec-selected')).toContainText('Sin semilla · Primera · 2X');
    for (const c of COMBOS) {
      await page.getByTestId(`rec-pack-${c.pack}`).tap();
      await page.getByTestId(`rec-mode-${c.mode}`).tap();
      for (const [testid, value] of Object.entries(c.fill)) await page.getByTestId(testid).fill(value);
      await expect(page.getByTestId('rec-net')).toHaveAttribute('data-milli', String(c.net));
      await visit(`Recepción › Nueva · ${c.name}`);
    }
    // Varias pesadas sumadas (12): lista larga de pesadas
    await page.getByTestId('rec-pack-granel').tap();
    await page.getByTestId('rec-mode-directo').tap();
    await page.getByTestId('rec-net-direct').fill('');
    await page.getByTestId('rec-weigh-toggle').tap();
    for (let i = 1; i <= 12; i++) {
      await page.getByTestId('rec-weigh-input').fill(String(100 + i / 4));
      await page.getByTestId('rec-weigh-add').tap();
    }
    await expect(page.getByTestId('rec-weigh-item')).toHaveCount(12);
    await expect(page.getByTestId('rec-net')).toHaveAttribute('data-milli', '1219500');
    await visit('Recepción › Nueva · 12 pesadas sumadas');
    await page.getByTestId('rec-weigh-toggle').tap(); // «Capturar un solo total»
    // Avisos de captura: número ambiguo, falta de datos, llegada de ayer
    await page.getByTestId('rec-net-direct').fill('1,500');
    await expect(page.getByTestId('rec-input-problem')).toBeVisible();
    await visit('Recepción › Nueva · número ambiguo «1,500»');
    await page.getByTestId('rec-net-direct').fill('');
    await expect(page.getByTestId('rec-missing')).toBeVisible();
    await visit('Recepción › Nueva · falta el peso');
    await page.getByTestId('rec-net-direct').fill('90');
    await page.getByTestId('rec-date-yesterday').tap();
    await expect(page.getByTestId('rec-date-hint')).toBeVisible();
    await page.getByTestId('rec-supplier').fill(sentence(118));
    await page.getByTestId('rec-reference').fill(sentence(58, 'CAM-77 '));
    await page.getByTestId('rec-notes').fill(sentence(498));
    await visit('Recepción › Nueva · llegada de ayer y textos largos');
    await page.getByTestId('rec-new-class-toggle').tap();
    await expect(page.getByTestId('rec-newclass-sheet')).toBeVisible();
    await visit('Recepción › Nueva · hoja «Nueva clasificación»');
    await page.getByTestId('rec-newclass-close').tap();
    await expect(page.getByTestId('rec-newclass-sheet')).toHaveCount(0);
    await page.getByTestId('rec-confirm').tap();
    await expect(page.getByTestId('rec-sheet')).toBeVisible();
    await visit('Recepción › Nueva · hoja de confirmar recepción');
    await page.getByTestId('rec-confirm-no').tap();
    await expect(page.getByTestId('rec-sheet')).toHaveCount(0);
  },

  async recBorradores(page: Page, visit: Visit) {
    await tab(page, 'recepcion');
    await page.getByTestId('rec-sub-borradores').tap();
    await expect(page.getByTestId('rec-draft-row')).toHaveCount(3);
    await visit('Recepción › Borradores');
    await page.getByTestId('rec-draft-row').first().getByTestId('rec-draft-cancel').tap();
    await expect(page.getByTestId('rec-draft-cancel-yes')).toBeVisible();
    await visit('Recepción › Borradores · confirmar descartar');
    await page.getByTestId('rec-draft-cancel-no').tap();
  },

  async recHistorial(page: Page, visit: Visit) {
    await tab(page, 'recepcion');
    await page.getByTestId('rec-sub-historial').tap();
    await expect(page.getByTestId('rec-row').first()).toBeVisible();
    await visit('Recepción › Historial · registradas');
    const corrected = page.getByTestId('rec-row').filter({ has: page.getByTestId('rec-row-corrections') }).first();
    for (const [testid, name] of [['rec-correct', 'corregir kilos'], ['rec-edit-data', 'corregir datos'], ['rec-void', 'anular'], ['rec-moves', 'detalle']] as const) {
      await corrected.getByTestId(testid).tap();
      await visit(`Recepción › Historial · ${name} (fila corregida)`);
    }
    const edited = page.getByTestId('rec-row').filter({ has: page.getByTestId('rec-row-dataedits') }).first();
    await edited.getByTestId('rec-moves').tap();
    await visit('Recepción › Historial · detalle con datos corregidos');
    await page.getByTestId('rec-filter-anulada').tap();
    await expect(page.getByTestId('rec-row')).toHaveCount(2);
    await page.getByTestId('rec-row').first().getByTestId('rec-moves').tap();
    await visit('Recepción › Historial · anuladas');
    await page.getByTestId('rec-filter-cancelada').tap();
    await expect(page.getByTestId('rec-row')).toHaveCount(2);
    await visit('Recepción › Historial · descartadas');
    await page.getByTestId('rec-filter-todas').tap();
    await visit('Recepción › Historial · todas');
    await page.getByTestId('rec-filter-confirmada').tap();
  },

  async recResumen(page: Page, visit: Visit) {
    await tab(page, 'recepcion');
    await page.getByTestId('rec-sub-resumen').tap();
    await expect(page.getByTestId('rep-received')).toBeVisible();
    await visit('Recepción › Resumen · hoy');
    for (const summary of await page.locator('details.fold > summary').all()) {
      if (await summary.evaluate((el) => !(el.parentElement as HTMLDetailsElement).open)) await summary.tap();
    }
    await expect(page.locator('details.fold:not([open])')).toHaveCount(0);
    await visit('Recepción › Resumen · hoy con todos los <details> abiertos');
    await page.getByTestId('rep-week').tap();
    await expect(page.getByTestId('rep-day-row').first()).toBeVisible();
    await visit('Recepción › Resumen · últimos 7 días con todo abierto');
  },

  async inventario(page: Page, visit: Visit, market: Market) {
    await tab(page, 'inventario');
    await expect(page.getByTestId('inv-row')).toHaveCount(CATALOG.length);
    await visit('Inventario · lista de 16 clasificaciones');
    const first = invRow(page, 'sin-1ra-2x');
    for (const [testid, name] of [['move-entrada', 'entrada manual'], ['move-merma', 'merma'], ['move-ajuste', 'conteo físico']] as const) {
      await first.getByTestId(testid).tap();
      await expect(first.getByTestId('move-form')).toBeVisible();
      await visit(`Inventario · formulario de ${name}`);
    }
    await first.getByTestId('move-form').getByRole('button', { name: 'Cancelar' }).tap();
    await first.getByTestId('show-moves').tap();
    const movesOfFirst = market.backup.stockMoves.filter((m) => m.productId === market.product('sin-1ra-2x').id).length;
    await expect(first.getByTestId('moves-list').locator('li')).toHaveCount(Math.min(15, movesOfFirst));
    await visit('Inventario · historial de movimientos abierto');
    await first.getByTestId('show-moves').tap();
    await expect(invRow(page, 'oax-3ra-500').getByTestId('stock-negative')).toBeVisible();
    await expect(invRow(page, 'sin-3ra').getByTestId('class-edits')).toBeVisible();
    await visit('Inventario · existencia negativa y bitácora de ediciones');
    const longRow = invRow(page, 'largo');
    await longRow.getByTestId('edit-product').tap();
    await expect(longRow.getByTestId('edit-moves-warning')).toBeVisible();
    await visit('Inventario · edición de la clasificación de nombre largo');
    await longRow.getByTestId('edit-cancel').tap();
  },

  async corte(page: Page, visit: Visit, market: Market) {
    await tab(page, 'corte');
    await expect(page.getByTestId('r-total')).toHaveText(money(market.facts.openShift.totalCents));
    await visit('Corte · turno abierto con muchas ventas');
    await page.getByTestId('counted').fill(String((market.facts.openShift.expectedCents - 500) / 100));
    await expect(page.getByTestId('diff')).toContainText('Faltan $5.00');
    await visit('Corte · efectivo contado con diferencia');
    await page.getByTestId('counted').fill('');
  },

  async mas(page: Page, visit: Visit, market: Market) {
    await tab(page, 'mas');
    await expect(page.getByTestId('hist-summary')).toContainText(`${market.facts.today.sales} ventas`);
    await visit('Más · historial, respaldo y estado de los datos');
    await page.getByTestId('audit').tap();
    await expect(page.getByTestId('audit-result')).toContainText('Sin inconsistencias');
    await visit('Más · auditoría abierta');
    await page.getByTestId('import-file').setInputFiles({ name: 'mercado.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(market.backup)) });
    await expect(page.getByTestId('restore-sheet')).toBeVisible();
    await visit('Más · hoja de restaurar con pérdida');
    await page.getByTestId('restore-cancel').tap();
    await expect(page.getByTestId('restore-sheet')).toHaveCount(0);
  },
};

/** Recorre TODAS las pantallas y estados con un mismo `visit`. */
async function walkEverything(page: Page, visit: Visit, market: Market) {
  await WALK.caja(page, visit);
  await WALK.vales(page, visit);
  await WALK.recNueva(page, visit);
  await WALK.recBorradores(page, visit);
  await WALK.recHistorial(page, visit);
  await WALK.recResumen(page, visit);
  await WALK.inventario(page, visit, market);
  await WALK.corte(page, visit, market);
  await WALK.mas(page, visit, market);
}

const receivedOn = (market: Market, day: string) =>
  market.backup.receptions.filter((r) => r.status === 'confirmada' && r.day === day).reduce((a, r) => a + (r.netMilli ?? 0), 0);

// =====================================================================================================================
// A. Pantallas pobladas, por tamaño (caso 21)
// =====================================================================================================================

for (const phone of PHONES) {
  test.describe(`Android · pantallas pobladas · ${phone.name}`, () => {
    test.use({ viewport: { width: phone.width, height: phone.height } });

    test('Caja con datos: completa y sin desbordar; el cobro con toques descuenta los kilos exactos y los límites se respetan', async ({ page }) => {
      test.setTimeout(90_000);
      const market = await boot(page);
      const layout = new Layout(page);
      const sin = market.product('sin-1ra-2x');
      const stock = market.facts.stock('sin-1ra-2x');

      // Lo que se ve al abrir: las cuatro variedades del mercado, la primera elegida con su precio y su existencia reales.
      await tab(page, 'caja');
      await expect(page.getByTestId('variety')).toHaveText(['Sin semilla', 'Con semilla', 'Limón criollo de exportación selecta', 'Limón en bolsa']);
      await expect(page.getByTestId('selling')).toHaveText('Vendiendo: Sin semilla · Primera · 2X');
      await expect(page.getByTestId('price')).toHaveValue('32');
      await expect(page.getByTestId('stock-hint')).toHaveText(`Disponible: ${kg(stock.available)} · Reservado: ${kg(stock.reserved)}`);

      // Camino negativo: kilos vacíos, cero, negativos, de más, con letras o en notación científica NO permiten cobrar.
      for (const bad of ['', '0', '-5', '200000.001', 'abc', '1e3']) {
        await page.getByTestId('kg').fill(bad);
        await expect(page.getByTestId('confirm'), `kilos «${bad}»`).toBeDisabled();
        await expect(page.getByTestId('total'), `kilos «${bad}»`).toContainText('$0.00');
      }

      // Cobro completo por toques: 12.5 kg × $32 = $400.00, con billete de $500 → cambio $100.00.
      const before = await readDb(page);
      await page.getByTestId('kg').fill('12.5');
      await expect(page.getByTestId('total')).toContainText('$400.00');
      await page.getByTestId('bill-500').tap();
      await expect(page.getByTestId('change')).toContainText('$100.00');
      await page.getByTestId('confirm').tap();
      await expect(page.getByTestId('sheet-total')).toHaveText('$400.00');
      await expect(page.getByTestId('sheet-change')).toContainText('$100.00');
      await expect(page.getByTestId('stock-warning')).toHaveCount(0); // hay 645 kg disponibles: no pide autorización
      await page.getByTestId('confirm-yes').tap();
      await expect(page.getByTestId('toast')).toContainText(`Venta #${market.facts.nextFolio} guardada`);
      await expect(page.getByTestId('last-sale')).toContainText(`Última: #${market.facts.nextFolio} · $400.00 · cambio $100.00`);
      const after = await readDb(page);
      expect(after.sales).toHaveLength(before.sales.length + 1);
      const sale = after.sales.find((s) => s.folio === market.facts.nextFolio)!;
      expect(sale).toMatchObject({ totalCents: 40_000, receivedCents: 50_000, changeCents: 10_000, paymentMethod: 'efectivo', delivery: 'inmediata', status: 'completada' });
      expect(sale.items).toHaveLength(1);
      expect(sale.items[0]).toMatchObject({ productId: sin.id, qtyMilli: 12_500, unitPriceCents: 3200, totalCents: 40_000 });
      expect(after.products.find((p) => p.id === sin.id)!.physicalMilli).toBe(stock.physical - 12_500);
      expect(after.stockMoves).toHaveLength(before.stockMoves.length + 1);
      expect(after.nextFolio).toBe(market.facts.nextFolio + 1);
      expect(invariants(after), 'invariantes tras la venta').toEqual([]);
      await expect(page.getByTestId('kg')).toHaveValue(''); // la caja queda lista para la siguiente

      // Pantalla y estados (teclado cerrado)
      await WALK.caja(page, layout.check);
      layout.expectClean(`Caja · ${phone.name}`);

      // Teclado abierto: en la caja rápida las pestañas se conservan (se escribe entre venta y venta) y «Cobrar» se alcanza.
      await tab(page, 'caja');
      await expectKeyboardLayout(page, phone, page.getByTestId('kg'), { keepTabs: true, primary: page.getByTestId('confirm') });
      await closeKeyboard(page, phone);
    });

    test('Estados vacíos de las seis secciones y las cuatro subsecciones: no se inventa nada, nada se desborda y el teclado abierto funciona', async ({ page }) => {
      test.setTimeout(90_000);
      await openApp(page, { seed: false });
      const layout = new Layout(page);

      await expect(page.getByTestId('caja-vacia')).toBeVisible();
      await expect(page.getByTestId('variety')).toHaveCount(0);
      await expect(page.getByTestId('kg')).toHaveCount(0);
      await layout.check('Caja · sin variedades');
      const form = page.locator('[data-testid="new-variety"]:visible');
      await expectKeyboardLayout(page, phone, form.getByTestId('new-name'), { primary: form.getByTestId('add-product') });
      await closeKeyboard(page, phone);

      await tab(page, 'vales');
      for (const st of ['pendiente', 'entregado', 'cancelado']) {
        await page.getByTestId(`vales-${st}`).tap();
        await expect(page.locator('[data-testid="vales"] .empty')).toHaveText(`No hay vales en estado ${st.toUpperCase()}.`);
        await layout.check(`Vales · vacío (${st})`);
      }

      await tab(page, 'recepcion');
      await expect(page.getByTestId('rec-sin-productos')).toBeVisible();
      await expect(page.getByTestId('rec-net')).toHaveAttribute('data-milli', '');
      await expect(page.getByTestId('rec-confirm')).toHaveAttribute('aria-disabled', 'true');
      await layout.check('Recepción › Nueva · sin clasificaciones');
      await page.getByTestId('rec-sub-borradores').tap();
      await expect(page.getByTestId('rec-borradores').locator('.empty')).toHaveText('No hay borradores.');
      await layout.check('Recepción › Borradores · vacío');
      await page.getByTestId('rec-sub-historial').tap();
      await expect(page.getByTestId('rec-historial').locator('.empty')).toHaveText('No hay recepciones con ese filtro.');
      await expect(page.getByTestId('rec-hist-count')).toHaveCount(0);
      await layout.check('Recepción › Historial · vacío');
      await page.getByTestId('rec-sub-resumen').tap();
      await expect(page.getByTestId('rep-received')).toHaveAttribute('data-milli', '0');
      await expect(page.getByTestId('rep-available')).toHaveAttribute('data-milli', '0');
      await layout.check('Recepción › Resumen · sin datos');

      await tab(page, 'inventario');
      await expect(page.getByTestId('inventario').locator('.empty')).toHaveText('Aún no hay productos. Agrégalos abajo.');
      await layout.check('Inventario · vacío');

      await tab(page, 'corte');
      await expect(page.getByTestId('corte').locator('.empty')).toContainText('No hay turno abierto');
      await layout.check('Corte · sin turno');
      await expectKeyboardLayout(page, phone, page.getByTestId('opening'), { primary: page.getByTestId('open-shift') });
      await closeKeyboard(page, phone);

      await tab(page, 'mas');
      await expect(page.getByTestId('historial').locator('.empty')).toHaveText('Sin ventas ese día.');
      await expect(page.getByTestId('last-backup')).toHaveText('Último respaldo: nunca'); // sin datos no se pide respaldo
      await page.getByTestId('audit').tap();
      await expect(page.getByTestId('audit-result')).toContainText('Sin inconsistencias (0 ventas, 0 vales, 0 recepciones, 0 movimientos)');
      await layout.check('Más · sin datos');

      // Nada se inventó: la base está vacía y los folios empiezan en 1.
      const d = await readDb(page);
      for (const k of ['products', 'sales', 'shifts', 'cashMovements', 'stockMoves', 'receptions'] as const) expect(d[k], k).toEqual([]);
      expect([d.nextFolio, d.nextValeFolio, d.nextReceptionFolio]).toEqual([1, 1, 1]);
      layout.expectClean(`Estados vacíos · ${phone.name}`);
    });

    test('Vales con varios vales: los tres estados, el nombre largo del cliente, entregar y cancelar con efecto exacto en kilos y en caja', async ({ page }) => {
      test.setTimeout(90_000);
      const market = await boot(page);
      const layout = new Layout(page);
      const pending = market.backup.sales.filter((s) => s.delivery === 'pendiente').sort((a, b) => a.folio - b.folio);
      expect(pending).toHaveLength(market.facts.valesPending);

      await WALK.vales(page, layout.check);
      layout.expectClean(`Vales · ${phone.name}`);

      // Datos reales de cada estado
      await tab(page, 'vales');
      await expect(page.getByTestId('vale')).toHaveCount(4);
      await expect(page.getByTestId('vale').filter({ hasText: LONG_CUSTOMER })).toHaveCount(1); // el nombre largo se ve completo
      await page.getByTestId('vales-cancelado').tap();
      const infos = page.getByTestId('cancel-info');
      await expect(infos).toHaveCount(2);
      await expect(infos.filter({ hasText: 'EFECTIVO' })).toHaveCount(1);
      await expect(infos.filter({ hasText: 'NO se devolvió dinero' })).toHaveCount(1);
      await page.getByTestId('vales-pendiente').tap();

      // Entregar el primero: sale de bodega y se libera el apartado, SIN cobrar otra vez.
      const first = pending[0];
      const prod = first.items[0];
      const d0 = await readDb(page);
      const p0 = d0.products.find((p) => p.id === prod.productId)!;
      await page.getByTestId('vale').first().getByTestId('deliver').tap();
      await expect(page.getByTestId('toast')).toContainText(`Vale V-${first.valeFolio} entregado`);
      await expect(page.getByTestId('vale')).toHaveCount(3);
      const d1 = await readDb(page);
      expect(d1.sales.find((s) => s.id === first.id)).toMatchObject({ delivery: 'entregado' });
      const p1 = d1.products.find((p) => p.id === prod.productId)!;
      expect([p1.physicalMilli, p1.reservedMilli]).toEqual([p0.physicalMilli - prod.qtyMilli, p0.reservedMilli - prod.qtyMilli]);
      expect(d1.stockMoves).toHaveLength(d0.stockMoves.length + 1);
      expect(d1.cashMovements).toHaveLength(d0.cashMovements.length); // entregar no es dinero
      expect(d1.sales.reduce((a, s) => a + s.totalCents, 0)).toBe(d0.sales.reduce((a, s) => a + s.totalCents, 0));

      // Cancelar el siguiente con la hoja y el teclado abierto: exige motivo y qué pasó con el dinero.
      const second = pending[1];
      const sprod = second.items[0];
      await page.getByTestId('vale').first().getByTestId('cancel-vale').tap();
      await expect(page.getByTestId('cancel-sheet')).toBeVisible();
      await expect(page.getByTestId('cancel-confirm')).toBeDisabled(); // sin motivo ni decisión sobre el dinero
      await showKeyboard(page, phone);
      await page.getByTestId('cancel-reason').focus();
      await expect(html(page)).toHaveClass(/kbd/);
      await page.getByTestId('cancel-reason').fill('El cliente no vino por su pedido');
      await expect(page.getByTestId('cancel-confirm')).toBeDisabled(); // falta decidir el dinero
      expect(await reachReport(page.getByTestId('refund-efectivo'))).toEqual([]);
      await page.getByTestId('refund-efectivo').tap();
      await expect(page.getByTestId('refund-efectivo')).toBeChecked();
      expect(await reachReport(page.getByTestId('cancel-confirm'))).toEqual([]);
      await page.getByTestId('cancel-confirm').tap();
      await expect(page.getByTestId('toast')).toContainText(`Vale V-${second.valeFolio} cancelado`);
      await closeKeyboard(page, phone);
      const d2 = await readDb(page);
      expect(d2.sales.find((s) => s.id === second.id)).toMatchObject({ delivery: 'cancelado', refundMethod: 'efectivo', refundCents: second.totalCents, cancelReason: 'El cliente no vino por su pedido' });
      const q = d2.products.find((p) => p.id === sprod.productId)!;
      const q1 = d1.products.find((p) => p.id === sprod.productId)!;
      expect(q.reservedMilli).toBe(q1.reservedMilli - sprod.qtyMilli); // se liberó el apartado
      expect(q.physicalMilli).toBe(q1.physicalMilli); // la mercancía sigue en bodega
      expect(d2.cashMovements).toHaveLength(d1.cashMovements.length + 1);
      expect(d2.cashMovements.find((m) => m.saleId === second.id)).toMatchObject({ type: 'devolucion', amountCents: second.totalCents });
      expect(invariants(d2), 'invariantes').toEqual([]);
      // La devolución en efectivo sale de la caja: el corte lo refleja exactamente.
      await tab(page, 'corte');
      await expect(page.getByTestId('r-refunds')).toContainText(money(market.facts.openShift.refundsCents + second.totalCents));
      await expect(page.getByTestId('r-expected')).toHaveText(money(market.facts.openShift.expectedCents - second.totalCents));
    });

    test('Recepción › Nueva: cada presentación y modo de peso con su neto exacto, sin desbordar, con teclado abierto, y se registra con toques', async ({ page }) => {
      test.setTimeout(120_000);
      const market = await boot(page);
      const layout = new Layout(page);

      // Camino negativo: con el formulario vacío «Registrar recepción» avisa lo que falta y no abre nada ni guarda nada.
      await tab(page, 'recepcion');
      const d0 = await readDb(page);
      await page.getByTestId('rec-confirm').tap({ force: true }); // aria-disabled: Playwright lo trata como deshabilitado
      await expect(page.getByTestId('toast')).toContainText('Escribe los kilos netos');
      await expect(page.getByTestId('rec-sheet')).toHaveCount(0);
      expect((await readDb(page)).receptions).toHaveLength(d0.receptions.length);

      await WALK.recNueva(page, layout.check);
      layout.expectClean(`Recepción › Nueva · ${phone.name}`);

      // Teclado abierto con el formulario poblado: la barra de registro se pega al borde y el botón se alcanza.
      await page.getByTestId('rec-supplier').fill('Huerta de prueba Android');
      await expectKeyboardLayout(page, phone, page.getByTestId('rec-supplier'), { primary: page.getByTestId('rec-confirm') });
      // Los demás campos de abajo, los más expuestos a la barra de registro: ninguno queda tapado y el botón se alcanza.
      for (const field of ['rec-reference', 'rec-notes'] as const) {
        await expectKeyboardLayout(page, phone, page.getByTestId(field), { primary: page.getByTestId('rec-confirm') });
      }
      // (con el formulario a la mitad de su recorrido: al final de la página el relleno inferior la deja un poco más arriba)
      await page.evaluate(() => window.scrollTo(0, 0));
      const dock = await rectOf(page.getByTestId('rec-dock'));
      expect(Math.abs(dock.bottom - (await innerHeight(page))), 'la barra de registro debe pegarse al borde inferior con el teclado abierto').toBeLessThanOrEqual(1.5);
      await closeKeyboard(page, phone);

      // Registro real por toques: 37 cajas × 15.5 kg = 573.5 kg (aritmética entera exacta) para «Sin semilla · Primera · 2X».
      const stock0 = market.facts.stock('sin-1ra-2x').physical;
      const sin = market.product('sin-1ra-2x');
      await page.getByTestId('rec-pack-caja').tap();
      await page.getByTestId('rec-mode-por_envase').tap();
      await page.getByTestId('rec-containers').fill('37');
      await page.getByTestId('rec-unit-net').fill('15.5');
      await page.getByTestId('rec-reference').fill(`AND-${phone.width}`);
      await page.getByTestId('rec-date-now').tap();
      await page.getByTestId('rec-confirm').tap();
      await expect(page.getByTestId('rec-sheet')).toBeVisible();
      await expect(page.getByTestId('rec-sheet-net')).toHaveAttribute('data-milli', '573500');
      await expect(page.getByTestId('rec-sheet-detail')).toContainText('37 cajas × 15.5 kg');
      await expect(page.getByTestId('rec-sheet-stock')).toContainText(`${kg(stock0)} → ${kg(stock0 + 573_500)}`);
      await page.getByTestId('rec-confirm-yes').tap();
      await expect(page.getByTestId('toast')).toContainText(`Recepción R-${market.facts.nextReceptionFolio} registrada: +573.5 kg`);
      await expect(page.getByTestId('rec-last')).toContainText(`Última registrada: R-${market.facts.nextReceptionFolio}`);
      const d1 = await readDb(page);
      expect(d1.receptions).toHaveLength(d0.receptions.length + 1);
      const rec = d1.receptions.find((r) => r.folio === market.facts.nextReceptionFolio)!;
      expect(rec).toMatchObject({ status: 'confirmada', packaging: 'caja', weightMode: 'por_envase', containers: 37, unitNetMilli: 15_500, confirmedNetMilli: 573_500, netMilli: 573_500, productId: sin.id, reference: `AND-${phone.width}` });
      expect(d1.products.find((p) => p.id === sin.id)!.physicalMilli).toBe(stock0 + 573_500);
      const move = d1.stockMoves.find((m) => m.receptionId === rec.id)!;
      expect(move).toMatchObject({ type: 'recepcion', deltaMilli: 573_500, productId: sin.id });
      expect(d1.stockMoves).toHaveLength(d0.stockMoves.length + 1);
      expect(d1.nextReceptionFolio).toBe(market.facts.nextReceptionFolio + 1);
      expect(invariants(d1), 'invariantes tras recibir').toEqual([]);
      // El formulario queda limpio y listo para otra recepción.
      await expect(page.getByTestId('rec-net')).toHaveAttribute('data-milli', '');
      await expect(page.getByTestId('rec-pick-hint')).toBeVisible();
    });

    test('Recepción › Borradores, Historial (63 registradas, corregida, anulada, descartada) y Resumen cuadran con el libro; completar y descartar borradores', async ({ page }) => {
      test.setTimeout(150_000);
      const market = await boot(page, { confirmedReceptions: 60 });
      const layout = new Layout(page);
      const today = mxDay(market.now);
      const confirmed = market.backup.receptions.filter((r) => r.status === 'confirmada');
      expect(confirmed).toHaveLength(market.facts.receptionsConfirmed);
      expect(confirmed.length).toBeGreaterThan(50);

      await WALK.recBorradores(page, layout.check);
      await WALK.recHistorial(page, layout.check);
      await WALK.recResumen(page, layout.check);
      layout.expectClean(`Recepción › Borradores, Historial y Resumen · ${phone.name}`);

      // ---- Historial: paginación, totales, búsqueda
      await tab(page, 'recepcion');
      await page.getByTestId('rec-sub-historial').tap();
      const n = confirmed.length;
      await expect(page.getByTestId('rec-hist-count')).toHaveText(`Mostrando 50 de ${n}`);
      await expect(page.getByTestId('rec-row')).toHaveCount(50);
      await expect(page.getByTestId('rec-hist-more')).toHaveText(`Mostrar ${n - 50} más`);
      await expect(page.getByTestId('rec-hist-total')).toContainText(`${n} recepciones registradas`);
      await expect(page.getByTestId('rec-hist-total')).toContainText(kg(confirmed.reduce((a, r) => a + (r.netMilli ?? 0), 0)));
      await page.getByTestId('rec-hist-more').tap();
      await expect(page.getByTestId('rec-hist-count')).toHaveText(`Mostrando ${n} de ${n}`);
      await expect(page.getByTestId('rec-row')).toHaveCount(n);
      await expect(page.getByTestId('rec-hist-more')).toHaveCount(0);
      const corrected2 = page.getByTestId('rec-row').filter({ hasText: 'Corregida 2 veces' });
      await expect(corrected2).toHaveCount(1);
      await expect(corrected2).toContainText('La báscula estaba descalibrada');
      await expect(corrected2.getByTestId('rec-row-corrections')).toContainText('vigente');
      await page.getByTestId('rec-search').fill('CAM-77');
      await expect(page.getByTestId('rec-row')).toHaveCount(4);
      await expect(page.getByTestId('rec-row').filter({ hasText: 'Rancho Los Limones' })).toHaveCount(4);
      await page.getByTestId('rec-search').fill('zzzz-no-existe');
      await expect(page.getByTestId('rec-historial').locator('.empty')).toHaveText('No hay recepciones con ese filtro.');
      await expect(page.getByTestId('rec-hist-total')).toHaveCount(0);
      await page.getByTestId('rec-search').fill('');
      await page.getByTestId('rec-filter-anulada').tap();
      await expect(page.getByTestId('rec-row-net').first()).toContainText('0 kg (se habían recibido');
      await page.getByTestId('rec-filter-cancelada').tap();
      await expect(page.getByTestId('rec-row').first()).toContainText('Descartada: ');
      await expect(page.getByTestId('rec-row-net').first()).toHaveText('—');

      // ---- Resumen del día: lo que llegó y el cuadre salen del libro, no de la app
      await page.getByTestId('rec-sub-resumen').tap();
      await expect(page.getByTestId('rep-received')).toHaveAttribute('data-milli', String(receivedOn(market, today)));
      const soldToday = market.backup.sales
        .filter((s) => s.day === today && s.status === 'completada' && s.delivery !== 'cancelado')
        .reduce((a, s) => a + s.items.filter((i) => i.unit === 'kg').reduce((b, i) => b + i.qtyMilli, 0), 0);
      await expect(page.getByTestId('rep-sold')).toHaveAttribute('data-milli', String(soldToday));
      const availableKg = market.backup.products.filter((p) => p.unit === 'kg').reduce((a, p) => a + p.physicalMilli - p.reservedMilli, 0);
      await expect(page.getByTestId('rep-available')).toHaveAttribute('data-milli', String(availableKg));
      await expect(page.getByTestId('rep-ledger-cuadra')).toBeVisible();
      await page.getByTestId('rep-week').tap();
      const week = new Set<string>();
      for (let k = 0; k < 7; k++) week.add(mxDay(new Date(market.now.getTime() - k * 86_400_000)));
      const days = new Set<string>([
        ...confirmed.filter((r) => week.has(r.day)).map((r) => r.day),
        ...market.backup.sales.filter((s) => week.has(s.day) && s.status === 'completada' && s.delivery !== 'cancelado').map((s) => s.day),
      ]);
      await expect(page.getByTestId('rep-day-row')).toHaveCount(days.size);

      // ---- Borradores: completar uno (el borrador pasa a registrada con el MISMO id) y descartar otro
      await page.getByTestId('rec-sub-borradores').tap();
      const rows = page.getByTestId('rec-draft-row');
      await expect(rows.filter({ hasText: 'Sin producto elegido' })).toHaveCount(1);
      await expect(rows.filter({ hasText: 'Falta: Escribe cuántas arpillas' })).toHaveCount(1);
      const d1 = rows.filter({ hasText: 'Con semilla · Oaxaca · Primera · 300' });
      await expect(d1).toContainText('Caja · 40 cajas · Huerta San Miguel · ref. CAM-205');
      await expect(d1).toContainText('Falta: Escribe el peso neto de cada caja');
      const d2 = rows.filter({ hasText: 'Con semilla · Michoacán · Segunda · 300' });
      await expect(d2).toContainText('Kilos netos: 75 kg');
      const before = await readDb(page);
      const draft1 = before.receptions.find((r) => r.status === 'borrador' && r.reference === 'CAM-205')!;
      const draft2 = before.receptions.find((r) => r.status === 'borrador' && r.supplier === 'Don Pepe')!;
      const oax = market.product('oax-1ra-300');
      const oaxStock = before.products.find((p) => p.id === oax.id)!.physicalMilli;

      await d1.getByTestId('rec-draft-open').tap();
      await expect(page.getByTestId('toast')).toContainText('Borrador abierto: completa lo que falta');
      await expect(page.getByTestId('rec-nueva')).toBeVisible();
      await expect(page.getByTestId('rec-containers')).toHaveValue('40');
      await expect(page.getByTestId('rec-supplier')).toHaveValue('Huerta San Miguel');
      await expect(page.getByTestId('rec-reference')).toHaveValue('CAM-205');
      await expect(page.getByTestId('rec-net')).toHaveAttribute('data-milli', ''); // aún falta el peso de cada caja
      await page.getByTestId('rec-unit-net').fill('15.5');
      await expect(page.getByTestId('rec-net')).toHaveAttribute('data-milli', '620000');
      await page.getByTestId('rec-confirm').tap();
      await expect(page.getByTestId('rec-sheet-net')).toHaveAttribute('data-milli', '620000');
      await page.getByTestId('rec-confirm-yes').tap();
      await expect(page.getByTestId('toast')).toContainText(`Recepción R-${market.facts.nextReceptionFolio} registrada: +620 kg`);
      const mid = await readDb(page);
      expect(mid.receptions).toHaveLength(before.receptions.length); // el borrador SE CONVIRTIÓ, no se duplicó
      expect(mid.receptions.find((r) => r.id === draft1.id)).toMatchObject({ status: 'confirmada', folio: market.facts.nextReceptionFolio, confirmedNetMilli: 620_000 });
      expect(mid.products.find((p) => p.id === oax.id)!.physicalMilli).toBe(oaxStock + 620_000);
      expect(mid.stockMoves).toHaveLength(before.stockMoves.length + 1);

      await page.getByTestId('rec-sub-borradores').tap();
      await expect(rows).toHaveCount(2);
      await rows.filter({ hasText: 'Con semilla · Michoacán · Segunda · 300' }).getByTestId('rec-draft-cancel').tap();
      await rows.filter({ hasText: 'Con semilla · Michoacán · Segunda · 300' }).getByTestId('rec-draft-cancel-yes').tap();
      await expect(page.getByTestId('toast')).toContainText('Borrador descartado: no cambió el inventario');
      await expect(rows).toHaveCount(1);
      const end = await readDb(page);
      expect(end.receptions.find((r) => r.id === draft2.id)).toMatchObject({ status: 'cancelada' });
      expect(end.stockMoves).toHaveLength(mid.stockMoves.length); // descartar no mueve inventario
      expect(end.products.map((p) => p.physicalMilli)).toEqual(mid.products.map((p) => p.physicalMilli));
      expect(invariants(end), 'invariantes').toEqual([]);
    });

    test('Inventario con 16 clasificaciones: lista, existencia negativa, formularios y edición sin desbordar; entradas, mermas y conteos con efecto exacto', async ({ page }) => {
      test.setTimeout(120_000);
      const market = await boot(page);
      const layout = new Layout(page);
      await WALK.inventario(page, layout.check, market);
      layout.expectClean(`Inventario · ${phone.name}`);

      await tab(page, 'inventario');
      // La lista cuenta lo que el libro dice (kilos exactos, apartado, negativo) y marca la oculta.
      const sin = market.facts.stock('sin-1ra-2x');
      const row0 = invRow(page, 'sin-1ra-2x');
      await expect(row0.getByTestId('stock-physical')).toHaveText(kg(sin.physical));
      await expect(row0.getByTestId('stock-reserved')).toHaveText(kg(sin.reserved));
      await expect(row0.getByTestId('stock-available')).toHaveText(kg(sin.available));
      const neg = invRow(page, 'oax-3ra-500');
      await expect(neg.getByTestId('stock-available')).toHaveText('-12.5 kg');
      await expect(neg.getByTestId('stock-negative')).toContainText('Quedan -12.5 kg');
      await expect(invRow(page, 'sin-4ta-oculta').getByRole('button', { name: 'Activar' })).toBeVisible();

      // Entrada manual de 100 piezas (no es kg: no hay aviso de recepción reciente). Por toques.
      const before = await readDb(page);
      const pieza = invRow(page, 'pieza');
      await pieza.getByTestId('move-entrada').tap();
      await pieza.getByTestId('move-qty').fill('100');
      await pieza.getByTestId('move-note').fill('Bolsas nuevas del proveedor');
      await pieza.getByTestId('move-save').tap();
      await expect(page.getByTestId('toast')).toContainText('Entrada manual registrada');
      let d = await readDb(page);
      expect(d.products.find((p) => p.id === market.product('pieza').id)!.physicalMilli).toBe(5_100_000);
      expect(d.stockMoves.find((m) => m.note === 'Bolsas nuevas del proveedor')).toMatchObject({ type: 'entrada', deltaMilli: 100_000 });

      // Merma: sin motivo no se puede guardar; con motivo resta exactamente.
      const tercera = invRow(page, 'sin-3ra');
      await tercera.getByTestId('move-merma').tap();
      await tercera.getByTestId('move-qty').fill('2');
      await expect(tercera.getByTestId('move-save')).toBeDisabled();
      await tercera.getByTestId('move-note').fill('Se aplastó una caja');
      await tercera.getByTestId('move-save').tap();
      await expect(page.getByTestId('toast')).toContainText('Merma registrada');
      const t0 = market.facts.stock('sin-3ra').physical;
      d = await readDb(page);
      expect(d.products.find((p) => p.id === market.product('sin-3ra').id)!.physicalMilli).toBe(t0 - 2000);

      // Conteo físico: la existencia queda en lo contado y el movimiento guarda la diferencia.
      const segunda = invRow(page, 'sin-2da-3x');
      const s0 = market.facts.stock('sin-2da-3x').physical;
      await segunda.getByTestId('move-ajuste').tap();
      await segunda.getByTestId('move-qty').fill('860');
      await segunda.getByTestId('move-note').fill('Conteo del lunes');
      await segunda.getByTestId('move-save').tap();
      await expect(page.getByTestId('toast')).toContainText('Conteo físico registrado');
      d = await readDb(page);
      expect(d.products.find((p) => p.id === market.product('sin-2da-3x').id)!.physicalMilli).toBe(860_000);
      expect(d.stockMoves.find((m) => m.note === 'Conteo del lunes')).toMatchObject({ type: 'ajuste', deltaMilli: 860_000 - s0 });
      expect(d.stockMoves).toHaveLength(before.stockMoves.length + 3);
      expect(invariants(d), 'invariantes').toEqual([]);

      // Teclado abierto con el formulario de movimiento
      await row0.getByTestId('move-entrada').tap();
      await expectKeyboardLayout(page, phone, row0.getByTestId('move-qty'), { primary: row0.getByTestId('move-save') });
      await closeKeyboard(page, phone);
    });

    test('Corte con turno abierto y 35 ventas: cifras del libro, teclado abierto y cierre con diferencia exacta', async ({ page }) => {
      test.setTimeout(120_000);
      const market = await boot(page);
      const layout = new Layout(page);
      const f = market.facts.openShift;
      page.on('dialog', (dlg) => dlg.accept()); // «¿Cerrar el turno?»

      await WALK.corte(page, layout.check, market);
      layout.expectClean(`Corte · ${phone.name}`);

      await tab(page, 'corte');
      await expect(page.getByTestId('r-total')).toHaveText(money(f.totalCents));
      await expect(page.getByTestId('r-efectivo')).toHaveText(money(f.efectivoCents));
      await expect(page.getByTestId('r-refunds')).toContainText(money(f.refundsCents));
      await expect(page.getByTestId('r-expected')).toHaveText(money(f.expectedCents));
      const shiftSales = market.backup.sales.filter((s) => s.shiftId === market.backup.shifts.find((x) => !x.closedAt)!.id);
      await expect(page.getByTestId('sale-row')).toHaveCount(shiftSales.length);
      await expect(page.getByTestId('corte').getByRole('button', { name: 'Anular' })).toHaveCount(
        shiftSales.filter((s) => s.status === 'completada' && s.delivery === 'inmediata').length,
      );
      await expect(page.getByTestId('closed-shift')).toHaveCount(1);
      await expect(page.getByTestId('closed-shift')).toContainText(
        `esperado ${money(market.facts.closedShift.expectedCents)} · contado ${money(market.facts.closedShift.countedCents)} · dif ${money(-500)}`,
      );

      // Teclado abierto con «Efectivo contado»: el botón de cerrar se alcanza.
      await expectKeyboardLayout(page, phone, page.getByTestId('counted'), { primary: page.getByTestId('close-shift') });
      await closeKeyboard(page, phone);

      // Camino negativo: sin contar no se puede cerrar; un monto absurdo se rechaza y no cambia nada.
      await page.getByTestId('counted').fill('');
      await expect(page.getByTestId('close-shift')).toBeDisabled();
      await page.getByTestId('out-amount').fill('abc');
      await page.getByTestId('out-concept').fill('prueba');
      await page.getByTestId('out-save').tap();
      await expect(page.getByTestId('toast')).toContainText('Monto inválido');
      await expect(page.getByTestId('r-expected')).toHaveText(money(f.expectedCents));
      await page.getByTestId('out-amount').fill('');
      await page.getByTestId('out-concept').fill('');

      // Cierre: faltan $10.00 → el corte guardado dice exactamente eso, y el turno ya no está abierto.
      const counted = f.expectedCents - 1000;
      await page.getByTestId('counted').fill(String(counted / 100));
      await expect(page.getByTestId('diff')).toHaveText('Faltan $10.00');
      await page.getByTestId('close-shift').tap();
      await expect(page.getByTestId('toast')).toContainText('Turno cerrado');
      await expect(page.getByTestId('open-shift')).toBeVisible();
      await expect(page.getByTestId('closed-shift')).toHaveCount(2);
      await expect(page.getByTestId('closed-shift').first()).toContainText(`esperado ${money(f.expectedCents)} · contado ${money(counted)} · dif ${money(-1000)}`);
      await layout.check('Corte · turno cerrado, sin turno abierto');
      layout.expectClean(`Corte cerrado · ${phone.name}`);
      const d = await readDb(page);
      const closed = d.shifts.find((x) => x.expectedCashCents === f.expectedCents)!;
      expect(closed).toMatchObject({ countedCashCents: counted, differenceCents: -1000 });
      expect(closed.closedAt).toBeTruthy();
      expect(d.currentShiftId).toBeUndefined();
      expect(d.sales).toHaveLength(market.backup.sales.length); // cerrar no toca las ventas
      expect(invariants(d), 'invariantes').toEqual([]);
    });

    test('Más con respaldo, restauración y auditoría: exporta el archivo completo, la auditoría cuadra y el historial del día coincide', async ({ page }) => {
      test.setTimeout(120_000);
      const market = await boot(page);
      const layout = new Layout(page);
      const b = market.backup;
      await WALK.mas(page, layout.check, market);
      layout.expectClean(`Más · ${phone.name}`);

      await tab(page, 'mas');
      // Historial de ventas de hoy y de ayer (el turno cerrado)
      const today = mxDay(market.now);
      const yesterday = mxDay(new Date(market.now.getTime() - 86_400_000));
      const todaySales = b.sales.filter((s) => s.day === today);
      await expect(page.getByTestId('hist-summary')).toContainText(`${market.facts.today.sales} ventas · ${money(market.facts.today.totalCents)}`);
      await expect(page.getByTestId('hist-summary')).toContainText('1 anuladas');
      await expect(page.getByTestId('hist-row')).toHaveCount(todaySales.length);
      await page.getByTestId('hist-day').fill(yesterday);
      const ySales = b.sales.filter((s) => s.day === yesterday && s.status === 'completada');
      await expect(page.getByTestId('hist-summary')).toContainText(`${ySales.length} ventas · ${money(ySales.reduce((a, s) => a + s.totalCents, 0))}`);
      await page.getByTestId('hist-day').fill(today);

      // La restauración dejó una copia para deshacer (con lo que había antes: nada).
      await expect(page.getByTestId('undo-box')).toContainText('Deshacer: volver a ese estado');
      await expect(page.getByTestId('undo-box')).toContainText('0 ventas, 0 recepciones');
      await expect(page.getByTestId('last-backup')).toContainText('Último respaldo: nunca');

      // Exportar: el archivo trae TODO y el aviso lo cuenta
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export').tap()]);
      const file = JSON.parse(readFileSync(await dl.path(), 'utf8'));
      expect(file.app).toBe('caja-central');
      expect(file.version).toBe(3); // formato actual (el 3 agregó los fletes)
      expect(file.freights, 'sin fletes capturados, la lista va vacía').toEqual([]);
      for (const k of ['products', 'sales', 'shifts', 'cashMovements', 'stockMoves', 'receptions'] as const) expect(file[k], k).toHaveLength(b[k].length);
      expect([file.nextFolio, file.nextValeFolio, file.nextReceptionFolio]).toEqual([b.nextFolio, b.nextValeFolio, b.nextReceptionFolio]);
      await expect(page.getByTestId('toast')).toContainText(`Respaldo exportado (${b.sales.length} ventas, ${b.receptions.length} recepciones)`);
      await expect(page.getByTestId('last-backup')).toHaveText('Último respaldo: hoy');

      // Auditoría: cuadra con el libro y avisa del negativo autorizado
      await page.getByTestId('audit').tap();
      const vales = b.sales.filter((s) => s.valeFolio !== undefined).length;
      await expect(page.getByTestId('audit-result')).toContainText(
        `Sin inconsistencias (${b.sales.length} ventas, ${vales} vales, ${b.receptions.length} recepciones, ${b.stockMoves.length} movimientos)`,
      );
      await expect(page.getByTestId('audit-warnings')).toContainText('existencia disponible negativa (-12.5');
      await expect(page.getByTestId('audit-warnings')).toContainText('con autorizaciones registradas');
      await expect(page.getByTestId('storage-state')).toContainText('Almacenamiento');
      expect(invariants(await readDb(page)), 'invariantes').toEqual([]);
    });

    test('Objetivos táctiles de al menos 44×44 px en TODAS las pantallas y estados (botones, chips, casillas, resúmenes de <details>)', async ({ page }) => {
      test.setTimeout(180_000);
      const market = buildMarket();
      await page.clock.setFixedTime(FIXED_NOW);
      await openApp(page, { seed: false });
      const touch = new Layout(page, ['objetivosTactiles']);
      // Sin datos: el formulario de alta de la caja vacía y las demás pantallas vacías
      await touch.check('Caja · sin variedades (formulario de alta)');
      for (const name of ['vales', 'recepcion', 'inventario', 'corte', 'mas'] as const) {
        await tab(page, name);
        await touch.check(`${name} · sin datos`);
      }
      await restoreBackup(page, market.backup);
      await walkEverything(page, touch.check, market);
      touch.expectClean(`Objetivos táctiles (mínimo 44×44 px) · ${phone.name}`);
    });

    test('Regresión del toque perdido: tras escribir en un campo, el PRIMER toque en el botón funciona con el teclado abierto (Corte, Recepción, Inventario, Vales)', async ({ page }) => {
      test.setTimeout(150_000);
      const market = await boot(page);
      const e0 = market.facts.openShift.expectedCents;

      // 1) Corte: salida de efectivo con el concepto todavía enfocado
      await tab(page, 'corte');
      await page.getByTestId('out-amount').fill('15');
      await page.getByTestId('out-concept').fill('Hielo para la bodega');
      await showKeyboard(page, phone);
      await expect(html(page)).toHaveClass(/kbd/);
      await expect(page.getByTestId('out-concept')).toBeFocused();
      await watchTaps(page);
      await page.getByTestId('out-save').tap();
      await expectSolidTap(page, 'out-save');
      await expect(page.getByTestId('toast')).toContainText('Salida registrada');
      await expect(page.getByTestId('r-expected')).toHaveText(money(e0 - 1500));
      expect((await readDb(page)).cashMovements.filter((m) => m.concept === 'Hielo para la bodega')).toHaveLength(1);
      await closeKeyboard(page, phone);

      // 2) Recepción: guardar borrador con las observaciones todavía enfocadas
      await tab(page, 'recepcion');
      await page.getByTestId('rec-sub-nueva').tap();
      await page.getByTestId('rec-variety').filter({ hasText: 'Sin semilla' }).tap();
      await page.getByTestId('rec-class').filter({ hasText: 'Tercera' }).tap();
      await page.getByTestId('rec-supplier').fill('Proveedor del toque');
      await page.getByTestId('rec-notes').fill('Primera captura, falta el peso');
      const r0 = await readDb(page);
      await showKeyboard(page, phone);
      await expect(html(page)).toHaveClass(/kbd/);
      await watchTaps(page);
      await page.getByTestId('rec-save-draft').tap();
      await expectSolidTap(page, 'rec-save-draft');
      await expect(page.getByTestId('toast')).toContainText('Borrador guardado');
      const r1 = await readDb(page);
      expect(r1.receptions).toHaveLength(r0.receptions.length + 1);
      expect(r1.receptions.find((r) => r.supplier === 'Proveedor del toque')).toMatchObject({ status: 'borrador' });
      expect(r1.stockMoves).toHaveLength(r0.stockMoves.length); // un borrador NO suma al inventario
      await closeKeyboard(page, phone);

      // 3) Inventario: guardar una entrada con la cantidad todavía enfocada
      await tab(page, 'inventario');
      const pieza = invRow(page, 'pieza');
      await pieza.getByTestId('move-entrada').tap();
      await pieza.getByTestId('move-qty').fill('25');
      await showKeyboard(page, phone);
      await expect(html(page)).toHaveClass(/kbd/);
      await watchTaps(page);
      await pieza.getByTestId('move-save').tap();
      await expectSolidTap(page, 'move-save');
      await expect(page.getByTestId('toast')).toContainText('Entrada manual registrada');
      expect((await readDb(page)).products.find((p) => p.id === market.product('pieza').id)!.physicalMilli).toBe(5_025_000);
      await closeKeyboard(page, phone);

      // 4) Vales: tras escribir el motivo, el primer toque en la opción de dinero y en «Cancelar vale» responde
      await tab(page, 'vales');
      const first = market.backup.sales.filter((s) => s.delivery === 'pendiente').sort((a, b) => a.folio - b.folio)[0];
      await page.getByTestId('cancel-vale').first().tap();
      await page.getByTestId('cancel-reason').fill('Se equivocaron de pedido');
      await showKeyboard(page, phone);
      await expect(html(page)).toHaveClass(/kbd/);
      await page.getByTestId('refund-ninguna').tap();
      await expect(page.getByTestId('refund-ninguna'), 'el primer toque en la opción debe marcarla').toBeChecked();
      await watchTaps(page);
      await page.getByTestId('cancel-confirm').tap();
      await expectSolidTap(page, 'cancel-confirm');
      await expect(page.getByTestId('toast')).toContainText(`Vale V-${first.valeFolio} cancelado`);
      const v = await readDb(page);
      expect(v.sales.find((s) => s.id === first.id)).toMatchObject({ delivery: 'cancelado', refundMethod: 'ninguna', refundCents: 0 });
      expect(invariants(v), 'invariantes').toEqual([]);
      await closeKeyboard(page, phone);
    });

    test('Más: justo después de restaurar un respaldo, el recordatorio «te conviene exportar uno ahora» ya aparece (sin salir y volver)', async ({ page }) => {
      test.setTimeout(60_000);
      await boot(page); // restoreBackup termina en Más, con la base ya llena
      await expect(page.getByTestId('last-backup')).toContainText('Último respaldo: nunca');
      await expect(page.getByTestId('last-backup'), 'hay ventas y recepciones y nunca se exportó: debe pedirse un respaldo').toContainText('te conviene exportar uno ahora');
      await expect(page.getByTestId('last-backup')).toHaveClass(/warn/);
    });

    test('El aviso (toast) no tapa el botón principal «Registrar recepción» mientras se lee el error', async ({ page }) => {
      test.setTimeout(60_000);
      await boot(page);
      await tab(page, 'recepcion');
      await page.getByTestId('rec-confirm').tap({ force: true }); // faltan datos: aparece el aviso de error (dura 8 s)
      const toast = page.getByTestId('toast');
      await expect(toast).toBeVisible();
      await expect(page.getByTestId('rec-confirm')).toBeVisible();
      const covered = await overlapArea(toast, page.getByTestId('rec-confirm'));
      expect(covered, `el aviso «${await toast.textContent()}» tapa ${covered} px² del botón «Registrar recepción» (el botón mide ${JSON.stringify(await rectOf(page.getByTestId('rec-confirm')))})`).toBe(0);
    });
  });
}

// =====================================================================================================================
// B. Hojas modales con contenido largo a 360×640 (caso 21)
// =====================================================================================================================

test.describe('Android · hojas modales · 360×640', () => {
  test.use({ viewport: { width: 360, height: 640 } });

  test('Hoja de confirmar recepción con tres avisos largos: el pie siempre se alcanza, el cuerpo se desplaza, «Volver» no registra y «Registrar de todos modos» registra una sola vez', async ({ page }) => {
    test.setTimeout(90_000);
    const market = await boot(page);
    const sin = market.product('sin-1ra-2x');
    const next = market.facts.nextReceptionFolio;
    await tab(page, 'recepcion');
    await page.getByTestId('rec-variety').filter({ hasText: 'Sin semilla' }).tap();
    await page.getByTestId('rec-class').filter({ hasText: 'Primera · 2X' }).tap();
    await page.getByTestId('rec-net-direct').fill('120');
    await page.getByTestId('rec-supplier').fill(sentence(118));
    await page.getByTestId('rec-reference').fill('CAM-77');
    await page.getByTestId('rec-date-yesterday').tap(); // llegó ayer: así el conteo de hoy resulta «posterior»
    const before = await readDb(page);
    await page.getByTestId('rec-confirm').tap();
    const sheet = page.getByTestId('rec-sheet');
    await expect(sheet).toBeVisible();

    // Los tres avisos: parecida a otra (con las cuatro del camión CAM-77), conteo posterior y entrada manual igual.
    const warn = page.getByTestId('rec-dup-warning');
    await expect(warn.locator('li')).toHaveCount(3);
    await expect(warn).toContainText('Ya hay una recepción parecida');
    await expect(warn).toContainText('Ya hubo un conteo físico');
    await expect(warn).toContainText('entrada manual de los mismos kilos');
    await expect(page.getByTestId('rec-confirm-yes')).toHaveCount(0); // con avisos NO hay «Confirmar» a secas
    const info = await sheetReport(page, 'rec-sheet');
    expect(info.problems).toEqual([]);
    expect(info.bodyScrolls, 'el escenario debe ser largo: el cuerpo se desplaza').toBe(true);
    expect(info.footVisible, 'el pie con botones debe verse sin desplazar').toBe(true);
    expect(await reachReport(page.getByTestId('rec-dup-ack'))).toEqual([]);
    expect(await reachReport(page.getByTestId('rec-confirm-no'))).toEqual([]);

    // Camino negativo: «Volver» cierra sin registrar y sin dejar nada inerte.
    await page.getByTestId('rec-confirm-no').tap();
    await expect(sheet).toHaveCount(0);
    expect(await inertLeft(page)).toBe(0);
    expect((await readDb(page)).receptions).toHaveLength(before.receptions.length);

    // «Registrar de todos modos»: una sola recepción, con los avisos reconocidos guardados.
    await page.getByTestId('rec-confirm').tap();
    await expect(page.getByTestId('rec-dup-ack')).toHaveText('Registrar de todos modos');
    await page.getByTestId('rec-dup-ack').tap();
    await expect(page.getByTestId('toast')).toContainText(`Recepción R-${next} registrada: +120 kg`);
    await expect(sheet).toHaveCount(0);
    expect(await inertLeft(page)).toBe(0);
    const after = await readDb(page);
    expect(after.receptions).toHaveLength(before.receptions.length + 1);
    const rec = after.receptions.find((r) => r.folio === next)!;
    expect(rec).toMatchObject({ status: 'confirmada', reference: 'CAM-77', supplier: sentence(118), confirmedNetMilli: 120_000, day: mxDay(new Date(market.now.getTime() - 86_400_000)) });
    expect(rec.acknowledged?.[0]).toMatchObject({ op: 'confirmar' });
    expect(rec.acknowledged![0].warnings).toHaveLength(3);
    expect(after.products.find((p) => p.id === sin.id)!.physicalMilli).toBe(market.facts.stock('sin-1ra-2x').physical + 120_000);
    expect(invariants(after), 'invariantes').toEqual([]);
  });

  test('Hojas de autorización: Inventario (merma que deja el disponible en negativo) y Caja (venta sin existencia): texto exacto, pie alcanzable, cancelar no cambia nada, autorizar deja la marca', async ({ page }) => {
    test.setTimeout(120_000);
    const market = await boot(page);
    const st = market.facts.stock('sin-1ra-2x');
    const sin = market.product('sin-1ra-2x');

    // ---- Inventario: merma de 700 kg con 685 en bodega y 40 apartados → quedarían −55 kg disponibles
    await tab(page, 'inventario');
    const row = invRow(page, 'sin-1ra-2x');
    await row.getByTestId('move-merma').tap();
    await row.getByTestId('move-qty').fill('700');
    await row.getByTestId('move-note').fill('Prueba de autorización por merma grande');
    const d0 = await readDb(page);
    await row.getByTestId('move-save').tap();
    const text = page.getByTestId('authorize-text');
    await expect(text).toContainText(`«Sin semilla · Primera · 2X» quedaría con ${kg(st.physical - 700_000 - st.reserved)} disponibles`);
    await expect(text).toContainText(`Hay ${kg(st.reserved)} apartados por vales`);
    const inv = await sheetReport(page, 'authorize-sheet');
    expect(inv.problems).toEqual([]);
    expect(inv.footVisible).toBe(true);
    expect(await reachReport(page.getByTestId('authorize-yes'))).toEqual([]);
    await page.getByTestId('authorize-no').tap(); // cancelar: nada cambia
    await expect(page.getByTestId('authorize-sheet')).toHaveCount(0);
    expect(await inertLeft(page)).toBe(0);
    expect(await readDb(page)).toEqual(d0);
    await row.getByTestId('move-save').tap();
    await page.getByTestId('authorize-yes').tap();
    await expect(page.getByTestId('toast')).toContainText('Merma registrada');
    const d1 = await readDb(page);
    expect(d1.products.find((p) => p.id === sin.id)!.physicalMilli).toBe(st.physical - 700_000);
    expect(d1.stockMoves.find((m) => m.note === 'Prueba de autorización por merma grande')).toMatchObject({
      type: 'merma',
      deltaMilli: -700_000,
      authorizedNegativeAfterMilli: st.physical - 700_000 - st.reserved,
    });
    expect(invariants(d1), 'invariantes').toEqual([]);

    // ---- Caja: 760 kg de «Limón criollo…» con 750 kg → pide autorización; Volver no vende
    await tab(page, 'caja');
    const largo = market.product('largo');
    const lst = market.facts.stock('largo');
    await page.getByTestId('variety').filter({ hasText: 'Limón criollo' }).tap();
    await page.getByTestId('kg').fill('760');
    await page.getByTestId('exact').tap();
    await expect(page.getByTestId('total')).toContainText('$31,350.00'); // 760 kg × $41.25
    const c0 = await readDb(page);
    await page.getByTestId('confirm').tap();
    await expect(page.getByTestId('stock-warning')).toContainText(`hay ${kg(lst.available)} y vendes ${kg(760_000)}`);
    await expect(page.getByTestId('authorize')).toHaveText('Autorizar y cobrar');
    await expect(page.getByTestId('confirm-yes')).toHaveCount(0);
    const caja = await sheetReport(page, 'confirm-sheet');
    expect(caja.problems).toEqual([]);
    expect(await reachReport(page.getByTestId('authorize'))).toEqual([]);
    await page.getByTestId('confirm-no').tap();
    await expect(page.getByTestId('confirm-sheet')).toHaveCount(0);
    expect(await inertLeft(page)).toBe(0);
    expect(await readDb(page)).toEqual(c0);
    await page.getByTestId('confirm').tap();
    await page.getByTestId('authorize').tap();
    await expect(page.getByTestId('toast')).toContainText(`Venta #${market.facts.nextFolio} guardada`);
    const c1 = await readDb(page);
    const sale = c1.sales.find((s) => s.folio === market.facts.nextFolio)!;
    expect(sale).toMatchObject({ stockOverride: true, totalCents: 3_135_000, delivery: 'inmediata' });
    expect(c1.products.find((p) => p.id === largo.id)!.physicalMilli).toBe(lst.physical - 760_000);
    expect(c1.stockMoves.find((m) => m.saleId === sale.id)).toMatchObject({ type: 'venta', deltaMilli: -760_000 });
    expect(c1.products.find((p) => p.id === largo.id)!.physicalMilli - c1.products.find((p) => p.id === largo.id)!.reservedMilli, 'disponible negativo visible').toBe(lst.available - 760_000);
    expect(invariants(c1), 'invariantes').toEqual([]);
  });

  test('Hoja de aviso por entrada manual tras una recepción reciente: lista los folios, cancelar no cambia nada y «Registrar de todos modos» suma una sola vez', async ({ page }) => {
    test.setTimeout(90_000);
    const market = await boot(page);
    const sin = market.product('sin-1ra-2x');
    const recent = market.backup.receptions.filter((r) => r.productId === sin.id && r.status === 'confirmada' && market.now.getTime() - Date.parse(r.confirmedAt!) <= 86_400_000);
    expect(recent.length).toBeGreaterThanOrEqual(4);
    await tab(page, 'inventario');
    const row = invRow(page, 'sin-1ra-2x');
    await row.getByTestId('move-entrada').tap();
    await row.getByTestId('move-qty').fill('10');
    const before = await readDb(page);
    await row.getByTestId('move-save').tap();
    await expect(page.getByTestId('warnings-sheet')).toBeVisible();
    for (const r of recent) await expect(page.getByTestId('warnings-text')).toContainText(`R-${r.folio}`);
    await expect(page.getByTestId('warnings-text')).toContainText('se contaría dos veces');
    const info = await sheetReport(page, 'warnings-sheet');
    expect(info.problems).toEqual([]);
    expect(info.footVisible).toBe(true);
    await page.getByTestId('warnings-no').tap();
    await expect(page.getByTestId('warnings-sheet')).toHaveCount(0);
    expect(await inertLeft(page)).toBe(0);
    expect(await readDb(page)).toEqual(before);
    await row.getByTestId('move-save').tap();
    await page.getByTestId('warnings-yes').tap();
    await expect(page.getByTestId('toast')).toContainText('Entrada manual registrada');
    const after = await readDb(page);
    expect(after.products.find((p) => p.id === sin.id)!.physicalMilli).toBe(market.facts.stock('sin-1ra-2x').physical + 10_000);
    expect(after.stockMoves).toHaveLength(before.stockMoves.length + 1);
    expect(after.stockMoves.filter((m) => m.type === 'entrada' && m.deltaMilli === 10_000)).toHaveLength(1);
    expect(invariants(after), 'invariantes').toEqual([]);
  });

  test('Hoja de restaurar con pérdida: dice exactamente lo que se perdería, no deja confirmar sin entenderlo, el pie se alcanza y deja copia para deshacer', async ({ page }) => {
    test.setTimeout(90_000);
    const market = await boot(page);
    const b = market.backup;
    const t = Date.parse(b.exportedAt);
    const lostSales = b.sales.filter((s) => Date.parse(s.createdAt) > t).length;
    const lostRecs = b.receptions.filter((r) => Date.parse(r.confirmedAt ?? r.createdAt) > t).length;
    const lostMoves = b.stockMoves.filter((m) => Date.parse(m.createdAt) > t).length;
    expect(lostSales).toBeGreaterThan(0);
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

    await tab(page, 'mas');
    const before = await readDb(page);
    await page.getByTestId('import-file').setInputFiles({ name: 'mismo.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(b)) });
    await expect(page.getByTestId('restore-sheet')).toBeVisible();
    await expect(page.getByTestId('restore-summary')).toContainText(
      `${plural(b.sales.length, 'venta', 'ventas')}, ${plural(b.receptions.length, 'recepción', 'recepciones')}, ${plural(b.products.length, 'producto', 'productos')}, ${plural(b.stockMoves.length, 'movimiento de inventario', 'movimientos de inventario')}`,
    );
    await expect(page.getByTestId('restore-loss')).toContainText(
      `Se perderá lo que capturaste DESPUÉS de ese momento: ${plural(lostSales, 'venta', 'ventas')}, ${plural(lostRecs, 'recepción', 'recepciones')} y ${plural(lostMoves, 'movimiento de inventario', 'movimientos de inventario')}`,
    );
    const info = await sheetReport(page, 'restore-sheet');
    expect(info.problems).toEqual([]);
    expect(info.bodyScrolls, 'con tantas advertencias el cuerpo debe desplazarse').toBe(true);
    expect(info.footVisible).toBe(true);
    // No se puede confirmar sin marcar «Entiendo lo que se perderá»
    await expect(page.getByTestId('restore-confirm')).toBeDisabled();
    expect(await reachReport(page.getByTestId('restore-understood'))).toEqual([]);
    await page.getByTestId('restore-understood').tap();
    await expect(page.getByTestId('restore-confirm')).toBeEnabled();
    await page.getByTestId('restore-understood').tap();
    await expect(page.getByTestId('restore-confirm')).toBeDisabled();
    // Cancelar no cambia nada
    await page.getByTestId('restore-cancel').tap();
    await expect(page.getByTestId('restore-sheet')).toHaveCount(0);
    expect(await inertLeft(page)).toBe(0);
    expect(await readDb(page)).toEqual(before);
    // Restaurar de verdad: la base queda igual al archivo y queda copia para deshacer.
    // (Con el reloj fijo las dos copias internas llevarían la misma hora: se adelanta un minuto para que «la más reciente» sea inequívoca.)
    await page.clock.setFixedTime(new Date(FIXED_NOW.getTime() + 60_000));
    await page.getByTestId('import-file').setInputFiles({ name: 'mismo.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(b)) });
    await page.getByTestId('restore-understood').tap();
    await page.getByTestId('restore-confirm').tap();
    await expect(page.getByTestId('toast')).toContainText('Respaldo restaurado');
    const after = await readDb(page);
    expect(after.sales).toHaveLength(b.sales.length);
    expect(after.receptions).toHaveLength(b.receptions.length);
    expect(after.products.map((p) => [p.id, p.physicalMilli, p.reservedMilli])).toEqual(b.products.map((p) => [p.id, p.physicalMilli, p.reservedMilli]));
    expect(invariants(after), 'invariantes').toEqual([]);
    await expect(page.getByTestId('undo-box')).toContainText(`${plural(b.sales.length, 'venta', 'ventas')}, ${plural(b.receptions.length, 'recepción', 'recepciones')}`);
  });

  test('Hojas «Nueva clasificación» y «Ver las N clasificaciones» (Recepción y Caja): caben, se desplazan, alta con kg y sin precio, duplicado rechazado y el contador N sube a 8', async ({ page }) => {
    test.setTimeout(120_000);
    await boot(page);
    await tab(page, 'recepcion');
    await page.getByTestId('rec-variety').filter({ hasText: 'Con semilla' }).tap();
    await expect(page.getByTestId('rec-class-all')).toHaveText('Ver las 7 clasificaciones');
    await page.getByTestId('rec-class-all').tap();
    await expect(page.getByTestId('rec-class-sheet-item')).toHaveCount(7);
    await expect(page.getByTestId('rec-class-sheet-item').first()).toContainText('Oaxaca · Primera · 300');
    await expect(page.getByTestId('rec-class-sheet-item').first()).toContainText('$30.00/kg');
    let info = await sheetReport(page, 'rec-class-sheet');
    expect(info.problems).toEqual([]);
    expect(info.footVisible).toBe(true);
    await page.getByTestId('rec-class-sheet-item').nth(2).tap();
    await expect(page.getByTestId('rec-class-sheet')).toHaveCount(0);
    await expect(page.getByTestId('rec-selected')).toContainText('Con semilla · Oaxaca · Tercera · 500');
    expect(await inertLeft(page)).toBe(0);

    // Nueva clasificación: formulario largo dentro de la hoja
    await page.getByTestId('rec-new-class-toggle').tap();
    await expect(page.getByTestId('rec-newclass-sheet')).toBeVisible();
    info = await sheetReport(page, 'rec-newclass-sheet');
    expect(info.problems).toEqual([]);
    expect(info.bodyScrolls, 'el formulario de alta es más largo que la hoja').toBe(true);
    expect(info.footVisible).toBe(true);
    const sheet = page.getByTestId('rec-newclass-sheet');
    await sheet.getByTestId('recnew-name').fill('Con semilla');
    await sheet.getByTestId('recnew-origin').fill('Oaxaca');
    await sheet.getByTestId('recnew-quality').fill('Tercera');
    await sheet.getByTestId('recnew-caliber').fill('500');
    await expect(sheet.getByTestId('recnew-dup')).toContainText('Ya existe esta clasificación'); // aviso ANTES de guardar
    expect(await reachReport(sheet.getByTestId('recnew-add'))).toEqual([]);
    const before = await readDb(page);
    await sheet.getByTestId('recnew-add').tap(); // camino negativo: duplicado
    await expect(page.getByTestId('toast')).toContainText('Ya existe esa clasificación');
    await expect(sheet).toBeVisible();
    expect((await readDb(page)).products).toHaveLength(before.products.length);
    await sheet.getByTestId('recnew-origin').fill('Chiapas');
    await sheet.getByTestId('recnew-quality').fill('Primera');
    await sheet.getByTestId('recnew-caliber').fill('350');
    await sheet.getByTestId('recnew-add').tap();
    await expect(page.getByTestId('toast')).toContainText('Producto agregado');
    await expect(sheet).toHaveCount(0);
    expect(await inertLeft(page)).toBe(0);
    await expect(page.getByTestId('rec-selected')).toContainText('Con semilla · Chiapas · Primera · 350');
    const after = await readDb(page);
    expect(after.products).toHaveLength(before.products.length + 1);
    expect(after.products.find((p) => p.origin === 'Chiapas')).toMatchObject({ name: 'Con semilla', quality: 'Primera', caliber: '350', unit: 'kg', priceCents: 0, active: true, physicalMilli: 0 });
    await expect(page.getByTestId('rec-class-all')).toHaveText('Ver las 8 clasificaciones');

    // En la caja la nueva clasificación aparece «sin precio» y el contador también dice 8
    await tab(page, 'caja');
    await page.getByTestId('variety').filter({ hasText: 'Con semilla' }).tap();
    await expect(page.getByTestId('quality-all')).toHaveText('Ver las 8 clasificaciones');
    await page.getByTestId('quality-all').tap();
    await expect(page.getByTestId('quality-sheet-item')).toHaveCount(8);
    await expect(page.getByTestId('quality-sheet-item').filter({ hasText: 'Chiapas · Primera · 350' })).toContainText('sin precio');
    info = await sheetReport(page, 'quality-sheet');
    expect(info.problems).toEqual([]);
    await page.getByTestId('quality-sheet-item').filter({ hasText: 'Chiapas · Primera · 350' }).tap();
    await expect(page.getByTestId('no-price-hint')).toBeVisible();
    await expect(page.getByTestId('confirm')).toBeDisabled(); // sin precio no se cobra
  });

  test('Hoja de confirmar el cobro de un vale grande con cliente de nombre largo y de cancelar un vale: caben en la ventana, el botón principal se alcanza y se toca al primer toque', async ({ page }) => {
    test.setTimeout(90_000);
    const market = await boot(page);
    const largo = market.product('largo');
    const lst = market.facts.stock('largo');
    await tab(page, 'caja');
    await page.getByTestId('variety').filter({ hasText: 'Limón criollo' }).tap();
    await page.getByTestId('kg').fill('760');
    await page.getByTestId('exact').tap();
    await page.getByTestId('is-vale').tap();
    await page.getByTestId('customer').fill(LONG_CUSTOMER);
    await page.getByTestId('confirm').tap();
    await expect(page.getByTestId('confirm-sheet')).toBeVisible();
    await expect(page.getByTestId('confirm-sheet')).toContainText('Confirmar vale pagado');
    await expect(page.getByTestId('confirm-sheet')).toContainText(LONG_CUSTOMER);
    const info = await sheetReport(page, 'confirm-sheet');
    expect(info.problems).toEqual([]);
    expect(await reachReport(page.getByTestId('authorize'))).toEqual([]);
    expect(await reachReport(page.getByTestId('confirm-no'))).toEqual([]);
    const before = await readDb(page);
    await watchTaps(page);
    await page.getByTestId('authorize').tap();
    await expectSolidTap(page, 'authorize');
    await expect(page.getByTestId('toast')).toContainText(`Venta #${market.facts.nextFolio} guardada`);
    const after = await readDb(page);
    expect(after.sales).toHaveLength(before.sales.length + 1);
    const sale = after.sales.find((s) => s.folio === market.facts.nextFolio)!;
    expect(sale).toMatchObject({ delivery: 'pendiente', valeFolio: market.facts.nextValeFolio, customerName: LONG_CUSTOMER, stockOverride: true, totalCents: 3_135_000 });
    const p = after.products.find((x) => x.id === largo.id)!;
    expect([p.physicalMilli, p.reservedMilli]).toEqual([lst.physical, lst.reserved + 760_000]); // reserva: no sale de bodega todavía
    expect(invariants(after), 'invariantes').toEqual([]);
    await expect(page.getByTestId('last-sale')).toContainText(`VALE V-${market.facts.nextValeFolio} pendiente de entrega`);

    // Cancelar ese vale (nombre largo): la hoja cabe y se opera completa
    await tab(page, 'vales');
    const card = page.getByTestId('vale').filter({ hasText: LONG_CUSTOMER }).filter({ hasText: `V-${market.facts.nextValeFolio}` });
    await card.getByTestId('cancel-vale').tap();
    const cancel = await sheetReport(page, 'cancel-sheet');
    expect(cancel.problems).toEqual([]);
    await page.getByTestId('cancel-reason').fill('Prueba de hoja de cancelar');
    await page.getByTestId('refund-transferencia').tap();
    expect(await reachReport(page.getByTestId('cancel-confirm'))).toEqual([]);
    await page.getByTestId('cancel-confirm').tap();
    await expect(page.getByTestId('toast')).toContainText(`Vale V-${market.facts.nextValeFolio} cancelado`);
    expect(await inertLeft(page)).toBe(0);
    const end = await readDb(page);
    expect(end.sales.find((s) => s.id === sale.id)).toMatchObject({ delivery: 'cancelado', refundMethod: 'transferencia', refundCents: 3_135_000 });
    expect(end.cashMovements).toHaveLength(before.cashMovements.length); // por transferencia: no sale de la caja
    expect(end.products.find((x) => x.id === largo.id)!.reservedMilli).toBe(lst.reserved);
    expect(invariants(end), 'invariantes').toEqual([]);
  });
});

// =====================================================================================================================
// C. Textos y cantidades extremas a 360×640 (caso 21 + pruebas negativas)
// =====================================================================================================================

test.describe('Android · textos y cantidades extremas · 360×640', () => {
  test.use({ viewport: { width: 360, height: 640 } });

  test('Proveedor, referencia y observaciones de 100+ caracteres: los topes se respetan, se registran completos y el Historial los muestra sin desbordar', async ({ page }) => {
    test.setTimeout(120_000);
    const market = await boot(page);
    const layout = new Layout(page);
    await tab(page, 'recepcion');
    await page.getByTestId('rec-variety').filter({ hasText: 'Sin semilla' }).tap();
    await page.getByTestId('rec-class').filter({ hasText: 'Segunda · 3X' }).tap();
    await page.getByTestId('rec-net-direct').fill('90');
    const d0 = await readDb(page);

    // Topes: 121 / 61 / 501 caracteres se rechazan con el mensaje del campo y no se guarda nada.
    for (const [testid, len, msg] of [
      ['rec-supplier', 121, 'Proveedor: máximo 120 caracteres'],
      ['rec-reference', 61, 'Referencia: máximo 60 caracteres'],
      ['rec-notes', 501, 'Observaciones: máximo 500 caracteres'],
    ] as const) {
      await page.getByTestId(testid).fill(sentence(len));
      await page.getByTestId('rec-confirm').tap({ force: true });
      await expect(page.getByTestId('toast'), `${testid} con ${len} caracteres`).toContainText(msg);
      await expect(page.getByTestId('rec-sheet')).toHaveCount(0);
      await page.getByTestId(testid).fill('');
    }
    expect((await readDb(page)).receptions).toHaveLength(d0.receptions.length);

    // Justo en el tope (118 / 58 / 498): se registra completo.
    const supplier = sentence(118, 'Cooperativa agrícola de productores de limón del sur');
    const reference = sentence(58, 'Camión rojo placas ABC');
    const notes = sentence(498, 'Llegó con humedad en las cajas de abajo y el chofer pidió firma de recibido');
    await page.getByTestId('rec-supplier').fill(supplier);
    await page.getByTestId('rec-reference').fill(reference);
    await page.getByTestId('rec-notes').fill(notes);
    await page.getByTestId('rec-confirm').tap();
    await expect(page.getByTestId('rec-sheet-net')).toHaveAttribute('data-milli', '90000');
    await layout.check('Recepción › hoja de confirmar con proveedor y referencia largos');
    await page.getByTestId('rec-confirm-yes').tap();
    await expect(page.getByTestId('toast')).toContainText(`Recepción R-${market.facts.nextReceptionFolio} registrada: +90 kg`);
    let d = await readDb(page);
    expect(d.receptions.find((r) => r.folio === market.facts.nextReceptionFolio)).toMatchObject({ supplier, reference, notes });

    // Peor caso: sin un solo espacio donde partir la línea (118 / 58 / 498 caracteres seguidos).
    await page.getByTestId('rec-class').filter({ hasText: 'Segunda · 3X' }).tap();
    await page.getByTestId('rec-net-direct').fill('91');
    await page.getByTestId('rec-supplier').fill(unbroken(118, 'S'));
    await page.getByTestId('rec-reference').fill(unbroken(58, 'R'));
    await page.getByTestId('rec-notes').fill(unbroken(498, 'N'));
    await page.getByTestId('rec-confirm').tap();
    await expect(page.getByTestId('rec-sheet')).toBeVisible();
    await layout.check('Recepción › hoja de confirmar con textos de una sola palabra');
    await page.getByTestId('rec-confirm-yes').tap();
    await expect(page.getByTestId('toast')).toContainText(`Recepción R-${market.facts.nextReceptionFolio + 1} registrada: +91 kg`);
    d = await readDb(page);
    expect(d.receptions.find((r) => r.folio === market.facts.nextReceptionFolio + 1)).toMatchObject({ supplier: unbroken(118, 'S'), reference: unbroken(58, 'R'), notes: unbroken(498, 'N') });

    // El Historial muestra TODO el texto de las dos recepciones recién registradas, sin cortarlo ni desbordar. Se buscan por folio y
    // no por posición: con el reloj fijo las dos comparten hora y su orden relativo no está definido (ver openIssues).
    await page.getByTestId('rec-sub-historial').tap();
    const rowOf = (folio: number) => page.getByTestId('rec-row').filter({ hasText: new RegExp(`^R-${folio} ·`) });
    const spaced = rowOf(market.facts.nextReceptionFolio);
    const worst = rowOf(market.facts.nextReceptionFolio + 1);
    await expect(worst).toHaveCount(1);
    await expect(worst).toContainText(unbroken(118, 'S'));
    await expect(worst).toContainText(`ref. ${unbroken(58, 'R')}`);
    await expect(worst).toContainText(`Obs.: ${unbroken(498, 'N')}`);
    await expect(spaced).toHaveCount(1);
    await expect(spaced).toContainText(supplier);
    await expect(spaced).toContainText(`ref. ${reference}`);
    await expect(spaced).toContainText(`Obs.: ${notes}`);
    await layout.check('Recepción › Historial con textos de 100+ caracteres');
    for (const [name, row] of [['con espacios', spaced], ['de una sola palabra', worst]] as const) {
      const fits = await row.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
      expect(fits, `la fila ${name} del Historial no debe desbordar su tarjeta`).toBe(true);
    }
    layout.expectClean('Textos largos');
    expect(invariants(d), 'invariantes').toEqual([]);
  });

  test('Nombres de variedad, calidad, origen y calibre de 40 caracteres SIN espacios no desbordan ni se cortan en chips, listas ni formularios', async ({ page }) => {
    test.setTimeout(120_000);
    await boot(page);
    const layout = new Layout(page);
    // Se crea la clasificación por la propia interfaz (Inventario → Nueva variedad): el tope es de 40 caracteres por campo.
    await tab(page, 'inventario');
    const form = page.locator('[data-testid="new-variety"]:visible');
    await form.getByTestId('new-name').fill(unbroken(40, 'W'));
    await form.getByTestId('new-origin').fill(unbroken(40, 'Z'));
    await form.getByTestId('new-quality').fill(unbroken(40, 'M'));
    await form.getByTestId('new-caliber').fill(unbroken(40, 'X'));
    await form.getByTestId('new-price').fill('12.5');
    await layout.check('Inventario · formulario con los cuatro nombres de 40 caracteres (vista previa y chips de sugerencia)');
    await form.getByTestId('add-product').tap();
    await expect(page.getByTestId('toast')).toContainText('Producto agregado');
    await layout.check('Inventario · lista con la clasificación de nombres sin espacios');
    await expect(page.getByTestId('inv-row').last()).toContainText(unbroken(40, 'W'));

    await tab(page, 'caja');
    await layout.check('Caja · variedad de 40 caracteres sin espacios en la fila de variedades');
    await page.getByTestId('variety').last().tap();
    await layout.check('Caja · esa variedad elegida');
    await tab(page, 'recepcion');
    await layout.check('Recepción › Nueva · variedad de 40 caracteres sin espacios');
    await page.getByTestId('rec-variety').last().tap();
    await page.getByTestId('rec-net-direct').fill('10');
    await layout.check('Recepción › Nueva · elegida y con kilos');
    await page.getByTestId('rec-confirm').tap();
    await expect(page.getByTestId('rec-sheet')).toBeVisible();
    await layout.check('Recepción › hoja de confirmar con la clasificación larga');
    await page.getByTestId('rec-confirm-yes').tap();
    await expect(page.getByTestId('toast')).toContainText('registrada: +10 kg');
    await page.getByTestId('rec-sub-historial').tap();
    await layout.check('Recepción › Historial con la clasificación larga');
    await page.getByTestId('rec-sub-resumen').tap();
    for (const summary of await page.locator('details.fold > summary').all()) {
      if (await summary.evaluate((el) => !(el.parentElement as HTMLDetailsElement).open)) await summary.tap();
    }
    await layout.check('Recepción › Resumen con la clasificación larga');
    layout.expectClean('Nombres de 40 caracteres sin espacios');
  });

  test('Cantidades máximas: 200,000 kg se registran y se ven completos; un poco más, decimales de más, notación científica y totales que rebasan el tope se rechazan', async ({ page }) => {
    test.setTimeout(150_000);
    const market = await boot(page);
    const layout = new Layout(page);
    const today = mxDay(market.now);
    const largo = market.product('largo');
    const lst = market.facts.stock('largo');

    await tab(page, 'recepcion');
    await page.getByTestId('rec-variety').filter({ hasText: 'Limón criollo' }).tap();
    const before = await readDb(page);

    // Camino negativo: nada de esto produce un neto ni deja registrar.
    for (const bad of ['200000.001', '200001', '1e5', '-1', '0', '1.2345', 'abc', '1,500']) {
      await page.getByTestId('rec-net-direct').fill(bad);
      await expect(page.getByTestId('rec-net'), `kilos «${bad}»`).toHaveAttribute('data-milli', '');
      await expect(page.getByTestId('rec-confirm'), `kilos «${bad}»`).toHaveAttribute('aria-disabled', 'true');
    }
    await page.getByTestId('rec-net-direct').fill('200000.001');
    await expect(page.getByTestId('rec-input-problem')).toContainText('demasiado grande (máximo 200,000 kg)');
    await page.getByTestId('rec-confirm').tap({ force: true });
    await expect(page.getByTestId('rec-sheet')).toHaveCount(0);
    // Envases: más de 100,000 cajas o un total por encima de 200,000 kg
    await page.getByTestId('rec-pack-caja').tap();
    await page.getByTestId('rec-mode-por_envase').tap();
    await page.getByTestId('rec-containers').fill('100001');
    await page.getByTestId('rec-unit-net').fill('1');
    await expect(page.getByTestId('rec-net')).toHaveAttribute('data-milli', '');
    await expect(page.getByTestId('rec-net-hint')).toContainText(/Máximo 100,000 (envases|cajas)/);
    await page.getByTestId('rec-containers').fill('100000');
    await page.getByTestId('rec-unit-net').fill('3');
    await expect(page.getByTestId('rec-net')).toHaveAttribute('data-milli', '');
    await expect(page.getByTestId('rec-net-hint')).toContainText('El total no puede pasar de 200,000 kg');
    await page.getByTestId('rec-containers').fill('0');
    await expect(page.getByTestId('rec-net')).toHaveAttribute('data-milli', '');
    await page.getByTestId('rec-containers').fill('2.5');
    await expect(page.getByTestId('rec-input-problem')).toContainText('número entero');
    expect(await readDb(page)).toEqual(before);

    // El máximo exacto SÍ se registra: 200,000 kg, y se ve completo en la barra, la hoja, el Inventario y el Resumen.
    await page.getByTestId('rec-pack-granel').tap();
    await page.getByTestId('rec-mode-directo').tap();
    await page.getByTestId('rec-net-direct').fill('200000');
    await expect(page.getByTestId('rec-net')).toHaveAttribute('data-milli', '200000000');
    await expect(page.getByTestId('rec-net')).toHaveText('200,000 kg');
    await layout.check('Recepción › barra de registro con 200,000 kg');
    await page.getByTestId('rec-confirm').tap();
    await expect(page.getByTestId('rec-sheet-net')).toHaveAttribute('data-milli', '200000000');
    await expect(page.getByTestId('rec-sheet-net')).toHaveText('+200,000 kg');
    await expect(page.getByTestId('rec-sheet-stock')).toContainText(`${kg(lst.physical)} → ${kg(lst.physical + 200_000_000)}`);
    await layout.check('Recepción › hoja con +200,000 kg');
    await page.getByTestId('rec-confirm-yes').tap();
    await expect(page.getByTestId('toast')).toContainText(`Recepción R-${market.facts.nextReceptionFolio} registrada: +200,000 kg`);
    const after = await readDb(page);
    expect(after.products.find((p) => p.id === largo.id)!.physicalMilli).toBe(lst.physical + 200_000_000);
    expect(after.receptions.find((r) => r.folio === market.facts.nextReceptionFolio)).toMatchObject({ confirmedNetMilli: 200_000_000, netMilli: 200_000_000 });
    expect(invariants(after), 'invariantes').toEqual([]);
    await tab(page, 'inventario');
    await expect(invRow(page, 'largo').getByTestId('stock-physical')).toHaveText(kg(lst.physical + 200_000_000));
    await layout.check('Inventario · 200,750 kg en bodega');
    await tab(page, 'recepcion');
    await page.getByTestId('rec-sub-resumen').tap();
    await expect(page.getByTestId('rep-received')).toHaveAttribute('data-milli', String(receivedOn(market, today) + 200_000_000));
    await expect(page.getByTestId('rep-ledger-cuadra')).toBeVisible();
    for (const summary of await page.locator('details.fold > summary').all()) {
      if (await summary.evaluate((el) => !(el.parentElement as HTMLDetailsElement).open)) await summary.tap();
    }
    await layout.check('Resumen · con 200,000 kg recibidos hoy');

    // Caja: 200,000 kg × $30 = $6,000,000.00 se ve completo; 200000.001 kg no deja cobrar.
    await tab(page, 'caja');
    await page.getByTestId('variety').filter({ hasText: 'Con semilla' }).tap();
    await page.getByTestId('kg').fill('200000');
    await expect(page.getByTestId('total')).toContainText('$6,000,000.00');
    await layout.check('Caja · total de $6,000,000.00 (200,000 kg × $30)');
    await page.getByTestId('kg').fill('200000.001');
    await expect(page.getByTestId('confirm')).toBeDisabled();
    layout.expectClean('Cantidades máximas');
  });

  test('Total imposible (200,000 kg × $100,000): la caja lo muestra completo, AVISA que rebasa el máximo y no deja cobrar (sin cambiar nada)', async ({ page }) => {
    test.setTimeout(90_000);
    const market = await boot(page);
    const layout = new Layout(page);
    await tab(page, 'caja');
    await page.getByTestId('variety').filter({ hasText: 'Con semilla' }).tap();
    await page.getByTestId('kg').fill('200000');
    await page.getByTestId('price').fill('100000'); // el precio máximo que la app acepta
    await expect(page.getByTestId('total')).toContainText('$20,000,000,000.00');
    await layout.check('Caja · total de $20,000,000,000.00 (máximo de kilos × máximo de precio)');
    await page.getByTestId('method-transferencia').tap(); // sin efectivo que cubrir, el botón se habilitaría si el total fuera válido
    // La app avisa ANTES de abrir la hoja de cobro y no deja cobrar un importe que la base rechazaría.
    await expect(page.getByTestId('total-too-big')).toContainText('rebasa el máximo');
    await expect(page.getByTestId('confirm')).toBeDisabled();
    await layout.check('Caja · aviso de total que rebasa el máximo');
    const before = await readDb(page);
    await page.getByTestId('confirm').tap({ force: true }); // un botón deshabilitado no hace nada
    await expect(page.getByTestId('confirm-sheet')).toHaveCount(0);
    // Con un total válido (200,000 kg × $30) el aviso desaparece y SÍ se puede cobrar.
    await page.getByTestId('price').fill('30');
    await expect(page.getByTestId('total-too-big')).toHaveCount(0);
    await expect(page.getByTestId('confirm')).toBeEnabled();
    const after = await readDb(page);
    expect(after.sales).toEqual(before.sales); // no se guardó ninguna venta
    expect(after.stockMoves).toEqual(before.stockMoves);
    expect(after.nextFolio).toBe(market.facts.nextFolio);
    layout.expectClean('Total imposible');
  });

  test('Existencia gigante (999,001,353.75 kg): Inventario, Resumen, Caja y Recepción la muestran completa sin desbordar', async ({ page }) => {
    test.setTimeout(90_000);
    const market = buildMarket();
    const p = market.product('sin-3ra');
    market.backup.stockMoves.push({ id: 'mv-gigante', productId: p.id, createdAt: new Date(market.now.getTime() - 60_000).toISOString(), type: 'entrada', deltaMilli: 999_000_000_000, reservedDeltaMilli: 0, note: 'Existencia gigante de prueba' });
    p.physicalMilli += 999_000_000_000;
    await page.clock.setFixedTime(FIXED_NOW);
    await openApp(page, { seed: false });
    await restoreBackup(page, market.backup);
    const layout = new Layout(page);
    const big = kg(p.physicalMilli);
    expect(big).toBe('999,001,353.75 kg');

    await tab(page, 'inventario');
    await expect(invRow(page, 'sin-3ra').getByTestId('stock-physical')).toHaveText(big);
    await expect(invRow(page, 'sin-3ra').getByTestId('stock-available')).toHaveText(big);
    await layout.check('Inventario · 999,001,353.75 kg');
    await tab(page, 'caja');
    await page.getByTestId('variety').filter({ hasText: 'Sin semilla' }).tap();
    await page.getByTestId('quality').filter({ hasText: 'Tercera' }).tap();
    await expect(page.getByTestId('stock-hint')).toContainText(`Disponible: ${big}`);
    await layout.check('Caja · existencia de 999,001,353.75 kg en el aviso de disponible');
    await tab(page, 'recepcion');
    await page.getByTestId('rec-variety').filter({ hasText: 'Sin semilla' }).tap();
    await page.getByTestId('rec-class').filter({ hasText: 'Tercera' }).tap();
    await expect(page.getByTestId('rec-selected')).toContainText(`en bodega ahora: ${big}`);
    await page.getByTestId('rec-net-direct').fill('90');
    await layout.check('Recepción › Nueva · clasificación con 999,001,353.75 kg en bodega');
    await page.getByTestId('rec-confirm').tap();
    await expect(page.getByTestId('rec-sheet-stock')).toContainText(`${big} → ${kg(p.physicalMilli + 90_000)}`);
    await layout.check('Recepción › hoja con existencia gigante');
    await page.getByTestId('rec-confirm-no').tap();
    await page.getByTestId('rec-sub-resumen').tap();
    for (const summary of await page.locator('details.fold > summary').all()) {
      if (await summary.evaluate((el) => !(el.parentElement as HTMLDetailsElement).open)) await summary.tap();
    }
    await layout.check('Resumen · existencias gigantes');
    layout.expectClean('Existencia gigante');
    await tab(page, 'mas');
    await page.getByTestId('audit').tap();
    await expect(page.getByTestId('audit-result')).toContainText('Sin inconsistencias');
  });
});

// =====================================================================================================================
// D. Orientación horizontal 640×360 (caso 21)
// =====================================================================================================================

test.describe('Android · orientación horizontal · 640×360', () => {
  test.use({ viewport: { width: 640, height: 360 } });

  test('Caja rápida en horizontal: sin desbordar (con <main> de 560 px centrado), el botón Cobrar se alcanza y la venta se cobra con toques', async ({ page }) => {
    test.setTimeout(90_000);
    const market = await boot(page);
    const layout = new Layout(page);
    const sin = market.product('sin-1ra-2x');
    const st = market.facts.stock('sin-1ra-2x');
    await tab(page, 'caja');
    await layout.check('Caja · horizontal · inicio');
    for (const name of ['caja', 'vales', 'recepcion', 'inventario', 'corte', 'mas'] as const) await expect(page.getByTestId(`tab-${name}`)).toBeVisible();
    await page.getByTestId('kg').fill('4');
    await page.getByTestId('exact').tap();
    await expect(page.getByTestId('total')).toContainText('$128.00'); // 4 kg × $32
    await layout.check('Caja · horizontal · venta lista');
    expect(await reachReport(page.getByTestId('kg'))).toEqual([]);
    expect(await reachReport(page.getByTestId('confirm'))).toEqual([]);
    await page.getByTestId('confirm').tap();
    await expect(page.getByTestId('confirm-sheet')).toBeVisible();
    const info = await sheetReport(page, 'confirm-sheet');
    expect(info.problems).toEqual([]);
    await layout.check('Caja · horizontal · hoja de confirmar cobro');
    expect(await reachReport(page.getByTestId('confirm-yes'))).toEqual([]);
    await page.getByTestId('confirm-yes').tap();
    await expect(page.getByTestId('toast')).toContainText(`Venta #${market.facts.nextFolio} guardada`);
    const d = await readDb(page);
    expect(d.sales.find((s) => s.folio === market.facts.nextFolio)).toMatchObject({ totalCents: 12_800, paymentMethod: 'efectivo' });
    expect(d.products.find((p) => p.id === sin.id)!.physicalMilli).toBe(st.physical - 4000);
    expect(invariants(d), 'invariantes').toEqual([]);
    layout.expectClean('Caja en horizontal');
  });

  test('Formulario de Recepción en horizontal: la barra de registro queda sobre las pestañas, el botón y la hoja se alcanzan y se registra', async ({ page }) => {
    test.setTimeout(90_000);
    const market = await boot(page);
    const layout = new Layout(page);
    const sin = market.product('sin-1ra-2x');
    const st = market.facts.stock('sin-1ra-2x');
    await tab(page, 'recepcion');
    await layout.check('Recepción › Nueva · horizontal · vacía');
    await page.getByTestId('rec-variety').filter({ hasText: 'Sin semilla' }).tap();
    await page.getByTestId('rec-class').filter({ hasText: 'Primera · 2X' }).tap();
    await page.getByTestId('rec-net-direct').fill('55.5');
    await expect(page.getByTestId('rec-net')).toHaveAttribute('data-milli', '55500');
    await layout.check('Recepción › Nueva · horizontal · lista para registrar');
    // La barra de registro está siempre a la vista y por encima de las pestañas
    const dock = await rectOf(page.getByTestId('rec-dock'));
    const nav = await rectOf(page.locator('nav.tabs'));
    const vh = await innerHeight(page);
    expect(dock.top).toBeGreaterThanOrEqual(0);
    expect(dock.bottom, 'la barra de registro no debe quedar bajo las pestañas').toBeLessThanOrEqual(nav.top + 0.5);
    expect(nav.bottom).toBeLessThanOrEqual(vh + 0.5);
    expect(await reachReport(page.getByTestId('rec-confirm'))).toEqual([]);
    await page.getByTestId('rec-confirm').tap();
    await expect(page.getByTestId('rec-sheet')).toBeVisible();
    const info = await sheetReport(page, 'rec-sheet');
    expect(info.problems).toEqual([]);
    expect(info.footVisible).toBe(true);
    await layout.check('Recepción › horizontal · hoja de confirmar');
    expect(await reachReport(page.getByTestId('rec-confirm-yes'))).toEqual([]);
    await page.getByTestId('rec-confirm-yes').tap();
    await expect(page.getByTestId('toast')).toContainText(`Recepción R-${market.facts.nextReceptionFolio} registrada: +55.5 kg`);
    const d = await readDb(page);
    expect(d.products.find((p) => p.id === sin.id)!.physicalMilli).toBe(st.physical + 55_500);
    expect(d.receptions.find((r) => r.folio === market.facts.nextReceptionFolio)).toMatchObject({ confirmedNetMilli: 55_500, status: 'confirmada' });
    expect(invariants(d), 'invariantes').toEqual([]);
    layout.expectClean('Recepción en horizontal');
  });

  test('Girar el teléfono con una captura en curso: Caja y Recepción conservan lo escrito, el diseño se acomoda y las pestañas no se quedan escondidas', async ({ page }) => {
    test.setTimeout(90_000);
    await boot(page);
    const layout = new Layout(page);
    await page.setViewportSize({ width: 360, height: 640 }); // se empieza de pie
    await tab(page, 'caja');
    await page.getByTestId('kg').fill('7.5');
    await page.getByTestId('bill-100').tap();
    await tab(page, 'recepcion');
    await page.getByTestId('rec-variety').filter({ hasText: 'Sin semilla' }).tap();
    await page.getByTestId('rec-class').filter({ hasText: 'Primera · 2X' }).tap();
    await page.getByTestId('rec-supplier').fill('Proveedor que no debe perderse al girar');
    await page.getByTestId('rec-net-direct').fill('33.25');
    for (const [w, h] of [[640, 360], [360, 640], [915, 412], [412, 915]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await expect(html(page)).not.toHaveClass(/kbd/);
      await expect(page.getByTestId('tab-caja')).toBeVisible();
      await expect(page.getByTestId('rec-supplier')).toHaveValue('Proveedor que no debe perderse al girar');
      await expect(page.getByTestId('rec-net')).toHaveAttribute('data-milli', '33250');
      await layout.check(`Recepción › Nueva · ${w}×${h}`);
    }
    await tab(page, 'caja');
    await expect(page.getByTestId('kg')).toHaveValue('7.5');
    await expect(page.getByTestId('cash')).toHaveValue('100');
    await layout.check('Caja · tras girar');
    layout.expectClean('Girar el teléfono');
  });
});

// =====================================================================================================================
// E. Sin conexión SIMULADA de todas las secciones (casos 22 y 23)
//
// goOffline() = context.setOffline(true) (eventos online/offline y navigator.onLine) + route.abort sobre toda petición, también la
// del service worker. NO equivale al modo avión real de Android (no apaga radios, no cambia el estado de la red del sistema, no
// activa el ahorro de datos): sigue pendiente probarlo en un teléfono físico. Estas pruebas usan el RELOJ REAL: la persistencia
// no depende de la hora.
//
// Dos tipos de prueba, separados a propósito:
//  · «Con la app ya abierta se corta la red» (todas menos la última): trabajar sin conexión (recorrer, vender, recibir, respaldar,
//    cerrar el turno). El estado se verifica leyendo IndexedDB crudo y, al volver la red, recargando.
//  · «Arranque en frío sin red» (la última): cerrar y reabrir la app ya sin conexión. HOY FALLA por un defecto real de la app
//    (el service worker no sirve el JS/CSS del precache cuando el servidor responde `Vary: Origin`, como `vite preview`): ver
//    reopenOffline() en helpers-android.ts. No se debilita ni se omite: es justo lo que hace el usuario con el teléfono en modo avión.
// =====================================================================================================================

/**
 * Prueba de que de verdad no hay red: lo que NO está en la caché del service worker falla y la app se sirve desde la caché. Sin
 * esto, una simulación que dejara pasar las peticiones del service worker haría que cualquier prueba «sin red» pasara en falso.
 */
async function expectNetworkCut(page: Page) {
  const probe = await page.evaluate(async () => {
    const out: Record<string, string> = {};
    try {
      await fetch(`/no-esta-en-la-cache-${Date.now()}`);
      out.nuevo = 'respondió';
    } catch {
      out.nuevo = 'sin red';
    }
    try {
      const r = await fetch('/');
      out.inicio = r.ok ? 'desde la caché' : `estado ${r.status}`;
    } catch {
      out.inicio = 'falló';
    }
    return out;
  });
  expect(probe, 'sin red: lo no cacheado falla y la app se sirve desde el service worker').toEqual({ nuevo: 'sin red', inicio: 'desde la caché' });
}

test.describe('Android · sin conexión simulada', () => {
  test.use({ viewport: { width: 360, height: 640 } });
  // La bandera de Playwright que enruta también al service worker vale solo para estas pruebas (ver helpers-android.ts).
  test.beforeEach(() => enableStrictOffline());
  test.afterEach(() => disableStrictOffline());

  test('Con datos previos y la red cortada con la app abierta, se recorren las 6 pestañas y las 4 subsecciones de Recepción: todo responde sin red y los datos siguen intactos', async ({ page, context }) => {
    test.setTimeout(120_000);
    const market = await boot(page, { realTime: true });
    const b = market.backup;
    const f = market.facts;
    const st = f.stock('sin-1ra-2x');
    const confirmed = b.receptions.filter((r) => r.status === 'confirmada');
    const latest = [...confirmed].sort((x, y) => y.confirmedAt!.localeCompare(x.confirmedAt!))[0];
    const before = await readDb(page);
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await goOffline(context);
    await expect(page.getByTestId('net')).toHaveText('Sin internet');
    await expect(page.getByTestId('net')).toHaveClass(/off/);
    // Independiente de cómo se simule la red: todo lo que la página cargó está en la caché del service worker. Se mide ANTES de la
    // sonda de abajo, que a propósito pide algo que no existe y quedaría anotado entre los recursos de la página.
    expect(await uncachedResources(page), 'recursos que la app cargó y NO están en la caché del service worker').toEqual([]);
    await expectNetworkCut(page);

    await tab(page, 'caja'); // la restauración deja la app en «Más»
    await expect(page.getByTestId('caja')).toBeVisible();
    await expect(page.getByTestId('variety')).toHaveCount(4);
    await expect(page.getByTestId('stock-hint')).toHaveText(`Disponible: ${kg(st.available)} · Reservado: ${kg(st.reserved)}`);

    await tab(page, 'vales');
    await expect(page.getByTestId('vale')).toHaveCount(f.valesPending);

    await tab(page, 'recepcion');
    await expect(page.getByTestId('rec-nueva')).toBeVisible();
    await expect(page.getByTestId('rec-last')).toContainText(`Última registrada: R-${latest.folio}`);
    await page.getByTestId('rec-sub-borradores').click();
    await expect(page.getByTestId('rec-draft-row')).toHaveCount(f.drafts);
    await page.getByTestId('rec-sub-historial').click();
    await expect(page.getByTestId('rec-hist-count')).toHaveText(`Mostrando ${confirmed.length} de ${confirmed.length}`);
    await page.getByTestId('rec-sub-resumen').click();
    const availableKg = b.products.filter((p) => p.unit === 'kg').reduce((a, p) => a + p.physicalMilli - p.reservedMilli, 0);
    await expect(page.getByTestId('rep-available')).toHaveAttribute('data-milli', String(availableKg));
    await expect(page.getByTestId('rep-ledger-cuadra')).toBeVisible();
    await page.getByTestId('rec-sub-nueva').click();

    await tab(page, 'inventario');
    await expect(page.getByTestId('inv-row')).toHaveCount(CATALOG.length);
    await expect(invRow(page, 'sin-1ra-2x').getByTestId('stock-physical')).toHaveText(kg(st.physical));

    await tab(page, 'corte');
    await expect(page.getByTestId('r-total')).toHaveText(money(f.openShift.totalCents));
    await expect(page.getByTestId('r-expected')).toHaveText(money(f.openShift.expectedCents));

    await tab(page, 'mas');
    await page.getByTestId('audit').click();
    await expect(page.getByTestId('audit-result')).toContainText(
      `Sin inconsistencias (${b.sales.length} ventas, ${b.sales.filter((s) => s.valeFolio !== undefined).length} vales, ${b.receptions.length} recepciones, ${b.stockMoves.length} movimientos)`,
    );
    await expect(page.getByTestId('net')).toHaveText('Sin internet'); // sigue así durante todo el recorrido
    expect(await readDb(page), 'recorrer pantallas sin red no cambia ningún dato').toEqual(before);
    expect(pageErrors, 'errores de la página durante el recorrido sin red').toEqual([]);
    await expect(page.getByTestId('toast')).toHaveCount(0); // ni un «Error inesperado»

    await goOnline(context);
    await expect(page.getByTestId('net')).toHaveText('En línea');
    expect(await readDb(page)).toEqual(before);
  });

  test('Sin conexión: cobrar, vender un vale y entregarlo, sacar efectivo y cerrar el turno; al volver la red y recargar no hay pérdidas ni duplicados', async ({ page, context }) => {
    test.setTimeout(150_000);
    const market = await boot(page, { realTime: true, confirmedReceptions: 6, sales: 6 });
    const f = market.facts;
    const sin = market.product('sin-1ra-2x');
    const st = f.stock('sin-1ra-2x');
    page.on('dialog', (dlg) => dlg.accept());
    await goOffline(context);
    await expect(page.getByTestId('net')).toHaveText('Sin internet');
    const base = await readDb(page);

    // 1) Venta en efectivo: 3.5 kg × $32 = $112.00, con billete de $200 → cambio $88.00
    await tab(page, 'caja');
    await expect(page.getByTestId('selling')).toHaveText('Vendiendo: Sin semilla · Primera · 2X');
    await page.getByTestId('kg').fill('3.5');
    await page.getByTestId('bill-200').tap();
    await expect(page.getByTestId('total')).toContainText('$112.00');
    await expect(page.getByTestId('change')).toContainText('$88.00');
    await page.getByTestId('confirm').tap();
    await page.getByTestId('confirm-yes').tap();
    await expect(page.getByTestId('toast')).toContainText(`Venta #${f.nextFolio} guardada`);
    let d = await readDb(page);
    expect(d.sales.find((s) => s.folio === f.nextFolio)).toMatchObject({ totalCents: 11_200, receivedCents: 20_000, changeCents: 8_800, delivery: 'inmediata' });
    expect(d.products.find((p) => p.id === sin.id)!.physicalMilli).toBe(st.physical - 3_500);

    // 2) Vale pagado de 10 kg × $32 = $320.00: reserva sin sacar de bodega
    await page.getByTestId('kg').fill('10');
    await page.getByTestId('exact').tap();
    await page.getByTestId('is-vale').tap();
    await page.getByTestId('customer').fill('Cliente sin red');
    await page.getByTestId('confirm').tap();
    await page.getByTestId('confirm-yes').tap();
    await expect(page.getByTestId('toast')).toContainText(`Venta #${f.nextFolio + 1} guardada`);
    await expect(page.getByTestId('last-sale')).toContainText(`VALE V-${f.nextValeFolio} pendiente de entrega`);
    d = await readDb(page);
    expect(d.sales.find((s) => s.folio === f.nextFolio + 1)).toMatchObject({ totalCents: 32_000, delivery: 'pendiente', valeFolio: f.nextValeFolio, customerName: 'Cliente sin red' });
    let p = d.products.find((x) => x.id === sin.id)!;
    expect([p.physicalMilli, p.reservedMilli]).toEqual([st.physical - 3_500, st.reserved + 10_000]);

    // 3) Entregar el vale: sale de bodega y se libera el apartado; no es dinero
    await tab(page, 'vales');
    await expect(page.getByTestId('vale')).toHaveCount(f.valesPending + 1);
    await page.getByTestId('vale').filter({ hasText: 'Cliente sin red' }).getByTestId('deliver').tap();
    await expect(page.getByTestId('toast')).toContainText(`Vale V-${f.nextValeFolio} entregado`);
    d = await readDb(page);
    p = d.products.find((x) => x.id === sin.id)!;
    expect([p.physicalMilli, p.reservedMilli]).toEqual([st.physical - 13_500, st.reserved]);

    // 4) Corte: las dos ventas suman $432.00; una salida de $20.00 resta
    await tab(page, 'corte');
    await expect(page.getByTestId('r-total')).toHaveText(money(f.openShift.totalCents + 43_200));
    await expect(page.getByTestId('r-expected')).toHaveText(money(f.openShift.expectedCents + 43_200));
    await page.getByTestId('out-amount').fill('20');
    await page.getByTestId('out-concept').fill('Hielo sin red');
    await page.getByTestId('out-save').tap();
    await expect(page.getByTestId('toast')).toContainText('Salida registrada');
    const expected = f.openShift.expectedCents + 43_200 - 2_000;
    await expect(page.getByTestId('r-expected')).toHaveText(money(expected));

    // 5) Lo escrito sin red ya está en la base (no en memoria) y el corte lo refleja
    const offlineDump = await readDb(page);
    expect(offlineDump.sales).toHaveLength(base.sales.length + 2);
    expect(offlineDump.cashMovements).toHaveLength(base.cashMovements.length + 1);
    await expect(page.getByTestId('r-expected')).toHaveText(money(expected));
    await expect(page.getByTestId('sale-row')).toHaveCount(base.sales.filter((s) => s.shiftId === base.currentShiftId).length + 2);

    // 6) Cerrar el turno contando exacto
    await page.getByTestId('counted').fill(String(expected / 100));
    await expect(page.getByTestId('diff')).toHaveText('Cuadra exacto');
    await page.getByTestId('close-shift').tap();
    await expect(page.getByTestId('toast')).toContainText('Turno cerrado');
    await expect(page.getByTestId('closed-shift').first()).toContainText(`esperado ${money(expected)} · contado ${money(expected)} · dif ${money(0)}`);
    const closedDump = await readDb(page);
    expect(closedDump.currentShiftId).toBeUndefined();
    expect(closedDump.sales).toHaveLength(base.sales.length + 2);

    // 7) Vuelve la red: el indicador cambia, y tras recargar NO hay pérdidas ni duplicados
    await goOnline(context);
    await expect(page.getByTestId('net')).toHaveText('En línea');
    await page.reload();
    await expect(page.getByTestId('net')).toHaveText('En línea');
    const online = await readDb(page);
    expect(online, 'la base en línea debe ser idéntica a la que se dejó sin red').toEqual(closedDump);
    expect(new Set(online.sales.map((s) => s.folio)).size).toBe(online.sales.length);
    expect(invariants(online), 'invariantes').toEqual([]);
    await expect(page.getByTestId('new-version')).toHaveCount(0); // volver la red no «actualiza» nada solo
  });

  test('Sin conexión: recibir mercancía, guardar un borrador, entrada manual, merma y conteo; ver Historial y Resumen; al volver la red no hay pérdidas ni duplicados', async ({ page, context }) => {
    test.setTimeout(150_000);
    const market = await boot(page, { realTime: true, confirmedReceptions: 6, sales: 6 });
    const f = market.facts;
    const oax = market.product('oax-1ra-300');
    const today = mxDay(market.now);
    await goOffline(context);
    await expect(page.getByTestId('net')).toHaveText('Sin internet');
    const base = await readDb(page);
    const st = (key: string) => base.products.find((x) => x.id === market.product(key).id)!;

    // 1) Recepción de 20 cajas × 15.5 kg = 310 kg (aritmética entera exacta) de «Con semilla · Oaxaca · Primera · 300»
    await tab(page, 'recepcion');
    await page.getByTestId('rec-variety').filter({ hasText: 'Con semilla' }).tap();
    await page.getByTestId('rec-class-all').tap();
    await page.getByTestId('rec-class-sheet-item').filter({ hasText: 'Oaxaca · Primera · 300' }).tap();
    await page.getByTestId('rec-pack-caja').tap();
    await page.getByTestId('rec-mode-por_envase').tap();
    await page.getByTestId('rec-containers').fill('20');
    await page.getByTestId('rec-unit-net').fill('15.5');
    await page.getByTestId('rec-supplier').fill('Proveedor sin red');
    await page.getByTestId('rec-reference').fill('SIN-RED-1');
    await page.getByTestId('rec-confirm').tap();
    await expect(page.getByTestId('rec-sheet-net')).toHaveAttribute('data-milli', '310000');
    await page.getByTestId('rec-confirm-yes').tap();
    await expect(page.getByTestId('toast')).toContainText(`Recepción R-${f.nextReceptionFolio} registrada: +310 kg`);
    let d = await readDb(page);
    expect(d.receptions.find((r) => r.folio === f.nextReceptionFolio)).toMatchObject({ status: 'confirmada', confirmedNetMilli: 310_000, packaging: 'caja', containers: 20, unitNetMilli: 15_500, reference: 'SIN-RED-1' });
    expect(d.products.find((x) => x.id === oax.id)!.physicalMilli).toBe(st('oax-1ra-300').physicalMilli + 310_000);

    // 2) Borrador SIN peso: no suma al inventario
    await page.getByTestId('rec-variety').filter({ hasText: 'Sin semilla' }).tap();
    await page.getByTestId('rec-class').filter({ hasText: 'Tercera' }).tap();
    await page.getByTestId('rec-supplier').fill('Borrador sin red');
    await page.getByTestId('rec-save-draft').tap();
    await expect(page.getByTestId('toast')).toContainText('Borrador guardado (aún sin peso neto): no suma al inventario');
    const afterDraft = await readDb(page);
    expect(afterDraft.receptions.find((r) => r.supplier === 'Borrador sin red')).toMatchObject({ status: 'borrador' });
    expect(afterDraft.stockMoves).toHaveLength(d.stockMoves.length);
    await page.getByTestId('rec-sub-borradores').tap();
    await expect(page.getByTestId('rec-draft-row')).toHaveCount(f.drafts + 1);
    await page.getByTestId('rec-sub-nueva').tap();

    // 3) Inventario: entrada de 250 piezas, merma de 2 kg y conteo físico
    await tab(page, 'inventario');
    const pieza = invRow(page, 'pieza');
    await pieza.getByTestId('move-entrada').tap();
    await pieza.getByTestId('move-qty').fill('250');
    await pieza.getByTestId('move-save').tap();
    await expect(page.getByTestId('toast')).toContainText('Entrada manual registrada');
    const tercera = invRow(page, 'sin-3ra');
    await tercera.getByTestId('move-merma').tap();
    await tercera.getByTestId('move-qty').fill('2');
    await tercera.getByTestId('move-note').fill('Se cayó una arpilla sin red');
    await tercera.getByTestId('move-save').tap();
    await expect(page.getByTestId('toast')).toContainText('Merma registrada');
    const segunda = invRow(page, 'sin-2da-3x');
    const counted = (st('sin-2da-3x').physicalMilli - 5_000) / 1000;
    await segunda.getByTestId('move-ajuste').tap();
    await segunda.getByTestId('move-qty').fill(String(counted));
    await segunda.getByTestId('move-note').fill('Conteo sin red');
    await segunda.getByTestId('move-save').tap();
    await expect(page.getByTestId('toast')).toContainText('Conteo físico registrado');
    d = await readDb(page);
    expect(d.products.find((x) => x.id === market.product('pieza').id)!.physicalMilli).toBe(st('pieza').physicalMilli + 250_000);
    expect(d.products.find((x) => x.id === market.product('sin-3ra').id)!.physicalMilli).toBe(st('sin-3ra').physicalMilli - 2_000);
    expect(d.products.find((x) => x.id === market.product('sin-2da-3x').id)!.physicalMilli).toBe(st('sin-2da-3x').physicalMilli - 5_000);
    expect(d.stockMoves).toHaveLength(base.stockMoves.length + 4);

    // 4) Historial y Resumen reflejan lo recibido sin red
    await tab(page, 'recepcion');
    await page.getByTestId('rec-sub-historial').tap();
    await expect(page.getByTestId('rec-row').first()).toContainText(`R-${f.nextReceptionFolio}`);
    await expect(page.getByTestId('rec-row').first()).toContainText('310 kg');
    await page.getByTestId('rec-sub-resumen').tap();
    await expect(page.getByTestId('rep-received')).toHaveAttribute('data-milli', String(receivedOn(market, today) + 310_000));
    await expect(page.getByTestId('rep-ledger-cuadra')).toBeVisible();

    // 5) Volver «en línea» y recargar: idéntico, sin duplicados
    const offlineDump = await readDb(page);
    await goOnline(context);
    await expect(page.getByTestId('net')).toHaveText('En línea');
    await page.reload();
    const online = await readDb(page);
    expect(online).toEqual(offlineDump);
    expect(online.receptions).toHaveLength(base.receptions.length + 2); // 1 registrada + 1 borrador
    expect(invariants(online), 'invariantes').toEqual([]);
    await tab(page, 'mas');
    await page.getByTestId('audit').tap();
    await expect(page.getByTestId('audit-result')).toContainText('Sin inconsistencias');
  });

  test('Sin conexión: exportar un respaldo, restaurarlo (con la pérdida advertida) y deshacer la restauración; los folios ya emitidos no se repiten', async ({ page, context }) => {
    test.setTimeout(150_000);
    const market = await boot(page, { realTime: true, confirmedReceptions: 6, sales: 6 });
    await goOffline(context);
    await expect(page.getByTestId('net')).toHaveText('Sin internet');
    const s0 = await readDb(page);

    // Exportar SIN red: el archivo se genera en el teléfono
    await tab(page, 'mas');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export').click()]);
    const path = await dl.path();
    const file = JSON.parse(readFileSync(path, 'utf8'));
    expect(file.sales).toHaveLength(s0.sales.length);
    expect(file.receptions).toHaveLength(s0.receptions.length);
    await expect(page.getByTestId('toast')).toContainText(`Respaldo exportado (${s0.sales.length} ventas, ${s0.receptions.length} recepciones)`);

    // Después del respaldo se vende: eso es lo que se perderá al restaurar
    await tab(page, 'caja');
    await page.getByTestId('kg').fill('2');
    await page.getByTestId('exact').tap();
    await page.getByTestId('confirm').tap();
    await page.getByTestId('confirm-yes').tap();
    await expect(page.getByTestId('toast')).toContainText(`Venta #${market.facts.nextFolio} guardada`);
    const s1 = await readDb(page);
    expect(s1.sales).toHaveLength(s0.sales.length + 1);

    // Restaurar el archivo: advierte la venta que se perdería y exige entenderlo
    await tab(page, 'mas');
    await page.getByTestId('import-file').setInputFiles(path);
    await expect(page.getByTestId('restore-sheet')).toBeVisible();
    await expect(page.getByTestId('restore-loss')).toContainText('1 venta');
    await expect(page.getByTestId('restore-confirm')).toBeDisabled();
    await page.getByTestId('restore-understood').tap();
    await page.getByTestId('restore-confirm').tap();
    await expect(page.getByTestId('toast')).toContainText('Respaldo restaurado');
    const s2 = await readDb(page);
    expect(s2.sales.map((s) => s.id)).toEqual(s0.sales.map((s) => s.id)); // la venta posterior ya no está
    expect(s2.products.map((x) => [x.id, x.physicalMilli])).toEqual(s0.products.map((x) => [x.id, x.physicalMilli]));
    expect(s2.nextFolio, 'los folios que ya se emitieron no se repiten').toBe(s1.nextFolio);
    expect(invariants({ ...s2, nextFolio: s2.nextFolio }), 'invariantes').toEqual([]);

    // Deshacer: vuelve la venta con su folio
    await expect(page.getByTestId('undo-box')).toBeVisible();
    await page.getByTestId('undo-restore').tap();
    await expect(page.getByTestId('restore-sheet')).toContainText('Deshacer la última restauración');
    await page.getByTestId('restore-confirm').tap();
    await expect(page.getByTestId('toast')).toContainText('Restauración deshecha');
    const s3 = await readDb(page);
    expect(s3.sales.map((s) => s.id).sort()).toEqual(s1.sales.map((s) => s.id).sort());
    expect(s3.products.map((x) => [x.id, x.physicalMilli])).toEqual(s1.products.map((x) => [x.id, x.physicalMilli]));
    expect(invariants(s3), 'invariantes').toEqual([]);
    await goOnline(context);
    await expect(page.getByTestId('net')).toHaveText('En línea');
  });

  test('El indicador «Sin internet» aparece y desaparece al perder y recuperar la red (también en cambios rápidos) sin romper el encabezado en ambos tamaños, y en línea sigue igual tras recargar', async ({ page, context }) => {
    test.setTimeout(90_000);
    await openApp(page, { seed: false });
    const net = page.getByTestId('net');
    await expect(net).toHaveText('En línea');
    await expect(net).toHaveClass(/\bon\b/);
    await expect(net).not.toHaveAttribute('title', /.+/);
    for (const phone of PHONES) {
      await page.setViewportSize({ width: phone.width, height: phone.height });
      await goOffline(context);
      await expect(net).toHaveText('Sin internet');
      await expect(net).toHaveClass(/\boff\b/);
      await expect(net).toHaveAttribute('title', 'La app funciona igual sin internet');
      const r = await rectOf(net);
      expect(r.left, `el indicador debe caber en el encabezado (${phone.name})`).toBeGreaterThanOrEqual(0);
      expect(r.right).toBeLessThanOrEqual(phone.width);
      expect(await overflowReport(page), `encabezado sin red (${phone.name})`).toEqual([]);
      expect(await clippedTextReport(page)).toEqual([]);
      await goOnline(context);
      await expect(net).toHaveText('En línea');
      await expect(net).toHaveClass(/\bon\b/);
      await expect(net).not.toHaveAttribute('title', /.+/);
      expect(await overflowReport(page), `encabezado en línea (${phone.name})`).toEqual([]);
    }
    // Cambios rápidos: el último estado manda
    for (let i = 0; i < 4; i++) {
      await goOffline(context);
      await goOnline(context);
    }
    await expect(net).toHaveText('En línea');
    await goOffline(context);
    await goOnline(context);
    await goOffline(context);
    await expect(net).toHaveText('Sin internet');
    // Al volver la red cambia sin recargar (lo de «dice Sin internet desde el primer momento al reabrir» está en el arranque en frío)
    await goOnline(context);
    await expect(net).toHaveText('En línea');
    await page.reload();
    await expect(net).toHaveText('En línea');
  });

  test('Corte de caja sin alteraciones indebidas trabajando sin red: recibir, contar, mermar y entregar vales NO tocan el efectivo; una venta suma exactamente lo cobrado y el corte cerrado persiste exacto tras recargar (caso 23)', async ({ page, context }) => {
    test.setTimeout(180_000);
    const market = await boot(page, { realTime: true });
    const f = market.facts.openShift;
    page.on('dialog', (dlg) => dlg.accept());
    const cut = async () => ({
      total: await page.getByTestId('r-total').innerText(),
      efectivo: await page.getByTestId('r-efectivo').innerText(),
      expected: await page.getByTestId('r-expected').innerText(),
      refunds: await page.getByTestId('r-refunds').innerText(),
      sales: await page.getByTestId('sale-row').count(),
    });
    const openShiftId = market.backup.shifts.find((x) => !x.closedAt)!.id;
    const shiftSales = market.backup.sales.filter((s) => s.shiftId === openShiftId).length;

    await tab(page, 'corte');
    const base = await cut();
    expect(base.total).toBe(money(f.totalCents));
    expect(base.efectivo).toBe(money(f.efectivoCents));
    expect(base.expected).toBe(money(f.expectedCents));
    expect(base.refunds).toContain(money(f.refundsCents));
    expect(base.sales).toBe(shiftSales);

    // Se corta la red con la app abierta: el corte es idéntico (reabrir la app sin red está en la prueba de arranque en frío)
    await goOffline(context);
    await expect(page.getByTestId('net')).toHaveText('Sin internet');
    expect(await cut(), 'el corte no cambia por quedarse sin red').toEqual(base);

    // Operaciones SIN dinero: recibir mercancía, entrada manual, merma, conteo, borrador y entrega de un vale
    await tab(page, 'recepcion');
    await page.getByTestId('rec-variety').filter({ hasText: 'Sin semilla' }).tap();
    await page.getByTestId('rec-class').filter({ hasText: 'Segunda · 3X' }).tap();
    await page.getByTestId('rec-net-direct').fill('100');
    await page.getByTestId('rec-confirm').tap();
    await page.getByTestId('rec-confirm-yes').tap();
    await expect(page.getByTestId('toast')).toContainText('registrada: +100 kg');
    await page.getByTestId('rec-variety').filter({ hasText: 'Sin semilla' }).tap();
    await page.getByTestId('rec-class').filter({ hasText: 'Tercera' }).tap();
    await page.getByTestId('rec-supplier').fill('Borrador del corte');
    await page.getByTestId('rec-save-draft').tap();
    await expect(page.getByTestId('toast')).toContainText('Borrador guardado');
    await tab(page, 'inventario');
    const pieza = invRow(page, 'pieza');
    await pieza.getByTestId('move-entrada').tap();
    await pieza.getByTestId('move-qty').fill('40');
    await pieza.getByTestId('move-save').tap();
    await expect(page.getByTestId('toast')).toContainText('Entrada manual registrada');
    const tercera = invRow(page, 'sin-3ra');
    await tercera.getByTestId('move-merma').tap();
    await tercera.getByTestId('move-qty').fill('3');
    await tercera.getByTestId('move-note').fill('Merma del corte');
    await tercera.getByTestId('move-save').tap();
    await expect(page.getByTestId('toast')).toContainText('Merma registrada');
    const segunda = invRow(page, 'sin-2da-3x');
    await segunda.getByTestId('move-ajuste').tap();
    await segunda.getByTestId('move-qty').fill('800');
    await segunda.getByTestId('move-note').fill('Conteo del corte');
    await segunda.getByTestId('move-save').tap();
    await expect(page.getByTestId('toast')).toContainText('Conteo físico registrado');
    await tab(page, 'vales');
    await page.getByTestId('vale').first().getByTestId('deliver').tap();
    await expect(page.getByTestId('toast')).toContainText('entregado');
    await tab(page, 'corte');
    expect(await cut(), 'recibir, contar, mermar y entregar vales no deben mover el corte').toEqual(base);

    // Una venta en efectivo de 2 kg × $32 = $64.00 suma EXACTAMENTE $64.00 a ventas, efectivo y esperado
    await tab(page, 'caja');
    await page.getByTestId('kg').fill('2');
    await page.getByTestId('exact').tap();
    await page.getByTestId('confirm').tap();
    await page.getByTestId('confirm-yes').tap();
    await expect(page.getByTestId('toast')).toContainText(`Venta #${market.facts.nextFolio} guardada`);
    await tab(page, 'corte');
    const afterSale = await cut();
    expect(afterSale).toEqual({
      total: money(f.totalCents + 6_400),
      efectivo: money(f.efectivoCents + 6_400),
      expected: money(f.expectedCents + 6_400),
      refunds: base.refunds,
      sales: base.sales + 1,
    });
    // Una salida de $20.00 resta exactamente $20.00 del esperado y nada más
    await page.getByTestId('out-amount').fill('20');
    await page.getByTestId('out-concept').fill('Hielo del corte');
    await page.getByTestId('out-save').tap();
    await expect(page.getByTestId('toast')).toContainText('Salida registrada');
    const afterOut = await cut();
    expect(afterOut).toEqual({ ...afterSale, expected: money(f.expectedCents + 6_400 - 2_000) });

    // Cerrar con diferencia de −$5.00: el corte cerrado queda exacto
    const expected = f.expectedCents + 6_400 - 2_000;
    await page.getByTestId('counted').fill(String((expected - 500) / 100));
    await expect(page.getByTestId('diff')).toHaveText('Faltan $5.00');
    await page.getByTestId('close-shift').tap();
    await expect(page.getByTestId('toast')).toContainText('Turno cerrado');
    const closedLine = `esperado ${money(expected)} · contado ${money(expected - 500)} · dif ${money(-500)}`;
    await expect(page.getByTestId('closed-shift').first()).toContainText(closedLine);
    await expect(page.getByTestId('open-shift')).toBeVisible(); // ya no hay turno abierto
    const closedBefore = await page.getByTestId('closed-shift').allInnerTexts();

    // La primera venta del turno siguiente lo abre solo con fondo $0 y NO toca el corte ya cerrado
    await tab(page, 'caja');
    await page.getByTestId('kg').fill('1');
    await page.getByTestId('exact').tap();
    await page.getByTestId('confirm').tap();
    await page.getByTestId('confirm-yes').tap();
    await expect(page.getByTestId('toast')).toContainText(`Venta #${market.facts.nextFolio + 1} guardada`);
    await tab(page, 'corte');
    await expect(page.getByTestId('r-expected')).toHaveText(money(3_200)); // fondo $0 + $32.00 de 1 kg
    await expect(page.getByTestId('r-total')).toHaveText(money(3_200));
    await expect(page.getByTestId('sale-row')).toHaveCount(1);
    expect(await page.getByTestId('closed-shift').allInnerTexts(), 'el corte cerrado no cambia').toEqual(closedBefore.slice(0, closedBefore.length));
    const d = await readDb(page);
    expect(d.shifts.find((x) => x.expectedCashCents === expected)).toMatchObject({ countedCashCents: expected - 500, differenceCents: -500 });

    // De vuelta en línea y recargando: nada cambia, el corte cerrado y el nuevo turno persisten exactos
    const offlineDump = await readDb(page);
    await goOnline(context);
    await expect(page.getByTestId('net')).toHaveText('En línea');
    await page.reload();
    expect(await readDb(page)).toEqual(offlineDump);
    expect(invariants(offlineDump), 'invariantes').toEqual([]);
    await tab(page, 'corte');
    await expect(page.getByTestId('r-expected')).toHaveText(money(3_200));
    expect(await page.getByTestId('closed-shift').allInnerTexts(), 'el corte cerrado persiste igual tras recargar').toEqual(closedBefore);
  });

  // El usuario del mercado cierra la app y la vuelve a abrir con el teléfono ya sin señal (docs/ANDROID.md, pasos 5 a 7 de la
  // ruta A). Es la única prueba que reinicia la app CON la red cortada; hoy falla por un defecto real, no por la simulación:
  // ver reopenOffline() en helpers-android.ts (hay una copia de dist/ servida sin `Vary: Origin` donde esta misma secuencia pasa).
  test('Arranque en frío SIN red (casos 22 y 23): al reabrir la app con la red cortada carga desde el service worker, con datos y corte intactos, y una venta hecha sin red sobrevive a otra reapertura', async ({ page, context }) => {
    test.setTimeout(150_000);
    const market = await boot(page, { realTime: true, confirmedReceptions: 6, sales: 6 });
    const f = market.facts;
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    const cut = async () => ({
      total: await page.getByTestId('r-total').innerText(),
      efectivo: await page.getByTestId('r-efectivo').innerText(),
      expected: await page.getByTestId('r-expected').innerText(),
      sales: await page.getByTestId('sale-row').count(),
    });
    await tab(page, 'corte');
    const baseCut = await cut();
    expect(baseCut.expected).toBe(money(f.openShift.expectedCents));
    const before = await readDb(page);

    // 1) Reabrir sin red: dice «Sin internet» desde el primer momento y todo está igual
    await goOffline(context);
    await reopenOffline(page, context);
    await expectNetworkCut(page); // si la red no estuviera cortada de verdad, reabrir «pasaría» en falso
    await expect(page.getByTestId('net')).toHaveText('Sin internet');
    await expect(page.getByTestId('caja')).toBeVisible();
    expect(await readDb(page), 'reabrir sin red no cambia ningún dato').toEqual(before);
    await tab(page, 'corte');
    expect(await cut(), 'el corte es idéntico tras reabrir sin red').toEqual(baseCut);

    // 2) Vender sin red (2 kg × $32 = $64.00) y reabrir otra vez sin red: la venta y el corte siguen ahí
    await tab(page, 'caja');
    await page.getByTestId('kg').fill('2');
    await page.getByTestId('exact').tap();
    await page.getByTestId('confirm').tap();
    await page.getByTestId('confirm-yes').tap();
    await expect(page.getByTestId('toast')).toContainText(`Venta #${f.nextFolio} guardada`);
    const afterSale = await readDb(page);
    expect(afterSale.sales).toHaveLength(before.sales.length + 1);
    await reopenOffline(page, context);
    await expect(page.getByTestId('net')).toHaveText('Sin internet');
    expect(await readDb(page), 'la venta hecha sin red sobrevive a reabrir sin red').toEqual(afterSale);
    await tab(page, 'corte');
    expect(await cut()).toEqual({
      total: money(f.openShift.totalCents + 6_400),
      efectivo: money(f.openShift.efectivoCents + 6_400),
      expected: money(f.openShift.expectedCents + 6_400),
      sales: baseCut.sales + 1,
    });
    await tab(page, 'mas');
    await page.getByTestId('audit').tap();
    await expect(page.getByTestId('audit-result')).toContainText('Sin inconsistencias');
    expect(pageErrors, 'errores de la página al reabrir sin red').toEqual([]);

    // 3) Vuelve la red: sin pérdidas ni duplicados
    await goOnline(context);
    await expect(page.getByTestId('net')).toHaveText('En línea');
    await page.reload();
    expect(await readDb(page)).toEqual(afterSale);
  });
});

// =====================================================================================================================
// F. Accesibilidad básica verificable (caso 21)
// =====================================================================================================================

interface SheetCase {
  name: string;
  testid: string;
  open: (page: Page) => Promise<void>;
  close: (page: Page) => Promise<void>;
}

/** Las nueve hojas modales de la app, con cómo se abre y se cierra cada una (siempre sobre el mercado de prueba). */
const SHEETS: SheetCase[] = [
  {
    name: 'Caja · confirmar cobro',
    testid: 'confirm-sheet',
    open: async (page) => {
      await tab(page, 'caja');
      await page.getByTestId('kg').fill('1');
      await page.getByTestId('exact').tap();
      await page.getByTestId('confirm').tap();
    },
    close: (page) => page.getByTestId('confirm-no').tap(),
  },
  {
    name: 'Caja · Ver las N clasificaciones',
    testid: 'quality-sheet',
    open: async (page) => {
      await tab(page, 'caja');
      await page.getByTestId('variety').filter({ hasText: 'Con semilla' }).tap();
      await page.getByTestId('quality-all').tap();
    },
    close: (page) => page.getByTestId('quality-sheet-close').tap(),
  },
  {
    name: 'Vales · cancelar vale',
    testid: 'cancel-sheet',
    open: async (page) => {
      await tab(page, 'vales');
      await page.getByTestId('cancel-vale').first().tap();
    },
    close: (page) => page.getByTestId('cancel-back').tap(),
  },
  {
    name: 'Recepción · confirmar recepción',
    testid: 'rec-sheet',
    open: async (page) => {
      await tab(page, 'recepcion');
      await page.getByTestId('rec-variety').filter({ hasText: 'Sin semilla' }).tap();
      await page.getByTestId('rec-class').filter({ hasText: 'Primera · 2X' }).tap();
      await page.getByTestId('rec-net-direct').fill('10');
      await page.getByTestId('rec-confirm').tap();
    },
    close: (page) => page.getByTestId('rec-confirm-no').tap(),
  },
  {
    name: 'Recepción · Ver las N clasificaciones',
    testid: 'rec-class-sheet',
    open: async (page) => {
      await tab(page, 'recepcion');
      // El caso anterior dejó un producto elegido: su paso quedó cerrado en la línea resumen y se toca para abrirlo.
      const sum = page.getByTestId('rec-step-1-sum');
      if ((await sum.count()) > 0 && (await sum.getAttribute('aria-expanded')) === 'false') await sum.tap();
      await page.getByTestId('rec-variety').filter({ hasText: 'Con semilla' }).tap();
      await page.getByTestId('rec-class-all').tap();
    },
    close: (page) => page.getByTestId('rec-class-sheet-close').tap(),
  },
  {
    name: 'Recepción · Nueva clasificación',
    testid: 'rec-newclass-sheet',
    open: async (page) => {
      await tab(page, 'recepcion');
      await page.getByTestId('rec-new-class-toggle').tap();
    },
    close: (page) => page.getByTestId('rec-newclass-close').tap(),
  },
  {
    name: 'Inventario · autorización',
    testid: 'authorize-sheet',
    open: async (page) => {
      await tab(page, 'inventario');
      const row = invRow(page, 'sin-1ra-2x');
      await row.getByTestId('move-merma').tap();
      await row.getByTestId('move-qty').fill('700');
      await row.getByTestId('move-note').fill('Prueba de accesibilidad');
      await row.getByTestId('move-save').tap();
    },
    close: (page) => page.getByTestId('authorize-no').tap(),
  },
  {
    name: 'Inventario · aviso de entrada manual',
    testid: 'warnings-sheet',
    open: async (page) => {
      await tab(page, 'inventario');
      const row = invRow(page, 'sin-1ra-2x');
      await row.getByTestId('move-entrada').tap();
      await row.getByTestId('move-qty').fill('10');
      await row.getByTestId('move-save').tap();
    },
    close: (page) => page.getByTestId('warnings-no').tap(),
  },
  {
    name: 'Más · restaurar respaldo',
    testid: 'restore-sheet',
    open: async (page) => {
      await tab(page, 'mas');
      await page.getByTestId('import-file').setInputFiles({ name: 'mercado.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(buildMarket().backup)) });
    },
    close: (page) => page.getByTestId('restore-cancel').tap(),
  },
];

/** Recorre todas las hojas: abre, deja que `inspect` mire, cierra y comprueba que se cerró. */
async function eachSheet(page: Page, inspect: (c: SheetCase) => Promise<void>, closeAfter = true) {
  for (const c of SHEETS) {
    await c.open(page);
    await expect(page.getByTestId(c.testid), `abrir «${c.name}»`).toBeVisible();
    await inspect(c);
    if (closeAfter && (await page.getByTestId(c.testid).count())) {
      await c.close(page);
      await expect(page.getByTestId(c.testid)).toHaveCount(0);
    }
  }
}

test.describe('Android · accesibilidad básica · 360×640', () => {
  test.use({ viewport: { width: 360, height: 640 } });

  /** Recorre toda la app y junta, por estado, los controles sin nombre y los que solo tienen texto de ayuda. */
  async function namesEverywhere(page: Page, market: Market) {
    const unnamed: Record<string, string[]> = {};
    const placeholderOnly: Record<string, string[]> = {};
    const duplicated: Record<string, string[]> = {};
    const visit: Visit = async (where) => {
      const r = await controlNameReport(page);
      if (r.unnamed.length) unnamed[where] = r.unnamed;
      if (r.placeholderOnly.length) placeholderOnly[where] = r.placeholderOnly;
      const ids = await duplicateIds(page);
      if (ids.length) duplicated[where] = ids;
    };
    await walkEverything(page, visit, market);
    return { unnamed, placeholderOnly, duplicated };
  }

  test('Todos los botones, casillas, opciones y resúmenes tienen nombre accesible (texto o aria-label) y no hay ids repetidos', async ({ page }) => {
    test.setTimeout(150_000);
    const market = await boot(page);
    const { unnamed, duplicated } = await namesEverywhere(page, market);
    expect(unnamed, 'controles sin ningún nombre accesible, por estado de pantalla').toEqual({});
    expect(duplicated, 'valores de id repetidos').toEqual({});
    // Los botones que solo muestran un símbolo llevan aria-label (p. ej. «×» de quitar una pesada)
    await tab(page, 'recepcion');
    await page.getByTestId('rec-sub-nueva').tap();
    await page.getByTestId('rec-weigh-toggle').tap();
    await page.getByTestId('rec-weigh-input').fill('10');
    await page.getByTestId('rec-weigh-add').tap();
    const remove = page.getByTestId('rec-weigh-remove');
    const n = await remove.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) await expect(remove.nth(i)).toHaveAttribute('aria-label', `Quitar la pesada ${i + 1}`);
    // Las pestañas con borradores dicen cuántos hay a los lectores de pantalla (el número visual va oculto)
    await expect(page.getByTestId('menu-btn')).toHaveAttribute('aria-label', `Más secciones, ${market.facts.drafts} borradores pendientes`);
  });

  test('Los campos de texto tienen una etiqueta visible o aria-label (no solo texto de ayuda que desaparece al escribir)', async ({ page }) => {
    test.setTimeout(150_000);
    const market = await boot(page);
    const { placeholderOnly } = await namesEverywhere(page, market);
    expect(placeholderOnly, 'campos cuyo único nombre es el placeholder, por estado de pantalla').toEqual({});
  });

  test('Cada hoja modal es role="dialog" con aria-modal="true" y un nombre accesible', async ({ page }) => {
    test.setTimeout(120_000);
    await boot(page);
    const bad: Record<string, string[]> = {};
    await eachSheet(page, async (c) => {
      const r = await dialogReport(page);
      if (r.length) bad[c.name] = r;
    });
    expect(bad, 'diálogos mal declarados').toEqual({});
  });

  test('Al abrir una hoja el foco entra en ella (en su acción principal o en la propia hoja)', async ({ page }) => {
    test.setTimeout(120_000);
    await boot(page);
    const bad: string[] = [];
    await eachSheet(page, async (c) => {
      const inside = await page.evaluate((id) => {
        const dlg = document.querySelector(`[data-testid="${id}"]`);
        return !!dlg && dlg.contains(document.activeElement);
      }, c.testid);
      if (!inside) {
        const f = await focusInfo(page);
        bad.push(`${c.name}: el foco se quedó FUERA del diálogo (en «${f.testid || f.tag}»)`);
      }
    });
    expect(bad, 'hojas que no reciben el foco').toEqual([]);
  });

  test('Al cerrar una hoja el foco no se pierde (vuelve a un control de la pantalla, no al cuerpo de la página)', async ({ page }) => {
    test.setTimeout(120_000);
    await boot(page);
    const bad: string[] = [];
    for (const c of SHEETS) {
      await c.open(page);
      await expect(page.getByTestId(c.testid)).toBeVisible();
      await c.close(page);
      await expect(page.getByTestId(c.testid)).toHaveCount(0);
      const f = await focusInfo(page);
      if (f.lost) bad.push(`${c.name}: al cerrar, el foco quedó en el cuerpo de la página`);
      expect(await inertLeft(page), `«${c.name}» dejó elementos inertes`).toBe(0);
    }
    expect(bad, 'hojas que pierden el foco al cerrarse').toEqual([]);
  });

  test('La tecla Escape cierra cada hoja modal (no hay Escape en Android: es el equivalente del gesto «atrás»)', async ({ page }) => {
    test.setTimeout(120_000);
    await boot(page);
    const stayed: string[] = [];
    for (const c of SHEETS) {
      await c.open(page);
      await expect(page.getByTestId(c.testid)).toBeVisible();
      await page.keyboard.press('Escape');
      try {
        // Que algo NO ocurra no se puede esperar con certeza: se da un segundo de margen.
        await expect(page.getByTestId(c.testid)).toHaveCount(0, { timeout: 1_000 });
      } catch {
        stayed.push(c.name);
        await c.close(page);
      }
    }
    expect(stayed, 'hojas que siguen abiertas tras pulsar Escape').toEqual([]);
  });

  test('La página permite acercar con los dedos, declara el idioma español de México y la navegación tiene nombre', async ({ page }) => {
    await openApp(page, { seed: false });
    const viewport = await page.locator('meta[name=viewport]').getAttribute('content');
    expect(viewport).toContain('width=device-width');
    expect(viewport, 'no debe bloquearse el zoom').not.toMatch(/user-scalable\s*=\s*(no|0)/i);
    expect(viewport, 'no debe limitarse el zoom').not.toMatch(/maximum-scale\s*=\s*1(\.0)?(\D|$)/i);
    await expect(page.locator('html')).toHaveAttribute('lang', 'es-MX');
    await expect(page.locator('nav.tabs')).toHaveAttribute('aria-label', 'Secciones');
    await expect(page.getByTestId('tab-caja')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });
});

// =====================================================================================================================
// G. Prueba de las pruebas
// =====================================================================================================================

test.describe('Android · prueba de las pruebas · 360×640', () => {
  test.use({ viewport: { width: 360, height: 640 } });

  test('Los barridos de diseño y de accesibilidad DETECTAN defectos inyectados a propósito (si no detectaran nada, todo lo demás sería humo)', async ({ page }) => {
    test.setTimeout(90_000);
    await boot(page);
    await tab(page, 'inventario');
    // Línea base: la pantalla está limpia
    expect(await overflowReport(page)).toEqual([]);
    expect(await clippedTextReport(page)).toEqual([]);
    expect((await touchTargetReport(page)).filter((x) => !x.includes('«1X»'))).toEqual([]); // (el chip «1X» de 43 px es un defecto real de la app)
    expect(await bottomReachReport(page)).toEqual([]);
    const names = await controlNameReport(page);
    expect(names.unnamed).toEqual([]);

    const inject = (html: string) =>
      page.evaluate((h) => {
        const t = document.createElement('template');
        t.innerHTML = h.trim();
        document.querySelector('main')!.appendChild(t.content.firstElementChild!);
      }, html);
    const style = (id: string, props: Record<string, string>) =>
      page.evaluate(
        ([i, p]) => {
          const el = document.querySelector<HTMLElement>(`[data-testid="${i}"]`)!;
          for (const [k, v] of Object.entries(p as Record<string, string>)) el.style.setProperty(k, v);
        },
        [id, props] as const,
      );
    const remove = (id: string) => page.evaluate((i) => document.querySelector(`[data-testid="${i}"]`)?.remove(), id);

    // 1) un elemento más ancho que la pantalla
    await inject('<div data-testid="inyectado-ancho">ancho</div>');
    await style('inyectado-ancho', { width: '700px', height: '20px' });
    expect((await overflowReport(page)).join('\n')).toContain('inyectado-ancho');
    await remove('inyectado-ancho');
    expect(await overflowReport(page)).toEqual([]);

    // 2) un botón de 30×30
    await inject('<button data-testid="inyectado-chico">x</button>');
    await style('inyectado-chico', { width: '30px', height: '30px', 'min-height': '0', padding: '0' });
    expect((await touchTargetReport(page)).join('\n')).toMatch(/inyectado-chico.*30×30/);
    await remove('inyectado-chico');

    // 3) un botón cuyo texto no cabe
    await inject('<button data-testid="inyectado-corto">Un texto bastante más largo que la caja</button>');
    await style('inyectado-corto', { width: '60px', 'white-space': 'nowrap' });
    expect((await clippedTextReport(page)).join('\n')).toContain('inyectado-corto');
    await remove('inyectado-corto');

    // 4) el final del contenido tapado por las pestañas (se quita el relleno inferior de la página)
    await page.evaluate(() => document.body.style.setProperty('padding-bottom', '0px'));
    expect((await bottomReachReport(page)).join('\n')).toContain('por debajo del borde de las pestañas');
    await page.evaluate(() => document.body.style.removeProperty('padding-bottom'));
    expect(await bottomReachReport(page)).toEqual([]);

    // 5) un botón tapado por una capa
    await tab(page, 'vales');
    const deliver = page.getByTestId('deliver').first();
    expect(await reachReport(deliver)).toEqual([]);
    await page.evaluate(() => {
      const cover = document.createElement('div');
      cover.setAttribute('data-testid', 'inyectado-capa');
      cover.style.setProperty('position', 'fixed');
      cover.style.setProperty('inset', '0');
      cover.style.setProperty('z-index', '99');
      document.body.appendChild(cover);
    });
    expect((await reachReport(deliver)).join('\n')).toContain('tapado por');
    await remove('inyectado-capa');
    expect(await reachReport(deliver)).toEqual([]);

    // 6) accesibilidad: un botón sin nombre y un diálogo sin nombre ni aria-modal
    await inject('<button data-testid="inyectado-mudo"><span aria-hidden="true">★</span></button>');
    expect((await controlNameReport(page)).unnamed.join('\n')).toContain('inyectado-mudo');
    await remove('inyectado-mudo');
    await inject('<div data-testid="inyectado-sheet" role="dialog">hola</div>');
    const dlg = (await dialogReport(page)).join('\n');
    expect(dlg).toContain('no tiene aria-modal');
    expect(dlg).toContain('no tiene nombre');
    await remove('inyectado-sheet');
    expect(await dialogReport(page)).toEqual([]);

    // 7) un campo cuyo único nombre es el placeholder
    await inject('<input data-testid="inyectado-campo" placeholder="solo ayuda">');
    expect((await controlNameReport(page)).placeholderOnly.join('\n')).toContain('inyectado-campo');
  });

  test('La regresión del toque perdido DETECTA el fallo original: si el diseño se mueve al soltar el foco del campo, el toque en el botón se pierde y la prueba falla', async ({ page }) => {
    test.setTimeout(90_000);
    await boot(page);
    await tab(page, 'corte');
    await page.getByTestId('out-amount').fill('15');
    await page.getByTestId('out-concept').fill('Hielo');
    await showKeyboard(page, PHONES[0]);
    await expect(html(page)).toHaveClass(/kbd/);
    const before = await readDb(page);
    // Se reproduce a propósito el diseño antiguo: al perder el foco (en el mousedown) el contenido se mueve antes del mouseup.
    await page.evaluate(() => {
      document.addEventListener('focusout', () => document.body.style.setProperty('padding-top', '90px'), true);
    });
    await watchTaps(page);
    await page.getByTestId('out-save').tap();
    await expect(
      expectSolidTap(page, 'out-save'),
      'con un diseño que se mueve al soltar el foco, la prueba de regresión debe FALLAR (si pasara, no detectaría el fallo original)',
    ).rejects.toThrow();
    // …y el efecto real también se pierde: la salida de efectivo no se registró con ese toque.
    expect((await readDb(page)).cashMovements).toHaveLength(before.cashMovements.length);
  });

  test('El mercado de prueba es consistente: la auditoría de la app, las invariantes independientes y el cuadre del Resumen coinciden, y la base guarda lo restaurado', async ({ page }) => {
    test.setTimeout(90_000);
    const market = await boot(page, { confirmedReceptions: 60 });
    const b = market.backup;
    // Invariantes independientes sobre el archivo y sobre lo que quedó en IndexedDB
    expect(invariants({ ...b })).toEqual([]);
    const d = await readDb(page);
    expect(invariants(d)).toEqual([]);
    expect(d.products.map((p) => [p.id, p.physicalMilli, p.reservedMilli, p.priceCents, p.active])).toEqual(
      b.products.map((p) => [p.id, p.physicalMilli, p.reservedMilli, p.priceCents, p.active]),
    );
    for (const k of ['sales', 'receptions', 'stockMoves', 'shifts', 'cashMovements'] as const) expect(d[k], k).toHaveLength(b[k].length);
    expect([d.nextFolio, d.nextValeFolio, d.nextReceptionFolio]).toEqual([b.nextFolio, b.nextValeFolio, b.nextReceptionFolio]);
    expect(d.currentShiftId).toBe(b.shifts.find((x) => !x.closedAt)!.id);
    // La auditoría de la app
    await page.getByTestId('audit').tap();
    await expect(page.getByTestId('audit-result')).toContainText('Sin inconsistencias');
    // El cuadre del Resumen: hoy y últimos 7 días
    await tab(page, 'recepcion');
    await page.getByTestId('rec-sub-resumen').tap();
    await expect(page.getByTestId('rep-ledger-cuadra')).toBeVisible();
    await page.getByTestId('rep-week').tap();
    await expect(page.getByTestId('rep-ledger-cuadra')).toBeVisible();
    await page.getByTestId('rep-today').tap();
    // Los hechos del libro coinciden con lo que muestra el Corte
    await tab(page, 'corte');
    await expect(page.getByTestId('r-total')).toHaveText(money(market.facts.openShift.totalCents));
    await expect(page.getByTestId('r-expected')).toHaveText(money(market.facts.openShift.expectedCents));
    expect(mxDay(market.now)).toBe('2026-10-10');
  });
});
