# Diseño: clasificación de limones y recepción de mercancía (v2, app 0.2.0)

> **Nota (app 0.3.0):** este diseño describe la versión 0.2.0 (base y respaldo de formato 2). Desde la 0.3.0 la base y el respaldo son de la **versión 3**, que agrega los fletes (ver [`FLETES.md`](FLETES.md)); todo lo de aquí sigue igual y los respaldos de formato 1 y 2 se siguen aceptando.

Estado: **IMPLEMENTADO** (sin commit; ver `docs/PRUEBAS.md` para lo verificado y lo pendiente). Alcance: adaptar la app
existente (no reescribirla) a un negocio mayorista de limón en la Central de Abasto de CDMX.

Etiquetas: **[CONFIRMADO]** lo dijo el contacto del negocio · **[REFERENCIAL]** dato orientativo, no obligatorio ·
**[NO DEFINIDO]** no se sabe: la app lo deja configurable y no lo asume · **[DECISIÓN]** elección de diseño.

## 1. Lo que dijo el negocio (y lo que NO se asume)

| Tema | Dato | Tratamiento en la app |
|---|---|---|
| Tipos | Limón sin semilla; limón con semilla [CONFIRMADO] | Presets de *variedad* + texto libre |
| Procedencia (con semilla) | Oaxaqueño: más grueso, cáscara marcada, "normalmente" calidad inferior. Michoacano: más fino [CONFIRMADO como apreciación] | Presets de *procedencia* **solo como etiqueta**. NUNCA se deduce una calidad ni un precio de la procedencia |
| Tamaños | 3X triple (más grande) > 2X doble > 1X (más pequeño de los tres) [CONFIRMADO] | Presets de *calibre* |
| Calibres | 200, 300, 400, 500; el 500 es el más pequeño [CONFIRMADO] | Presets de *calibre* |
| Equivalencia 1X/2X/3X ↔ 200–500 | [NO DEFINIDO] | **No existe ninguna conversión** en el código. Son valores distintos del mismo campo libre |
| Calidad | Primera, Segunda, Tercera [CONFIRMADO] | Presets de *calidad* |
| "Torreones" | Término comercial, ligado a sin semilla y tamaño pequeño; su relación con "primera" y con los calibres [NO DEFINIDO] | **Sin preset.** Se escribe como calidad o calibre personalizados donde el usuario decida; luego queda como sugerencia (solo dentro de la variedad donde se usó). No se impone a ninguna variedad |
| Presentación | A granel, caja limonera negra, arpilla [CONFIRMADO] | `Packaging = granel \| caja \| arpilla` |
| Arpilla | "Normalmente" 15 kg [REFERENCIAL] | **No se precarga.** El peso por envase siempre lo captura el usuario (se ofrece reutilizar su último valor real para esa clasificación y presentación) |
| Peso de la caja | [NO DEFINIDO] | Exige kilos netos, peso por caja capturado o bruto − tara; si no se conoce → borrador |
| Kilos por calibre, precios | [NO DEFINIDO] | La app no trae precios ni existencias; todo se captura |

## 2. Modelo de datos

Principio: **extender, no duplicar**. Un `Product` ya es "la combinación operativa con su propio precio e inventario";
se le añaden campos de clasificación. No se crea una entidad de catálogo aparte.

```ts
Product {            // ya existente
  name: string       // = Variedad / tipo (ej. "Sin semilla", "Con semilla", o texto propio)
  quality?: string   // Primera / Segunda / Tercera / personalizada
  origin?: string    // opcional: Oaxaca / Michoacán / personalizada
  caliber?: string   // opcional: 1X 2X 3X 200 300 400 500 / personalizado
  unit, priceCents, active, sort, physicalMilli, reservedMilli, updatedAt
  classEdits?: Array<{ at, before: Classification, after: Classification }>  // bitácora de cambios de clasificación
}
```

* "No especificada / Sin clasificar / No especificado / N/A" = **campo ausente** (`undefined`). Una sola representación
  de "desconocido" evita duplicados ('' vs 'No especificada').
* `priceCents = 0` significa **"sin precio todavía"** (al recibir mercancía de una clasificación nueva no se inventa un
  precio). La caja no deja cobrar hasta capturar un precio > 0.
* **Identidad / duplicados** [DECISIÓN]: clave = `varietyKey(name) | key(origin) | key(quality) | caliberKey(caliber) | unit`.
  `key()` = sin acentos, minúsculas, espacios colapsados; `varietyKey` además ignora un "limón"/"limones" inicial
  ("Limón sin semilla" ≡ "Sin semilla"); `caliberKey` ignora espacios, prefijo "calibre"/"cal."/"#" y trata "×" como "x"
  ("3 X" ≡ "3X", "Calibre 300" ≡ "300") **sin mezclar nunca** los tamaños (1X–3X) con los números (200–500).
  Dos productos con la misma clave **no pueden coexistir** (se rechaza al guardar).
* **Canonización** (`canonicalizeClass`, `src/domain/classification.ts`): lo escrito se normaliza contra los atajos y los
  valores ya usados, con alias ("oaxaqueño" → Oaxaca, "michoacana" → Michoacán; solo comodidad de escritura). La usan
  **el guardado y la vista previa «Quedará como»** del formulario, así que lo que se muestra es exactamente lo que se guarda
  y el aviso de duplicado aparece antes de guardar.
* Texto de clasificación: ≤ 40 caracteres, sin caracteres de control ni invisibles, espacios recortados/colapsados.
* **Editar** una clasificación existente se permite (corregir un error de captura), con las mismas reglas de duplicado y
  con bitácora `classEdits`. Cambiar la **unidad** de un producto con movimientos está **prohibido**. Las ventas y
  recepciones anteriores conservan la clasificación con la que se hicieron (foto).
* Las ventas guardan además `SaleItem.cls` (foto, opcional → ventas anteriores siguen válidas).

### Presets (configurables = escribir otro valor; los valores usados quedan como sugerencias)
Variedad: Sin semilla · Con semilla · Otra (texto). Procedencia: Oaxaca · Michoacán · Otra (texto) · No especificada.
Calidad: Primera · Segunda · Tercera · Otra (texto) · Sin clasificar. Calibre: 1X · 2X · 3X · 200 · 300 · 400 · 500 ·
Otro (texto) · No especificado. Los chips solo rellenan el campo de texto (única fuente de verdad = el texto).

## 3. Recepción de mercancía

Entidad `Reception` (store `receptions`). Es **el documento**; el inventario se mueve solo por un `StockMove` enlazado
(`receptionId`).

```ts
type Packaging = 'granel' | 'caja' | 'arpilla'
type WeightMode = 'directo' | 'por_envase' | 'bruto_tara'
type ReceptionStatus = 'borrador' | 'confirmada' | 'cancelada' | 'anulada'

Reception {
  id, folio? (R-n, se asigna al confirmar), status, createdAt, updatedAt,
  receivedAt (ISO, editable, no futura), day (YYYY-MM-DD local),
  supplier?, reference? (camión/referencia), notes?,
  productId?, productLabel? (foto al confirmar o al descartar el borrador), cls? (foto al confirmar),
  packaging, containers? (entero ≥1; no aplica a granel),
  weightMode,
  netDirectMilli?, weighingsMilli?[]   // directo (con ≥2 pesadas cuya suma es el neto, opcional)
  unitNetMilli?                        // por_envase  (neto por caja/arpilla, admite decimales)
  grossMilli?, tareMilli?              // bruto_tara  (neto = bruto − tara)
  netMilli?                            // kilos netos vigentes (calculado, nunca introducidos dos veces)
  confirmedAt?, confirmedNetMilli?, stockMoveId?,
  corrections[]: { id, at, reason, previousNetMilli, newNetMilli, deltaMilli, stockMoveId }   // de KILOS
  dataEdits?[]:  { id, at, reason, changes[{field, before, after}] }                         // de DATOS, sin efecto en kilos
  acknowledged?[]: { at, op: 'confirmar'|'corregir'|'anular', warnings[] }                   // avisos que la persona reconoció
  cancelledAt?, cancelReason?, voidedAt?, voidReason?, voidStockMoveId?
}
```

### 3.1 Peso: tres modos **excluyentes** (no se suman)
1. **Neto directo**: el usuario escribe los kilos netos pesados (o «Sumar varias pesadas»: cada pesada > 0, hasta 100).
2. **Envases × neto por envase**: `containers × unitNetMilli` (aritmética entera exacta; admite 15.5 kg). Requiere `caja` o `arpilla`.
3. **Bruto − tara**: `grossMilli − tareMilli` (> 0).
Solo se guardan los campos del modo activo; al cambiar de modo se descartan los demás. `containers` puede registrarse
en cualquier modo como dato informativo (no suma kilos). No se convierte nunca un envase a kilos sin un peso capturado:
sin peso → **borrador**.

### 3.2 Estados y operaciones
* `borrador` → editable, **sin efecto en inventario**, puede estar incompleto (sin peso/producto).
* `confirmada` → un solo movimiento `recepcion` (+neto) enlazado; asigna folio R-n.
* `cancelada` → solo desde borrador (`cancelReceptionDraft`); no toca inventario; se conserva el registro, con motivo
  opcional y la etiqueta del limón que era.
* `anulada` → reversa auditada de una confirmada (`reversa_recepcion`, −neto vigente), con motivo (`voidReception`).
* **Corrección de kilos** (`correctReception`) → movimiento `correccion_recepcion` (± diferencia) + entrada en
  `corrections[]` con motivo; el movimiento original NO se borra ni se edita.
* **Corrección de datos** (`annotateReception`) → proveedor, referencia, fecha, observaciones, número de envases: queda
  el antes y el después con motivo (`dataEdits`); no mueve inventario.
* **Anular y copiar a borrador** (`voidAndCopyToDraft`) → corregir un tipo de limón equivocado en una sola transacción:
  anula la recepción y deja un borrador con los mismos datos de llegada y pesos pero SIN el tipo de limón, listo para
  elegir el correcto (rastro en ambos).
* Anular/corregir a la baja que dejaría el **disponible negativo** requiere autorización explícita (número = el disponible
  que se le mostró a la persona; queda en `StockMove.authorizedNegativeAfterMilli`).
* Si después de la recepción hubo un conteo físico o una merma de esa clasificación, corregir/anular **avisa** (el conteo
  pudo incluir esos kilos) y exige reconocerlo; queda en `acknowledged`.

### 3.3 Idempotencia y duplicados
* Cada formulario genera un `id` al abrirse (y se conserva al recargar); `confirmReception` con un id ya **confirmado**
  NO vuelve a sumar (`DuplicateReceptionError`, la UI lo trata como éxito) y con el mismo id pero **otro contenido**
  lanza `ReceptionIdConflictError` (nunca se da por buena). Cubre doble toque, reintentos y la misma captura en dos ventanas.
* Posible duplicado *lógico* (otro id, mismo contenido): misma `reference` + mismo producto dentro de 48 h; mismo
  proveedor + producto + kilos netos + día; o mismos kilos del mismo producto en menos de 10 minutos. Se **advierte ANTES de
  confirmar** (`previewReceptionWarnings`) y exige reconocimiento explícito (`acknowledgeDuplicate`).
  Otros avisos: ya hubo un conteo físico después de la llegada; una entrada manual igual en las últimas 24 h.
* Todo en **una transacción** (reception + producto + stockMove + folio). Cualquier excepción revierte todo (`runRw`,
  durabilidad `strict`).
* **Interfaz**: «Registrar recepción» solo abre una hoja de revisión; los botones de la hoja ignoran los toques los primeros
  0.45 s y la pantalla de fondo los ignora 0.45 s tras cerrarla (escudo contra el «toque fantasma» de un doble toque:
  el segundo toque no debe confirmar una hoja que la persona no alcanzó a ver).

### 3.4 Límites (validación en dominio y en repositorio)
Neto ≤ 200 000 kg; envases ≤ 100 000; ≤ 100 pesadas; cantidades en milésimas enteras, ≤ 3 decimales; sin negativos,
vacíos, NaN, ni notación científica; **«1,500» es ambiguo y se rechaza** (se pide 1500 o 1.5); proveedor ≤ 120, referencia
≤ 60, notas ≤ 500, motivos ≤ 300 caracteres; fecha válida y no futura (+5 min).
Captura de ventas: cantidad por renglón ≤ 200 000 kg y precio ≤ $100 000 por unidad; dinero (efectivo, fondo, contado,
salida) ≤ $1 000 000 000; saldo de inventario ≤ 1 000 000 t. **Para datos YA guardados** (respaldos y bases migradas) el
tope es más amplio (`HIST_*` en `src/domain/money.ts`): la versión 1 no tenía topes y un error de dedo (p. ej. 1 000 000 kg)
pudo quedar en el historial; el respaldo que la propia app exporta **siempre** se puede restaurar, y la auditoría avisa
de lo que hoy no se podría capturar.

### 3.5 Producto de destino
Solo productos activos con **unidad kg** (el inventario de cajas/arpillas/piezas se maneja con entradas manuales en su
unidad; no hay conversión automática). Si la clasificación no existe, se crea en el momento (precio opcional).

## 4. Inventario
`Disponible = físico − reservado` (sin cambio). Tipos de movimiento: `entrada`, `merma`, `ajuste`, `venta`, `reserva`,
`entrega_vale`, `anulacion`, y los de recepción: `recepcion`, `correccion_recepcion`, `reversa_recepcion` (+
`StockMove.receptionId`). Identidad contable por producto:
`físico = recepciones netas + entradas manuales − ventas netas − mermas ± ajustes`. Las entradas de una recepción NO se
vuelven a sumar como "entrada manual" (tipos distintos). Los **envases** (cajas/arpillas) se cuentan aparte en la
recepción y en reportes; nunca alimentan el inventario en kg.

## 5. Persistencia, respaldo y seguridad
* `DB_VERSION` 1 → **2**. Migración 2: crea el store `receptions` (+ índices `byStatus`, `byDay`, `byProduct`, `byFolio`
  único) y el índice `stockMoves.byReception`. No toca productos, ventas, vales, turnos ni movimientos (campos nuevos
  opcionales). Idempotente, no destructiva; si falla se revierte y la base queda en v1 intacta. Una base de versión MÁS
  NUEVA que la app muestra un panel de ayuda con copia de emergencia y no se borra ni se baja de versión.
* `meta.nextReceptionFolio` (default 1). Los contadores de folio **nunca bajan** al restaurar (max(archivo, actual)).
* **Respaldo v2**: añade `receptions` y `nextReceptionFolio`. Se siguen aceptando respaldos **v1** (se normalizan); un v1
  con recepciones se rechaza (formato mixto). Validación estricta de forma (un solo esquema por tipo de registro que
  también copia solo los campos conocidos; fechas ISO estrictas; enteros seguros con tope), tamaño ≤ 25 MB, antes de
  tocar nada. Restauración atómica.
* **Antes de restaurar**, la app guarda una copia de lo que hay en una base interna aparte (`venta-limones-undo`, últimas
  3) y permite **deshacer**; si esa copia no se puede guardar, no se restaura.
* **Copia de emergencia** (`dumpRawDatabase`): descarga lo que haya en la base sin aplicar el esquema, cuando la app no
  puede abrirla; nunca crea una base.
* **Auditoría** (Más → Auditar integridad): cada recepción confirmada tiene exactamente un movimiento `recepcion` con su
  `receptionId` y `delta = confirmedNetMilli`; Σ correcciones coincide con sus movimientos; anulada ⇒ reversa;
  borrador/cancelada ⇒ cero movimientos; folios únicos y < `nextReceptionFolio`; `netMilli = confirmed + Σ correcciones`
  (o 0 si anulada); ningún movimiento apunta a una recepción inexistente; la identidad contable por producto; las ventas
  cuadran contra sus movimientos. **Avisos** (no son errores): clasificaciones duplicadas en uso, textos largos heredados,
  existencia disponible negativa (con o sin autorización registrada), valores por encima de los topes de captura actuales.
* Sin servicios externos, cuentas, pagos, claves ni dependencias nuevas. Texto de usuario siempre escapado por Preact
  (no hay `dangerouslySetInnerHTML`); CSP con `style-src 'self'`.

## 6. Interfaz
Pestañas: Caja · Vales · **Recepción** · Inventario · Corte · Más (con iconos para caber en 360 px). `Caja` y `Recepción`
permanecen montadas (no pierden la captura al mirar otra pestaña).
* **Recepción**: sub-secciones *Nueva · Borradores · Historial · Resumen*; barra fija abajo con los kilos netos y el botón.
* **Caja**: fila 1 variedad; fila 2 clasificación (origen · calidad · calibre) solo si hay varias; el resto igual
  (kg, precio editable, billetes, exacto, cambio, hoja de confirmación, vales). Un total que rebasa el máximo se avisa antes
  de abrir la hoja.
* **Inventario**: físico / reservado / disponible + recibido, entradas manuales, vendido, mermas y conteos; historial de
  movimientos por tandas (nunca recortado en silencio) con enlace a la recepción; editar clasificación/precio; alta con chips.
* **Resumen**: kilos recibidos y vendidos por día, existencia disponible, desglose por variedad/calidad/calibre y por
  presentación, ajustes y diferencias, historial. **No** se mezclan con ingresos por ventas ni con pagos a proveedor.
* **Teclado** (`src/ui/keyboard.ts`): con el teclado del teléfono abierto (la ventana se encoge: `interactive-widget=
  resizes-content`) y fuera de la Caja, las pestañas se esconden y la barra de registro baja al borde. La clase se quita
  con retraso y nunca con el dedo apoyado: un cambio de diseño en el instante en que el campo pierde el foco movía el botón
  entre el mousedown y el mouseup y **el toque se perdía** (fallo real que detectaron las E2E; ver `tests/e2e/teclado.spec.ts`).
  `scroll-padding` evita que un campo enfocado quede tapado por la barra o las pestañas.
* **Hojas** (`src/ui/Sheet.tsx`): título, cuerpo con scroll y pie fijo; fondo `inert` (se marcan los *hermanos* de la hoja,
  no `<main>`, que la contiene); foco al botón principal habilitado y de regreso al cerrar; Escape = «Volver».
* Avisos (toast) arriba, bajo el encabezado, para no tapar el botón principal; cada aviso tiene su propio temporizador.
* **Límite conocido**: el gesto/botón «atrás» de Android no se maneja (no hay historial del navegador): con la app
  instalada puede cerrar la app en lugar de cerrar una hoja. Pendiente de validar en el teléfono.

## 7. Fuera de alcance (explícito)
Importe de compra, cuentas por pagar, pagos a proveedores, precios de compra, conversión envase→kg automática,
equivalencia 1X/2X/3X↔200–500, calificación automática por procedencia, fiado, sincronización entre teléfonos.

## 8. Matriz de pruebas (25 casos del prompt → archivos)
Los números exactos de la última corrida están en `docs/PRUEBAS.md`.

| Caso | Prueba |
|---|---|
| 1–7 catálogo (sin/con semilla, Oaxaca/Michoacán, 1X–3X, 200–500, 1ª/2ª/3ª, personalizados, no especificados) | `tests/unit/classification.test.ts`, `catalog-repo.test.ts`, `tests/e2e/clasificacion.spec.ts` |
| 8–11 recepción granel/cajas/arpillas/neto exacto | `tests/unit/reception-domain.test.ts`, `reception-repo.test.ts`, `tests/e2e/recepcion.spec.ts` |
| 12–13 duplicados / cancelada | `reception-repo.test.ts`, E2E `recepcion.spec.ts` |
| 14–15 venta y vale con kilos correctos | `reception-repo.test.ts` (integración), E2E `clasificacion.spec.ts`, `recepcion.spec.ts` |
| 16 precio independiente por clasificación | `classification.test.ts`, E2E `clasificacion.spec.ts` |
| 17 recargas y reinicio | E2E `recepcion.spec.ts`, `migracion.spec.ts` (reinicio real con perfil persistente) |
| 18–20 respaldo/restauración/anterior/corrupto | `backup-v2.test.ts`, `safety-v2.test.ts`, E2E `respaldo.spec.ts` |
| 21 tamaño Android (360×640 y 412×915, teclado abierto y cerrado) | E2E `teclado.spec.ts`, `android.spec.ts` |
| 22 offline | E2E `recepcion.spec.ts`, `android.spec.ts` (**simulado**; el real en Android sigue pendiente) |
| 23 corte sin alteraciones | `reception-repo.test.ts`, E2E `recepcion.spec.ts` |
| 24 migración con datos previos | `migration-v2.test.ts`, E2E `migracion.spec.ts` (base v1 real en el navegador y app anterior compilada) |
| 25 auditoría | `backup-v2.test.ts`, `audit-v2.test.ts`, simulación aleatoria, E2E |
| Negativas | kilos inválidos, negativos, desbordamientos, excesivos, vacíos, confirmaciones repetidas: unitarias y E2E |
