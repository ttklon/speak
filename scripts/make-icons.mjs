/**
 * Генерация иконок ZSpeakly без внешних зависимостей:
 * рисуем «Z» в белом скруглённом квадрате и сохраняем PNG (256/128/64/32)
 * и ICO (мультиразмерный, PNG-сжатие) для Windows-сборки.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'icons');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Простая отрисовка: скруглённый квадрат + буква Z из прямоугольников. */
function renderIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const radius = size * 0.22;

  const inRoundRect = (x, y) => {
    const r = radius;
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r + 0.001;
  };

  // Геометрия буквы Z (в долях от размера)
  const stroke = size * 0.13;
  const left = size * 0.28;
  const right = size * 0.72;
  const top = size * 0.3;
  const bottom = size * 0.7;

  const inZ = (x, y) => {
    if (x < left || x > right || y < top || y > bottom) return false;
    // верхняя и нижняя горизонтали
    if (y <= top + stroke || y >= bottom - stroke) return true;
    // диагональ: от правого верха к левому низу, обрезанная по прямоугольнику буквы
    const t = (y - top) / (bottom - top);
    const cx = right - t * (right - left);
    const half = (stroke * 0.86) / 2 / Math.cos(Math.atan2(bottom - top, right - left));
    return Math.abs(x - cx) <= half;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const inside = inRoundRect(x + 0.5, y + 0.5);
      const glyph = inside && inZ(x + 0.5, y + 0.5);
      if (glyph) {
        px[i] = 0x11; px[i + 1] = 0x11; px[i + 2] = 0x13; px[i + 3] = 255;
      } else if (inside) {
        px[i] = 0xf7; px[i + 1] = 0xf6; px[i + 2] = 0xf9; px[i + 3] = 255;
      } else {
        px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 0;
      }
    }
  }
  return px;
}

function encodePng(size) {
  const px = renderIcon(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.subarray(y * size * 4, (y + 1) * size * 4).forEach((v, i) => {
      raw[y * (size * 4 + 1) + 1 + i] = v;
    });
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const sizes = [512, 256, 128, 64, 48, 32, 16];
const pngs = new Map();
for (const size of sizes) {
  const png = encodePng(size);
  pngs.set(size, png);
  writeFileSync(join(outDir, `icon-${size}.png`), png);
}

// Основная иконка приложения
writeFileSync(join(outDir, 'icon.png'), pngs.get(256));

// ICO: в Windows 7+ допускаются PNG-кадры
const icoSizes = [256, 128, 64, 48, 32, 16];
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icoSizes.length, 4);

let offset = 6 + icoSizes.length * 16;
const entries = [];
const payloads = [];
for (const size of icoSizes) {
  const data = pngs.get(size);
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(data.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  payloads.push(data);
  offset += data.length;
}
writeFileSync(join(outDir, 'icon.ico'), Buffer.concat([header, ...entries, ...payloads]));

// SVG-логотип для веба/README
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect x="0" y="0" width="256" height="256" rx="56" fill="#f7f6f9"/>
  <path d="M72 77h112v33L110 179h74v33H72v-33l74-69H72z" fill="#111113"/>
</svg>`;
writeFileSync(join(outDir, 'logo.svg'), svg);

console.log('icons готовы:', sizes.map((s) => `icon-${s}.png`).join(', '), '+ icon.ico, logo.svg');
if (!existsSync(join(outDir, 'icon.ico'))) process.exit(1);
