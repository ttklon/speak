import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { processWhisperText } = require('../../electron/whisperTextPolicy.cjs');

describe('эвристики текста Whisper', () => {
  it('в режиме сохранения не стирает намеренные повторы', () => {
    for (const text of ['Алло алло алло, приветики.', '100% 100% 100% заработка']) {
      expect(processWhisperText(text, '', { preserve: true }).text).toBe(text);
    }
  });
  it('в режиме сохранения не стирает продолжение, совпавшее с предыдущей фразой', () => {
    const text = 'обсуждали Zoom и Telegram, а завтра Docker.';
    expect(processWhisperText(text, 'обсуждали Zoom и Telegram', { preserve: true }).text).toBe(text);
    expect(processWhisperText(text, 'обсуждали Zoom и Telegram').text).toBe('а завтра Docker.');
  });
  it('в обычном режиме сохраняет существующую защиту и не срезает эхо частичного результата', () => {
    const loop = 'Спасибо за просмотр. Спасибо за просмотр. Спасибо за просмотр.';
    expect(processWhisperText(loop, '')).toMatchObject({ text: 'Спасибо за просмотр.', collapsed: true, loop: true });
    const text = 'обсуждали Zoom и Telegram, а завтра Docker.';
    expect(processWhisperText(text, 'обсуждали Zoom и Telegram', { partial: true }).text).toBe(text);
  });
  it('не отбрасывает ответ, полностью совпадающий с подсказкой', () => {
    const text = 'обсуждали Zoom и Telegram';
    expect(processWhisperText(text, text).text).toBe(text);
  });
});
