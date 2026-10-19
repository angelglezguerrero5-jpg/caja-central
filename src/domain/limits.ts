/**
 * Límites de texto libre. TODO lo que se puede escribir en la app debe poder restaurarse desde un respaldo
 * (validateBackup rechaza textos de más de 2000 caracteres), así que cada ruta de escritura usa estos topes.
 * Los textos derivados (p. ej. "Corrección R-12: <motivo>") suman prefijos cortos y quedan muy por debajo de 2000.
 */
export const MAX_REASON = 300; // motivos de anulación, corrección, cancelación, merma y conteo
export const MAX_NOTE = 500; // observaciones de una recepción
export const MAX_NAME = 120; // proveedor, cliente
export const MAX_CONCEPT = 120; // concepto de una salida de efectivo

const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** NFC, espacios (y saltos de línea) colapsados y recortado. */
export const normalizeText = (s: string | undefined | null): string => (s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

/**
 * Texto limpio listo para guardar, o un Error con un mensaje claro si trae caracteres invisibles/de control o se pasa
 * del largo permitido. `label` es el nombre del campo para el mensaje ("Motivo", "Cliente"...).
 */
export function checkedText(raw: string | undefined | null, label: string, max: number): string {
  const t = normalizeText(raw);
  if (FORBIDDEN.test(t)) throw new Error(`${label}: contiene caracteres no permitidos`);
  if (t.length > max) throw new Error(`${label}: máximo ${max} caracteres (llevas ${t.length})`);
  return t;
}
