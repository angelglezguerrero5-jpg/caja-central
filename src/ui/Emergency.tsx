import { useState } from 'preact/hooks';
import { dumpRawDatabase } from '../db/emergency';
import { errMsg } from './ctx';
import { downloadJson } from './format';

/**
 * Salida de emergencia: descarga TODO lo que haya en la base del teléfono (lectura cruda, sin aplicar el esquema de la
 * app). Se ofrece cuando la app no puede abrir la base o se rompió una pantalla.
 */
export function EmergencyDump() {
  const [msg, setMsg] = useState('');
  async function run() {
    try {
      const dump = await dumpRawDatabase();
      downloadJson(dump, `emergencia-limones-${new Date().toISOString().slice(0, 10)}.json`);
      const n = Object.values(dump.stores).reduce((s, rows) => s + rows.length, 0);
      setMsg(`Listo: se descargó una copia con ${n} registros. Guárdala en un lugar seguro antes de hacer cualquier otra cosa.`);
    } catch (e) {
      setMsg(`No se pudo leer la base: ${errMsg(e)}`);
    }
  }
  return (
    <>
      <button class="primary" data-testid="emergency-dump" onClick={run}>
        Descargar copia de emergencia de mis datos
      </button>
      {msg && (
        <p class="hint" data-testid="emergency-result" role="status">
          {msg}
        </p>
      )}
    </>
  );
}
