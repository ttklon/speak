import { describe, it, expect } from 'vitest';
import {
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_LABELS,
  SECTION_ALIASES,
  resolveSection,
  hintSections,
} from './settingsSections.js';

describe('разделы настроек', () => {
  it('разделов четыре, и все они подписаны', () => {
    expect(SETTINGS_SECTIONS).toHaveLength(4);
    expect(SETTINGS_SECTION_LABELS).toEqual(['Диктовка', 'Приложение', 'Данные', 'Диагностика']);
    for (const section of SETTINGS_SECTIONS) {
      expect(section.desc, section.id).toBeTruthy();
    }
  });

  it('нынешний id остаётся собой', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(resolveSection(section.id)).toBe(section.id);
    }
  });

  it('старые id ведут в новые разделы', () => {
    expect(resolveSection('features')).toBe('dictation');
    expect(resolveSection('network')).toBe('dictation');
    expect(resolveSection('account')).toBe('app');
    expect(resolveSection('about')).toBe('app');
    expect(resolveSection('data-and-permissions')).toBe('data');
  });

  it('каждая ссылка из SECTION_ALIASES указывает на существующий раздел', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    for (const [from, to] of Object.entries(SECTION_ALIASES)) {
      expect(ids, `алиас ${from} → ${to}`).toContain(to);
    }
  });

  it('неизвестный id не оставляет пустой экран', () => {
    expect(resolveSection('нет-такого')).toBe('dictation');
    expect(resolveSection(undefined)).toBe('dictation');
    expect(resolveSection(null)).toBe('dictation');
    expect(resolveSection('')).toBe('dictation');
  });
});

describe('подсказки «Настройки → Раздел»', () => {
  it('берёт первый раздел и игнорирует хвост', () => {
    expect(hintSections('Откройте «Настройки → Диктовка → Модель распознавания».')).toEqual([
      'Диктовка',
    ]);
    expect(hintSections('Настройки → Приложение, затем «Тест микрофона».')).toEqual([
      'Приложение',
    ]);
  });

  it('текст без ссылки ничего не выдумывает', () => {
    expect(hintSections('Тут раздела нет.')).toEqual([]);
    expect(hintSections(undefined)).toEqual([]);
    expect(hintSections('')).toEqual([]);
  });
});
