'use strict';

// Лимит строки применяется до nativeImage.createFromDataURL и не ограничивает
// уже выделенную строку IPC или память нативного декодера других форматов.
const MAX_IMAGE_DATA_URL_CHARS = 16 * 1024 * 1024;
const MAX_IMAGE_SIDE = 16384;
const MAX_IMAGE_PIXELS = 40 * 1000 * 1000;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

function validImageDimensions(size) {
  const { width, height } = size || {};
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) &&
    width > 0 && height > 0 && width <= MAX_IMAGE_SIDE && height <= MAX_IMAGE_SIDE &&
    width * height <= MAX_IMAGE_PIXELS;
}

function validateImageDataUrl(image) {
  if (typeof image !== 'string' || image.length > MAX_IMAGE_DATA_URL_CHARS || !image.startsWith('data:image/')) return false;
  // История и экранные снимки приложения используют PNG. Читаем только IHDR,
  // не распаковывая пиксели, чтобы не передавать очевидные PNG-бомбы декодеру.
  // Остальные поддерживаемые Electron форматы не разбираем до декодирования.
  if (!/^data:image\/png(?:;|,|$)/i.test(image)) return true;
  const prefix = /^data:image\/png;base64,/i.exec(image);
  if (!prefix) return false;
  const data = image.slice(prefix[0].length);
  if (data.length < 32 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return false;
  const header = Buffer.from(data.slice(0, 40), 'base64');
  if (header.length < 24 || !header.subarray(0, 8).equals(PNG_SIGNATURE) ||
      header.readUInt32BE(8) !== 13 || header.toString('ascii', 12, 16) !== 'IHDR') return false;
  return validImageDimensions({ width: header.readUInt32BE(16), height: header.readUInt32BE(20) });
}

module.exports = { MAX_IMAGE_DATA_URL_CHARS, MAX_IMAGE_SIDE, MAX_IMAGE_PIXELS, validImageDimensions, validateImageDataUrl };
