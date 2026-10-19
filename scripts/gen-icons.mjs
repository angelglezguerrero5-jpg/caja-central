// Genera íconos PNG (sin dependencias): limón amarillo sobre fondo verde.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

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
// rgb=true → PNG de 3 canales SIN canal alfa (el ícono de iPhone no debe tener transparencia: iOS la rellena de negro).
function png(size, maskable, rgb = false) {
  const bg = [47, 125, 50], lemon = [253, 216, 53], leaf = [27, 94, 32];
  const scale = maskable ? 0.62 : 0.8; // maskable: zona segura central
  const bpp = rgb ? 3 : 4;
  const stride = size * bpp + 1;
  const raw = Buffer.alloc(stride * size);
  const cx = size / 2, cy = size / 2, rx = (size * scale) / 2, ry = rx * 0.78;
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      // limón = elipse inclinada
      const a = Math.PI / 6, rxp = dx * Math.cos(a) + dy * Math.sin(a), ryp = -dx * Math.sin(a) + dy * Math.cos(a);
      const inLemon = rxp * rxp + (ryp * ryp) / 0.85 <= 1;
      const inLeaf = Math.hypot((x - cx - rx * 0.55) / (rx * 0.3), (y - cy + ry * 0.75) / (ry * 0.18)) <= 1;
      const col = inLemon ? lemon : inLeaf ? leaf : bg;
      const o = y * stride + 1 + x * bpp;
      raw[o] = col[0]; raw[o + 1] = col[1]; raw[o + 2] = col[2];
      if (!rgb) raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = rgb ? 2 : 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', png(192, false));
writeFileSync('public/icons/icon-512.png', png(512, false));
writeFileSync('public/icons/maskable-512.png', png(512, true));
// iPhone/iPad: 180×180 (iPhone @3x), opaco y sin esquinas redondeadas (iOS les pone su propia máscara).
writeFileSync('public/icons/apple-touch-icon.png', png(180, false, true));
console.log('íconos generados');
