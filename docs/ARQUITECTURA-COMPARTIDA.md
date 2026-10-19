# Datos compartidos, cuentas y seguridad — diseño PROPUESTO

> **Estado: PROPUESTO, NO IMPLEMENTADO.** Este documento es un diseño. No existe servidor, base remota, cuenta, inicio de
> sesión, sincronización ni migración. Nada de lo de abajo está construido, probado ni conectado a producción. Para construir
> cualquier parte hacen falta decisiones tuyas (sección 7) y, para publicar o migrar datos reales, tu autorización explícita.

## 1. Cómo es HOY (VERIFICADO en el código y con pruebas)

| Tema | Hoy |
|---|---|
| Dónde viven los datos | IndexedDB del navegador **de cada teléfono** (`venta-limones`, versión 3) |
| Servidor / cuentas / roles | **No hay.** Cualquiera que abra la app en ese teléfono ve y puede hacer todo |
| Red | El código no usa `fetch`, `XMLHttpRequest`, `WebSocket` ni `sendBeacon`; la CSP solo permite `connect-src 'self'`. Lo comprobó una búsqueda en `src/` y la prueba `tests/e2e/dispositivos.spec.ts` |
| Entre dispositivos | **Aislados.** Otro iPhone, otro Android o la misma app en Safari vs. instalada tienen su propia base. El único puente es un archivo de respaldo |
| Entre pestañas del mismo navegador | Comparten la base; un `BroadcastChannel` (`limones-db`) las avisa entre sí. Nada sale del navegador |
| Folios | Cada teléfono numera sus ventas (#1, #2…), vales y recepciones; el folio del flete lo escribe la persona. **Dos teléfonos repetirán folios** |
| Bitácora | Las correcciones y anulaciones de recepciones y fletes guardan cuándo, motivo y antes/después. **No guardan «quién»**: no existen usuarios |
| Cifrado de los datos locales | Ninguno propio de la app (los protege el bloqueo del teléfono) |

Consecuencia directa: si Alejandro y el encargado usan **cada uno su teléfono**, tienen **dos negocios separados** que no se
suman, y nada impide que repitan folios o que uno modifique lo del otro (si comparten el teléfono). Si usan **el mismo**
teléfono, no hay forma de saber quién hizo cada cosa.

## 2. Qué se pidió que cumpla un diseño compartido

Autenticación individual (Alejandro y el encargado), permisos por rol, bitácora de auditoría, datos financieros protegidos,
cero secretos en el código de la app, HTTPS, aislamiento de datos y, antes de tocar datos reales, **respaldo + plan de
migración + autorización explícita**.

## 3. Opciones

| Opción | Qué es | A favor | En contra |
|---|---|---|---|
| **A. Seguir como hoy** | Un teléfono por negocio, respaldos disciplinados | Cero infraestructura, ya probado | Sin vista conjunta, sin «quién», pérdida si se pierde el teléfono sin respaldo reciente |
| **B. Paquetes a mano** | El encargado exporta un archivo de movimientos del día; el dueño lo importa (por `id`, sin duplicar) | Sin servidor ni cuentas | Manual, se olvida, la confianza es del que manda el archivo, sin permisos reales |
| **C. Servicio administrado (Postgres + autenticación + reglas por fila)** | Todo en un proveedor | Menos código propio | Atarse a un proveedor; las reglas de negocio quedan duplicadas en SQL; revisar bien las reglas por fila |
| **D. API propia pequeña + Postgres administrado** | Un servicio sin estado que **reutiliza `src/domain`** | Las mismas validaciones (dinero, pesos, folios, respaldos) corren en el servidor sin reescribirlas; control total de permisos y bitácora | Hay que mantenerla; es lo más trabajo |

**Recomendación: D, en dos pasos** (el orden importa porque el riesgo grande hoy es **perder los datos**, no la falta de
sincronización):

1. **Paso 1 — Respaldo en la nube con inicio de sesión del dueño.** Un solo usuario; el archivo de respaldo (que la app ya
   sabe validar y restaurar) se sube cifrado y se baja en un teléfono nuevo. No cambia cómo se captura. Resuelve «se me
   perdió/dañó el teléfono».
2. **Paso 2 — Dos personas capturando (sincronización).** Se construye **solo si** el negocio de verdad necesita ver lo
   mismo en dos teléfonos.

(Elegir proveedor de hosting, costos y quién da mantenimiento es **decisión tuya**; no se verificó ningún precio.)

## 4. Diseño del Paso 2 (sincronización)

### 4.1 Modelo

- Un **negocio** (tenant) con **usuarios** (dueño, encargado) y **dispositivos** registrados.
- Todo registro lleva `id` generado en el teléfono (UUID), `deviceId`, `createdBy`, `createdAt`. Lo que ya se guarda hoy (ventas,
  vales, movimientos de inventario, recepciones, fletes y sus revisiones) ya es casi un **registro de operaciones**: solo se
  agregan quién y dónde.
- El servidor asigna un número de orden `serverSeq` a lo que recibe; cada teléfono pide «lo nuevo desde mi último
  `serverSeq`».
- Sin conexión sigue funcionando igual que hoy: se guarda **primero en el teléfono** y se envía cuando hay red. La app nunca
  debe decir «guardado» antes de que esté en el teléfono, ni «sincronizado» antes de que el servidor lo confirme (dos estados
  distintos en pantalla).

### 4.2 Conflictos y folios

- Reenvíos y duplicados: seguros porque cada operación trae su `id` (el servidor responde igual a la segunda vez).
- **Folios de venta/vale/recepción:** si dos teléfonos numeran solos, chocan. Opciones: prefijo por dispositivo (`A-0001`,
  `E-0001`) o folio global asignado al sincronizar (no sirve para el ticket que ya se entregó). *Decisión pendiente* (sección 7).
- **Folio de flete:** índice único por negocio en el servidor; si dos teléfonos usaron el mismo, el segundo recibe un conflicto y
  la persona lo renombra (la bitácora conserva el nombre anterior).
- **Dos correcciones del mismo registro:** ambas se conservan en su bitácora; la última por `serverSeq` es la vigente.
- Corregir lo ya capturado sigue exigiendo motivo; anular no borra.

### 4.3 Inicio de sesión

- **Una cuenta por persona.** Preferido: **llaves de acceso (passkeys / WebAuthn)**; alternativa: código por correo.
  *(Que Safari de iPhone las soporte es información de documentación; no se probó en un iPhone.)*
- Sesión con credenciales de **corta duración** en cookies `HttpOnly; Secure; SameSite=Strict`, **no** en `localStorage`.
- Dar de alta un teléfono nuevo requiere al dueño; un teléfono perdido se **revoca** desde otra sesión (no borra lo que ya está
  guardado en ese teléfono: por eso conviene el bloqueo del teléfono y, opcionalmente, un PIN de la app).
- Límite de intentos y bloqueo temporal.

### 4.4 Roles (propuesta; la matriz definitiva la decide el dueño)

| Acción | Dueño | Encargado |
|---|---|---|
| Vender, hacer vales, recibir mercancía, capturar fletes, movimientos de caja del turno abierto | sí | sí |
| Corregir lo ya capturado (con motivo) | sí | sí, queda registrado quién |
| Anular ventas, vales, recepciones, fletes | sí | *por decidir* |
| Cambiar precios, catálogo, rango de referencia de fletes | sí | *por decidir* |
| Ver cortes anteriores, totales del negocio, reportes | sí | solo el turno actual *(por decidir)* |
| Exportar/restaurar respaldos, auditar, invitar o revocar usuarios y teléfonos | sí | no |

### 4.5 Bitácora de auditoría

Tabla **solo de inserción** (sin permisos de actualizar ni borrar para la API): quién, desde qué teléfono, cuándo, qué acción y
sobre qué registro (valores antes/después de lo que ya se registra hoy). Opcional: encadenar hashes para detectar manipulación.

### 4.6 Seguridad

- Sin secretos en el frontend: la app solo conoce la dirección pública de la API; claves de base de datos y firmas viven en el
  gestor de secretos del hosting.
- HTTPS obligatorio con HSTS; CSP actualizada (`connect-src` a la API, `frame-ancestors 'none'`, `object-src 'none'`).
- Aislamiento: toda consulta filtra por negocio; la base aplica **reglas por fila** además del filtro en el código; pruebas de
  que un usuario de otro negocio no lee nada.
- Validación **en el servidor** con el mismo `src/domain` (no se confía en lo que manda el teléfono).
- Datos mínimos: lo más sensible son los **montos** y los **nombres de clientes en los vales**; registrar en logs solo ids.
- Cifrado en reposo y en tránsito, respaldos de la base con restauración puntual, usuario de base con mínimos privilegios,
  dependencias fijadas y auditadas.

## 5. Plan de migración desde los teléfonos de hoy (sin ejecutar nada sin autorización)

1. **Antes de tocar nada:** cada teléfono exporta su respaldo (formato 3) y se corre *Auditar integridad*; se guarda copia
   aparte (con suma de verificación).
2. **Ensayo en un entorno de pruebas aparte** (nunca producción): un importador lee el respaldo con `validateBackup`, lo carga
   y **compara** cantidades, sumas de ventas, existencias por variedad, efectivo esperado y fletes contra el origen.
3. **Revisión de los resultados contigo** (diferencias = no se sigue).
4. **Solo con tu autorización explícita:** importación real. El teléfono conserva su base local intacta como plan de vuelta.
5. Un segundo teléfono: o empieza vacío y descarga, o se combina por `id` (idempotente) con detección de duplicados.

**Reversa:** descartar el negocio en el servidor y seguir con los teléfonos como hoy.

## 6. Pruebas que se escribirían junto con el código

Dos dispositivos simulados: sin conexión → con conexión, reenvíos duplicados, desorden de llegada, relojes desajustados,
choque de folios, permisos denegados por rol, aislamiento entre negocios, bitácora que no se puede alterar, importación de
ensayo contra un respaldo real, que actualizar la app no borre lo pendiente de enviar.

## 7. Decisiones que necesito de ti

1. ¿Cuántos teléfonos y personas capturan? ¿El encargado vende, recibe mercancía, hace cortes?
2. ¿Qué **no** debe ver o poder hacer el encargado (precios, cortes anteriores, anular)?
3. ¿Necesitas ver el negocio **en tiempo real** desde otro lado, o basta un respaldo seguro en la nube (Paso 1)?
4. ¿Folios con prefijo por teléfono (`A-`, `E-`) o algo distinto?
5. ¿Quién dará mantenimiento y cuánto estás dispuesto a pagar al mes? ¿En qué país/región deben vivir los datos?
6. ¿Los nombres de clientes en vales requieren aviso de privacidad?

## 8. Qué NO se hizo (para que no haya malentendidos)

No se creó ningún servicio, cuenta, base de datos remota, dominio ni publicación; no se conectó nada a producción; no se migraron
datos; no hay inicio de sesión ni roles en la app. Los datos reales (si existen en el teléfono de Alejandro) **no se tocaron**.
