import { describe, it, expect } from 'vitest';
import { describeRecognitionError, RECOGNITION_MESSAGES } from './errors.js';

describe('понятные сообщения об ошибках распознавания', () => {
  it('каждый известный код объясняет, что делать', () => {
    for (const [code, message] of Object.entries(RECOGNITION_MESSAGES)) {
      expect(message.title, code).toBeTruthy();
      expect(Object.keys(message)).toContain('hint');
      expect(describeRecognitionError(code)).toBe(message);
    }
  });

  it('нет доступа к микрофону ведёт в настройки разрешений', () => {
    const r = describeRecognitionError('not-allowed');
    expect(r.title).toMatch(/микрофон/i);
    expect(r.hint).toMatch(/Микрофон/);
  });

  it('неизвестный код не показывается пустотой', () => {
    const r = describeRecognitionError('что-то-новое');
    expect(r.title).toBe('Ошибка распознавания');
    expect(r.hint).toContain('что-то-новое');
    expect(describeRecognitionError().hint).toContain('unknown');
  });
});
