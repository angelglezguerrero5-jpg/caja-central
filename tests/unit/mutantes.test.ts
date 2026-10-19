/**
 * Pruebas añadidas por la revisión de MUTANTES (cada una mata un cambio defectuoso del código que SOBREVIVIÓ a todas las
 * pruebas automáticas anteriores, unitarias y E2E). Cada bloque dice qué mutante mata y cómo se reproduce ese mutante.
 *
 *  - M11 (y sus variantes M11a / M11b): el campo `day` de una recepción se calculaba en UTC en vez de en la hora local del
 *    negocio. Las pruebas anteriores no lo veían porque (1) Vitest corre aquí en UTC, donde día local = día UTC, y (2) las E2E
 *    fijan el reloj a las 12:00 / 14:00 de la Ciudad de México, donde también coinciden. Sólo difieren entre las 18:00 y las
 *    23:59 hora local, justo cuando llegan camiones a la Central de Abasto: esa recepción caería en el día SIGUIENTE del
 *    Resumen, del filtro por día y del cuadre.
 *      Reproducir M11a: src/db/receptions.ts, build(): `day: localDay(new Date(receivedAt))`
 *                       → `day: new Date(receivedAt).toISOString().slice(0, 10)`
 *      Reproducir M11b: src/db/receptions.ts, annotateReception(): `next.day = localDay(new Date(t))`
 *                       → `next.day = new Date(t).toISOString().slice(0, 10)`
 *  - M4a: `computeNet` en modo «directo» sumaba envases × peso por envase al neto capturado (los modos son EXCLUYENTES).
 *    En la app real `normalizeFields` descarta los campos de otros modos antes de calcular, así que ningún camino de la
 *    interfaz lo expone; la regla (§3.1 del diseño) debe quedar fijada también en la propia función.
 *      Reproducir M4a: src/domain/reception.ts, `case 'directo'`: `return { ok: true, netMilli: f.netDirectMilli }`
 *                      → `... netMilli: f.netDirectMilli + (isInt(f.containers) && isInt(f.unitNetMilli) ? f.containers * f.unitNetMilli : 0)`
 */
import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { annotateReception, confirmReception, listReceptions, saveReceptionDraft } from '../../src/db/receptions';
import { newId, openDatabase, saveProduct, type DB } from '../../src/db/repo';
import { computeNet } from '../../src/domain/reception';
import { localDay } from '../../src/domain/report';
import type { Product } from '../../src/domain/types';

// La zona horaria del negocio (Central de Abasto, CDMX: UTC−6; las fechas de estas pruebas son de enero, fuera de cualquier horario
// de verano, para no depender de la versión de la base de zonas horarias). Se fija ANTES de crear ninguna fecha
// y se restaura al terminar. Si el entorno no respetara TZ, la primera prueba falla en voz alta (no se salta en silencio).
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Mexico_City';
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const kg = (n: number) => Math.round(n * 1000);

describe('M11 · el día (day) de una recepción es el día LOCAL del negocio, no el día UTC', () => {
  let db: DB;
  let p: Product;
  beforeEach(async () => {
    db = await openDatabase(`mutantes-${newId()}`);
    p = await saveProduct(db, { name: 'Sin semilla', quality: 'Primera', caliber: '2X', unit: 'kg', priceCents: 3000, active: true });
  });
  afterEach(() => db.close());

  const direct = (n: number, extra: Record<string, unknown> = {}) => ({
    id: newId(), productId: p.id, packaging: 'granel' as const, weightMode: 'directo' as const, netDirectMilli: kg(n), ...extra,
  });

  it('precondición: la prueba corre en hora de la Ciudad de México (21:30 del 15-ene allá = 03:30 UTC del 16-ene)', () => {
    const d = new Date('2026-01-16T03:30:00.000Z');
    expect(d.getTimezoneOffset(), 'el entorno no respetó TZ=America/Mexico_City: esta prueba no probaría nada').toBe(360);
    expect(localDay(d)).toBe('2026-01-15');
    expect(d.toISOString().slice(0, 10)).toBe('2026-01-16'); // el día UTC es OTRO: justo lo que no debe usarse
  });

  it('M11a · confirmar una llegada de las 21:30 hora local la deja en el día local (15-ene), no en el 16-ene UTC', async () => {
    const receivedAt = '2026-01-16T03:30:00.000Z';
    const r = await confirmReception(db, direct(100, { receivedAt }), { at: new Date('2026-01-16T04:00:00.000Z') });
    expect(r.receivedAt).toBe(receivedAt);
    expect(r.day).toBe('2026-01-15');
    expect(r.day).toBe(localDay(new Date(r.receivedAt)));
    // Y lo que depende de `day` (filtro por día del historial / Resumen) también la ve en el día local.
    expect((await listReceptions(db, { day: '2026-01-15' })).map((x) => x.id)).toEqual([r.id]);
    expect(await listReceptions(db, { day: '2026-01-16' })).toHaveLength(0);
    expect((await listReceptions(db, { from: '2026-01-15', to: '2026-01-15' })).map((x) => x.id)).toEqual([r.id]);
  });

  it('M11a · también un borrador guarda el día local', async () => {
    const d = await saveReceptionDraft(db, direct(50, { receivedAt: '2026-01-16T03:30:00.000Z' }), { at: new Date('2026-01-16T04:00:00.000Z') });
    expect(d.status).toBe('borrador');
    expect(d.day).toBe('2026-01-15');
  });

  it('M11a · el límite exacto de la medianoche local: 23:59:59.999 sigue en el 15-ene y 00:00:00.000 ya es el 16-ene', async () => {
    const at = new Date('2026-01-16T09:00:00.000Z');
    const antes = await confirmReception(db, direct(10, { receivedAt: '2026-01-16T05:59:59.999Z' }), { at });
    const despues = await confirmReception(db, direct(20, { receivedAt: '2026-01-16T06:00:00.000Z' }), { at });
    expect(antes.day).toBe('2026-01-15');
    expect(despues.day).toBe('2026-01-16');
    // Control: de madrugada (02:30 local) el día local y el UTC coinciden, así que esto no depende del arreglo.
    const madrugada = await confirmReception(db, direct(30, { receivedAt: '2026-01-16T08:30:00.000Z' }), { at });
    expect(madrugada.day).toBe('2026-01-16');
  });

  it('M11b · corregir la fecha de llegada a una hora de la noche también reasigna el día LOCAL', async () => {
    const r = await confirmReception(db, direct(100, { receivedAt: '2026-01-14T18:00:00.000Z' }), { at: new Date('2026-01-14T19:00:00.000Z') });
    expect(r.day).toBe('2026-01-14'); // 12:00 local
    const at = new Date('2026-01-16T04:00:00.000Z');
    const fixed = await annotateReception(db, r.id, { receivedAt: '2026-01-16T03:30:00.000Z' }, 'se capturó la fecha mal', { at });
    expect(fixed.receivedAt).toBe('2026-01-16T03:30:00.000Z');
    expect(fixed.day).toBe('2026-01-15');
    expect((await listReceptions(db, { day: '2026-01-15' })).map((x) => x.id)).toEqual([r.id]);
    expect(await listReceptions(db, { day: '2026-01-16' })).toHaveLength(0);
  });
});

describe('M4a · computeNet: los tres modos de peso son excluyentes, también en la propia función', () => {
  // Campos "sobrantes" de otros modos, como los que dejaría un cambio de modo sin normalizar.
  const sobrantes = { packaging: 'caja' as const, containers: 10, unitNetMilli: kg(12.5), netDirectMilli: kg(100), grossMilli: kg(520), tareMilli: kg(20) };

  it('directo: el neto es SOLO lo capturado; envases × peso por envase no se suma', () => {
    expect(computeNet({ ...sobrantes, weightMode: 'directo' })).toEqual({ ok: true, netMilli: kg(100) });
  });

  it('por_envase: el neto es SOLO envases × peso por envase; el neto directo no se suma', () => {
    expect(computeNet({ ...sobrantes, weightMode: 'por_envase' })).toEqual({ ok: true, netMilli: kg(125) });
  });

  it('bruto_tara: el neto es SOLO bruto − tara; ni el neto directo ni envases × peso se suman', () => {
    expect(computeNet({ ...sobrantes, weightMode: 'bruto_tara' })).toEqual({ ok: true, netMilli: kg(500) });
  });
});
