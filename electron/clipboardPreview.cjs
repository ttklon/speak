'use strict';
const { validImageDimensions, MAX_IMAGE_PIXELS } = require('./clipboardImage.cjs');
const PREVIEW_MAX_SIDE = 320;

/** Без копирования полного bitmap: только длина заимствованного Buffer в этом же тике.
 * `clipboard.readImage()` уже мог выделить память до этой проверки. */
function prepareClipboardPreview(image, lastHash) {
  if (!image || image.isEmpty()) return { status: 'empty' };
  const size = image.getSize();
  if (!validImageDimensions(size)) return { status: 'size' };
  const bitmapBytes = image.getBitmap().length;
  if (!Number.isSafeInteger(bitmapBytes) || bitmapBytes <= 0 || bitmapBytes > MAX_IMAGE_PIXELS * 4) return { status: 'size' };
  // Совместимость с прежней дедупликацией: она не сравнивает содержимое.
  const hash = `${size.width}x${size.height}:${bitmapBytes}`;
  if (hash === lastHash) return { status: 'same' };
  const scale = PREVIEW_MAX_SIDE / Math.max(size.width, size.height);
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const dataUrl = image.resize({ width, height }).toDataURL();
  return { status: 'ready', hash, dataUrl };
}

module.exports = { PREVIEW_MAX_SIDE, prepareClipboardPreview };
