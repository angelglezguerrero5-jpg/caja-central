# Sistema de Venta de Limones

PWA offline-first de **caja rápida** para venta de limones, pensada para Android.
Todo se guarda en IndexedDB del propio teléfono; no hay servidor ni cuentas.

## Qué hace (MVP 0.1.0)

- **Caja rápida**: variedad → kilos → precio por kg (editable y persistente) → billetes
  ($20–$1000, acumulables), "Exacto", total y cambio. Al confirmar se limpian kilos y
  efectivo, se conservan variedad y precio, y el foco vuelve a *Kilos*.
- **Ventas** con id único, folio consecutivo y prevención de duplicados (doble toque / reintento).
  Cada venta guarda el precio con que se vendió; cambiar el precio después no la altera.
- **Vales** = ventas **ya pagadas** cuya mercancía se entrega después. Tienen folio, reservan
  mercancía y **no vuelven a sumar dinero** al entregarse.
- **Inventario por variedad**: físico, reservado y disponible (= físico − reservado);
  entradas, mermas y conteo físico; las ventas y anulaciones lo mueven solas.
- **Corte de caja**: fondo inicial, ventas por forma de pago, vales, salidas de efectivo,
  efectivo esperado vs. contado, diferencia. El turno se abre solo con la primera venta.
- **Respaldo**: exportar/restaurar JSON (se valida antes de reemplazar nada).
- **Offline real**: service worker con precache generado en cada build.

Regla de dinero: efectivo esperado = fondo + ventas en efectivo − salidas. (Transferencia/tarjeta
no entran a caja.) Dinero en centavos enteros y cantidades en milésimas: sin errores de flotante.

## Desarrollo

```bash
npm install
npm run dev            # desarrollo (sin service worker)
npm run build          # tsc + build de producción (incluye dist/sw.js)
npm run preview        # sirve dist en :4173
npm test               # pruebas unitarias (vitest + fake-indexeddb)
npm run test:e2e       # Playwright (build + preview + Chromium)
```

El E2E usa el Chromium preinstalado (`CHROMIUM_PATH`, por defecto `/opt/pw-browsers/chromium`).

## Instalar en Android

Requiere servir por **HTTPS** (o `localhost`): los service workers y "Instalar app" no
funcionan por `http://IP-de-red`. Ver "Pendiente" más abajo — **aún no hay URL desplegada**.
Una vez servida por HTTPS: Chrome → menú ⋮ → *Instalar app*. Después funciona sin internet.

## Pendiente / límites conocidos (no probado o no hecho)

- **Despliegue HTTPS y prueba en un Android real**: NO realizados. Lo verificado es instalabilidad
  *técnica* (manifest, íconos, service worker activo) en Chromium de escritorio emulando Pixel 7.
- Los datos viven solo en el teléfono: si se borra el almacenamiento del navegador se pierden.
  Se pide almacenamiento persistente, pero exporta respaldos con frecuencia.
- Un solo dispositivo/caja: sin sincronización entre teléfonos.
- Sin impresión de ticket, sin cobro parcial de vales, sin clientes/catálogo de clientes,
  sin edición de ventas (solo anular dentro del turno abierto).
- Actualización de la app: el service worker nuevo se activa al siguiente arranque tras descargar.
