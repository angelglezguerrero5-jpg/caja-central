import { useEffect, useState } from 'preact/hooks';
import { auditData, auditDatabase, type AuditResult } from '../db/audit';
import { exportBackup, importBackup, validateBackup } from '../db/repo';
import { errMsg, useApp } from './ctx';
import { Historial } from './Historial';

export function Mas() {
  const { db, bump, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<AuditResult | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [quota, setQuota] = useState('');

  useEffect(() => {
    navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
    navigator.storage?.estimate?.().then((e) => {
      if (e.usage !== undefined && e.quota) setQuota(`${(e.usage / 1024).toFixed(0)} KB de ${(e.quota / 1048576).toFixed(0)} MB`);
    }).catch(() => undefined);
  }, []);

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
      const open = b.shifts.find((s) => !s.closedAt);
      const found = auditData(b, open?.id).issues;
      const ok = window.confirm(
        `Esto REEMPLAZARÁ todos los datos actuales por el respaldo (${b.sales.length} ventas, ${b.products.length} variedades).` +
          (found.length ? `\n\n⚠ El respaldo tiene ${found.length} inconsistencia(s) internas (por ejemplo: ${found[0]}).` : '') +
          '\n\n¿Continuar?',
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
      <Historial />
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
      <h2>Estado de los datos</h2>
      <p class="hint" data-testid="storage-state">
        Almacenamiento:{' '}
        {persisted === null ? 'no se pudo consultar' : persisted ? 'persistente (Android no lo borrará solo)' : 'NO persistente: puede ser borrado si falta espacio'}
        {quota && ` · en uso ${quota}`}
      </p>
      <button
        data-testid="audit"
        onClick={async () => {
          try {
            setAudit(await auditDatabase(db));
          } catch (e) {
            toast(errMsg(e), 'error');
          }
        }}
      >
        Auditar integridad
      </button>
      {audit && (
        <div data-testid="audit-result" class={audit.ok ? 'ok' : 'warn'}>
          {audit.ok
            ? `✔ Sin inconsistencias (${audit.stats.sales} ventas, ${audit.stats.vales} vales, ${audit.stats.stockMoves} movimientos)`
            : `✖ ${audit.issues.length} problema(s):`}
          {!audit.ok && <ul>{audit.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
        </div>
      )}
      <p class="hint">Versión 0.1.0 · MVP</p>
    </section>
  );
}
