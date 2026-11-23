import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readClipboard, writeClipboard } from './clipboard.js';

describe('буфер обмена', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { ...globalThis.window });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete globalThis.window;
  });

  it('сначала использует нативный мост (file:// не даёт браузерного API)', async () => {
    const calls = [];
    globalThis.window = {
      zspeakly: { native: { writeClipboard: async (payload) => { calls.push(payload); return true; } } },
    };
    await expect(writeClipboard('привет')).resolves.toBe('native');
    expect(calls[0].text).toBe('привет');
  });

  it('пробрасывает картинку вместе с текстом', async () => {
    let got;
    globalThis.window = {
      zspeakly: { native: { writeClipboard: async (p) => { got = p; return true; } } },
    };
    await writeClipboard('текст', 'data:image/png;base64,AAA');
    expect(got.image).toBe('data:image/png;base64,AAA');
  });

  it('после отказа нативного пути копирует текст через текстовый мост', async () => {
    const writeText = vi.fn();
    globalThis.window = { zspeakly: { native: { writeClipboard: async () => false }, clipboard: { writeText } } };
    await expect(writeClipboard('обычный текст')).resolves.toBe('bridge');
    expect(writeText).toHaveBeenCalledWith('обычный текст');
  });

  it('не подменяет изображение текстом при отказе нативной записи', async () => {
    const writeText = vi.fn();
    globalThis.window = {
      zspeakly: {
        native: { writeClipboard: async () => false },
        clipboard: { writeText },
      },
    };
    await expect(writeClipboard('подпись', 'data:image/png;base64,AAA')).rejects.toThrow('clipboard-image-unavailable');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('не выдаёт текстовый фолбэк за копирование изображения без нативного моста', async () => {
    const writeText = vi.fn();
    globalThis.window = { zspeakly: { clipboard: { writeText } } };
    await expect(writeClipboard('', 'data:image/png;base64,AAA')).rejects.toThrow('clipboard-image-unavailable');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('падает честно, если все способы недоступны', async () => {
    globalThis.window = {};
    globalThis.navigator = {};
    globalThis.document = { createElement: () => ({ style: {}, setAttribute() {}, select() {} }) };
    await expect(writeClipboard('текст')).rejects.toThrow('clipboard-unavailable');
  });

  it('убирает временное поле с текстом, даже если execCommand выбросил ошибку', async () => {
    const area = { style: {}, setAttribute() {}, select() {}, parentNode: null };
    const body = {
      appendChild: vi.fn((node) => { node.parentNode = body; }),
      removeChild: vi.fn((node) => { node.parentNode = null; }),
    };
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', { body, createElement: () => area, execCommand: () => { throw new Error('denied'); } });
    await expect(writeClipboard('тестовый секрет')).rejects.toThrow('clipboard-unavailable');
    expect(body.removeChild).toHaveBeenCalledWith(area);
    expect(area.parentNode).toBeNull();
    expect(area.value).toBe('');
  });

  it('при успешном execCommand копирует текст и удаляет временное поле', async () => {
    let copied;
    const area = { style: {}, setAttribute() {}, select() {}, parentNode: null };
    const body = {
      appendChild: (node) => { node.parentNode = body; },
      removeChild: (node) => { node.parentNode = null; },
    };
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', { body, createElement: () => area, execCommand: () => { copied = area.value; return true; } });
    await expect(writeClipboard('обычный текст')).resolves.toBe('execCommand');
    expect(copied).toBe('обычный текст');
    expect(area.parentNode).toBeNull();
    expect(area.value).toBe('');
  });

  it('читает через мост, если он есть', async () => {
    globalThis.window = { zspeakly: { native: { readClipboard: async () => 'из буфера' } } };
    await expect(readClipboard()).resolves.toBe('из буфера');
  });
});
