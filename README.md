# Sistema de Venta de Limones

PWA offline-first de **caja rápida** para un puesto de limones (Central de Abasto, CDMX), pensada para el teléfono:
**iPhone (Safari y pantalla de inicio), Android (Chrome) y computadora**.
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
- **Clasificación de limón** (sin semilla / con semilla / otra · origen · calidad · calibre o tamaño): cada combinación
  tiene su propio precio e inventario. Todo es opcional salvo el tipo; hay atajos (Oaxaca, Michoacán, Primera/Segunda/
  Tercera, 1X–3X, 200–500) pero se puede escribir cualquier valor propio. La app **no** convierte 1X/2X/3X en 200–500 ni
  deduce calidad o precio de la procedencia.
- **Recepción de mercancía** (pestaña nueva): kilos que llegan a granel, en cajas o en arpillas; por kilos netos, por
  envases × kilos de cada uno o por bruto − tara; borradores cuando aún no se sabe el peso; confirmación explícita
  antes de sumar (una sola vez, aunque se toque dos veces); corrección, anulación y corrección de datos auditadas;
  historial y resumen de kilos recibidos/vendidos/disponibles. No es un pago a proveedor y no toca el corte de caja.
  Guía para quien opera: [`docs/RECEPCION.md`](docs/RECEPCION.md).
- **Inventario** por clasificación: físico, reservado y disponible; recibido, entradas manuales, vendido, mermas y
  conteos (con motivo); historial de movimientos. Vender más que el disponible exige autorización explícita y queda
  marcado.
- **Control de pesaje por flete** (Inventario → Fletes): por cada flete, folio único, fecha, origen, destino y las dos
  pesadas (bruto − tara o neto directo, con boleta y báscula): peso inicial, peso final, **diferencia en kg y en %** contra
  el peso inicial, comparada con un rango de referencia **configurable y pendiente de validación** (200–300 kg de fábrica).
  No llama a la diferencia «merma» ni «deshidratación», no toca inventario, ventas ni caja, y las correcciones (con motivo) y
  anulaciones quedan en una bitácora. Guía: [`docs/FLETES.md`](docs/FLETES.md).
- **Corte de caja**: fondo inicial, entregadas vs vales, forma de pago, salidas con motivo, devoluciones,
  efectivo esperado vs contado, diferencia, cortes anteriores. El cambio no es gasto.
- **Historial** por día, **respaldo** exportar/restaurar (valida antes de reemplazar, guarda una copia para deshacer,
  acepta respaldos de la versión anterior) y **auditoría de integridad** (Más → Auditar integridad). Si la base no abre,
  hay una **copia de emergencia** que se descarga sin aplicar el esquema de la app.
- **Offline**: service worker con precache generado en cada build; esquema IndexedDB versionado con migraciones.
- **iPhone**: metas de Apple, ícono de 180×180, zonas seguras (isla dinámica y barra de inicio), teclado de Safari (que no encoge
  la pantalla), campos de 16 px (sin zoom involuntario), aviso de que Safari y la app instalada **no comparten datos** y ayuda de
  instalación. Guía: [`docs/IPHONE.md`](docs/IPHONE.md).

Dinero en centavos enteros y cantidades en milésimas: sin errores de flotante.
Efectivo esperado = fondo + ventas en efectivo − salidas − devoluciones en efectivo.

## Primer uso (la app NO trae datos de ejemplo)

1. Abre la app: la caja pide dar de alta tus variedades con **tus** precios reales (y calidad/calibre si aplica).
2. Registra tu existencia inicial en *Inventario → Entrada*. Mientras no lo hagas, cada venta pedirá
   autorización por existencia insuficiente (la app no inventa inventario).
3. Opcional: *Corte → abrir turno* con el fondo inicial (también se puede corregir después).

## Comandos

```bash
npm install
npm run dev            # desarrollo (sin service worker)
npm run build          # tsc + build de producción (incluye dist/sw.js)
npm run verify:pwa     # comprueba manifest, íconos, metas de iPhone y que todo lo precacheado exista
npm run verify:deploy -- https://direccion   # revisa una dirección YA publicada (HTTPS, manifest, SW, cabeceras); solo lee
npm test               # unitarias (vitest + fake-indexeddb)
npm run test:e2e       # Playwright (build en dist-e2e/, puerto libre, Chromium emulando Pixel 7 y iPhone: NO es Safari)
npm run check          # todo lo anterior en cadena
```

Las E2E nunca tocan `dist/` ni detienen un servidor ajeno: si el 4173 está ocupado usan el siguiente libre. Opciones:
`E2E_PORT`, `CHROMIUM_PATH`, `E2E_OUT_DIR`, `E2E_RESULTS_DIR`, `E2E_SKIP_TSC=1`. Un archivo suelto:
`npm run test:e2e -- tests/e2e/recepcion.spec.ts`.

## Documentación

- [`docs/RECEPCION.md`](docs/RECEPCION.md) — guía en lenguaje sencillo: clasificar el limón y registrar la mercancía que llega.
- [`docs/DISENO-CLASIFICACION-RECEPCION.md`](docs/DISENO-CLASIFICACION-RECEPCION.md) — diseño técnico (modelo, reglas, migración, auditoría).
- [`docs/IPHONE.md`](docs/IPHONE.md) — instalar en iPhone 16, qué cambia respecto a Android, riesgos y checklist físico.
- [`docs/FLETES.md`](docs/FLETES.md) — guía del control de pesaje por flete (fórmulas, folio, correcciones, rango de referencia).
- [`docs/ANDROID.md`](docs/ANDROID.md) — instalar en Android (USB + `adb reverse`, sin publicar nada) y checklist físico.
- [`docs/ARQUITECTURA-COMPARTIDA.md`](docs/ARQUITECTURA-COMPARTIDA.md) — diseño **propuesto** (no construido) para compartir datos
  entre teléfonos con cuentas, roles y bitácora.
- [`docs/PUBLICACION-PRUEBA.md`](docs/PUBLICACION-PRUEBA.md) — cómo publicar una versión de prueba (hoy **no publicada**, requiere autorización).
- [`docs/UBUNTU.md`](docs/UBUNTU.md) — pasar el proyecto a Ubuntu.
- [`docs/PRUEBAS.md`](docs/PRUEBAS.md) — qué se probó, cómo, resultados reales y lo que **no** está probado.

## Límites conocidos

- Un solo teléfono, sin sincronización ni cuentas: **dos teléfonos son dos negocios separados** (y en iPhone, Safari y la app
  instalada también). Lo que no esté respaldado no se puede recuperar.
- Sin impresión de tickets, sin fiado/crédito, sin cobro parcial de vales.
- La recepción registra **kilos**, no dinero: sin costo de compra, cuentas por pagar ni pagos a proveedores.
- Las cajas y arpillas nunca se convierten solas en kilos: el peso lo captura la persona (o se usa bruto − tara).
- **No validado en un iPhone ni en un Android físicos** (ver `docs/PRUEBAS.md`). Un E2E que pasa en Chromium no equivale a una
  validación en el teléfono; el offline de las pruebas es **simulado**, no modo avión real.
