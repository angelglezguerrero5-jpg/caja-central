// Pre-vuelo de las pruebas E2E:
//  1) Chromium debe existir (no se asume /opt/pw-browsers/chromium).
//  2) El puerto de pruebas debe estar libre; si no, se usa el siguiente libre. NUNCA se detiene un servidor ajeno
//     (por ejemplo el que usa el teléfono). Las pruebas construyen/sirven desde dist-e2e/, no desde dist/.
//  3) Las pruebas usan contextos de navegador aislados (IndexedDB propia): no tocan datos reales.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';

const log = (m) => console.log(`[e2e] ${m}`);

// 1) Chromium
const candidates = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium'];
try {
  const { chromium } = await import('@playwright/test');
  candidates.push(chromium.executablePath());
} catch {
  /* sin playwright instalado: se reporta abajo */
}
const chromiumPath = candidates.find((p) => p && existsSync(p));
if (!chromiumPath) {
  console.error(
    '[e2e] No se encontró Chromium. Opciones:\n' +
      '  - npx playwright install chromium\n' +
      '  - o define CHROMIUM_PATH=/ruta/a/chrome (probado: Chromium/Chrome de Playwright)',
  );
  process.exit(2);
}
log(`Chromium: ${chromiumPath}`);

// 2) Puerto
const isBusy = (port) =>
  new Promise((resolve) => {
    let pending = 2;
    let busy = false;
    const done = () => --pending === 0 && resolve(busy);
    for (const host of ['127.0.0.1', '::1']) {
      const s = net.connect({ port, host });
      s.setTimeout(500);
      s.once('connect', () => ((busy = true), s.destroy(), done()));
      s.once('timeout', () => (s.destroy(), done()));
      s.once('error', () => done());
    }
  });
const wanted = Number(process.env.E2E_PORT ?? 4173);
let port = wanted;
while (await isBusy(port)) {
  log(`El puerto ${port} está ocupado (¿servidor en uso?). No se detiene; se prueba el siguiente.`);
  if (++port > wanted + 20) {
    console.error('[e2e] No hay puerto libre en el rango. Define E2E_PORT con un puerto libre.');
    process.exit(3);
  }
}
log(`Puerto de pruebas: ${port}  ·  carpeta de build de pruebas: ${process.env.E2E_OUT_DIR ?? 'dist-e2e'} (dist/ no se toca)`);

// 3) Ejecutar Playwright
const child = spawn('npx', ['playwright', 'test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, CHROMIUM_PATH: chromiumPath, E2E_PORT: String(port) },
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
