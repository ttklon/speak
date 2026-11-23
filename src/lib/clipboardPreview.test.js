import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const { prepareClipboardPreview, PREVIEW_MAX_SIDE } = createRequire(import.meta.url)('../../electron/clipboardPreview.cjs');
function fakeImage(width, height, bytes = width * height * 4) {
  return {
    isEmpty: vi.fn(() => false),
    getSize: vi.fn(() => ({ width, height })),
    getBitmap: vi.fn(() => ({ length: bytes })),
    toBitmap: vi.fn(() => { throw new Error('не копировать bitmap'); }),
    resize: vi.fn(() => ({ toDataURL: () => 'data:image/png;base64,synthetic' })),
  };
}

describe('ограниченное превью системного буфера', () => {
  it('вписывает портрет и пейзаж в 320×320 и не копирует bitmap', () => {
    for (const [width, height, expected] of [[40, 4000, { width: 3, height: 320 }], [4000, 40, { width: 320, height: 3 }], [200, 200, { width: 320, height: 320 }]]) {
      const image = fakeImage(width, height);
      const result = prepareClipboardPreview(image, '');
      expect(result.status).toBe('ready');
      expect(result.hash).toBe(`${width}x${height}:${width * height * 4}`);
      expect(image.resize).toHaveBeenCalledWith(expected);
      expect(image.getBitmap).toHaveBeenCalledOnce();
      expect(image.toBitmap).not.toHaveBeenCalled();
    }
    expect(PREVIEW_MAX_SIDE).toBe(320);
  });

  it('проверяет граничные размеры до доступа к bitmap и размер представления до resize', () => {
    const enormous = fakeImage(20000, 1);
    expect(prepareClipboardPreview(enormous, '').status).toBe('size');
    expect(enormous.getBitmap).not.toHaveBeenCalled();
    expect(enormous.resize).not.toHaveBeenCalled();
    const area = fakeImage(8001, 5000);
    expect(prepareClipboardPreview(area, '').status).toBe('size');
    expect(area.getBitmap).not.toHaveBeenCalled();
    const bytes = fakeImage(10, 10, 160000001);
    expect(prepareClipboardPreview(bytes, '').status).toBe('size');
    expect(bytes.resize).not.toHaveBeenCalled();
    const boundary = fakeImage(8000, 5000, 160000000);
    expect(prepareClipboardPreview(boundary, '').status).toBe('ready');
  });

  it('сохраняет прежнюю дедупликацию по размерам и длине, не утверждая совпадение пикселей', () => {
    const image = fakeImage(50, 100);
    expect(prepareClipboardPreview(image, '50x100:20000').status).toBe('same');
    expect(image.resize).not.toHaveBeenCalled();
    expect(prepareClipboardPreview(image, '50x100:19999').status).toBe('ready');
  });

  it('не читает пустое изображение; ошибки подготовки не выдаются за успешное превью', () => {
    expect(prepareClipboardPreview(null, '').status).toBe('empty');
    expect(prepareClipboardPreview({ isEmpty: () => true }, '').status).toBe('empty');
    const image = fakeImage(40, 4000);
    image.resize.mockImplementation(() => { throw new Error('decode error'); });
    expect(() => prepareClipboardPreview(image, '')).toThrow('decode error');
    image.resize.mockImplementation(() => ({ toDataURL: () => 'ok' }));
    expect(prepareClipboardPreview(image, '').status).toBe('ready');
  });
});
