import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MAX_IMAGE_DATA_URL_CHARS, MAX_IMAGE_SIDE, MAX_IMAGE_PIXELS, validateImageDataUrl, validImageDimensions } = require('../../electron/clipboardImage.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const url = (buffer = png) => `data:image/png;base64,${buffer.toString('base64')}`;
function pngDimensions(width, height) {
  const result = Buffer.from(png);
  result.writeUInt32BE(width, 16);
  result.writeUInt32BE(height, 20);
  return url(result); // заголовок проверяется отдельно, CRC проверит декодер
}

describe('граница копирования изображения', () => {
  it('пропускает PNG снимка и проверяет обе границы размеров до декодирования', () => {
    expect(validateImageDataUrl(url())).toBe(true);
    expect(validateImageDataUrl(pngDimensions(8000, 5000))).toBe(true);
    expect(validateImageDataUrl(pngDimensions(8001, 5000))).toBe(false);
    expect(validateImageDataUrl(pngDimensions(MAX_IMAGE_SIDE, 1))).toBe(true);
    expect(validateImageDataUrl(pngDimensions(MAX_IMAGE_SIDE + 1, 1))).toBe(false);
    expect(validateImageDataUrl(pngDimensions(0, 1))).toBe(false);
    expect(validateImageDataUrl(pngDimensions(1, 0))).toBe(false);
  });

  it('отклоняет битую сигнатуру, IHDR, base64 и заголовок PNG', () => {
    for (const offset of [0, 8, 12]) {
      const broken = Buffer.from(png);
      broken[offset] ^= 0xff;
      expect(validateImageDataUrl(url(broken))).toBe(false);
    }
    expect(validateImageDataUrl('data:image/png;base64,@@@@')).toBe(false);
    expect(validateImageDataUrl('data:image/png;base64,' + png.toString('base64').replace('A', '%'))).toBe(false);
    expect(validateImageDataUrl('data:image/png;charset=utf-8,anything')).toBe(false);
    expect(validateImageDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(false);
    expect(validateImageDataUrl('data:image/png;base64,' + png.toString('base64').replace(/=+$/, ''))).toBe(false);
  });

  it('проверяет длину всей строки до обработки, другие типы оставляет декодеру', () => {
    const prefix = 'data:image/jpeg;base64,';
    expect(validateImageDataUrl(prefix + 'A'.repeat(MAX_IMAGE_DATA_URL_CHARS - prefix.length))).toBe(true);
    expect(validateImageDataUrl(prefix + 'A'.repeat(MAX_IMAGE_DATA_URL_CHARS - prefix.length + 1))).toBe(false);
    expect(validateImageDataUrl('data:image/svg+xml;charset=utf-8,%3Csvg%3E')).toBe(true);
    expect(validateImageDataUrl(null)).toBe(false);
    expect(validateImageDataUrl('https://example.org/picture.png')).toBe(false);
  });

  it('проверяет размеры декодированного изображения любых типов до записи в буфер', () => {
    expect(validImageDimensions({ width: 8000, height: MAX_IMAGE_PIXELS / 8000 })).toBe(true);
    for (const size of [null, {}, { width: 0, height: 1 }, { width: 1.5, height: 1 }, { width: Infinity, height: 1 }, { width: MAX_IMAGE_SIDE + 1, height: 1 }, { width: 8001, height: 5000 }]) {
      expect(validImageDimensions(size)).toBe(false);
    }
  });
});
