# Usar la app en iPhone (iPhone 16, Safari y pantalla de inicio)

> **Estado honesto:** todo lo de esta guía que dice «probado» se probó **simulando un iPhone dentro de Chromium** (tamaño de
> pantalla, zonas seguras y teclado simulados). **No se ha probado en un iPhone físico ni con el motor de Safari (WebKit).**
> Lo que depende del iPhone de verdad (instalar en la pantalla de inicio, cómo se ve la barra de estado, el teclado real,
> el modo avión real, el menú de compartir) está en la lista de comprobación del final y **sigue sin comprobarse**.

## Qué necesita el iPhone para instalarla

1. Una dirección **https://** (con candado). Sin HTTPS el iPhone no registra el service worker: la app abre, pero **no
   quedaría instalada ni funcionaría sin internet**. `http://192.168…` (la computadora en la misma red) **no sirve** para
   probar esto. *(OBSERVADO en la documentación de los navegadores; no comprobado con un iPhone.)*
2. **Safari.** Los pasos de abajo son los de Safari.
3. **A fecha de hoy esa dirección no existe:** la app **no está publicada** y publicarla requiere tu autorización explícita
   (ver [`PUBLICACION-PRUEBA.md`](PUBLICACION-PRUEBA.md)). Mientras no se publique, no hay nada que instalar en el iPhone.

## Instalar (iPhone 16)

1. Abre la dirección de la app en **Safari** (no en Chrome ni en el navegador interno de WhatsApp, Gmail, etc.).
2. Toca **Compartir** (un cuadro con una flecha hacia arriba; en algunas versiones está dentro del menú «…»).
3. Elige **«Añadir a pantalla de inicio»**.
4. Si aparece el interruptor **«Abrir como app web»**, déjalo **encendido** (iOS 26 lo pone en cada sitio que añades).
5. Toca **«Añadir»**. Abre la app desde el **ícono nuevo («Limones»)**, no desde Safari.

La app también te lo explica: si la abres dentro de Safari te muestra el aviso «Estás usando la app en Safari» con el botón
**Cómo instalarla**, y en **Más** hay el mismo botón. Dentro de la app instalada, **Más → Estado de los datos** debe decir
«Modo: app instalada».

> Los nombres exactos de los menús cambian un poco entre versiones de iOS. Estos pasos describen el flujo conocido; no se
> han seguido en un iPhone real.

## Lo más importante: Safari y la app instalada NO comparten datos

En el iPhone, lo que capturas dentro de Safari **no aparece** en el ícono de la pantalla de inicio, y al revés: son dos
almacenes separados. Por eso:

- **Instala la app antes de capturar datos reales.**
- Si ya capturaste algo en Safari: *Más → Exportar respaldo* **en Safari**, abre la app instalada y *Más → Restaurar desde
  archivo*. Si no, parecerá que «se perdió todo» (no se perdió: sigue en Safari).
- Usa **siempre el mismo ícono**.

## Respaldos (la única copia son tus propios archivos)

Todo vive en el iPhone (IndexedDB). No hay servidor ni cuenta: **si borras la app, borras sus datos de Safari/Ajustes o el
iPhone limpia espacio, esos datos no se pueden recuperar.**

- *Más → Exportar respaldo* baja un archivo `.json`. Si el iPhone lo permite, también aparece **«Compartir respaldo»** para
  mandarlo a Archivos, WhatsApp, correo o Drive (si la hoja de compartir falla, la app lo descarga). Hazlo seguido, sobre todo
  antes de actualizar la app o de un día importante.
- Apple dice que las apps de la pantalla de inicio no entran en la regla de Safari que borra los datos de un sitio sin uso
  después de unos días. También hay reportes de desarrolladores de datos perdidos de todos modos *(OBSERVADO en foros y en
  la documentación; no se pudo comprobar)*. Un respaldo reciente es la única garantía.
- La app pide al sistema «almacenamiento persistente». En **Más → Estado de los datos** ves lo que contestó el iPhone; si no
  es persistente, exporta con más frecuencia.

## Actualizaciones

Cuando hay una versión nueva, la app lo avisa: «Hay una versión nueva de la app. Tus datos no se tocan.» con **Actualizar
ahora** / **Después**. No se recarga sola para no perder una captura a medias. La app pregunta si hay versión nueva al abrirla,
al volver a ella y cuando regresa el internet.

*Pendiente de probar en un iPhone real:* que el aviso aparezca en la app instalada y que, tras actualizar, los datos sigan
(en Chromium sí se probó que actualizar no borra nada).

## Cómo se adaptó a la pantalla del iPhone

Lo siguiente está en el código y probado **en simulación** (no en Safari):

- **Zonas seguras:** el encabezado queda debajo de la isla dinámica / muesca y las pestañas de abajo encima de la barra de
  inicio; de lado, nada queda bajo los bordes.
- **Teclado:** Safari **no encoge** la pantalla al abrir el teclado (solo reduce la zona visible); la app mide esa zona y deja
  la barra de registro justo encima del teclado y los campos a la vista. Las pestañas de abajo se esconden con el teclado
  abierto, excepto en la Caja.
- **Sin zoom involuntario:** los campos de captura miden 16 px o más (menos hace que Safari amplíe la pantalla) y un doble
  toque rápido en los billetes no hace zoom.
- **Girar el teléfono:** hay una versión compacta para horizontal.
- **Botones táctiles:** mínimo 44 × 44 px (probado en iPhone 16, 16 Pro Max y SE, vertical y horizontal).

## Lista de comprobación en un iPhone físico (nada de esto está hecho)

Marca solo lo que hagas de verdad. Anota iOS y modelo.

Instalación
- [ ] Safari abre la dirección HTTPS y carga la caja
- [ ] «Añadir a pantalla de inicio» funciona y el ícono dice «Limones» y se ve bien (sin fondo negro ni recortes)
- [ ] La app abre a pantalla completa (sin barra de Safari) y **Más → Modo** dice «app instalada»
- [ ] El texto de la barra de estado (hora, batería) se lee sobre el verde del encabezado
- [ ] Nada queda bajo la isla dinámica ni bajo la barra de inicio, en vertical y de lado

Datos
- [ ] Una venta de prueba sobrevive a cerrar la app (deslizar hacia arriba) y volver a abrirla
- [ ] **Modo avión real:** cerrar la app, activar modo avión, abrirla desde el ícono: abre la caja y se puede vender
- [ ] Exportar respaldo → «Compartir» → guardar en Archivos; restaurarlo en la app (con una copia previa aparte)
- [ ] Datos de Safari y de la app instalada son distintos (como avisa la app)
- [ ] Reiniciar el iPhone y abrir la app: los datos siguen

Teclado y toques
- [ ] En **Recepción**, escribir los kilos y tocar «Registrar» al **primer** toque (sin que el teclado se «coma» el toque)
- [ ] En **Fletes**, llenar peso bruto, tara, boleta y báscula con el teclado abierto: el campo enfocado se ve y «Guardar flete» se alcanza
- [ ] Con el teclado cerrado, las pestañas de abajo regresan
- [ ] Doble toque rápido en los billetes de la Caja: no hace zoom
- [ ] Rotar a horizontal a media captura no pierde lo escrito

Actualización
- [ ] Con la versión anterior instalada, abrir la nueva: aparece el aviso y «Actualizar ahora» conserva ventas, vales, precios,
      inventario y fletes (**exporta un respaldo antes**)

## Riesgos y pendientes conocidos

| Riesgo | Estado |
|---|---|
| No se ha probado en iPhone físico ni en WebKit | **NO VERIFICADO** |
| iOS puede borrar datos de sitios web en situaciones raras (poco espacio, desinstalar) | mitigado solo con respaldos |
| Safari y la app instalada tienen datos separados | avisado en la app y en esta guía |
| iOS 26 reportó fallos de zona segura con barra de estado translúcida y de «desplazamiento viejo» al cerrar el teclado | contemplados en el diseño y en pruebas simuladas; **NO VERIFICADO** en iOS real |
| «Compartir respaldo» necesita que el archivo esté listo en el mismo toque; si el iPhone lo rechaza, la app descarga el archivo | diseñado así; **NO VERIFICADO** |
| Sin servidor: dos teléfonos no se sincronizan | ver [`ARQUITECTURA-COMPARTIDA.md`](ARQUITECTURA-COMPARTIDA.md) |
