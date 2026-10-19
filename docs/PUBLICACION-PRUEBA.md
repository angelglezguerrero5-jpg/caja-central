# Publicar una versión de PRUEBA para probar en iPhone y Android

> **Estado: BLOQUEADO — no se publicó nada.** Publicar crea una dirección en internet y requiere **tu autorización
> explícita**. Tampoco se compró ningún dominio, ni se cambió ningún DNS, ni se usaron datos reales. No hay ninguna URL de
> prueba: cualquier dirección que alguien te dé como «ya publicada» no viene de este trabajo.

## Qué es la app para efectos de publicarla

Una carpeta de archivos estáticos (`dist/`, la crea `npm run build`): HTML, JS, CSS, íconos, `manifest.webmanifest` y
`sw.js`. **Los datos del negocio nunca están en esa carpeta**: viven en el teléfono. Publicar la carpeta no publica datos.
(Por eso una versión de prueba pública no expone información del negocio mientras **no captures datos reales en ella**.)

Requisitos del hosting (todos verificables con `npm run verify:deploy -- <url>`):

1. **HTTPS** con certificado válido. Sin HTTPS el iPhone y Android no instalan la app ni activan el service worker.
2. **En la raíz de su propio dominio o subdominio** (`https://algo.ejemplo.com/`, no `https://ejemplo.com/limones/`): el
   manifest usa `start_url: "/"`, `scope: "/"` y el service worker está en `/sw.js`. En una subcarpeta no funcionaría.
3. Tipos de archivo correctos (`.webmanifest` como `application/manifest+json`, `.js` como JavaScript, íconos `image/png`).
4. `sw.js` e `index.html` **sin caché larga** (`Cache-Control: no-cache` o `max-age=0`), o las versiones nuevas tardan en
   llegar. `/assets/*` (nombres con huella) sí puede ser `immutable`.
5. Cabeceras de seguridad recomendadas: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
   `Referrer-Policy: no-referrer`, `Permissions-Policy` vacía y `Content-Security-Policy` con `frame-ancestors 'none'` (esa
   directiva solo funciona como cabecera; el resto ya viene en el `<meta>` del `index.html`).
6. **Una dirección por app.** Una futura app de mandarinas debe vivir en **otro** subdominio: el almacenamiento del navegador se
   separa por dirección y así no se mezclan ni se pisan los datos ni el service worker.

## Opciones para una prueba (de menor a mayor compromiso)

| Opción | Qué da | Costo/riesgo | Estado |
|---|---|---|---|
| **1. Túnel temporal** de la computadora (p. ej. `cloudflared tunnel --url http://localhost:4173`) | Una URL HTTPS al azar mientras el túnel esté abierto | Servicio externo; **la dirección cambia cada vez** y con ella el almacenamiento del teléfono → sirve para ver pantallas y probar el instalador, **no** para guardar datos de varios días | No usado. No se comprobó que la herramienta exista ni que la red del entorno la permita |
| **2. Hosting estático administrado** (Render, Cloudflare Pages, Netlify, Vercel…) con su subdominio gratuito | URL HTTPS estable | Crea una cuenta/servicio en internet; precios y límites **no verificados** | **BLOQUEADO — falta tu autorización.** En esta sesión hay una conexión a Render, pero **no se usó** |
| **3. GitHub Pages** | URL HTTPS | Solo sirve si está en la **raíz** (sitio de usuario u organización o dominio propio); en un «project page» queda en subcarpeta y **no funciona** sin cambios | No usado |
| **4. Computadora + cable (Android)** | Sin publicar nada (ver `docs/ANDROID.md`) | Solo Android: el iPhone no tiene un equivalente sencillo de `adb reverse` (su «localhost» no apunta a la computadora) | Disponible, requiere tu teléfono |

**Recomendación:** opción 2 con un subdominio **descartable** (por ejemplo `limones-prueba`), sin datos reales, y borrarlo al
terminar; antes, un túnel (opción 1) si solo quieres ver cómo se ve en tu iPhone. Para producción real: tu propio subdominio y,
si van a compartir datos, primero el diseño de [`ARQUITECTURA-COMPARTIDA.md`](ARQUITECTURA-COMPARTIDA.md).

## Procedimiento (cuando lo autorices)

1. `npm ci && npm run check` (todo en verde, con los resultados reales guardados).
2. `npm run build && npm run verify:pwa`.
3. Subir **solo** el contenido de `dist/`. Configurar las cabeceras de arriba.
4. `npm run verify:deploy -- https://<la-direccion>` → debe terminar sin fallos (HTTPS, manifest, íconos de verdad, apple-touch-icon
   de 180×180, service worker con alcance `/`, cabeceras de caché y seguridad).
5. Probar a mano en los teléfonos con la lista de [`IPHONE.md`](IPHONE.md) y [`ANDROID.md`](ANDROID.md): abrir por HTTPS, instalar,
   modo avión **real**, persistencia al cerrar y reabrir, actualización, y abrir desde **otra red** (datos móviles) para confirmar
   que la dirección es pública.
6. Anotar el resultado real de cada casilla (PASS / FAIL / NO VERIFICADO). Una URL «publicada» no es «verificada».

## Antes de usarla con datos reales

- Hacer un respaldo en cada teléfono **antes** de instalar o actualizar.
- Esta app **no tiene inicio de sesión**: quien abra la dirección en SU teléfono solo ve SUS datos locales, pero quien tenga acceso
  físico al teléfono desbloqueado ve todo. Si se van a **compartir datos entre personas**, no basta publicar: falta autenticación,
  permisos y un servidor (ver `ARQUITECTURA-COMPARTIDA.md`).
- Confirmar con `verify:deploy` que HTTPS y las cabeceras están bien en la dirección **final**, no solo en la de prueba.
