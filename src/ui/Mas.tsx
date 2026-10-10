import { useState } from 'preact/hooks';
import { exportBackup, importBackup, validateBackup } from '../db/repo';
import { errMsg, useApp } from './ctx';

export function Mas() {
  const { db, bump, toast } = useApp();
  const [busy, setBusy] = useState(false);

  async function download() {
    try {
      const data = await exportBackup(db);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `respaldo-limones-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(`Respaldo exportado (${data.sales.length} ventas)`);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }

  async function restore(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const data = JSON.parse(await file.text());
      const b = validateBackup(data); // valida antes de pedir confirmación
      const ok = window.confirm(
        `Esto REEMPLAZARÁ todos los datos actuales por el respaldo (${b.sales.length} ventas, ${b.products.length} variedades). ¿Continuar?`,
      );
      if (!ok) return;
      await importBackup(db, b);
      toast('Respaldo restaurado');
      bump();
    } catch (e) {
      toast(e instanceof SyntaxError ? 'El archivo no es JSON válido' : errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="mas">
      <h2>Respaldo</h2>
      <p class="hint">Los datos viven solo en este teléfono. Exporta un respaldo seguido y guárdalo fuera del equipo.</p>
      <button class="primary" data-testid="export" onClick={download}>
        Exportar respaldo
      </button>
      <label class="file">
        <span>Restaurar desde archivo</span>
        <input
          type="file"
          accept="application/json,.json"
          data-testid="import-file"
          disabled={busy}
          onChange={(e) => {
            const input = e.target as HTMLInputElement;
            restore(input.files?.[0]).finally(() => (input.value = ''));
          }}
        />
      </label>
      <p class="hint">Versión 0.1.0 · MVP</p>
    </section>
  );
}
