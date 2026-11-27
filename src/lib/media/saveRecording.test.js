import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordingBase64, saveScreenRecording } from './saveRecording.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('сохранение записи экрана', () => {
  it('преобразует данные 1 МиБ без потери байтов', async () => {
    const bytes = new Uint8Array(1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const encoded = await recordingBase64(new Blob([bytes], { type: 'video/webm' }));
    const decoded = atob(encoded);
    expect(decoded.length).toBe(bytes.length);
    for (let i = 0; i < bytes.length; i++) if (decoded.charCodeAt(i) !== bytes[i]) throw new Error(`byte ${i}`);
  });

  it('не читает слишком большой Blob в память и не вызывает мост', async () => {
    const saveFile = vi.fn();
    const readAsDataURL = vi.fn();
    vi.stubGlobal('FileReader', class { readAsDataURL = readAsDataURL; });
    await expect(saveScreenRecording({ size: 64 * 1024 * 1024 + 1 }, 'test.webm', { saveFile })).rejects.toThrow(/размер/i);
    expect(readAsDataURL).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('отказ или исключение моста не выдаётся за успех', async () => {
    const blob = new Blob(['video']);
    await expect(saveScreenRecording(blob, 'test.webm', { saveFile: async () => ({ ok: false }) })).rejects.toThrow();
    await expect(saveScreenRecording(blob, 'test.webm', { saveFile: async () => { throw new Error('failed'); } })).rejects.toThrow();
  });

  it('сообщает об ошибке чтения Blob', async () => {
    class BrokenReader { readAsDataURL() { this.onerror(); } }
    vi.stubGlobal('FileReader', BrokenReader);
    const saveFile = vi.fn();
    await expect(saveScreenRecording(new Blob(['video']), 'test.webm', { saveFile })).rejects.toThrow();
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('в браузере сообщает только о запросе загрузки и отзывает URL', async () => {
    vi.useFakeTimers();
    const revokeObjectURL = vi.fn();
    const click = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:download', revokeObjectURL });
    vi.stubGlobal('document', { createElement: () => ({ click }) });
    try {
      await expect(saveScreenRecording(new Blob(['video']), 'test.webm')).resolves.toEqual({ saved: false });
      expect(click).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(4000);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:download');
    } finally { vi.useRealTimers(); }
  });

  it('отзывает URL, если браузер не смог запросить загрузку', async () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:download', revokeObjectURL });
    vi.stubGlobal('document', { createElement: () => ({ click() { throw new Error('blocked'); } }) });
    await expect(saveScreenRecording(new Blob(['video']), 'test.webm')).rejects.toThrow();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:download');
  });
});
