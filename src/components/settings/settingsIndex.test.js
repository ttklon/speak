import { describe, expect, it } from 'vitest';
import { SETTING_ENTRIES } from './settingsIndex.js';

describe('индекс настроек', () => {
  it('содержит строки из всех шести разделов', () => {
    const sections = new Set(SETTING_ENTRIES.map((e) => e.section));
    expect([...sections].sort()).toEqual([
      'about',
      'account',
      'app',
      'data',
      'diagnostics',
      'features',
      'network',
    ]);
  });

  it('находит настройки по частым запросам', () => {
    const find = (q) => SETTING_ENTRIES.filter((e) => e.title.toLowerCase().includes(q)).map((e) => e.title);
    expect(find('звук')).toContain('Звуковой отклик');
    expect(find('уведомл')).toContain('Уведомления');
    expect(find('пароли')).toContain('Скрывать пароли');
    expect(find('обновлен')).toContain('Проверять обновления на GitHub');
    expect(find('ошибки')).toContain('Отправлять ошибки и логи');
  });

  it('не содержит обрезков короче четырёх символов', () => {
    expect(SETTING_ENTRIES.every((e) => e.title.length >= 4)).toBe(true);
  });

  it('описания не обрезаны на первом переносе строки', () => {
    // раньше регулярка сборщика останавливалась на переводе строки, и в индекс
    // попадали обрезки вроде «…, уровень микрофона, живой текст и»
    const descs = SETTING_ENTRIES.map((e) => e.desc).filter(Boolean);
    expect(descs.length).toBeGreaterThan(10);
    const broken = descs.filter((d) => !/[.!?»)]$/.test(d.trim()));
    expect(broken).toEqual([]);
  });

  it('находит строки по словам из конца описания', () => {
    const byDesc = (q) => SETTING_ENTRIES.filter((e) => (e.desc || '').toLowerCase().includes(q));
    expect(byDesc('кнопки').map((e) => e.title)).toContain('Плавающий индикатор записи');
    expect(byDesc('на 1–3 секунды').map((e) => e.title)).toContain('Переписывать диктовку моделью');
  });
});
