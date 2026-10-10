# Sistema de Venta de Limones

PWA offline-first de **caja rápida** para un puesto de limones (Central de Abasto, CDMX), pensada para Android.
Todo se guarda en IndexedDB del propio teléfono; no hay servidor ni cuentas.

## Qué hace

- **Caja rápida**: variedad → calidad/calibre (opcional) → kilos → precio por kg editable (se conserva por
  variedad/calidad) → billetes ($20–$1,000, acumulables), "Exacto", total y cambio → **hoja de confirmación**
  antes de registrar. Tras cobrar: se limpian kilos y efectivo, se conservan variedad y precio, y el foco
  vuelve a *Kilos*.
- **Ventas** con id único, fecha/hora, folio consecutivo y prevención de duplicados (doble pulsación/reintento).
  Guardan el precio con que se vendieron.
- **Vales pagados** (mercancía pagada por adelantado, *no* fiado): un solo ingreso al venderse, folio propio
  `V-n`, reservan kilos. Estados PENDIENTE → ENTREGADO, o CANCELADO (motivo obligatorio y decisión explícita:
  devuelto en efectivo / por transferencia / sin devolución). Entregar no cobra otra vez; no se canjea dos veces.
- **Inventario** por variedad/calidad: físico, reservado y disponible. Entradas, mermas y conteos (con motivo),
  historial de movimientos. Vender más que el disponible exige autorización explícita y queda marcado.
- **Corte de caja**: fondo inicial, entregadas vs vales, forma de pago, salidas con motivo, devoluciones,
  efectivo esperado vs contado, diferencia, cortes anteriores. El cambio no es gasto.
- **Historial** por día, **respaldo** exportar/restaurar (valida antes de reemplazar) y **auditoría de integridad**
  (Más → Auditar integridad).
- **Offline**: service worker con precache generado en cada build; esquema IndexedDB versionado con migraciones.

Dinero en centavos enteros y cantidades en milésimas: sin errores de flotante.
Efectivo esperado = fondo + ventas en efectivo − salidas − devoluciones en efectivo.

## Comandos

```bash
npm install
npm run dev            # desarrollo (sin service worker)
npm run build          # tsc + build de producción (incluye dist/sw.js)
npm run verify:pwa     # comprueba manifest, íconos y que todo lo precacheado exista
npm test               # unitarias (vitest + fake-indexeddb)
npm run test:e2e       # Playwright (build + preview + Chromium emulando Pixel 7)
npm run check          # todo lo anterior en cadena
```

## Documentación

- [`docs/ANDROID.md`](docs/ANDROID.md) — instalar en Android (USB + `adb reverse`, sin publicar nada) y checklist físico.
- [`docs/UBUNTU.md`](docs/UBUNTU.md) — pasar el proyecto a Ubuntu.
- [`docs/PRUEBAS.md`](docs/PRUEBAS.md) — qué se probó, cómo, resultados reales y lo que **no** está probado.

## Límites conocidos

- Un solo teléfono, sin sincronización. Lo que no esté respaldado no se puede recuperar.
- Sin impresión de tickets, sin fiado/crédito, sin cobro parcial de vales, sin recepción de camiones.
- **No validado en un Android físico** (ver `docs/PRUEBAS.md`).
