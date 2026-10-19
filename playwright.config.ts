import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// El script scripts/run-e2e.mjs resuelve estos valores (puerto libre, Chromium existente).
// Si se ejecuta `playwright test` directamente, se usan los valores por defecto.
const PORT = Number(process.env.E2E_PORT ?? 4173);
// Las E2E construyen y sirven desde una carpeta propia: NUNCA tocan dist/ (que puede estar sirviéndose al teléfono).
const OUT_DIR = process.env.E2E_OUT_DIR ?? 'dist-e2e';
// Carpeta de resultados/trazas: se puede cambiar para correr varias tandas a la vez sin pisarse (E2E_RESULTS_DIR).
const RESULTS_DIR = process.env.E2E_RESULTS_DIR ?? 'test-results';
// E2E_SKIP_TSC=1 omite el typecheck del arranque (el flujo normal `npm run check` ya lo ejecuta antes por separado).
const TYPECHECK = process.env.E2E_SKIP_TSC ? '' : 'npx tsc --noEmit && ';
const DEFAULT_CHROMIUM = '/opt/pw-browsers/chromium';
const CHROMIUM = process.env.CHROMIUM_PATH ?? (existsSync(DEFAULT_CHROMIUM) ? DEFAULT_CHROMIUM : undefined);

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: RESULTS_DIR,
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Pantalla tipo teléfono Android, con la zona horaria y el idioma del negocio (Central de Abasto, CDMX).
    ...devices['Pixel 7'],
    timezoneId: 'America/Mexico_City',
    locale: 'es-MX',
    launchOptions: { ...(CHROMIUM ? { executablePath: CHROMIUM } : {}), args: ['--no-sandbox'] },
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `${TYPECHECK}npx vite build --outDir ${OUT_DIR} --emptyOutDir && npx vite preview --outDir ${OUT_DIR} --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
