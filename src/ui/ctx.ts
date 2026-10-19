import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { DB } from '../db/repo';

export interface AppCtx {
  db: DB;
  /** Cambia cada vez que se modifican datos; las pantallas recargan con él. */
  version: number;
  bump: () => void;
  toast: (msg: string, kind?: 'ok' | 'error') => void;
}

export const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('Ctx no disponible');
  return c;
}

export function errMsg(e: unknown): string {
  const name = (e as { name?: string } | null)?.name;
  if (name === 'QuotaExceededError') {
    return 'Almacenamiento lleno: el registro NO se guardó. Exporta un respaldo y libera espacio.';
  }
  if (name === 'InvalidStateError' || name === 'UnknownError') {
    return 'No se pudo escribir en la base de datos del teléfono. Cierra y vuelve a abrir la app.';
  }
  if (name === 'VersionError') {
    return (
      'Los datos del teléfono son de una versión MÁS NUEVA que esta copia de la app. No se borró nada: ' +
      'cierra la app por completo y ábrela con internet para que se actualice.'
    );
  }
  return e instanceof Error ? e.message : String(e);
}
