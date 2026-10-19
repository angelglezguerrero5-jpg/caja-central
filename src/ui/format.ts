import { localDay } from '../domain/report';

/** Milésimas (enteras) → texto para un campo numérico, sin ceros sobrantes: 15500 → "15.5". */
export function milliToText(n: number | undefined): string {
  if (n === undefined) return '';
  return String(n / 1000);
}

/** Fecha → valor de <input type="datetime-local"> en hora local: "2026-10-10T08:30". */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Valor de datetime-local → ISO. '' → undefined (el repositorio usa "ahora"); ilegible → 'invalid' (se reporta como error). */
export function localInputToIso(text: string): string | undefined {
  if (!text.trim()) return undefined;
  const t = new Date(text).getTime();
  return Number.isNaN(t) ? 'invalid' : new Date(t).toISOString();
}

export const fmtDateTime = (iso: string): string =>
  new Date(iso).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** "vie, 10 oct" para un día YYYY-MM-DD. */
export const fmtDay = (day: string): string =>
  new Date(`${day}T12:00:00`).toLocaleDateString('es-MX', { weekday: 'short', day: '2-digit', month: 'short' });

/** Suma días a un día local YYYY-MM-DD (usa el mediodía para no tropezar con cambios de horario). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDay(d);
}

/** "Hoy", "Ayer" o la fecha corta; para decirle al usuario en qué día quedará algo. */
export function dayLabel(day: string, today = localDay()): string {
  if (day === today) return 'hoy';
  if (day === addDays(today, -1)) return 'ayer';
  return fmtDay(day);
}

/** Hace cuántos días (calendario local) ocurrió algo; 0 = hoy. */
export function calendarDaysAgo(iso: string, today = localDay()): number {
  const a = new Date(`${localDay(new Date(iso))}T12:00:00`).getTime();
  const b = new Date(`${today}T12:00:00`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** Descarga un JSON con el nombre dado (respaldo, copia de emergencia). */
export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
