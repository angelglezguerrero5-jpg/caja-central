# Pruebas — qué se probó y qué NO

Esta página dice solo lo que se ejecutó de verdad. Cada número sale de la salida completa del comando indicado.
**Un E2E que pasa en Chromium NO equivale a una validación en un Android físico**, y el «modo avión» de las pruebas es
**simulado**.

## Resultado de la última corrida completa

Una sola corrida de `npm run check` (código de salida **0**), sin filtros y con las variables por defecto
(salida completa guardada; los números de abajo salen de ella):

| Paso | Comando | Resultado |
|---|---|---|
| Tipos | `tsc --noEmit` | sin errores |
| Unitarias e integración (Vitest + `fake-indexeddb`) | `vitest run` | **410 de 410** pasan, 22 archivos |
| Build de producción | `tsc --noEmit && vite build` | correcto (JS 227.4 kB, CSS 12.4 kB) |
| PWA | `node scripts/verify-pwa.mjs` | «build PWA consistente»: manifest, íconos reales, metas de iPhone y precache de 9 archivos |
| E2E completas (Chromium: perfil Pixel 7 y, en `iphone.spec.ts`, iPhone emulado; zona `America/Mexico_City`, `es-MX`) | `node scripts/run-e2e.mjs` | **398 de 398** pasan (14.7 min) |
| Lint | — | **no existe** en el proyecto (no hay script ni configuración); no se inventó uno |

E2E por archivo: `caja` 8 · `negocio` 15 · `offline` 3 (las **26 originales**: solo cambiaron selectores y textos y se añadió el
paso de confirmar la restauración; no se quitó ni se debilitó ninguna aserción) · `teclado` 22 · `recepcion` 74 · `clasificacion`
74 · `migracion` 23 · `respaldo` 55 · `android` 55 · **`iphone` 38 · `fletes` 29 · `dispositivos` 2** (estas tres son nuevas).

> Primera corrida completa tras agregar los fletes y la base v3: 370 de 394 pasaron y **24 fallaron**. Todas eran
> expectativas de la versión anterior (el respaldo exportado y la base pasaron de la versión 2 a la 3; una app «más nueva» pasó de
> ser la 3 a la 4) salvo un defecto real de pantalla que se corrigió (ver «Incidentes de la ronda de iPhone y fletes»).

## Cómo correrlas

```bash
npm run typecheck && npm test                 # tipos + unitarias
npm run build && npm run verify:pwa           # build de producción + coherencia de la PWA
npm run test:e2e                              # todas las E2E (construye en dist-e2e/, puerto libre)
npm run test:e2e -- tests/e2e/recepcion.spec.ts          # un archivo
npm run test:e2e -- -g "arpillas"                         # por nombre
npm run check                                 # todo en cadena
```

Seguridad de las corridas: antes de empezar comprueban que Chromium exista; si el puerto 4173 está ocupado usan el
siguiente libre y **nunca detienen un servidor ajeno** (por ejemplo el del teléfono); construyen en `dist-e2e/` (no tocan
`dist/`); cada prueba usa un contexto de navegador aislado, así que **jamás** leen ni escriben datos reales.
Variables: `E2E_PORT`, `CHROMIUM_PATH`, `E2E_OUT_DIR`, `E2E_RESULTS_DIR`, `E2E_SKIP_TSC=1`.

## Los 25 casos obligatorios

| # | Caso | Dónde se prueba |
|---|---|---|
| 1–2 | Limón sin semilla / con semilla | unit `classification`, `catalog-repo` · E2E `clasificacion` |
| 3 | Procedencia Oaxaca y Michoacán | ídem |
| 4–5 | Calibres 1X-2X-3X y 200-300-400-500 (sin equivalencias inventadas) | ídem |
| 6 | Calidad primera, segunda y tercera | ídem |
| 7 | Valores personalizados y no especificados | ídem (`Torreones`, `N/A`, vacío) |
| 8 | Recepción a granel | unit `reception-repo` · E2E `recepcion` |
| 9–10 | Cajas y arpillas con peso configurado (sin peso precargado) | ídem |
| 11 | Kilos netos exactos (directo, envases × peso, bruto − tara, varias pesadas) | unit `reception-domain` · E2E `recepcion` |
| 12 | Prevención de entradas duplicadas (doble toque, mismo intento, camión repetido) | unit `reception-repo` · E2E `recepcion` |
| 13 | Recepción cancelada sin tocar existencias | ídem |
| 14 | Venta de 20 kg descuenta exactamente 20 kg de esa clasificación | E2E `clasificacion`, `recepcion` |
| 15 | Vale que reserva sin doble descuento | E2E `clasificacion`, `recepcion`, `migracion` |
| 16 | Precio independiente por clasificación (y precio histórico) | E2E `clasificacion` |
| 17 | Recepciones sobreviven a recarga y a reinicio real | E2E `recepcion`, `migracion` (perfil persistente) |
| 18 | Respaldo y restauración de los registros nuevos | unit `backup-v2` · E2E `respaldo` |
| 19 | Importar un respaldo de la versión anterior | unit `backup-v2` · E2E `respaldo` (fixture real) |
| 20 | Rechazo de respaldo corrupto sin pérdida | unit `backup-v2`, `safety-v2` · E2E `respaldo` (16 tipos) |
| 21 | Pantallas Android 360×640 y 412×915, teclado abierto y cerrado | E2E `teclado`, `android` |
| 22 | Funcionamiento sin conexión (**simulado**) | E2E `recepcion`, `android` |
| 23 | Corte de caja sin alteraciones | unit `reception-repo` · E2E `recepcion`, `android` |
| 24 | Migración con datos previos preservados | unit `migration-v2` · E2E `migracion` (base v1 real en el navegador y app anterior compilada) |
| 25 | Auditoría de inventario consistente | unit `audit-v2`, `backup-v2` + simulación aleatoria · E2E varias |

Pruebas negativas: kilos vacíos, cero, negativos, texto, notación científica, coma ambigua («1,500»), más de 3 decimales,
excesos (200 000 kg), envases decimales o negativos, tara mayor al bruto, textos y fechas inválidas, respaldos dañados,
confirmaciones repetidas, doble toque, importes por encima del máximo.

## Ronda de iPhone y fletes: qué se probó

| Área | Dónde | Pruebas |
|---|---|---|
| Cuentas de fletes: neto = bruto − tara, diferencia, porcentaje, redondeo, rango de referencia con límites exactos, formatos, validaciones | unit `freight-domain` | 41 (incluye un **oráculo independiente con BigInt** sobre 2,000 pares aleatorios) |
| Guardado: folio único (mayúsculas y espacios no cuentan), idempotencia por `id`, completar sin motivo, corregir con motivo, bitácora, anulación que conserva todo, auditoría, fechas en hora de México | unit `freight-repo` | 33 |
| Migración real de la base a la v3 desde la v1 y la v2: nada cambia y aparece el almacén de fletes | unit `migration-v3` | 6 |
| Respaldo formato 3: forma estricta, **formatos mezclados** (un «2» que trae fletes), entradas hostiles (`__proto__`, números enormes, textos de 2,001 caracteres) | unit `backup-v3` | 36 |
| iPhone: geometría del teclado de Safari, zonas seguras, detección de plataforma | unit `iphone` | 16 |
| «Deshacer»: el orden de las copias internas no depende del reloj | unit `undo` | 7 (4 nuevas) |
| Verificador de una dirección publicada (`verify:deploy`) contra sitios locales correctos y con 14 defectos introducidos | unit `verify-deploy` | 19 |
| Fletes en pantalla: captura y cuentas, folio repetido, doble y triple toque, completar/corregir/anular, rango configurable, recarga, sin conexión **simulada**, almacenamiento lleno **simulado**, respaldo y restauración (incluida la de un archivo viejo que vacía los fletes), migración real v2→v3 en el navegador, pantalla en 2 tamaños | E2E `fletes` | 29 |
| iPhone **emulado**: paquete instalable (metas, ícono 180×180 real, manifest, service worker que no guarda datos), todas las pantallas en 3 iPhone y horizontal (con Fletes), zonas seguras, campos ≥ 16 px, **contraste de color WCAG 4.5:1**, teclado de Safari simulado, aviso de instalación, «Compartir respaldo», actualización de la app sin perder datos, reconexión a la base | E2E `iphone` | 38 |
| Dos dispositivos aislados y **cero tráfico de red de datos** | E2E `dispositivos` | 2 |

Repetición para detectar pruebas intermitentes, sobre el código final: `fletes` + `iphone` + `dispositivos` + las 5 de «Deshacer»
de `respaldo`, ×3 con `--repeat-each=3`: **231 de 231** pasan (5.1 min), 0 intermitentes. (Una pasada anterior de 204 sobre el código
previo también salió limpia.)

## Incidentes de la ronda de iPhone y fletes

1. **«Deshacer» podía ofrecer —y conservar— la copia equivocada.** Una prueba de fletes falló de forma intermitente. Causa
   raíz: las copias internas previas a una restauración se ordenaban y se podaban por la **hora del teléfono**; con la misma hora
   (reloj congelado) el orden era al azar y con un reloj que **retrocede** (hora mal puesta que se corrige) se podaba la copia
   MÁS NUEVA. Corrección: cada copia lleva un número de orden (`seq`) y las anteriores sin él se siguen ordenando por fecha; además
   «Deshacer» lee la lista en el momento del toque. Pruebas: 4 unitarias nuevas y una E2E determinista (toque a «Deshacer» en el
   instante exacto en que aparece «Respaldo restaurado»). Con el código anterior, **3 de las 4 unitarias y la E2E fallan** (en las
   unitarias, el código viejo conservaba `copia 1, 2, 3` y descartaba la 4, la más reciente).
2. **El aviso «La app se actualizó» podía quedar fuera de vista.** Lo halló la prueba de pantalla de migración: el campo *Kilos*
   tenía el atributo `autofocus`, que desplaza la página hasta el campo; un aviso más largo lo empujaba hacia abajo y la pantalla
   se movía unos 250 px, dejando el aviso arriba, fuera de vista. Corrección: el foco se da por código con `preventScroll`.
3. **Las verificaciones del service worker solo buscaban `cache.put(`.** Un service worker que guardara con `c.put(` pasaba.
   Ahora buscan `.put(` con cualquier nombre (`verify-pwa` y `verify-deploy`, con prueba).
4. **Una guarda de tiempo (0.7 s) contra toques fantasma en Fletes bloqueaba guardados seguidos legítimos** (las pruebas guardan
   más rápido que eso). Se cambió por el escudo que ya usan las hojas (`shieldTaps`).
5. **El aviso de actualización decía «ahora puedes registrar la mercancía…» a quien venía de la versión 2**, que ya la tenía.
   Ahora el texto depende de la versión de origen.
6. **Contraste insuficiente en las tarjetas «inactivas».** La prueba nueva de contraste (WCAG 1.4.3, 4.5:1) midió **3.41:1** en el
   texto secundario de ventas anuladas, fletes anulados y variedades ocultas: las atenuaba un `opacity: .7`. Ahora se distinguen
   con fondo gris y borde punteado y el texto conserva su color. La prueba mide ~400+ textos reales en todas las pantallas (con el
   aviso de Safari, la ayuda de instalación, un error y la hoja de cobro) y se omiten solo los controles deshabilitados.
7. **Errores míos que las pruebas atraparon antes de entregar:** la lista de folios de fletes devolvía ids en vez de folios
   (`freightFolioKeys`), el «Deshacer» marcaba como «versión anterior» una copia que ya era de la versión 3 (falso aviso de que
   se perderían los fletes), y dos expectativas de pruebas nuevas mal escritas.

### Expectativas de pruebas existentes que cambiaron (ninguna se quitó ni se debilitó)

Al pasar la base y el respaldo a la **versión 3** (se agregaron los fletes), 24 E2E de la corrida anterior fallaron porque
afirmaban la versión 2. Se actualizaron así, y se agregaron aserciones:

| Archivo | Cambio | Motivo |
|---|---|---|
| `android.spec.ts` | el respaldo exportado es versión **3** y trae `freights: []` | el formato actual |
| `recepcion.spec.ts` | ídem (respaldo con recepciones) | ídem |
| `respaldo.spec.ts` | `version: 2` → `3` en 8 exportaciones; la lista de claves del archivo incluye `freights`; «versión desconocida (3)» pasó a **(4)** y se **agregó** «versión 3 sin la lista de fletes» → *Respaldo incompleto* | la 3 ya es válida |
| `migracion.spec.ts` | la base queda en versión **3** (8 lugares); la lista de almacenes incluye `freights` y se **agregan** aserciones de sus índices; una app «más nueva» que la actual pasó a ser la **4** (2 lugares) | ídem |

## La regresión del «toque perdido» (el fallo que dejó en rojo las 26 E2E originales)

**Síntoma:** al terminar de rediseñar la interfaz, las 26 E2E originales fallaron todas en el primer paso («Variedad
agregada» nunca aparecía). **Causa raíz (reproducida):** el CSS `body:has(input:focus)` cambiaba el diseño en el instante en
que el campo pierde el foco —el *mousedown* del botón tocado—; el botón se movía antes del *mouseup* y el `click` caía en el
DIV padre (en el registro de eventos: `click` sobre `DIV` en lugar de `add-product`). En un teléfono ocurre igual porque los
eventos de ratón de un toque se despachan de corrido.

**Corrección:** `src/ui/keyboard.ts` decide el «modo teclado» por el **tamaño de la ventana** (el teclado la encoge) y quita la
clase con retraso y nunca con el dedo apoyado; las hojas dejan de ponerse `inert` a sí mismas; `scroll-padding` evita que un
campo enfocado quede tapado; los toques fantasma tras abrir o cerrar una hoja se ignoran 0.45 s.

**Pruebas:** `tests/e2e/teclado.spec.ts` (22 = 11 × 2 tamaños) mide en cada toque dónde estaba el botón al poner y al levantar el
dedo y a quién le llegó el `click`; también hay pruebas equivalentes en `recepcion`, `clasificacion`, `respaldo`, `migracion` y
`android`. **Demostración de que no son pruebas vacías** (copias temporales del proyecto con el defecto reintroducido):

| Mutante | Defecto reintroducido | Resultado |
|---|---|---|
| A | CSS `:has(:focus)` antiguo y sin modo teclado | **22 de 22 fallan**; las de alta de variedad con «el click cayó en otro elemento (el botón se movió bajo el dedo)» |
| B | sin `scroll-padding` | fallan 2 (campo tapado, en 360 y 412 px) |
| C | `inert` en `<main>` (la hoja quedaba inerte) | fallan 4 |
| D | rejilla de billetes `1fr` | falla 1 (desbordamiento a 360 px) |

## Simulado vs. real (son cosas distintas)

- **Sin conexión.** *Simulado (probado):* `context.setOffline(true)` y, en `android.spec.ts`, el bloqueo estricto de **toda**
  petición, incluida la del service worker (`PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS`). Esto encontró un defecto real: con
  `Vary: Origin` (lo que responde `vite preview`) el service worker no encontraba sus propios archivos y la app abría en blanco
  sin red; corregido con `ignoreVary` y cubierto por la prueba de arranque en frío. *Real en Android (NO probado):* modo avión
  con la app instalada, cerrada y reabierta (`docs/ANDROID.md`).
- **Teclado.** *Emulado:* se encoge la ventana 300–340 px como hace Chrome con `interactive-widget=resizes-content`.
  *Real (NO probado):* teclado de Android, autocorrección, gesto «atrás».
- **Reinicio.** *Real en Chromium:* perfil persistente cerrado y reabierto. *NO probado:* muerte de proceso de Android.
- **iPhone.** *Emulado en Chromium (NO es Safari):* tamaño de pantalla de iPhone 16, 16 Pro Max y SE, vertical y horizontal; proporción
  de píxeles 3; «user agent» de iPhone; pantalla táctil; `navigator.standalone`; las zonas seguras (isla dinámica y barra de inicio)
  se **simulan** escribiendo las variables CSS que lee la app (`env(safe-area-inset-*)` no se puede forzar desde fuera); el teclado de
  Safari, que no encoge la pantalla, se simula con un `window.visualViewport` **falso**; la hoja de compartir también es simulada.
  Esto prueba que la app reacciona bien a esas medidas, **no** que Safari las entregue así. *Real (NO probado):* instalar en la
  pantalla de inicio, cómo pinta WebKit, la barra de estado translúcida, el teclado de iPhone, el modo avión real, el menú de
  compartir, la persistencia del almacenamiento y los fallos propios de iOS 26 (`docs/IPHONE.md`).

## Incidentes de prueba y cómo se resolvieron

1. **Toque perdido por `:has(:focus)`** (arriba). Hallado por las 26 E2E originales.
2. **Hojas inertes:** `setInert` marcaba `<main>` y las hojas se pintan dentro de `<main>`; sus botones no respondían (lo
   hallaron las E2E de restaurar respaldo). Ahora se marcan los *hermanos* de la hoja.
3. **Botones «$200» y «Borrar» se salían 5 px de la pantalla a 360 px** (rejilla `1fr`). Hallado por el barrido de desbordamiento.
4. **Campo enfocado tapado** por las pestañas o la barra de registro (sin `scroll-padding`).
5. **Offline real roto con `Vary: Origin`** (ver arriba), no visible con `setOffline` solo.
6. **Respaldo propio no restaurable:** el esquema de validación aplicaba los topes de *captura* a datos históricos; un
   «1 000 000 kg» tecleado por error en la versión 1 impedía restaurar. Ahora hay topes históricos más amplios y la
   auditoría avisa de lo que hoy no se podría capturar.
7. **«Última venta» obsoleta tras restaurar**, recordatorio de respaldo que no se refrescaba, plurales («1 ventas»), «Cancelar»
   que arrastraba cantidad y motivo a otro producto, vista previa de clasificación distinta de lo guardado, calibres con
   escritura libre, pesada de 0 kg aceptada y captura en curso perdida por ello, etiqueta del borrador descartado, aviso
   (toast) que tapaba el botón principal, hojas de Caja y Vales sin foco ni nombre, Escape sin efecto, doble toque con avisos
   en rojo sobre un éxito. Todos reproducidos por una prueba, corregidos y vueltos a probar (ver el código y `git diff`).
8. **Pruebas que codificaban el comportamiento anterior** (se actualizaron, no se debilitaron): total imposible (ahora la
   Caja avisa antes y no deja cobrar), singular/plural, vista previa «Sin semilla», esperas de los escudos de toque.
9. **v1 (histórico):** `rtk` resumió «21/21» y ocultó un `AbortError` sin capturar; se corrigió con `runRw` y desde entonces
   las corridas de validación son sin filtro. Un respaldo dañado borraba datos al restaurar (reproducido y corregido).

## Mutantes: ¿las pruebas detectan defectos reales?

Se aplicó, **uno por uno y en una copia temporal del proyecto** (nunca en el código real), cada uno de estos 29 cambios
defectuosos, y se corrieron las pruebas unitarias y, si ninguna fallaba, la E2E correspondiente (script de la sesión, no
incluido en el repositorio). Resultado: **28 detectados** (17 por unitarias, 11 por E2E) y **1 sobrevivió**.

| Mutante | Defecto introducido | Lo detecta |
|---|---|---|
| M1 | confirmar una recepción suma los kilos DOS veces al inventario | unitarias |
| M2 | se quita la idempotencia: una recepción ya confirmada con el mismo id ya no se reconoce como repetida | unitarias |
| M3 | descartar un borrador modifica las existencias | unitarias |
| M4 | computeNet en modo directo suma envases × peso al neto capturado | unitarias |
| M5 | anular una recepción no resta los kilos (signo invertido) | unitarias |
| M6 | restaurar un respaldo NO vacía las recepciones actuales (se mezclan) | unitarias |
| M7 | validateBackup ignora las recepciones del archivo | unitarias |
| M8 | la migración 2 BORRA los movimientos de inventario existentes | unitarias |
| M9 | un vale descuenta el inventario físico al venderse (en vez de solo reservar) | unitarias |
| M10 | el folio de recepción no avanza | unitarias |
| M11a | el día de una recepción se calcula en UTC, no en la hora local | unitarias |
| M11b | corregir la fecha de llegada recalcula el día en UTC | unitarias |
| M12 | la pantalla de recepción precarga 15 kg por arpilla | E2E |
| M13 | las hojas no se «arman»: el segundo toque de un doble toque confirma sin que se vea la hoja | E2E |
| M14 | el service worker no ignora Vary (la app abre en blanco sin red real) | E2E |
| M15 | la «Última venta» de la Caja no se refresca tras restaurar un respaldo | E2E |
| M16 | el respaldo vuelve a rechazar cantidades históricas (tope de captura) | unitarias |
| M17 | al descartar un borrador no se guarda qué limón era | unitarias |
| M18 | los calibres se canonizan sin ignorar espacios ni × | unitarias |
| M19 | el temporizador del aviso borra por texto: dos avisos iguales seguidos se cortan | E2E |
| M20 | «Cancelar» un movimiento de Inventario deja la cantidad y el motivo para el siguiente producto | E2E |
| M21 | Escape ya no cierra las hojas | E2E |
| M22 | el modo teclado se activa siempre que hay un campo enfocado (aunque no haya teclado real) | E2E |
| M23 | la Caja deja abrir la hoja de cobro con un total que la base rechazaría | E2E |
| M24 | Vales: el segundo toque de «Entregar» llega a la base (aviso de error engañoso) | E2E |
| M25 | la auditoría cuenta los duplicados ocultos y vacíos (el consejo «ocultar uno» no se puede cumplir) | unitarias |
| M26 | registrar/guardar borrador regaña con un error tras un doble toque | sobrevivió |
| M27 | Más: el recordatorio de respaldo no se refresca al cambiar los datos | E2E |
| M28 | la restauración permite que el folio de recepción retroceda | unitarias |

- **M26 sobrevivió**: quitar la guarda contra el segundo toque en `explainMissing` no hacía fallar nada porque el escudo de la
  hoja ya absorbe ese toque; además la guarda podía tragarse un aviso legítimo. Se **eliminó** (y se acotó la guarda restante a
  «Guardar borrador» y «＋ Sumar», que sí la necesitan).
- **M11 (día en UTC en vez de hora local)** y **M4 (neto directo + envases × peso)** sobrevivían a TODAS las pruebas anteriores
  (Vitest corre en UTC y las E2E fijan el reloj al mediodía); `tests/unit/mutantes.test.ts` las cubre con `TZ=America/Mexico_City`
  y llegadas de las 21:30.
- Además hay una **simulación aleatoria con oráculo independiente** (`tests/unit/simulacion-recepciones.test.ts`: 3 semillas × 320
  operaciones de recepciones, borradores, correcciones, anulaciones, ventas, vales, conteos y respaldos de ida y vuelta; el modelo
  en memoria no lee la base y se compara tras cada operación).

## Mutantes de la ronda de iPhone y fletes

Misma técnica de arriba (copia temporal del proyecto, **un defecto por vez**, script de la sesión que no está en el repositorio):
34 defectos introducidos a propósito. Resultado final: **34 detectados** (17 por unitarias, 13 por E2E y 4 por `verify-pwa`), 0
sobrevivientes. Aviso de honestidad: **F19 sobrevivió en la primera pasada** (quitar la guarda contra el doble toque de «Guardar
flete» no hacía fallar nada, porque el guardado es idempotente por `id` y la prueba aceptaba cualquier aviso que dijera «guardado»);
se reforzó la prueba para exigir el aviso exacto y entonces sí lo detecta.

| Grupo | Defectos introducidos (todos detectados) |
|---|---|
| Cuentas de fletes (F1–F9) | neto = bruto **+** tara · diferencia con el signo invertido · porcentaje contra el peso final · porcentaje truncado en vez de redondeado · límites del rango (200 / 300 kg exactos) contados fuera · el folio distingue mayúsculas · tara igual al bruto aceptada · neto cero aceptado |
| Datos de fletes (F10–F16) | corregir sin pedir motivo · anular **borra** el flete · crear con un folio ya usado · un respaldo «versión 2» que trae fletes se acepta · la auditoría no recalcula el neto · la diferencia dentro del rango se llama «Deshidratación normal» · restaurar un respaldo no restaura los fletes |
| Pantalla de fletes (F17–F19) | dice «guardado» **antes** de guardar · la captura a medias no sobrevive a recargar · doble toque sin la guarda de «ocupado» |
| Teclado y pantalla del iPhone (I1–I6, I13) | sin `touch-action: manipulation` · el teclado ya no publica `--kb` · la barra de registro ignora `--kb` · las hojas no suben sobre el teclado · el encabezado ignora la muesca · campos de 15 px · horizontal sin diseño compacto |
| Paquete instalable (I7–I11) | falta el `apple-touch-icon` · el manifest bloquea la orientación · el service worker guarda respuestas al vuelo · sin `viewport-fit=cover` · el aviso de iPhone sale en Android |
| Datos y actualización en iPhone (I12, I14, I15) | al volver a la app no se comprueba la conexión a la base · «Compartir respaldo» arma el archivo después del toque · el aviso de versión nueva sin «Actualizar ahora» |

Esto demuestra que **estas** pruebas detectan **estos** defectos; no que no existan otros.

## Revisión independiente

- **Hecho:** cuatro agentes de QA escribieron y ejecutaron las pruebas nuevas por área y reportaron 26 defectos con evidencia
  (todos corregidos y vueltos a probar); revisiones adversarial, de arquitectura, seguridad, QA y UX de las fases anteriores.
- **NO completado:** la revisión adversarial independiente del código FINAL (integridad y seguridad, usabilidad en Android y
  calidad de las pruebas) se interrumpió por el límite de uso de la sesión y no entregó hallazgos. Está sustituida por los
  mutantes y la simulación de arriba, y **no equivale** a una revisión humana independiente antes de operar con dinero real.

## Cierre

`npm run check` terminó con código de salida 0 (tipos, 410 unitarias, build, `verify:pwa` y 398 E2E). Lo que **no** se pudo
hacer: la revisión independiente del código final (arriba) —**tampoco se hizo para los cambios de iPhone y fletes**— y cualquier
prueba en un iPhone o un Android físicos. Que todo esté en verde en Chromium **no** quiere decir «lista para producción».

## No probado / no verificable aquí

- **iPhone físico y Safari (WebKit):** todo lo del párrafo «iPhone» de arriba. La lista de comprobación física está en
  `docs/IPHONE.md` y **ninguna casilla está marcada**.
- **Teléfono Android real:** instalación, modo avión real, teclado real, gesto «atrás», almacenamiento persistente,
  rendimiento. La lista está en `docs/ANDROID.md`.
- **Una dirección publicada:** no existe ninguna. `verify:deploy` se probó solo contra servidores locales (HTTP); sus
  comprobaciones propias de HTTPS (HSTS, redirección de http a https) **no se ejercitaron** contra un servidor HTTPS real.
- **Dos dispositivos sincronizados:** no hay servidor ni sincronización (`docs/ARQUITECTURA-COMPARTIDA.md` es un diseño).
- **Fotos de la boleta o la báscula:** no están implementadas.
- Otros navegadores (solo Chromium).
- Cuota de almacenamiento realmente llena (se simula el fallo de escritura).
- Letra grande del sistema (a ×1.3 las etiquetas de las pestañas pueden rebasar su caja unos píxeles).
- Uso prolongado con miles de ventas (se probó restaurar 3 000 ventas en ~3 s de escritorio).
- El rango de 200–300 kg es una **referencia sin validar** con datos reales del negocio.
