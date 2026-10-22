/**
 * Identidad de la app en UN solo lugar. Para el nombre comercial definitivo se cambia aquí (y en index.html /
 * public/manifest.webmanifest, que son archivos estáticos). `id` es la base de los nombres internos: base de datos,
 * respaldo, caché del service worker y claves de almacenamiento. No cambiarlo después de entregar la app: cambiaría
 * dónde se guardan los datos de quienes ya la usan.
 */
export const BRAND = {
  name: 'Caja Central',
  short: 'Caja',
  description: 'Caja, entradas e inventario para vendedores de la Central de Abasto',
  id: 'caja-central',
  /** Prefijo de localStorage y de eventos del navegador. */
  ns: 'cc',
} as const;
