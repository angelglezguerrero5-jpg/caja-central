# Pasar el proyecto a Ubuntu

El repositorio es autocontenido (código + pruebas + documentos). Nada depende de la nube ni de servicios externos.

## 0. Obtener el código (decide tú cómo)

El trabajo de la versión 0.2.0 (recepción de mercancía y clasificación) está **sin confirmar en git** (sin commit y sin
push): la decisión de confirmarlo y subirlo es tuya. Hay dos caminos:

- **Con git**: cuando decidas confirmar los cambios, en la computadora actual `git push` a tu remoto y en Ubuntu
  `git clone <URL> ~/sistema-venta-limones && cd ~/sistema-venta-limones && git checkout claude/dazzling-ritchie-xtjmf8`.
  También sirve `git bundle create limones.bundle --all` (solo incluye lo ya confirmado).
- **Sin confirmar nada**: copia la carpeta del proyecto **sin** `node_modules/`, `dist/`, `dist-e2e*/` ni
  `test-results*/` (por ejemplo `tar --exclude=node_modules --exclude='dist*' --exclude='test-results*' -czf limones.tgz sistema-venta-limones`)
  y descomprímela en Ubuntu (`tar -xzf limones.tgz -C ~`). Incluye los cambios sin confirmar.

## 1. Herramientas

```bash
sudo apt update && sudo apt install -y git adb
# Node 22 recomendado (nvm o NodeSource). Verifica:
node -v   # >= 20
```

Para correr las pruebas con navegador (E2E) en Ubuntu limpio hacen falta además las bibliotecas de Chromium:

```bash
sudo apt install -y libnss3 libnspr4 libatk-bridge2.0-0 libgbm1 libasound2t64
npx playwright install chromium     # ~150 MB, solo si no tienes Chromium
```

## 2. Instalar y verificar (todo local)

```bash
cd ~/sistema-venta-limones
npm ci
npm run typecheck
npm test                     # pruebas unitarias (Vitest + fake-indexeddb)
npm run build
npm run verify:pwa           # debe decir "build PWA consistente"
npm run test:e2e             # E2E: construye en dist-e2e/, elige un puerto libre y usa un navegador aislado
```

`npm run check` encadena todo lo anterior.

- Si ya tienes Chromium/Chrome: `CHROMIUM_PATH=/ruta/a/chrome npm run test:e2e`.
- El puerto de pruebas empieza en 4173; **si está ocupado usa el siguiente libre y nunca detiene un servidor ajeno**
  (por ejemplo el que usa tu teléfono). Se puede fijar con `E2E_PORT=4300`.
- Las E2E **no tocan `dist/`** (construyen en `dist-e2e/`) y usan perfiles de navegador aislados: no leen ni escriben
  los datos reales del teléfono.
- Para correr un solo archivo: `npm run test:e2e -- tests/e2e/recepcion.spec.ts`.

Luego sigue `docs/ANDROID.md`.

## Qué NO viaja con el repo

- Los **datos de ventas e inventario**: viven en IndexedDB del navegador del teléfono. Usa *Más → Exportar respaldo*
  antes de cambiar de teléfono, de navegador o de dirección (otro origen = otros datos).
- Los respaldos son archivos `.json`: guárdalos fuera del teléfono (correo, Drive, WhatsApp).
