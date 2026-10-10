# Pruebas — qué se probó y qué NO

Todo lo de esta página se ejecutó con `npm run check` (código de salida 0). Los números salen de la
salida completa del comando, no de resúmenes de RTK.

## Resultado de la última corrida completa

| Paso | Resultado |
|---|---|
| `tsc --noEmit` | sin errores |
| Vitest (unitarias/integración con `fake-indexeddb`) | **48 de 48** pasan, 0 errores sin capturar (domain 11 · repo 31 · integrity 6) |
| `vite build` | OK (precache de 8 archivos) |
| `verify:pwa` | manifest, 3 íconos y precache consistentes |
| Playwright E2E (Chromium, perfil Pixel 7) | **25 de 25** pasan |

La prueba aleatoria (400 operaciones con semilla fija: ventas, vales, entregas, cancelaciones, anulaciones,
entradas, mermas, ajustes, cierres de turno) audita el inventario y el dinero cada 50 operaciones.

## Los 15 casos mínimos pedidos

| # | Caso | Dónde se prueba |
|---|---|---|
| 1 | Venta normal y cálculo | E2E `caja: total, billetes…`; unit `money`/`cart` |
| 2 | Pago exacto | E2E `caja: total, billetes…` |
| 3 | Billete y cambio | E2E `caja: total, billetes…` (y la hoja de confirmación) |
| 4 | Precio editado y persistido | E2E `precio por kg editable persiste tras recargar` |
| 5 | Variedad y precio se conservan | E2E `conserva la variedad`, `calidad: cada calidad…` |
| 6 | Se limpian kilos y efectivo; foco en kilos | E2E `caja: total, billetes…` |
| 7 | Doble pulsación sin duplicar | E2E `doble toque…`; unit `mismo id… no duplica` |
| 8 | Persistencia tras recarga | E2E `precio…`, `modo avión…`, `los registros sobreviven…` |
| 9 | Vale pagado reserva inventario | E2E `inventario: físico, reservado…`; unit `vales` |
| 10 | Entrega sin segundo cobro | E2E (efectivo esperado igual antes/después); unit |
| 11 | Canje duplicado rechazado | **Unit** (`ya fue entregado`, `cancelado`). En E2E solo se comprueba que la UI ya no ofrece el botón y que el doble clic entrega una vez; la API no se ataca desde el navegador |
| 12 | Físico/reservado/disponible consistentes | unit + `auditData` + simulación; E2E de inventario |
| 13 | Corte de caja | E2E `corte: fondo, salida, cierre…`; unit `turnos y corte` |
| 14 | Exportar y restaurar respaldo | E2E `respaldo…` (en un contexto limpio) ; unit |
| 15 | Funciona sin conexión tras precarga | E2E `modo avión…` (**simulado**, ver abajo) |

Además: primer arranque sin datos inventados (la app no trae variedades, precios ni inventario), fondo inicial corregible, aviso de turno que sigue abierto al día siguiente (reloj simulado),
caja que conserva kilos/efectivo al cambiar de pestaña, confirmación explícita, calidades, existencias negativas con autorización, mermas con motivo,
cancelación de vales con/sin devolución, historial, auditoría, migraciones (v1→v3 y reversión si una migración falla).

## Offline: simulado vs. real (son cosas distintas)

- **Simulado (probado):** Playwright instala el service worker, y luego `context.setOffline(true)` corta la red del
  navegador de escritorio. Demuestra que el precache y el código sirven la app sin red y que IndexedDB persiste.
- **Real en Android (NO probado):** modo avión en un teléfono, con la app instalada, cerrada por completo y
  reabierta. Puede revelar cosas que la simulación no ve (política de energía del navegador, almacenamiento no
  persistente, versión de Chrome). Se valida con `docs/ANDROID.md`; hasta entonces está **pendiente**.

## Incidentes de prueba y cómo se resolvieron

1. **Error sin capturar con RTK reportando 21/21.** `rtk vitest run` resumió "PASS 21 / FAIL 0" y ocultó
   `Errors 1 error` (un `AbortError` sin capturar). Causa real: al abortar una transacción de IndexedDB
   (venta duplicada, pago inválido…) la promesa `tx.done` se rechazaba sin nadie esperándola. Corrección:
   toda transacción de escritura pasa por `rw()` que atiende ese rechazo (el error sigue llegando a quien
   hace `await`). Verificado con la salida completa de Vitest (0 errores). Igual en la actualización de esquema.
   Lección: RTK se usó solo donde el resumen no esconde fallos; las corridas de validación son sin filtro.
2. **"Error al crear `repo.ts`".** Fue el rechazo de la herramienta de escritura ("el archivo cambió desde que
   se leyó") porque lo había modificado con un script entre la lectura y la escritura. No era un error de código;
   el archivo se reescribió y compila.
3. **Prueba intermitente de auditoría** (pasó una vez, falló la siguiente): la prueba tomaba `products[0]` y
   `getAll` ordena por UUID aleatorio. Corregida seleccionando por id; 8 corridas consecutivas estables.
4. **Pérdida de datos al restaurar un respaldo dañado (encontrado en revisión propia, reproducido y corregido).**
   Un respaldo con un registro sin `id` pasaba la validación superficial; `importBackup` borraba todas las tablas y
   luego `put()` lanzaba `DataError`, que en IndexedDB **no aborta** la transacción: se confirmaba vacía.
   Reproducción real: antes del intento 3 variedades y 1 venta, después 0 y 0. Corrección: (a) `runRw`, que aborta y
   revierte ante CUALQUIER excepción (ahora usado por todas las escrituras multi-paso) y (b) validación estricta de
   la forma de cada registro antes de tocar nada. Comprobado también "al revés": la misma secuencia sin `runRw`
   deja la primera escritura confirmada. Regresión cubierta por 4 pruebas unitarias y 1 E2E.
5. **Bug real encontrado por E2E:** `formatQty` mostraba "-2000 g" en vez de "-2 kg". Corregido, con prueba unitaria.

## No probado / no verificable aquí

- Teléfono Android real (instalación, modo avión, teclado, rendimiento, almacenamiento persistente).
- Otros navegadores (solo Chromium); iOS/Safari no es objetivo.
- Cuota de almacenamiento llena (se muestra un mensaje específico, pero no se forzó el fallo).
- Varias pestañas/ventanas escribiendo a la vez (las transacciones son atómicas, pero no hay prueba E2E multi-pestaña).
- Uso prolongado con miles de ventas (rendimiento de listas).
