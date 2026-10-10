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
  return e instanceof Error ? e.message : String(e);
}
