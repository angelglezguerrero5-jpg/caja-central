# Pasar el proyecto a Ubuntu

El repositorio es autocontenido (código + pruebas + docs). Nada depende de la nube.

```bash
# 1. Herramientas
sudo apt update && sudo apt install -y git adb
# Node 22 recomendado (nvm o NodeSource). Verifica:
node -v   # >= 20

# 2. Obtener el código
#    a) si está en tu remoto:  git clone <URL> && cd sistema-venta-limones
#    b) sin remoto: en la máquina actual  git bundle create limones.bundle --all
#       y en Ubuntu  git clone limones.bundle sistema-venta-limones
git checkout claude/dazzling-ritchie-xtjmf8

# 3. Instalar y verificar (todo local)
npm ci
npm run typecheck
npm test                     # pruebas unitarias
npx playwright install chromium   # solo si no tienes Chromium (descarga ~150 MB)
npm run test:e2e             # E2E (hace build + preview solo)
npm run verify:pwa
```

Si ya tienes Chromium/Chrome: `CHROMIUM_PATH=/ruta/a/chrome npm run test:e2e`
(por defecto busca `/opt/pw-browsers/chromium`, que es el del entorno donde se construyó).

Luego sigue `docs/ANDROID.md`.

## Qué NO viaja con el repo
- Los **datos de ventas**: viven en IndexedDB del navegador del teléfono. Usa *Más → Exportar respaldo*.
