import { DB_NAME } from './repo';

/**
 * Copia de EMERGENCIA: lee todo lo que haya en la base del teléfono con IndexedDB "a pelo", sin aplicar el esquema de
 * la app y sin importar su versión. Sirve cuando la app no puede abrir la base (una actualización que falló, una
 * versión más nueva de los datos...) para sacar los datos antes de intentar cualquier arreglo.
 *
 * Solo LEE: no escribe, no borra, no sube la versión y nunca crea una base que no exista.
 * El formato (stores crudos) NO es el del respaldo normal: es para recuperación asistida.
 */
export interface RawDump {
  app: 'sistema-venta-limones';
  kind: 'emergency-raw-dump';
  exportedAt: string;
  database: string;
  version: number;
  stores: Record<string, unknown[]>;
}

export class NoDatabaseError extends Error {
  constructor() {
    super('No hay ninguna base de datos de la app en este teléfono.');
  }
}

export function dumpRawDatabase(name = DB_NAME): Promise<RawDump> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(name); // sin versión: abre la que haya, sin actualizar nada
    } catch (e) {
      return reject(e);
    }
    let missing = false;
    req.onupgradeneeded = () => {
      // Solo ocurre si la base NO existía (versión 0): se aborta para no crear una vacía.
      missing = true;
      try {
        req.transaction?.abort();
      } catch {
        /* ya abortada */
      }
    };
    req.onerror = () => reject(missing ? new NoDatabaseError() : req.error);
    req.onblocked = () => reject(new Error('La base está en uso por otra ventana de la app: ciérrala e inténtalo de nuevo.'));
    req.onsuccess = () => {
      const db = req.result;
      try {
        const names = [...db.objectStoreNames];
        const stores: Record<string, unknown[]> = {};
        if (names.length === 0) {
          db.close();
          return resolve({ app: 'sistema-venta-limones', kind: 'emergency-raw-dump', exportedAt: new Date().toISOString(), database: name, version: db.version, stores });
        }
        const tx = db.transaction(names, 'readonly');
        let pending = names.length;
        for (const n of names) {
          const all = tx.objectStore(n).getAll();
          all.onsuccess = () => {
            stores[n] = all.result as unknown[];
            if (--pending === 0) {
              db.close();
              resolve({ app: 'sistema-venta-limones', kind: 'emergency-raw-dump', exportedAt: new Date().toISOString(), database: name, version: db.version, stores });
            }
          };
          all.onerror = () => {
            db.close();
            reject(all.error);
          };
        }
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      } catch (e) {
        db.close();
        reject(e);
      }
    };
  });
}
