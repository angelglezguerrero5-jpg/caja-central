import { useEffect, useState } from 'preact/hooks';
import { auditData, auditDatabase, type AuditResult } from '../db/audit';
import { listUndoSnapshots, loadUndoSnapshot, saveUndoSnapshot, type UndoInfo } from '../db/undo';
import { exportBackup, importBackup, validateBackup } from '../db/repo';
import type { Backup } from '../domain/types';
import { errMsg, useApp } from './ctx';
import { downloadJson, fmtDateTime, toLocalInput } from './format';
import { Historial } from './Historial';
import { InstallSheet } from './Instalar';
import { isIOS, isStandalone } from './platform';
import { Sheet } from './Sheet';

export const APP_VERSION = '0.3.0';
const LS_LAST_BACKUP = 'limones.lastBackupAt';
/** Un respaldo de esta app pesa unos cuantos MB como mucho; algo mayor no es un respaldo (y podría tumbar el teléfono al leerlo). */
const MAX_BACKUP_BYTES = 25 * 1024 * 1024;

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* solo se pierde el recordatorio */
  }
}

/** "hoy", "ayer", "hace 5 días" o 'nunca'. */
export function backupAgeText(iso: string | null, now = Date.now()): { text: string; days: number | null } {
  if (!iso || Number.isNaN(Date.parse(iso))) return { text: 'nunca', days: null };
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  return { text: days <= 0 ? 'hoy' : days === 1 ? 'ayer' : `hace ${days} días`, days: Math.max(days, 0) };
}

/** Nombre del archivo con la fecha y hora LOCALES: respaldo-limones-2026-10-10-1730.json */
export const backupFileName = (d = new Date()) => `respaldo-limones-${toLocalInput(d).replace('T', '-').replace(':', '')}.json`;

interface Pending {
  kind: 'file' | 'undo';
  fileVersion: number;
  backup: Backup;
  audit: AuditResult;
  current: Backup;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Cuánto de lo que hay HOY en el teléfono es posterior al respaldo (y por tanto se perdería al restaurarlo). */
function lostAfter(current: Backup, exportedAt: string) {
  const t = Date.parse(exportedAt);
  if (Number.isNaN(t)) return null;
  const later = (iso: string) => Date.parse(iso) > t;
  return {
    sales: current.sales.filter((s) => later(s.createdAt)).length,
    receptions: current.receptions.filter((r) => later(r.confirmedAt ?? r.createdAt)).length,
    moves: current.stockMoves.filter((m) => later(m.createdAt)).length,
    freights: current.freights.filter((f) => later(f.createdAt)).length,
  };
}

export function Mas() {
  const { db, version, bump, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<AuditResult | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [quota, setQuota] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [lastBackup, setLastBackup] = useState<string | null>(lsGet(LS_LAST_BACKUP));
  const [hasData, setHasData] = useState(false);
  const [undos, setUndos] = useState<UndoInfo[]>([]);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
  const ios = isIOS();
  const standalone = isStandalone();
  const [installHelp, setInstallHelp] = useState(false);
  // Respaldo ya armado para compartir: el iPhone solo abre «Compartir» si se pide en el MISMO toque, sin esperar a leer la base.
  const [prepared, setPrepared] = useState<{ file: File; version: number } | null>(null);

  useEffect(() => {
    if (!canShare) return;
    let alive = true;
    exportBackup(db)
      .then((data) => {
        if (alive) setPrepared({ file: new File([JSON.stringify(data, null, 2)], backupFileName(), { type: 'application/json' }), version });
      })
      .catch(() => alive && setPrepared(null));
    return () => {
      alive = false;
    };
  }, [db, version, canShare]);

  useEffect(() => {
    navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
    navigator.storage?.estimate?.().then((e) => {
      if (e.usage !== undefined && e.quota) setQuota(`${(e.usage / 1024).toFixed(0)} KB de ${(e.quota / 1048576).toFixed(0)} MB`);
    }).catch(() => undefined);
    listUndoSnapshots().then(setUndos).catch(() => undefined);
  }, [db]);

  // ¿Hay algo que respaldar? (para decidir si el recordatorio importa). Se recalcula cuando cambian los datos: esta sección
  // sigue montada al cambiar de pestaña, y tras restaurar o vender el recordatorio quedaría viejo.
  useEffect(() => {
    Promise.all([db.count('sales'), db.count('receptions')])
      .then(([s, r]) => setHasData(s + r > 0))
      .catch(() => undefined);
  }, [db, version]);

  function markBackup() {
    const iso = new Date().toISOString();
    lsSet(LS_LAST_BACKUP, iso);
    setLastBackup(iso);
  }

  async function download(): Promise<boolean> {
    try {
      const data = await exportBackup(db);
      downloadJson(data, backupFileName());
      markBackup();
      toast(`Respaldo exportado (${count(data.sales.length, 'venta', 'ventas')}, ${count(data.receptions.length, 'recepción', 'recepciones')})`);
      return true;
    } catch (e) {
      toast(errMsg(e), 'error');
      return false;
    }
  }

  /** Compartir (WhatsApp, Drive, correo, Archivos del iPhone...) sin pasar por la carpeta de descargas. Si el teléfono no lo permite, se descarga. */
  async function share() {
    try {
      // Con el archivo ya preparado (y vigente: no cambió nada desde entonces) se pide «Compartir» sin esperar; si todavía
      // no está listo se arma ahora (Android lo admite; el iPhone, si lo rechaza, cae a la descarga de abajo).
      const ready = prepared && prepared.version === version ? prepared.file : null;
      const file = ready ?? new File([JSON.stringify(await exportBackup(db), null, 2)], backupFileName(), { type: 'application/json' });
      if (!navigator.canShare({ files: [file] })) return void (await download());
      await navigator.share({ files: [file], title: 'Respaldo de Venta de Limones' });
      markBackup();
      toast('Respaldo compartido');
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return; // la persona canceló
      await download();
    }
  }

  async function prepare(backup: Backup, fileVersion: number, kind: Pending['kind']) {
    const open = backup.shifts.find((s) => !s.closedAt);
    setUnderstood(false);
    setPending({ kind, fileVersion, backup, audit: auditData(backup, open?.id), current: await exportBackup(db) });
  }

  async function restore(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new Error('El archivo es demasiado grande para ser un respaldo de esta app (más de 25 MB).');
      const data = JSON.parse(await file.text());
      const fileVersion = typeof data?.version === 'number' ? data.version : 0;
      const backup = validateBackup(data); // valida ANTES de mostrar nada: un archivo dañado no llega a la hoja
      await prepare(backup, fileVersion, 'file');
    } catch (e) {
      toast(e instanceof SyntaxError ? 'El archivo no es JSON válido' : errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function undoLast() {
    setBusy(true);
    try {
      // La más reciente se lee AHORA de la base interna, no de lo que se pintó hace rato: si el aviso aún no se actualizó tras
      // una restauración, «Deshacer» no puede volver a un estado más viejo que el que la persona espera.
      const latest = (await listUndoSnapshots())[0] ?? undos[0];
      if (!latest) return;
      const snap = await loadUndoSnapshot(latest.id);
      if (!snap) throw new Error('Esa copia interna ya no existe');
      await prepare(validateBackup(JSON.parse(JSON.stringify(snap))), 3, 'undo'); // la copia interna siempre es del formato actual
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function confirmRestore() {
    if (!pending || busy) return;
    setBusy(true);
    try {
      // Red de seguridad: antes de reemplazar, el estado ACTUAL (leído ahora, no el de hace un rato) queda guardado en una
      // base interna aparte. Si no se puede guardar, NO se restaura.
      const before = await exportBackup(db);
      try {
        await saveUndoSnapshot(before, pending.kind === 'undo' ? 'Antes de deshacer una restauración' : `Antes de restaurar un respaldo del ${fmtDateTime(pending.backup.exportedAt || new Date().toISOString())}`);
      } catch (e) {
        throw new Error(`No se pudo guardar la copia interna de seguridad (${errMsg(e)}). No se restauró nada: exporta tus datos primero.`);
      }
      await importBackup(db, pending.backup);
      setPending(null);
      await listUndoSnapshots().then(setUndos).catch(() => undefined); // antes del aviso: así el botón «Deshacer» ya apunta a la copia nueva
      toast(pending.kind === 'undo' ? 'Restauración deshecha' : 'Respaldo restaurado');
      bump();
    } catch (e) {
      setPending(null);
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const age = backupAgeText(lastBackup);
  const stale = hasData && (age.days === null || age.days >= 7);
  const lost = pending ? lostAfter(pending.current, pending.backup.exportedAt) : null;
  const losesLater = !!lost && lost.sales + lost.receptions + lost.moves + lost.freights > 0;
  const losesReceptions = !!pending && pending.fileVersion < 2 && pending.current.receptions.length > 0;
  // Los fletes llegaron con el formato 3: un respaldo anterior no los trae y restaurarlo vacía los de hoy.
  const losesFreights = !!pending && pending.fileVersion < 3 && pending.current.freights.length > 0;
  const risky = losesLater || losesReceptions || losesFreights || (!!pending && !pending.audit.ok);

  return (
    <section data-testid="mas">
      <Historial />
      <h2>Respaldo</h2>
      <p class="hint">
        Los datos viven solo en este teléfono. Exporta un respaldo seguido y mándalo fuera del equipo (WhatsApp, correo, Drive).
        No borres los datos de la app ni la desinstales sin exportar antes.
      </p>
      <p class={stale ? 'warn' : 'hint'} data-testid="last-backup">
        Último respaldo: {age.text}
        {stale && ' · te conviene exportar uno ahora'}
      </p>
      <button class="primary" data-testid="export" onClick={download}>
        Exportar respaldo
      </button>
      {canShare && (
        <button data-testid="share-backup" data-ready={prepared && prepared.version === version ? 'yes' : 'no'} onClick={share}>
          Compartir respaldo (WhatsApp, correo, Drive…)
        </button>
      )}
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
      {undos.length > 0 && (
        <div class="notice" data-testid="undo-box">
          Antes de cada restauración se guarda aquí una copia de lo que tenías (las últimas {Math.min(undos.length, 3)}). La más
          reciente: {fmtDateTime(undos[0].at)} · {count(undos[0].sales, 'venta', 'ventas')}, {count(undos[0].receptions, 'recepción', 'recepciones')}.{' '}
          <button class="link" data-testid="undo-restore" disabled={busy} onClick={undoLast}>
            Deshacer: volver a ese estado
          </button>
        </div>
      )}
      <h2>Estado de los datos</h2>
      <p class="hint" data-testid="storage-state">
        Almacenamiento:{' '}
        {persisted === null
          ? 'no se pudo consultar'
          : persisted
            ? 'persistente (el sistema no lo borra solo; sí se borra si borras los datos de la app o la desinstalas)'
            : 'NO persistente: puede ser borrado si falta espacio'}
        {persisted !== true && ios && ' · en iPhone instala la app en la pantalla de inicio y haz respaldos seguido'}
        {quota && ` · en uso ${quota}`}
      </p>
      <p class="hint" data-testid="install-state">
        Modo: {standalone ? 'app instalada (abierta desde el ícono de la pantalla de inicio)' : 'navegador'}.
        {ios && !standalone && ' En iPhone los datos de Safari y los de la app instalada son distintos.'}
      </p>
      {ios && !standalone && (
        <button data-testid="install-help-mas" onClick={() => setInstallHelp(true)}>
          Cómo instalarla en el iPhone
        </button>
      )}
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
            ? `✔ Sin inconsistencias (${count(audit.stats.sales, 'venta', 'ventas')}, ${count(audit.stats.vales, 'vale', 'vales')}, ${count(audit.stats.receptions, 'recepción', 'recepciones')}, ${count(audit.stats.stockMoves, 'movimiento', 'movimientos')})`
            : `✖ ${audit.issues.length} problema(s):`}
          {!audit.ok && <ul>{audit.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
          {audit.warnings.length > 0 && (
            <div class="hint" data-testid="audit-warnings">
              Avisos (no son errores, pero conviene revisarlos):
              <ul>{audit.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      <p class="hint" data-testid="app-version">
        Versión {APP_VERSION} · datos con recepción de mercancía y control de pesaje por flete. Después de actualizar, una copia con una versión anterior
        de la app ya no abre estos datos: exporta un respaldo antes de actualizar.
      </p>

      {pending && (
        <Sheet
          title={pending.kind === 'undo' ? 'Deshacer la última restauración' : 'Restaurar respaldo'}
          testid="restore-sheet"
          onClose={busy ? undefined : () => setPending(null)}
          foot={
            <div class="actions two">
              <button data-testid="restore-cancel" disabled={busy} onClick={() => setPending(null)}>
                Cancelar
              </button>
              <button class="danger" data-testid="restore-confirm" disabled={busy || (risky && !understood)} onClick={confirmRestore}>
                {busy ? 'Restaurando…' : pending.kind === 'undo' ? 'Volver a ese estado' : 'Restaurar y reemplazar'}
              </button>
            </div>
          }
        >
          <p class="warn" data-testid="restore-replace">
            Esto REEMPLAZA todo lo que hay ahora en este teléfono. No se mezcla con los datos actuales. Los folios que ya se
            emitieron no se repiten.
          </p>
          <p data-testid="restore-summary">
            <strong>{pending.kind === 'undo' ? 'La copia interna trae' : 'El respaldo trae'}</strong>
            {pending.backup.exportedAt && ` (guardada ${fmtDateTime(pending.backup.exportedAt)})`}:{' '}
            {count(pending.backup.sales.length, 'venta', 'ventas')}, {count(pending.backup.receptions.length, 'recepción', 'recepciones')},{' '}
            {count(pending.backup.products.length, 'variedad', 'variedades')}, {count(pending.backup.stockMoves.length, 'movimiento de inventario', 'movimientos de inventario')}
            {pending.backup.freights.length > 0 && `, ${count(pending.backup.freights.length, 'flete', 'fletes')}`}.
          </p>
          <p data-testid="restore-current">
            <strong>Hoy tienes</strong>: {count(pending.current.sales.length, 'venta', 'ventas')},{' '}
            {count(pending.current.receptions.length, 'recepción', 'recepciones')}, {count(pending.current.products.length, 'variedad', 'variedades')},{' '}
            {count(pending.current.stockMoves.length, 'movimiento de inventario', 'movimientos de inventario')}
            {pending.current.freights.length > 0 && `, ${count(pending.current.freights.length, 'flete', 'fletes')}`}.
          </p>
          {losesLater && lost && (
            <p class="warn" role="alert" data-testid="restore-loss">
              ⚠ Se perderá lo que capturaste DESPUÉS de ese momento: {count(lost.sales, 'venta', 'ventas')}, {count(lost.receptions, 'recepción', 'recepciones')} y{' '}
              {count(lost.moves, 'movimiento de inventario', 'movimientos de inventario')}
              {lost.freights > 0 && `, además de ${count(lost.freights, 'flete', 'fletes')}`}.
            </p>
          )}
          {losesFreights && (
            <p class="warn" role="alert" data-testid="restore-loss-freights">
              ⚠ Este respaldo es de una versión anterior y no trae fletes:{' '}
              {pending.current.freights.length === 1
                ? 'el flete que tienes hoy se perderá.'
                : `los ${pending.current.freights.length} fletes que tienes hoy se perderán.`}
            </p>
          )}
          {losesReceptions && (
            <p class="warn" role="alert" data-testid="restore-loss-receptions">
              ⚠ Este respaldo es de una versión anterior y no trae recepciones:{' '}
              {pending.current.receptions.length === 1
                ? 'la recepción de hoy se perderá.'
                : `las ${pending.current.receptions.length} recepciones de hoy se perderán.`}
            </p>
          )}
          {!pending.audit.ok && (
            <p class="warn" data-testid="restore-audit">
              ⚠ El respaldo tiene {count(pending.audit.issues.length, 'inconsistencia interna', 'inconsistencias internas')} (por ejemplo: {pending.audit.issues[0]}).
            </p>
          )}
          {pending.audit.warnings.length > 0 && (
            <p class="hint" data-testid="restore-warnings">
              Avisos del respaldo (no impiden restaurarlo): {pending.audit.warnings[0]}
              {pending.audit.warnings.length > 1 &&
                ` (y ${pending.audit.warnings.length - 1} ${pending.audit.warnings.length === 2 ? 'aviso más' : 'avisos más'}: se ven en «Auditar integridad»)`}
            </p>
          )}
          <p class="hint">
            Antes de reemplazar, la app guarda sola una copia de lo que tienes hoy, y puedes <strong>deshacer</strong> desde aquí. Aun así,
            te conviene exportarla:
          </p>
          <div class="actions">
            <button data-testid="restore-export-first" onClick={download}>
              Exportar lo que tengo hoy
            </button>
          </div>
          {risky && (
            <label class="check" data-testid="restore-understood-box">
              <input type="checkbox" data-testid="restore-understood" checked={understood} onChange={(e) => setUnderstood((e.target as HTMLInputElement).checked)} />
              Entiendo lo que se perderá y quiero continuar
            </label>
          )}
        </Sheet>
      )}
      {installHelp && <InstallSheet onClose={() => setInstallHelp(false)} />}
    </section>
  );
}
