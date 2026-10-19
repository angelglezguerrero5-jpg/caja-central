# Recepción de mercancía — guía para quien opera la tienda

Esta guía es para usar la app, no para programarla. Si algo no queda claro, la pantalla siempre te dice qué falta
antes de dejarte registrar.

## 1. Para qué sirve (y para qué no)

**Sirve para** anotar los kilos de limón que **llegan** al puesto (camión, caja, arpilla o a granel) y que esos kilos
**sumen al inventario una sola vez**.

**No sirve para** (todavía) anotar cuánto costó, cuánto se le debe a quien lo mandó ni pagarle. Registrar una
recepción **no es un pago** y **no mueve el dinero de la caja ni el corte**. Eso queda fuera a propósito.

Dos reglas que la app cumple siempre:

1. **Nada suma al inventario hasta que tú confirmas.** Llenar el formulario no cambia nada; el botón
   «Registrar recepción» solo abre una hoja de revisión, y los kilos entran hasta que tocas **Confirmar**.
2. **Nada se borra a escondidas.** Si te equivocas, se corrige o se anula y queda el rastro (qué había, qué cambió,
   cuándo y por qué).

## 2. Primero: tus tipos de limón

Cada combinación que manejas con su propio precio y su propio inventario es una **clasificación**. Se da de alta en
**Inventario → Nueva variedad** (o desde la propia Recepción con **＋ Nueva clasificación**, sin salir de la pantalla).

| Campo | Qué es | ¿Obligatorio? |
|---|---|---|
| Tipo de limón (variedad) | Sin semilla, Con semilla u otro que escribas | **Sí** |
| Origen | Oaxaca, Michoacán u otro que escribas | No |
| Calidad | Primera, Segunda, Tercera u otra que escribas | No |
| Calibre o tamaño | 1X, 2X, 3X, 200, 300, 400, 500 u otro que escribas | No |
| Precio por kilo | Tu precio de venta | No: puedes dejar «Sin precio todavía» y ponerlo en Caja antes de vender |

- Los botones (chips) solo **rellenan** el texto: todo se puede escribir a mano.
- **La app no supone nada por ti.** Elegir «Oaxaca» no pone «segunda»; elegir «2X» no pone un calibre numérico;
  1X/2X/3X y 200–500 son listas distintas y la app **no** las convierte entre sí. Si manejas «Torreones», escríbelo
  en Calidad o en Calibre, donde tú lo uses; después te lo sugiere dentro de esa misma variedad.
- Si repites una clasificación que ya existe, la app te avisa («Ya existe esta clasificación») y **no crea otra**.
- Escribir «Limón con semilla» queda guardado como la variedad **Con semilla** (así se muestra en toda la app).

## 3. Registrar lo que llegó, paso a paso

Pestaña **Recepción → Nueva**. Son cuatro pasos en una sola pantalla:

1. **¿Qué limón llegó?** Toca el tipo y, si tiene varias clasificaciones, la clasificación. Debajo aparece cuánto hay
   «en bodega ahora» de ese limón.
2. **¿Cómo llegó?** A granel, caja o arpilla.
3. **¿Cuánto pesa?** Tres formas, elige la que te sirva (nunca se mezclan ni se suman entre sí):
   - **Ya tengo los kilos netos**: escribe los kilos de limón (sin caja ni costal). Si pesaste por partes, usa
     **Sumar varias pesadas**: cada pesada se anota y se suma sola.
   - **Cajas (o arpillas) × kilos de cada una**: cuenta las cajas y escribe cuánto limón trae **cada** una; se
     admiten decimales (por ejemplo 12.5). *La app no supone ese peso*: ni siquiera el de 15 kg de la arpilla viene
     puesto; si ya lo capturaste antes, te ofrece reusarlo con un toque.
   - **Con envase − envase vacío**: peso **bruto** (todo junto) menos la **tara** (lo que pesa el envase vacío) =
     kilos **netos**.
4. **Datos del lote (opcional)**: proveedor (te sugiere los recientes), camión o referencia, fecha y hora de llegada
   (por defecto ahora; con **Ayer** retrocede un día) y observaciones.

La barra de abajo siempre muestra los **kilos netos** y el botón **Registrar recepción**. Si falta algo, el botón te
dice qué falta y te lleva ahí (no se queda «muerto»).

Al tocarlo se abre la hoja **Confirmar recepción**: tipo de limón, kilos, presentación, cómo se calculó y
**«En bodega: 80 kg → 200 kg»**. Si todo está bien, **Confirmar**. Después verás «Recepción R-3 registrada: +120 kg»
y el formulario queda limpio.

- **No pasa nada si tocas dos veces** o si se va la señal a media operación: la recepción se registra **una sola
  vez**. Si ya estaba registrada, la app te lo dice («ya estaba registrada como R-3… No se sumó otra vez»).
- Si llegaron **varias clasificaciones en el mismo camión**, usa **＋ Otra clasificación del mismo camión**: conserva
  proveedor y referencia.
- Si recargas la página o cierras la app a medias, lo que estabas capturando **se recupera** (te avisa con
  «Recuperé lo que estabas capturando»).

## 4. Si todavía no sabes el peso: borrador

Puedes **Guardar borrador** sin peso (por ejemplo, llegaron las cajas pero aún no se pesan). Un borrador:

- **no suma al inventario**; lo dice en pantalla;
- aparece en **Recepción → Borradores** (y como un número rojo sobre la pestaña);
- se abre con **Abrir y completar** cuando ya tengas el dato, y se registra como cualquier otra;
- se puede **Descartar**: queda en el historial como «Descartada» y no cambia el inventario.

## 5. Avisos antes de registrar

La hoja de confirmación puede mostrar avisos en ámbar. No son errores: te piden que mires dos veces.

- **Posible recepción repetida**: ya hay una con la misma referencia hace menos de 48 horas, o mismo proveedor y kilos
  el mismo día, o los mismos kilos hace pocos minutos.
- **Ya se contó el inventario después de esa llegada** (al corregir o anular): el conteo físico posterior ya incluye esa
  mercancía; corregir ahora puede descuadrarlo.
- **Entrada manual igual**: acabas de dar de alta esos kilos como «entrada» en Inventario.

Si estás seguro, toca **Registrar de todos modos**; quedará anotado que reconociste el aviso. Si no, **Volver**.

## 6. Me equivoqué: corregir sin borrar

**Recepción → Historial** muestra lo registrado (filtros: Registradas, Anuladas, Descartadas, Todas; búsqueda por
folio, proveedor, referencia o tipo). En cada recepción registrada:

| Botón | Para qué | Efecto en el inventario |
|---|---|---|
| **Corregir kilos** | Los kilos estaban mal | Suma o resta **solo la diferencia**, con un movimiento de corrección y tu motivo (obligatorio). El original se conserva |
| **Corregir datos** | Proveedor, referencia, fecha, observaciones o número de envases | Ninguno (solo cambia el dato; queda anotado cuál era el anterior) |
| **Anular** | La recepción no debió registrarse | Resta los kilos con un movimiento de anulación y tu motivo |
| **Anular y copiar a borrador** | Te equivocaste de tipo de limón | Anula y deja un borrador listo para elegir el limón correcto |
| **Detalle** | Ver los movimientos de inventario que causó | — |

Si anular o corregir dejara el disponible en negativo, la app te lo muestra y pide tu autorización explícita.

## 7. Resumen de kilos

**Recepción → Resumen** muestra kilos recibidos por día, vendidos por día y lo disponible hoy, con desglose por
variedad, calidad, calibre y presentación (abre cada sección para verla) y las diferencias por mermas y conteos.
**Son kilos, no dinero**: no se mezclan con las ventas del corte de caja.

## 8. Sin internet y respaldos

- La app funciona **igual sin internet**, también la recepción.
- **Más → Exportar respaldo** ahora incluye las recepciones. Hazlo todos los días al cerrar.
- **Restaurar desde archivo** te muestra primero qué trae el archivo y qué tienes hoy (y avisa si perderías algo);
  hasta que confirmes no cambia nada. Antes de reemplazar, la app guarda una copia de lo que tenías y puedes
  **Deshacer: volver a ese estado** (las últimas 3).
- Si la app no abre la base de datos, **no borres los datos ni desinstales**: toca **Descargar copia de emergencia de
  mis datos** y pide ayuda con ese archivo.
- Un respaldo de la versión anterior de la app se puede restaurar sin problema.

## 9. Glosario

- **Neto**: kilos de limón solamente.
- **Bruto**: limón + envase. **Tara**: lo que pesa el envase vacío. Neto = bruto − tara.
- **A granel**: sin envase. **Caja** (limonera) y **arpilla** (costal): envases; el número de envases se anota aparte
  de los kilos y **nunca** se convierte en kilos sin un peso que tú captures.
- **Borrador**: recepción sin sumar. **Registrada**: ya sumó. **Anulada**: se restó. **Descartada**: borrador que se tiró.
- **Folio R-n**: número consecutivo de cada recepción registrada.

## 10. Decisiones que la app NO tomó por ti (te las dejo preguntadas)

1. ¿El **tamaño** (1X–3X) y el **calibre** (200–500) se manejan **juntos** en un mismo producto o son cosas distintas?
   Hoy son un solo campo libre «Calibre o tamaño»; si lo necesitas separado, hay que agregar un campo.
2. ¿Cuánto pesa realmente una **caja limonera** de limón? Hoy se captura cada vez (o se usa «bruto − tara»).
3. ¿«Oaxaqueño» y «Michoacano» son una **procedencia** (como están) o un **tipo** de limón?
4. ¿Qué es exactamente **«Torreones»** y cómo se relaciona con «primera» y con los calibres? Hoy se escribe donde tú
   decidas.
5. ¿Se usa **un solo teléfono**? Con dos no hay sincronización: cada uno tendría su propio inventario.
6. ¿Quieres llevar **costo de compra y pago a proveedores**? Está fuera de esta versión a propósito.

*Nada de esto se probó en un Android físico todavía; ver `docs/ANDROID.md` para la prueba en el teléfono.*
