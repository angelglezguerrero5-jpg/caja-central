import { BRAND } from '../brand';
import { openDB } from 'idb';
import type { Backup } from '../domain/types';
import { newId } from './repo';

/**
 * Copias INTERNAS de seguridad previas a una restauración. Restaurar un respaldo REEMPLAZA todo lo que hay en el
 * teléfono; antes de hacerlo se guarda aquí el estado actual (en una base aparte, las últimas 3) para poder
 * «deshacer» si se eligió el archivo equivocado. No sustituye a exportar respaldos: vive en el mismo teléfono y se
 * borra si se borran los datos de la app.
 */
export const UNDO_DB = `${BRAND.id}-undo`;
const KEEP = 3;

export interface UndoInfo {
  id: string;
  at: string;
  reason: string;
  sales: number;
  receptions: number;
  products: number;
  moves: number;
}
interface UndoRow extends UndoInfo {
  /**
   * Orden en que se guardaron (1, 2, 3...). Decide cuál es «la más reciente» y cuál se descarta: la hora del teléfono no sirve
   * para eso, porque puede repetirse, quedar congelada o retroceder (un reloj mal puesto que luego se corrige). Las copias
   * guardadas por versiones anteriores no lo traen: cuentan como 0 y entre ellas se ordenan por fecha.
   */
  seq?: number;
  backup: Backup;
}

const open = (name: string) =>
  openDB(name, 1, {
    upgrade(db) {
      db.createObjectStore('snapshots', { keyPath: 'id' });
    },
  });

/** De la más vieja a la más reciente. */
const oldestFirst = (a: UndoRow, b: UndoRow) => (a.seq ?? 0) - (b.seq ?? 0) || a.at.localeCompare(b.at);

const toInfo = ({ backup: _backup, seq: _seq, ...info }: UndoRow): UndoInfo => info;

export async function saveUndoSnapshot(backup: Backup, reason: string, name = UNDO_DB): Promise<UndoInfo> {
  const db = await open(name);
  try {
    const tx = db.transaction('snapshots', 'readwrite');
    const existing = (await tx.store.getAll()) as UndoRow[];
    const row: UndoRow = {
      id: newId(),
      at: new Date().toISOString(),
      seq: existing.reduce((max, r) => Math.max(max, r.seq ?? 0), 0) + 1,
      reason: reason.slice(0, 300),
      sales: backup.sales.length,
      receptions: backup.receptions.length,
      products: backup.products.length,
      moves: backup.stockMoves.length,
      backup,
    };
    await tx.store.put(row);
    const all = [...existing, row].sort(oldestFirst);
    for (const old of all.slice(0, Math.max(0, all.length - KEEP))) await tx.store.delete(old.id);
    await tx.done;
    return toInfo(row);
  } finally {
    db.close();
  }
}

/** Más reciente primero, sin el contenido (solo para mostrar). */
export async function listUndoSnapshots(name = UNDO_DB): Promise<UndoInfo[]> {
  const db = await open(name);
  try {
    const all = (await db.getAll('snapshots')) as UndoRow[];
    return all.sort((a, b) => oldestFirst(b, a)).map(toInfo);
  } finally {
    db.close();
  }
}

export async function loadUndoSnapshot(id: string, name = UNDO_DB): Promise<Backup | undefined> {
  const db = await open(name);
  try {
    return ((await db.get('snapshots', id)) as UndoRow | undefined)?.backup;
  } finally {
    db.close();
  }
}
