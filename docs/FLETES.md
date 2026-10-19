# Control de pesaje por flete

Guía en lenguaje sencillo. Está en **Inventario → Fletes** (la pantalla de Inventario tiene dos pestañitas arriba:
*Existencias* y *Fletes*).

## Para qué sirve (y para qué no)

Sirve para comparar, flete por flete, **lo que pesó la mercancía al salir** (origen) contra **lo que pesó al llegar**
(destino), y ver cuántos kilos y qué porcentaje cambió. Cada flete lleva un folio que no se repite, la fecha, el origen y
el destino, y como evidencia el número de boleta y el nombre de la báscula de cada pesada.

**No hace estas cosas** (por diseño):

- **No suma ni resta existencias.** Para que entren kilos al inventario se sigue usando *Recepción*. Un flete no mueve
  inventario, ventas ni caja.
- **No dice por qué hay diferencia.** Nunca la llama «merma» ni «deshidratación»: solo la compara con un rango de
  referencia. El motivo lo decides tú.
- **No guarda fotos** de la boleta ni de la báscula. Hoy solo se captura el número de boleta y la báscula como texto.
- **No se sincroniza con otro teléfono.** Los fletes viven en este teléfono (ver «Límites»).

## Las cuentas

```
peso neto            = peso bruto − tara          (o el neto directo, si solo tienes ese dato)
diferencia (kg)      = neto inicial − neto final
porcentaje           = diferencia ÷ neto inicial × 100
```

Todo se calcula en gramos enteros y el porcentaje se redondea a dos decimales. La diferencia y el porcentaje **no se
guardan**: se calculan al mostrarlos, así que siempre coinciden con los pesos capturados.

Ejemplo real del tipo de caso que maneja:

| Pesada | Bruto | Tara | Neto |
|---|---|---|---|
| Inicial (origen) | 22,000 kg | 7,000 kg | **15,000 kg** |
| Final (destino) | — | — | **14,760 kg** (solo tenías el neto) |

Diferencia = 15,000 − 14,760 = **240 kg** → 240 ÷ 15,000 × 100 = **1.60 %**.

Si el peso final sale **mayor** que el inicial, la diferencia sale negativa (por ejemplo −150 kg, −1.00 %) y la pantalla
avisa «El peso final es MAYOR que el inicial: revisa las boletas y el pesaje». No lo trata como error ni como ganancia:
solo te pide que lo revises.

## Registrar un flete

1. **Inventario → Fletes → ＋ Nuevo flete.**
2. **Folio:** la app propone uno libre (`F-AAMMDD-NN`, por ejemplo `F-261010-01`); puedes escribir el tuyo. **No se puede
   repetir**, ni cambiando mayúsculas o espacios (`abc-1` y `ABC-1` son el mismo folio).
3. **Fecha y hora**, **origen** (de dónde sale) y **destino** (a dónde llega).
4. **Peso inicial (origen):** elige *Bruto − tara* (escribes los dos y la app resta) o *Solo tengo el neto*. Opcional:
   número de boleta y báscula.
5. **Peso final (destino):** igual. **Puedes dejarlo para después**: el flete queda *Incompleto* («Falta el peso final») y no
   tiene diferencia hasta que lo captures. Lo mismo al revés si solo tienes la pesada de destino.
6. Mientras escribes, la pantalla muestra el neto de cada pesada y, con las dos, la **diferencia**, el **porcentaje** y la
   comparación con el rango de referencia.
7. **Guardar flete.** Sale el aviso «Flete … guardado» solo cuando ya quedó guardado de verdad. Si algo impide guardarlo
   (almacenamiento lleno, por ejemplo) sale un error y el formulario no se cierra.

Lo que se captura a medias en un flete **nuevo** se conserva si cambias de pantalla, se cierra la app o se recarga;
*Cancelar* lo descarta.

### Lo que la app no deja guardar

- Pesos vacíos, en cero, negativos, con letras, con más de tres decimales o en notación científica (`1e3`).
- Una coma que se puede leer de dos maneras: `1,234` **no se acepta** (¿mil doscientos treinta y cuatro o uno punto
  doscientos treinta y cuatro?); escríbelo `1234` o `1.234`. `15,5` sí se lee como 15.5.
- Tara **mayor o igual** que el peso bruto (la tara puede ser 0).
- Un peso bruto o neto de **más de 200,000 kg** (tope de sensatez; 200,000 kg exactos sí se aceptan).
- Folio, origen o destino vacíos; textos de más de 40 (folio), 120 (lugares, báscula), 60 (boleta) o 500 (observaciones)
  caracteres; una fecha futura.

La pantalla dice qué falta o qué está mal antes de que toques «Guardar».

## Completar, corregir y anular

- **Completar** (agregar el peso final que faltaba, o la boleta): botón *Registrar peso final* / *Registrar peso inicial*.
  No pide motivo; queda en la bitácora como «Se completó el registro».
- **Corregir** algo que **ya estaba capturado** (un peso, el folio, el origen, el destino, la fecha): botón *Corregir*. Pide
  **motivo** obligatorio. Guardar sin cambiar nada no registra nada («Sin cambios en el flete …»).
- **Bitácora:** cada flete guarda cada corrección con fecha, motivo y los valores de antes y después. No se borra.
- **Anular:** pide motivo, **no borra nada** (el flete queda guardado y marcado «Anulado») y su folio queda reservado:
  no se puede volver a usar. Un flete anulado no se corrige ni suma en los totales.

## Rango de referencia (200–300 kg, pendiente de validación)

Debajo de la lista, *Rango de referencia*. De fábrica es **200–300 kg**, y la app lo muestra siempre como **«pendiente de
validación»**: es una referencia para comparar, **no una regla confirmada**.

| La diferencia del flete es… | La pantalla dice |
|---|---|
| Dentro del rango | «Dentro del rango de referencia» |
| Menor que el mínimo | «Por debajo del rango de referencia» |
| Mayor que el máximo | «Por encima del rango de referencia» |
| Cero | «Sin diferencia de peso» |
| Negativa (llegó más de lo que salió) | «El peso final es MAYOR que el inicial…» |
| No hay rango configurado | «Sin rango de referencia configurado» |

Puedes **cambiar** el mínimo y el máximo, marcar **«Ya validé este rango»** cuando lo confirmes con tus propios datos
(entonces deja de decir «pendiente»), **no usar rango** o **volver a 200–300 kg**. El rango se guarda en el teléfono y entra
en el respaldo. Los límites se cuentan como «dentro» (200 kg y 300 kg exactos están dentro).

Arriba de la lista, con los fletes **completos** que se están viendo, aparece la suma de pesos iniciales, de finales y la
diferencia total (también comparada con el rango).

## Respaldo y restauración

- Los fletes y el rango van dentro del **respaldo** (formato 3): *Más → Exportar respaldo*.
- **Cuidado al restaurar un respaldo hecho antes de que existieran los fletes** (formato 1 o 2): ese archivo no trae
  fletes, así que restaurarlo **vacía los fletes de hoy**. La app lo avisa con «no trae fletes: los N fletes que tienes hoy
  se perderán» y pide confirmar. Antes de restaurar guarda una copia interna y puedes usar *Deshacer* (Más), pero lo más
  seguro es exportar un respaldo nuevo primero.
- *Auditar integridad* (Más) también revisa los fletes: folios únicos, que neto = bruto − tara, que lo anulado tenga motivo
  y que cada corrección tenga motivo.

## Límites (léelos)

- **Cada teléfono tiene sus propios fletes.** Si dos personas capturan en dos teléfonos, la app no los junta ni avisa que un
  folio se repite entre teléfonos. Mientras no haya servidor compartido (ver
  [`ARQUITECTURA-COMPARTIDA.md`](ARQUITECTURA-COMPARTIDA.md)), usa un prefijo distinto por teléfono (por ejemplo `A-…` y
  `E-…`).
- No hay fotos de evidencia (decisión pendiente: ver el informe).
- El 200–300 kg es una referencia **sin validar**. No tomes decisiones de dinero con él hasta confirmarlo.
- Probado con Chromium simulando teléfono; **no se ha probado en un iPhone ni en un Android físicos**.
