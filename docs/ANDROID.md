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
conexión al servidor; la versión nueva se activa al **cerrar y volver a abrir** la app. Los datos no se
tocan (las migraciones de IndexedDB nunca borran).

## Checklist de validación física (marcar solo al hacerlo de verdad)

- [ ] Instala y se abre sin barra de navegador
- [ ] Ícono correcto en la pantalla principal
- [ ] Abre en modo avión tras cerrar y reabrir
- [ ] Venta con teclado numérico cómodo (kilos, precio, billetes)
- [ ] Venta sobrevive a cerrar/abrir la app
- [ ] Más → "Almacenamiento" dice *persistente* (si no, exportar respaldos con frecuencia)
- [ ] Exportar respaldo guarda el archivo en el teléfono y se puede restaurar
- [ ] Rotar/bloquear pantalla a media venta no pierde nada
