# Instalar la PWA en Android (procedimiento)

> Estado: **NO validado en un teléfono real todavía.** Este procedimiento está escrito pero
> los pasos 4–7 solo se consideran probados cuando se hagan en el teléfono (ver checklist al final).

Una PWA solo se instala y funciona offline si se sirve por **HTTPS o `localhost`**.
Hay dos rutas; la A no requiere publicar nada en internet.

## Ruta A — Por cable USB, sin publicar nada (recomendada para la primera prueba)

Requisitos en la computadora (Ubuntu): `node` ≥ 20, `adb` (`sudo apt install adb`), Chrome en el teléfono,
**Depuración USB** activada en el teléfono (Ajustes → Opciones de desarrollador).

```bash
npm ci
npm run build
npm run verify:pwa            # debe imprimir "build PWA consistente"
npm run serve:android &       # sirve dist en http://127.0.0.1:4173
adb devices                   # el teléfono debe aparecer como "device"
adb reverse tcp:4173 tcp:4173 # el "localhost" del teléfono apunta a la computadora
```

1. En el teléfono, abre Chrome → `http://localhost:4173` (en Android `localhost` cuenta como origen seguro).
2. Espera a que cargue la caja. Chrome ⋮ → **Instalar app** (o "Agregar a pantalla principal").
3. Abre la app desde el ícono nuevo (se abre sin barra del navegador).
4. **Con la app abierta y ya cargada**, desconecta el cable y apaga el servidor (`kill %1`).
5. Activa **modo avión**. Cierra la app por completo (deslizar de recientes) y vuelve a abrirla desde el ícono.
6. Debe abrir la caja y mostrar "Sin internet · funciona igual". Haz una venta de prueba.
7. Ciérrala, ábrela otra vez: la venta debe seguir en *Corte* y en *Más → Historial*.

Limitación importante de la ruta A: los datos viven en el origen `http://localhost:4173` del Chrome del
teléfono. Si luego instalas desde otra URL (ruta B), **son datos distintos**: exporta un respaldo antes
(Más → Exportar) y restáuralo allá.

## Ruta B — URL HTTPS permanente (requiere tu autorización para publicar)

Cualquier hosting estático con HTTPS sirve (la app es solo la carpeta `dist/`). **No se ha publicado nada.**
Si decides hacerlo: sube `dist/`, abre la URL en Chrome del teléfono e instala como en la ruta A (paso 2).
Ventaja: no necesitas computadora para volver a instalar o actualizar.

## Actualizar la app

Cada `npm run build` genera un service worker con versión nueva. El teléfono lo descarga cuando hay
conexión al servidor (al abrir la app, al volver a ella y cuando regresa el internet). Con la app abierta aparece
«Hay una versión nueva de la app. Tus datos no se tocan.»: **Actualizar ahora** recarga; **Después** la deja como está
(no se recarga sola para no perder una captura a medias). Los datos no se tocan (las migraciones de IndexedDB nunca
borran). Importante: la base pasó a la **versión 3** (fletes); una vez abierta con la app nueva, una app vieja ya no la abre.

## Checklist de validación física (marcar solo al hacerlo de verdad)

Nada de esta lista se ha probado en un Android físico. Las pruebas automáticas (Chromium con perfil Pixel 7 y el
teclado *emulado* encogiendo la ventana) **no** sustituyen estas comprobaciones: ver `docs/PRUEBAS.md`.

Instalación y datos
- [ ] Instala y se abre sin barra de navegador
- [ ] Ícono correcto en la pantalla principal
- [ ] Abre en modo avión tras cerrar y reabrir (modo avión **real**, no simulado)
- [ ] Más → "Almacenamiento" dice *persistente* (si no, exportar respaldos con frecuencia)
- [ ] Exportar respaldo guarda el archivo en el teléfono y se puede restaurar
- [ ] Rotar/bloquear pantalla a media venta o a media recepción no pierde nada
- [ ] Si el teléfono ya tenía la versión anterior: al abrir la nueva aparece el aviso "La app se actualizó" y las
      ventas, vales, precios e inventario siguen igual (hacer un respaldo **antes** de actualizar)

Caja rápida
- [ ] Venta con teclado numérico cómodo (kilos, precio, billetes)
- [ ] Venta sobrevive a cerrar/abrir la app

Teclado en pantalla (lo que más se parece a lo que falló en las pruebas)
- [ ] Escribir un precio y tocar **Agregar variedad** al **primer** toque, sin que el teclado "se coma" el toque
- [ ] En Recepción: escribir los kilos y tocar **Registrar recepción** al primer toque; con el teclado abierto
      las pestañas de abajo se esconden y la barra con los kilos netos queda pegada arriba del teclado
- [ ] Cerrar el teclado con el gesto/botón *atrás*: las pestañas vuelven aunque el campo siga seleccionado
- [ ] Un campo seleccionado no queda tapado por la barra de registro ni por las pestañas
- [ ] En la Caja las pestañas **no** se esconden aunque el teclado esté abierto

Recepción (con balanza o con cajas/arpillas reales)
- [ ] A granel, cajas × kilos, arpillas × kilos y bruto − tara dan los kilos netos que esperas
- [ ] Doble toque rápido en **Confirmar** registra **una** sola recepción
- [ ] Guardar borrador sin peso no suma; completarlo después sí suma una vez
- [ ] Corregir kilos y anular dejan el rastro en Historial → Detalle
- [ ] Todo lo anterior en modo avión

Control de pesaje por flete (Inventario → Fletes)
- [ ] Capturar un flete con bruto − tara en origen y neto directo en destino: la diferencia y el % coinciden con tu calculadora
- [ ] Con el teclado abierto, el campo enfocado se ve y «Guardar flete» se alcanza al primer toque
- [ ] Doble toque en «Guardar flete» deja UN solo flete
- [ ] Exportar respaldo trae los fletes; restaurarlo en otra instalación los deja iguales

Gesto o botón «atrás» (la app NO lo maneja: no usa el historial del navegador)
- [ ] Con una hoja abierta (por ejemplo «Confirmar recepción»), «atrás»: anota qué pasa (lo probable es que cierre la app
      en lugar de la hoja; lo capturado se conserva y se recupera al reabrir). Si molesta, hay que manejarlo en una versión futura
- [ ] «Atrás» con el teclado abierto cierra solo el teclado y las pestañas vuelven

Pantallas (360 px y 412 px de ancho)
- [ ] Ninguna pantalla se corta a los lados; los botones se pueden tocar con el pulgar
- [ ] Las seis pestañas se leen completas ("Recepción" no se recorta)
- [ ] Las hojas de confirmación tienen siempre a la vista los botones de abajo
