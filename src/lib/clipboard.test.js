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

  it('падает честно, если все способы недоступны', async () => {
    globalThis.window = {};
    globalThis.navigator = {};
    globalThis.document = { createElement: () => ({ style: {}, setAttribute() {}, select() {} }) };
    await expect(writeClipboard('текст')).rejects.toThrow('clipboard-unavailable');
  });

  it('читает через мост, если он есть', async () => {
    globalThis.window = { zspeakly: { native: { readClipboard: async () => 'из буфера' } } };
    await expect(readClipboard()).resolves.toBe('из буфера');
  });
});
