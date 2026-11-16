import { describe, it, expect } from 'vitest';
import { describeRecognitionError, RECOGNITION_MESSAGES } from './errors.js';
import { EMPTY_RESULT_MESSAGES } from './engine.js';
import { SETTINGS_SECTION_LABELS, hintSections } from '../settingsSections.js';

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

describe('подсказки ведут в существующий раздел настроек', () => {
  const all = [
    ...Object.entries(RECOGNITION_MESSAGES).map(([code, m]) => [`errors:${code}`, m.hint]),
    ...Object.entries(EMPTY_RESULT_MESSAGES).map(([code, m]) => [`empty:${code}`, m.hint]),
  ];

  it('каждое «Настройки → Раздел» называет раздел из списка', () => {
    const broken = [];
    for (const [where, hint] of all) {
      for (const label of hintSections(hint)) {
        if (!SETTINGS_SECTION_LABELS.includes(label)) broken.push(`${where}: «${label}»`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('хотя бы одна подсказка действительно указывает раздел', () => {
    const withSection = all.filter(([, hint]) => hintSections(hint).length > 0);
    expect(withSection.length).toBeGreaterThan(2);
  });

  it('разбор подсказки берёт только первый раздел', () => {
    expect(hintSections('Откройте «Настройки → Функции → Модель распознавания».')).toEqual([
      'Функции',
    ]);
    expect(hintSections('Тут раздела нет.')).toEqual([]);
  });
});
