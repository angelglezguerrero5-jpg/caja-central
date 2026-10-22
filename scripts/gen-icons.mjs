// Genera los íconos PNG a partir de public/icons/logo.svg (gráfica de barras ascendente con signo de peso).
// Rasteriza con Chromium (playwright-core) en un <canvas> y escribe el PNG a mano con zlib para controlar el tipo de color:
//  - icon-192 / icon-512: RGBA, esquinas redondeadas transparentes (como el SVG fuente).
//  - maskable-512: fondo a sangre y dibujo reducido dentro de la zona segura (círculo central del 80 %).
//  - apple-touch-icon (180): RGB SIN canal alfa y fondo a sangre (iOS rellena la transparencia de negro y redondea solo).
// Uso: node scripts/gen-icons.mjs   (CHROMIUM_PATH para otro ejecutable; por defecto /opt/pw-browsers/chromium)
import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const SRC = 'public/icons/logo.svg';
const svg = readFileSync(SRC, 'utf8');

/** Variante del SVG: fondo a sangre (rx=0) y/o dibujo escalado hacia el centro. */
function variant({ fullBleed = false, scale = 1 }) {
  let s = svg;
  if (fullBleed) s = s.replace(/(<rect id="bg"[^>]*?)\s+rx="[^"]*"/, '$1');
  if (scale !== 1) s = s.replace('<g id="art"', `<g id="art" transform="translate(256 256) scale(${scale}) translate(-256 -256)"`);
  return s;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** rgba: bytes de size*size*4. rgb=true → PNG tipo 2 (sin alfa); exige que todo píxel sea opaco. */
function encodePng(size, rgba, rgb) {
  const bpp = rgb ? 3 : 4, stride = size * bpp + 1, raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4, o = y * stride + 1 + x * bpp;
      if (rgb && rgba[i + 3] !== 255) throw new Error(`píxel no opaco en (${x},${y}) del ícono RGB de ${size}px`);
      raw[o] = rgba[i]; raw[o + 1] = rgba[i + 1]; raw[o + 2] = rgba[i + 2];
      if (!rgb) raw[o + 3] = rgba[i + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = rgb ? 2 : 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><body style="margin:0"></body>');
  const raster = async (svgText, size) =>
    Uint8Array.from(await page.evaluate(async ({ svgText, size }) => {
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, size, size);
      return Array.from(ctx.getImageData(0, 0, size, size).data);
    }, { svgText, size }));

  const out = [
    { file: 'public/icons/icon-192.png', size: 192, svg: variant({}) },
    { file: 'public/icons/icon-512.png', size: 512, svg: variant({}) },
    { file: 'public/icons/maskable-512.png', size: 512, svg: variant({ fullBleed: true, scale: 0.8 }) },
    { file: 'public/icons/apple-touch-icon.png', size: 180, svg: variant({ fullBleed: true, scale: 0.9 }), rgb: true },
  ];
  for (const o of out) {
    writeFileSync(o.file, encodePng(o.size, await raster(o.svg, o.size), !!o.rgb));
    console.log(`${o.file} ${o.size}x${o.size} ${o.rgb ? 'RGB (sin alfa)' : 'RGBA'}`);
  }
} finally {
  await browser.close();
}
