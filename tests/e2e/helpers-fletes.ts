import { expect, type Page } from '@playwright/test';
import type { Freight, FreightSettings, LegacyBackup } from '../../src/domain/types';
import { tab } from './helpers';

/** Ayudas de fletes.spec.ts y de las pantallas de iphone.spec.ts: datos de ejemplo, lectura cruda de la base y captura por la interfaz. */

export const kg = (n: number) => Math.round(n * 1000);

/** Un flete válido (misma forma que guarda la app) para cargarlo dentro de un respaldo. */
export function mkFreight(folio: string, over: Partial<Freight> = {}): Freight {
  return {
    id: `fl-${folio.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    folio,
    folioKey: folio.toUpperCase(),
    status: 'activo',
    createdAt: '2026-10-09T18:00:00.000Z',
    updatedAt: '2026-10-09T18:00:00.000Z',
    date: '2026-10-09T18:00:00.000Z',
    day: '2026-10-09',
    origin: 'Apatzingán, Mich.',
    destination: 'Central de Abasto, CDMX',
    initial: { mode: 'bruto_tara', grossMilli: kg(22_000), tareMilli: kg(7_000), netMilli: kg(15_000), ticket: 'B-1203', scale: 'Báscula del huerto' },
    final: { mode: 'directo', netMilli: kg(14_760), ticket: 'CDMX-88' },
    revisions: [],
    ...over,
  };
}

/** Fletes de todos los casos que la pantalla debe saber mostrar (con la referencia de fábrica 200–300 kg). */
export function sampleFreights(): Freight[] {
  const long = (n: number, ch: string) => ch.repeat(n);
  return [
    mkFreight('F-DENTRO'), // 240 kg → dentro del rango
    mkFreight('F-DEBAJO', { final: { mode: 'directo', netMilli: kg(14_900) } }), // 100 kg → debajo
    mkFreight('F-ENCIMA', { final: { mode: 'directo', netMilli: kg(14_500) } }), // 500 kg → encima
    mkFreight('F-MAYOR', { final: { mode: 'directo', netMilli: kg(15_150) } }), // llegó más
    mkFreight('F-IGUAL', { final: { mode: 'directo', netMilli: kg(15_000) } }),
    mkFreight('F-SOLO-ORIGEN', { final: undefined }),
    mkFreight('F-SOLO-DESTINO', { initial: undefined }),
    mkFreight('F-ANULADO', {
      status: 'anulado',
      voidedAt: '2026-10-09T20:00:00.000Z',
      voidReason: 'Capturado dos veces',
      revisions: [{ id: 'rv-1', at: '2026-10-09T20:00:00.000Z', reason: 'Capturado dos veces', changes: [{ field: 'status', before: 'activo', after: 'anulado' }] }],
    }),
    mkFreight('F-CORREGIDO', {
      revisions: [{ id: 'rv-2', at: '2026-10-09T19:00:00.000Z', reason: 'La boleta decía 22,500', changes: [{ field: 'initial.grossMilli', before: kg(22_000), after: kg(22_500) }] }],
    }),
    mkFreight(long(40, 'F'), {
      origin: long(120, 'O'),
      destination: `${long(60, 'D')} ${long(59, 'E')}`,
      notes: `${long(250, 'n')} ${long(249, 'm')}`,
      initial: { mode: 'directo', netMilli: kg(199_999.999), ticket: long(60, 'T'), scale: long(120, 'B') },
      final: { mode: 'directo', netMilli: kg(1), ticket: long(60, 'U') },
    }),
  ];
}

/** Un respaldo de las pruebas (formato 2) convertido a formato 3 con estos fletes. */
export function asV3(backup: LegacyBackup, freights: Freight[], freightSettings?: FreightSettings) {
  return { ...backup, version: 3, freights, ...(freightSettings ? { freightSettings } : {}) };
}

/** Lee los fletes crudos de IndexedDB (solo lectura, sin pasar por el código de la app). */
export async function rawFreights(page: Page): Promise<Freight[]> {
  return page.evaluate(
    () =>
      new Promise<Freight[]>((resolve, reject) => {
        const open = indexedDB.open('caja-central');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('freights')) {
            db.close();
            return resolve([]);
          }
          const req = db.transaction('freights', 'readonly').objectStore('freights').getAll();
          req.onsuccess = () => {
            db.close();
            resolve((req.result as Freight[]).sort((a, b) => a.folio.localeCompare(b.folio)));
          };
          req.onerror = () => reject(req.error);
        };
      }),
  );
}

/** La configuración del rango tal como está en la base (undefined = nunca se cambió). */
export async function rawSettings(page: Page): Promise<unknown> {
  return page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const open = indexedDB.open('caja-central');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction('meta', 'readonly').objectStore('meta').get('freightSettings');
          req.onsuccess = () => {
            db.close();
            resolve((req.result as { value?: unknown } | undefined)?.value);
          };
          req.onerror = () => reject(req.error);
        };
      }),
  );
}

/** Inventario → Fletes. */
export async function openFletes(page: Page): Promise<void> {
  await tab(page, 'inventario');
  await page.getByTestId('inv-sub-fletes').click();
  await expect(page.getByTestId('fletes')).toBeVisible();
}

export interface SideInput {
  mode?: 'directo';
  gross?: string;
  tare?: string;
  net?: string;
  ticket?: string;
  scale?: string;
}
export interface FleteInput {
  folio?: string;
  origin?: string;
  destination?: string;
  notes?: string;
  initial?: SideInput;
  final?: SideInput;
}

async function fillSide(page: Page, prefix: 'fl-i' | 'fl-f', v: SideInput) {
  if (v.mode === 'directo') await page.getByTestId(`${prefix}-mode-directo`).click();
  if (v.gross !== undefined) await page.getByTestId(`${prefix}-gross`).fill(v.gross);
  if (v.tare !== undefined) await page.getByTestId(`${prefix}-tare`).fill(v.tare);
  if (v.net !== undefined) await page.getByTestId(`${prefix}-net`).fill(v.net);
  if (v.ticket !== undefined) await page.getByTestId(`${prefix}-ticket`).fill(v.ticket);
  if (v.scale !== undefined) await page.getByTestId(`${prefix}-scale`).fill(v.scale);
}

/** Llena el formulario que ya está abierto (los campos no mencionados se dejan como están). */
export async function fillFlete(page: Page, v: FleteInput): Promise<void> {
  if (v.folio !== undefined) await page.getByTestId('fl-folio').fill(v.folio);
  if (v.origin !== undefined) await page.getByTestId('fl-origin').fill(v.origin);
  if (v.destination !== undefined) await page.getByTestId('fl-destination').fill(v.destination);
  if (v.initial) await fillSide(page, 'fl-i', v.initial);
  if (v.final) await fillSide(page, 'fl-f', v.final);
  if (v.notes !== undefined) await page.getByTestId('fl-notes').fill(v.notes);
}

/** Abre «Nuevo flete», lo llena y lo guarda. Devuelve tras ver el aviso de guardado. */
export async function saveFlete(page: Page, v: FleteInput): Promise<void> {
  await page.getByTestId('fl-new').click();
  await expect(page.getByTestId('fl-form')).toBeVisible();
  await fillFlete(page, v);
  await page.getByTestId('fl-save').click();
  await expect(page.getByTestId('toast')).toContainText('guardado');
  await expect(page.getByTestId('fl-form')).toHaveCount(0);
}

export const row = (page: Page, folio: string) => page.locator(`[data-testid="fl-row"][data-folio="${folio}"]`);
